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
                .or(`name.eq.${cleanId},name.eq.#${cleanId}`)
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

module.exports = router;
