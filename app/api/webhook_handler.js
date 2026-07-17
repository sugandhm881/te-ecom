const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const { rawToDbRow } = require('./easyecom');
const { parseRapidshypJourney, parseDocpharmaJourney, saveJourney, updateJourneyForOrder } = require('./delivery_journey');
const { syncDocpharmaOrderFromPortal } = require('./docpharma_portal');
const config = require('../../config');

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

module.exports = router;
