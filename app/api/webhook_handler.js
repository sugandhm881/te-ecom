const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const { rawToDbRow } = require('./easyecom');
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

module.exports = router;
