const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const { rawToDbRow } = require('./easyecom');
const { parseRapidshypJourney, parseDocpharmaJourney, saveJourney, updateJourneyForOrder } = require('./delivery_journey');
const { syncDocpharmaOrderFromPortal } = require('./docpharma_portal');
const config = require('../../config');
const crypto = require('crypto');

router.post('/rapidshyp', async (req, res) => {
    console.log("\n--- [Webhook Received] ---");
    const data = req.body;

    if (!data || !data.records) {
        console.log("[Webhook Error] Invalid payload.");
        return res.status(400).json({ error: 'Invalid payload' });
    }

    let updatedCount = 0;

    try {
        for (const record of data.records) {
            const orderId = record.seller_order_id; // Usually something like "#1001" or "1001"
            const shipment = (record.shipment_details || [{}])[0];
            const status = shipment.shipment_status;
            const awb = shipment.awb;

            if (!orderId || !status) continue;

            // Normalize ID for searching: Remove #
            const cleanId = String(orderId).replace('#', '');
            // Guard against PostgREST filter injection (this webhook is unauthenticated): safe order-id chars only.
            if (!/^[\w-]+$/.test(cleanId)) { console.warn('[Webhook] skipped unsafe seller_order_id:', orderId); continue; }

            // Update enriched_orders_ecom where name matches
            const updateFields = {
                rapidshyp_webhook_status: status,
                updated_at: new Date().toISOString()
            };
            if (awb) updateFields.awb = awb;

            // Try matching by name (e.g. "#1001" or "1001")
            const { data: updated, error } = await supabase
                .from('enriched_orders_ecom')
                .update(updateFields)
                .in('name', [cleanId, '#' + cleanId])
                .select('shopify_id');

            if (!error && updated && updated.length > 0) {
                console.log(`[Webhook] Updated Order ${orderId} to ${status}`);
                updatedCount += updated.length;
            }

            // Also update rapidshyp_tracking_ecom if AWB is present
            if (awb) {
                await supabase.from('rapidshyp_tracking_ecom').upsert({
                    awb,
                    raw_status: status,
                    last_checked: Date.now() / 1000,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'awb' });

                // Delivery-journey update (RTO/NDR/FASR dashboard).
                const scans = shipment.track_scans || shipment.tracking_history || shipment.tracking_events || [];
                if (scans.length) {
                    // Webhook carried the full timeline → parse directly (no API call). Pass the canonical
                    // current status code so RTO/lost/delivered are classified exactly.
                    await saveJourney(awb, cleanId, 'rapidshyp', parseRapidshypJourney(scans, status, shipment.child_courier_name || shipment.courier_name, null, shipment.current_tracking_status_code, shipment.edd || shipment.current_courier_edd), null, null);
                } else {
                    // No scans in payload → refresh via one API call, ONLY if not already final.
                    const { data: j } = await supabase.from('shipment_journey_ecom').select('is_final').eq('awb', awb).maybeSingle();
                    if (!j || !j.is_final) updateJourneyForOrder(cleanId, awb, shipment.courier_name || null, null).catch(() => {});
                }
            }
        }

        console.log(`[Webhook] Processed. Updated ${updatedCount} orders in DB.`);

    } catch (e) {
        console.error(`[Webhook Critical] ${e.message}`);
    }

    res.json({ status: 'success' });
});

