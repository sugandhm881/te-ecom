const express = require('express');
const router = express.Router();
const moment = require('moment-timezone');
const helpers = require('./helpers');
const { fetchAmazonOrders } = require('./amazon');
const config = require('../../config');

function normalizeShopifyOrder(order) {
    let status = (!order.fulfillment_status) ? "New" : (order.fulfillment_status === 'fulfilled' ? "Shipped" : "Processing");
    if (order.cancelled_at) status = "Cancelled";

    const fulfillments = order.fulfillments || [];
    const awb = fulfillments.find(f => f.tracking_number)?.tracking_number || null;
    
    if (awb && status === "New") status = "Processing";

    const refunds = (order.refunds || []).reduce((acc, r) => {
        return acc + (r.transactions || []).filter(t => t.kind === 'refund' && t.status === 'success')
            .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
    }, 0);

    const netTotal = parseFloat(order.total_price || 0) - refunds;
    const addr = order.shipping_address || {};
    const customerName = `${addr.first_name || ''} ${addr.last_name || ''}`.trim() || 'N/A';
    
    const tags = (order.tags || '').toLowerCase();
    const isRapidShyp = !tags.includes('docpharma: in-progress');

    return {
        platform: "Shopify",
        id: order.name,
        originalId: order.id,
        date: moment(order.created_at).format('YYYY-MM-DD'),
        name: customerName,
        total: netTotal,
        status: status,
        items: (order.line_items || []).map(i => ({ name: i.name, sku: i.sku, qty: i.quantity })),
        address: `${addr.address1 || ''}, ${addr.city || ''}`.replace(/^, /, '') || 'No address',
        paymentMethod: order.financial_status === 'paid' ? 'Prepaid' : 'COD',
        awb: awb,
        isRapidShyp: isRapidShyp,
        tags: order.tags
    };
}

router.get('/get-orders', async (req, res) => {
    try {
        // Auth check (Simplified for brevity, add real middleware as needed)
        // const authHeader = req.headers['x-access-token']; 

        const thirtyDaysAgo = moment().subtract(30, 'days').toISOString();

        const params = {
            'status': 'any',
            'limit': 250,
            'created_at_min': thirtyDaysAgo,
            'fields': 'id,name,created_at,total_price,financial_status,fulfillment_status,cancelled_at,shipping_address,line_items,tags,refunds,fulfillments,location_id'
        };

        console.log("\n[Orders Endpoint] Fetching Shopify orders (Last 30 Days)...");
        
        const [shopifyRaw, amazonOrders] = await Promise.all([
            helpers.getAllShopifyOrdersPaginated(params),
            fetchAmazonOrders()
        ]);

        const shopifyOrders = shopifyRaw.map(normalizeShopifyOrder);
        const allOrders = [...shopifyOrders, ...amazonOrders].sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json(allOrders);
    } catch (e) {
        console.error("CRITICAL ERROR in get-orders:", e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;