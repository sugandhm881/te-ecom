const express = require('express');
const router = express.Router();
const moment = require('moment-timezone');
const helpers = require('./helpers');
const { fetchAmazonOrders } = require('./amazon');
const config = require('../../config');

// --- 1. IMPORT DATABASE MODELS ---
const { Shipment, AWB, RapidShyp } = require('../../models/Schemas');

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

        // --- 2. FETCH ORDERS & DB CACHE IN PARALLEL ---
        // We run all queries at once to make it faster
        const [shopifyRaw, amazonOrders, shipmentDocs, awbDocs, trackingDocs] = await Promise.all([
            helpers.getAllShopifyOrdersPaginated(params),
            fetchAmazonOrders(),
            Shipment.find().lean(),    // Fetch all shipments
            AWB.find().lean(),         // Fetch all assignments
            RapidShyp.find().lean()    // Fetch all tracking logs
        ]);

        // --- 3. CONVERT DB ARRAYS TO OBJECT MAPS ---
        // This rebuilds the "Cache Object" structure your code expects
        // Format: { "ORDER_ID": { data } }
        
        const shipmentCache = {};
        shipmentDocs.forEach(doc => {
            // Use _id_key (from migration) as the lookup key
            if(doc._id_key) shipmentCache[String(doc._id_key)] = doc;
        });

        const awbCache = {};
        awbDocs.forEach(doc => {
            if(doc._id_key) awbCache[String(doc._id_key)] = doc;
        });

        const trackingCache = {};
        trackingDocs.forEach(doc => {
            if(doc._id_key) trackingCache[String(doc._id_key)] = doc;
        });

        // --- 4. PROCESS ORDERS (EXISTING LOGIC) ---
        
        const shopifyOrders = shopifyRaw.map(o => {
            const norm = normalizeShopifyOrder(o);
            norm.shipping_address = o.shipping_address; 
            norm.line_items = o.line_items;
            return norm;
        });

        let allOrders = [...shopifyOrders, ...amazonOrders].sort((a, b) => new Date(b.date) - new Date(a.date));

        // --- ENRICH STATUS ---
        allOrders = allOrders.map(order => {
            // 1. Basic IDs
            // Note: If shipmentCache[id] is an object (from DB), we try to use it.
            // If your original cache was Key->String, check if doc.shipmentId exists, else use doc itself or check your Compass data.
            let shipmentData = shipmentCache[String(order.originalId)];
            
            // Adjust this based on your DB data structure:
            // If shipmentData is an object, we use its ID. If it's the ID itself, we use it.
            let shipmentId = shipmentData ? (shipmentData.shipmentId || shipmentData.value || shipmentData._id_key) : null; 
            
            // Fallback: If migration saved the string as the object key, it might just be the object itself.
            // You might need to console.log(shipmentData) to see exactly how migration saved it.

            const awbData = shipmentId ? awbCache[String(shipmentId)] : null;
            const awbNumber = awbData ? awbData.awb : order.awb; 

            order.shipmentId = shipmentId;
            order.awbData = awbData;

            // 2. Base Status (Internal Workflow)
            if (order.status === 'New' || order.status === 'Processing') {
                if (awbData && awbData.pickupScheduled) {
                    order.status = 'Shipped'; 
                } else if (awbData && awbData.awb) {
                    order.status = 'Ready To Ship';
                } else if (shipmentId) {
                    order.status = 'Processing';
                } else {
                    order.status = 'New';
                }
            }

            // 3. TRACKING OVERRIDE
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
                    order.status = 'Shipped'; 
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