// ─── EasyEcom Webhook ────────────────────────────────────────────────────────
// Registered in EasyEcom dashboard under Settings → Webhooks
// Events: "Get All Orders" (V1/V2) and "Confirm Order"
// EasyEcom sends Access-Token header for verification
router.post('/easyecom', async (req, res) => {
    // Validate token if configured in .env as EASYECOM_WEBHOOK_TOKEN
    if (config.EASYECOM_WEBHOOK_TOKEN) {
        const incoming = req.headers['access-token'] || req.headers['authorization'];
        if (incoming !== config.EASYECOM_WEBHOOK_TOKEN) {
            console.warn('[Webhook EasyEcom] Rejected — invalid Access-Token');
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    // Respond immediately so EasyEcom doesn't timeout and retry
    res.json({ status: 'received' });

    try {
        const payload = req.body;
        if (!payload) return;
        console.log(`[Webhook EasyEcom] ⬇️ Received a webhook (${new Date().toLocaleTimeString('en-IN')})`);

        // V1 wraps in { orders: [...] }, V2 sends array directly
        let orders = [];
        if (Array.isArray(payload))                           orders = payload;
        else if (Array.isArray(payload.orders))               orders = payload.orders;
        else if (payload.data && Array.isArray(payload.data)) orders = payload.data;
        else if (payload.order)                               orders = [payload.order];
        else                                                  orders = [payload];

        const rows = orders.map(rawToDbRow).filter(Boolean);
        if (rows.length === 0) {
            console.warn('[Webhook EasyEcom] No valid orders in payload');
            return;
        }

        const { error } = await supabase
            .from('b2c_order_easycom')
            .upsert(rows, { onConflict: 'order_id' });

        if (error) {
            console.error('[Webhook EasyEcom] Upsert error:', error.message);
        } else {
            console.log(`[Webhook EasyEcom] ✅ Updated ${rows.length} order(s): ${rows.map(r => `${r.reference_code || r.store_order_id || r.order_id}=${r.order_status}`).join(', ')}`);
        }
    } catch (e) {
        console.error('[Webhook EasyEcom] Critical error:', e.message);
    }
});

// ─── DocPharma Webhook → delivery journey ────────────────────────────────────
// DocPharma POSTs order updates to the webhook_url set on each order. The payload carries the full
// order (partner_order_no + suborders[].logistic_details with reattempt_count/current_status), so we
// build the journey directly — no API call. Set the DocPharma webhook to POST here.
router.post('/docpharma', async (req, res) => {
    res.json({ status: 'received' }); // ack immediately
    try {
        const dp = (req.body && (req.body.data || req.body.order || req.body)) || null;
        if (!dp || !dp.suborders) { console.warn('[Webhook DocPharma] no order in payload'); return; }
        const orderName = dp.partner_order_no || dp.order_no || dp.reference || null;
        const ld = (dp.suborders[0] && dp.suborders[0].logistic_details) || {};
        const awb = ld.tracking_number || orderName;
        if (!awb) { console.warn('[Webhook DocPharma] no awb/order name'); return; }
        await saveJourney(awb, orderName, 'docpharma', parseDocpharmaJourney(dp), null, dp);
        // docpharma_orders (recon) is owned solely by the portal sync — never write it from the partner API
        // (avoids overlap/mismatch). Just refresh THIS order from the portal (order fields + timeline).
        syncDocpharmaOrderFromPortal(orderName).catch(() => {});
        console.log(`[Webhook DocPharma] ⬇️ ${orderName} → journey updated (${ld.current_status || dp.status || '?'})`);
    } catch (e) {
        console.error('[Webhook DocPharma] error:', e.message);
    }
});

// ─── DocPharma NDR-log webhook ───────────────────────────────────────────────
// Dedicated receiver for DocPharma NDR (Non-Delivery Report) events → stored in `docpharma_ndr_logs`.
// Point DocPharma's NDR webhook here. Accepts a single event, an array, or {records|data|orders:[...]}.
// Optional shared secret: set DOCPHARMA_NDR_TOKEN in .env and append ?token=... (or send an
// x-webhook-token header); if the env is unset the endpoint is open (like the RapidShyp webhook).
router.post('/docpharma-ndr', async (req, res) => {
    const secret = process.env.DOCPHARMA_NDR_TOKEN;
    if (secret) {
        const got = req.query.token || req.headers['x-webhook-token'];
        if (got !== secret) return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ status: 'received' });   // ack immediately so DocPharma doesn't retry/timeout
    try {
        const body = req.body || {};
        const events = Array.isArray(body) ? body
            : Array.isArray(body.records) ? body.records
            : Array.isArray(body.data)    ? body.data
            : Array.isArray(body.orders)  ? body.orders
            : [body];
        const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '');
        const rows = events.map(ev => {
            const dp = (ev && (ev.data || ev.order || ev)) || {};
            const sub = (dp.suborders && dp.suborders[0]) || {};
            const ld = sub.logistic_details || dp.logistic_details || ev.logistic_details || {};
            const at = pick(ld.ndr_date, ld.ndr_at, ev.ndr_at, ev.ndr_date, ev.timestamp, ev.event_time);
            let ndrAt = null; if (at) { const d = new Date(at); if (!isNaN(d.getTime())) ndrAt = d.toISOString(); }
            return {
                order_name: String(pick(dp.partner_order_no, dp.order_no, dp.reference, ev.order_id, ev.order_name) || '').replace('#', '').trim() || null,
                awb:        pick(ld.tracking_number, dp.tracking_number, ev.awb, ev.tracking_number) || null,
                status:     pick(ld.current_status, dp.status, ev.status, ev.ndr_status) || null,
                ndr_reason: pick(ld.ndr_reason, ld.remarks, dp.ndr_reason, ev.ndr_reason, ev.reason, ev.remark) || null,
                attempt:    (v => Number.isFinite(Number(v)) ? Number(v) : null)(pick(ld.reattempt_count, dp.reattempt_count, ev.attempt, ev.attempt_count, ev.ndr_attempt)),
                courier:    pick(ld.courier_name, dp.courier, ev.courier, ev.courier_name) || null,
                ndr_at:     ndrAt,
                raw:        ev,
            };
        });
        const { error } = await supabase.from('docpharma_ndr_logs').insert(rows);
        if (error) console.error('[Webhook DocPharma-NDR] insert error:', error.message);
        else console.log(`[Webhook DocPharma-NDR] ⬇️ saved ${rows.length} NDR log(s): ${rows.map(r => `${r.order_name || '?'}(${r.status || '-'})`).join(', ')}`);
    } catch (e) { console.error('[Webhook DocPharma-NDR] error:', e.message); }
});

