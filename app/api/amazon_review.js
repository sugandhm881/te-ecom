const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const { makeSignedApiRequest } = require('./helpers');
const config = require('../../config');

const MARKETPLACE_ID = config.MARKETPLACE_ID || 'A21TJRUUN4KGV';

// ─────────────────────────────────────────────────────
// POST /api/amazon/review-data
// Returns amazon orders + review request history for a date range
// Includes payment_method and order items (SKUs) from Supabase
// ─────────────────────────────────────────────────────
router.post('/review-data', async (req, res) => {
    const { date_from, date_to } = req.body;
    if (!date_from || !date_to) {
        return res.status(400).json({ success: false, error: 'date_from and date_to are required' });
    }

    try {
        const [ordersRes, requestsRes, skuRes] = await Promise.all([
            supabase
                .from('amazon_orders')
                .select(`
                    amazon_order_id,
                    purchase_date,
                    order_status,
                    payment_method,
                    buyer_name,
                    order_total_amount,
                    latest_delivery_date,
                    earliest_delivery_date,
                    amazon_order_items (
                        seller_sku,
                        asin,
                        title,
                        quantity_ordered
                    )
                `)
                .gte('purchase_date', date_from)
                .lte('purchase_date', date_to)
                .order('purchase_date', { ascending: false })
                .limit(1000),

            supabase
                .from('amazon_review_requests')
                .select('order_id, solicitation_status, attempted_at, response_code, response_body'),

            supabase
                .from('sku_master')
                .select('seller_sku, product_name, master_sku')
        ]);

        if (ordersRes.error) throw new Error('Orders fetch failed: ' + ordersRes.error.message);

        // Build SKU lookup map: seller_sku → { product_name, master_sku }
        const skuMap = {};
        (skuRes.data || []).forEach(s => { skuMap[s.seller_sku] = s; });

        // Enrich order items with product names from sku_master
        const orders = (ordersRes.data || []).map(o => ({
            ...o,
            order_items: (o.amazon_order_items || []).map(item => ({
                ...item,
                product_name: skuMap[item.seller_sku]?.product_name || null,
                master_sku:   skuMap[item.seller_sku]?.master_sku  || item.seller_sku
            }))
        }));

        return res.json({
            success: true,
            orders,
            requests: requestsRes.data || [],
            sku_map: skuMap
        });

    } catch (e) {
        console.error('[AmazonReview] review-data error:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────
// POST /api/amazon/review-send
// Calls Amazon Solicitations API for one order, saves result to Supabase
// ─────────────────────────────────────────────────────
router.post('/review-send', async (req, res) => {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, error: 'order_id is required' });

    const attemptedAt = new Date().toISOString();
    let responseCode = null;
    let responseBody = null;
    let success = false;

    try {
        const result = await makeSignedApiRequest({
            method: 'POST',
            path: `/solicitations/v1/orders/${order_id}/solicitations/productReviewAndSellerFeedback`,
            queryParams: { marketplaceIds: MARKETPLACE_ID },
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });

        responseCode = 201;
        responseBody = JSON.stringify(result || {});
        success = true;
        console.log(`[AmazonReview] ✅ Solicitation sent for ${order_id}`);

    } catch (e) {
        const status = e.response?.status || 500;
        const body = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        responseCode = status;
        responseBody = body;
        success = false;
        console.error(`[AmazonReview] ✗ Solicitation failed for ${order_id}: HTTP ${status}`);
    }

    // Save result to Supabase
    await supabase
        .from('amazon_review_requests')
        .upsert({
            order_id,
            solicitation_status: success ? 'sent' : 'failed',
            attempted_at: attemptedAt,
            response_code: responseCode,
            response_body: responseBody
        }, { onConflict: 'order_id' });

    return res.json({
        success,
        status: responseCode,
        body: responseBody
    });
});

module.exports = router;
