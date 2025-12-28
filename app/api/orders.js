const express = require('express');
const router = express.Router();
const moment = require('moment-timezone');
const helpers = require('./helpers');
const { fetchAmazonOrders } = require('./amazon');
const config = require('../../config');
const fs = require('fs-extra');
const path = require('path');
const ORDER_CACHE_FILE = path.resolve(config.CACHE_DIR, 'order_shipment_cache.json');
const AWB_CACHE_FILE = path.resolve(config.CACHE_DIR, 'awb_assignment_cache.json');
const TRACKING_CACHE_FILE = path.resolve(config.CACHE_DIR, 'rapidshyp_cache.json');

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
        // Force conversion to IST (Asia/Kolkata)
        date: moment(order.created_at).tz('Asia/Kolkata').format('DD-MM-YYYY'),
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
        const thirtyDaysAgo = moment().subtract(30, 'days').toISOString();
        const params = {
            'status': 'any',
            'limit': 250,
            'created_at_min': thirtyDaysAgo,
            'fields': 'id,name,created_at,total_price,financial_status,fulfillment_status,cancelled_at,shipping_address,line_items,tags,refunds,fulfillments,location_id'
        };

        const [shopifyRaw, amazonOrders] = await Promise.all([
            helpers.getAllShopifyOrdersPaginated(params),
            fetchAmazonOrders()
        ]);

                    const shopifyOrders = shopifyRaw.map(o => {
                const norm = normalizeShopifyOrder(o);
                // --- FORCE ATTACH SHIPPING ADDRESS ---
                norm.shipping_address = o.shipping_address; 
                norm.line_items = o.line_items; // Ensure products are also attached
                return norm;
            });
        let allOrders = [...shopifyOrders, ...amazonOrders].sort((a, b) => new Date(b.date) - new Date(a.date));

        // --- LOAD ALL CACHES ---
        let shipmentCache = {};
        let awbCache = {};
        let trackingCache = {}; // New Cache
        try {
            if (fs.existsSync(ORDER_CACHE_FILE)) shipmentCache = fs.readJsonSync(ORDER_CACHE_FILE);
            if (fs.existsSync(AWB_CACHE_FILE)) awbCache = fs.readJsonSync(AWB_CACHE_FILE);
            if (fs.existsSync(TRACKING_CACHE_FILE)) trackingCache = fs.readJsonSync(TRACKING_CACHE_FILE);
        } catch (e) {}

        // --- ENRICH STATUS ---
        allOrders = allOrders.map(order => {
            // 1. Basic IDs
            const shipmentId = shipmentCache[String(order.originalId)];
            const awbData = shipmentId ? awbCache[String(shipmentId)] : null;
            const awbNumber = awbData ? awbData.awb : order.awb; // Check cache first, then Shopify AWB

            order.shipmentId = shipmentId;
            order.awbData = awbData;

            // 2. Base Status (Internal Workflow)
            if (order.status === 'New' || order.status === 'Processing') {
                if (awbData && awbData.pickupScheduled) {
                    order.status = 'Shipped'; // Default if pickup is scheduled
                } else if (awbData && awbData.awb) {
                    order.status = 'Ready To Ship';
                } else if (shipmentId) {
                    order.status = 'Processing';
                } else {
                    order.status = 'New';
                }
            }

            // 3. TRACKING OVERRIDE (The New Layer)
            // If we have live tracking data for this AWB, it takes priority
            if (awbNumber && trackingCache[String(awbNumber)]) {
                const track = trackingCache[String(awbNumber)];
                const rawStatus = (track.raw_status || '').toUpperCase();

                if (rawStatus.includes('RTO') || rawStatus.includes('RETURN')) {
                    order.status = 'RTO';
                } else if (rawStatus === 'DELIVERED') {
                    order.status = 'Delivered';
                } else if (rawStatus === 'OUT_FOR_DELIVERY') {
                    order.status = 'Out For Delivery';
                } else if (rawStatus === 'IN_TRANSIT') {
                    order.status = 'In Transit';
                } else if (rawStatus === 'SHIPPED') {
                    order.status = 'Shipped';
                } else if (rawStatus === 'PICKUP_SCHEDULED' || rawStatus === 'PICKUP_GENERATED') {
                    order.status = 'Shipped'; // Treat as shipped/ready for transit
                }
            }

            return order;
        });

        res.json(allOrders);

    } catch (e) {
        console.error("CRITICAL ERROR in get-orders:", e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;