// ─── EasyEcom panel-session auto-sync (Chrome extension) ─────────────────────
// A small MV3 browser extension reads the `laravel_session`+`PHPSESSID` cookies from the admin's
// logged-in EasyEcom tab and POSTs them here every ~20 min (and on change), so the stored panel
// session stays fresh WITHOUT a manual re-paste — no credentials leave the browser. Server-side
// auto-login is impossible (EasyEcom uses Google SSO + 2FA), so this browser-side sync is the way.
// Auth: shared secret EE_SESSION_PUSH_TOKEN (query ?token= or x-ee-token header). Disabled if unset.
router.post('/ee-session', async (req, res) => {
    const secret = process.env.EE_SESSION_PUSH_TOKEN;
    if (!secret) return res.status(503).json({ error: 'EE_SESSION_PUSH_TOKEN not set' });
    if ((req.query.token || req.headers['x-ee-token']) !== secret) return res.status(401).json({ error: 'unauthorized' });
    try {
        const { savePanelCookie } = require('./easyecom');
        await savePanelCookie((req.body || {}).cookie, 'chrome-extension');
        console.log(`[EE-sync] panel cookie refreshed from extension (${new Date().toLocaleTimeString('en-IN')})`);
        res.json({ status: 'saved' });
    } catch (e) {
        const msg = e.message === 'empty' ? 'no cookie in body' : e.message;
        console.warn('[EE-sync] rejected:', msg);
        res.status(400).json({ error: msg });
    }
});

// ─── Browser-executor routing (Firefox extension runs UpdateVendor from the user's IP) ───────
// EasyEcom's panel is behind AWS WAF that blocks our VPS's datacenter IP, so the VPS can't call
// UpdateVendor itself. Instead the browser extension (on the admin's residential IP, which the WAF
// trusts) executes it. The VPS just serves the pending DocPharma-rejected routes and records the
// results. Auth: the same EE_SESSION_PUSH_TOKEN as /ee-session.
function _eeAuthed(req) {
    const secret = process.env.EE_SESSION_PUSH_TOKEN;
    return !!secret && (req.query.token || req.headers['x-ee-token']) === secret;
}

// GET pending routes → [{orderName, invoiceId, currentCid, targetCid, cId, eeOrderId}].
router.get('/ee-routes', async (req, res) => {
    if (!process.env.EE_SESSION_PUSH_TOKEN) return res.status(503).json({ error: 'EE_SESSION_PUSH_TOKEN not set' });
    if (!_eeAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
        const ee = require('./easyecom');
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase.from('dp_rejected_handled_ecom')
            .select('order_name').is('routed_at', null).gte('updated_at', cutoff).limit(80);
        if (error) throw new Error(error.message);
        const cId = await ee.ourCompanyCid();
        const routes = [];
        for (const row of (data || [])) {
            const name = row.order_name;
            const info = await ee.resolveInvoiceAndWarehouse(name);
            if (!info || !info.invoiceId) continue;                                   // not synced yet → skip this pass
            if (String(info.currentCid) === String(ee.SHIFUPRO_CID)) {                // already on Shifupro → close it out
                await supabase.from('dp_rejected_handled_ecom').update({ routed_at: new Date().toISOString() }).eq('order_name', name);
                continue;
            }
            routes.push({ orderName: name, invoiceId: info.invoiceId, currentCid: info.currentCid, targetCid: ee.SHIFUPRO_CID, cId, eeOrderId: info.eeOrderId, source: 'dp' });
        }
        // Manual "Move order" requests — route_pending marks (any target warehouse).
        const { data: pend } = await supabase.from('order_marks_ecom').select('order_name, note').eq('mark_type', 'route_pending');
        for (const m of (pend || [])) {
            const name = m.order_name;
            if (routes.some(r => r.orderName === name)) continue;               // already queued via the DP list
            const targetCid = Number(m.note);
            if (!targetCid) continue;
            const info = await ee.resolveInvoiceAndWarehouse(name);
            if (!info || !info.invoiceId) continue;
            if (String(info.currentCid) === String(targetCid)) {                // already there → clear the mark
                await supabase.from('order_marks_ecom').delete().eq('order_name', name).eq('mark_type', 'route_pending');
                continue;
            }
            routes.push({ orderName: name, invoiceId: info.invoiceId, currentCid: info.currentCid, targetCid, cId, eeOrderId: info.eeOrderId, source: 'manual' });
        }
        res.json({ routes });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST a route result from the extension → {orderName, ok, currentCid, message}. Marks routed / retries.
router.post('/ee-route-result', async (req, res) => {
    if (!process.env.EE_SESSION_PUSH_TOKEN) return res.status(503).json({ error: 'EE_SESSION_PUSH_TOKEN not set' });
    if (!_eeAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
        const ee = require('./easyecom');
        const { orderName, ok, currentCid, targetCid, message } = req.body || {};
        if (!orderName) return res.status(400).json({ error: 'orderName required' });
        const dest = targetCid || ee.SHIFUPRO_CID;
        supabase.from('api_logs_ecom').insert({ action: 'ee_browser_route', status_code: ok ? 200 : 422,
            payload: { order: orderName, to: dest, via: 'extension' }, response: String(message || (ok ? 'routed' : 'failed')).slice(0, 200) }).then(() => {}).catch(() => {});
        // Clear BOTH queues for this order (it may be in the DP list and/or a manual mark).
        const clearQueues = async () => {
            await supabase.from('dp_rejected_handled_ecom').update({ routed_at: new Date().toISOString() }).eq('order_name', orderName);
            await supabase.from('order_marks_ecom').delete().eq('order_name', orderName).eq('mark_type', 'route_pending');
        };
        if (ok) {
            await ee.markWarehouseRouted(orderName, currentCid || null, dest, 'extension');
            await clearQueues();
            console.log(`[EE-route] ${orderName} routed → ${dest} (via extension)`);
        } else {
            // Permanent block (shipment already assigned) → close it so it stops retrying; transient → leave for next pass.
            if (/shipment.*assigned|already been assigned/i.test(String(message || ''))) await clearQueues();
            console.warn(`[EE-route] ${orderName} not routed: ${String(message || '').slice(0, 80)}`);
        }
        res.json({ status: 'recorded' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Shopify orders/create → auto-hold repeat COD orders (upstream of EasyEcom) ──────────────
// Registered as a Shopify webhook (topic orders/create). HMAC-verified with SHOPIFY_WEBHOOK_SECRET over
// the RAW body (captured in server.js via express.json verify). Holds instantly so the order never
// reaches EasyEcom; the */5-min cron is the backstop. 503 until the secret is set. Acks fast (Shopify
// needs a quick 200), then evaluates + holds asynchronously.
function _shopifyHmacOk(req) {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!secret) return false;
    const sent = req.get('X-Shopify-Hmac-Sha256') || '';
    const digest = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('base64');
    try { return sent.length === digest.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(digest)); } catch (_) { return false; }
}
router.post('/shopify-order', async (req, res) => {
    if (!process.env.SHOPIFY_WEBHOOK_SECRET) { console.warn('[ShopifyHold] webhook hit but SHOPIFY_WEBHOOK_SECRET is not set → 503'); return res.status(503).json({ error: 'SHOPIFY_WEBHOOK_SECRET not set' }); }
    if (!_shopifyHmacOk(req)) { console.warn('[ShopifyHold] webhook HMAC mismatch → 401 (does SHOPIFY_WEBHOOK_SECRET match the Shopify Webhooks signing secret?)'); return res.status(401).json({ error: 'invalid hmac' }); }
    const o = req.body || {};
    const orderName = o.name || String(o.order_number || o.id);
    console.log(`[ShopifyHold] webhook received: ${orderName} (financial_status=${o.financial_status || '—'})`);
    res.json({ ok: true });   // ack immediately
    setImmediate(async () => {
        try {
            // Real-time dashboard feed — write the order to `orders` (+ line items + address) so it shows
            // on Support Orders / Call Queue immediately, without waiting ~30 min for the external sync.
            const { upsertShopifyOrder } = require('./orders_ingest');
            const ing = await upsertShopifyOrder(o);
            if (!ing.ok) console.warn(`[OrderSync] ${orderName}: dashboard upsert failed — ${ing.error}`);
            // Auto-hold repeat COD orders.
            const phone = (o.shipping_address && o.shipping_address.phone) || (o.customer && o.customer.phone) || o.phone || null;
            const shopifyHold = require('./shopify_hold');
            const reasons = await shopifyHold.holdReasons({ phone, financialStatus: o.financial_status, createdAt: o.created_at, shopifyOrderId: o.id, totalPrice: o.total_price });
            if (!reasons.length) { console.log(`[ShopifyHold] ${orderName}: not a repeat-COD candidate → no hold`); return; }
            const r = await shopifyHold.autoHoldOrder(orderName, o.id, shopifyHold.reasonNoteFrom(reasons));
            console.log(`[ShopifyHold] ${orderName}: ${r.held ? 'HELD on Shopify ✓' : r.skipped ? 'skipped (' + r.skipped + ')' : 'hold FAILED (' + r.failed + ')'}`);
        } catch (e) { console.error('[ShopifyHold] webhook error:', e.message); }
    });
});

module.exports = router;
