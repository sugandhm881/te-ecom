const express = require('express');
const router = express.Router();
const moment = require('moment-timezone');
const { supabase } = require('../supabase');
const { dbRowToDashboard } = require('./easyecom');

// ─────────────────────────────────────────────────────
// NORMALIZE: Supabase Shopify order → dashboard format
// ─────────────────────────────────────────────────────
function normalizeSupabaseOrder(order) {
    const addrArr = order.order_shipping_addresses || [];
    const addr = Array.isArray(addrArr) ? (addrArr[0] || {}) : addrArr;
    const lineItems = order.order_line_items || [];

    let status = (!order.fulfillment_status) ? 'New'
        : (order.fulfillment_status === 'fulfilled' ? 'Shipped' : 'Processing');
    if (order.cancelled_at) status = 'Cancelled';

    const awb = order.awb_number || null;
    if (awb && status === 'New') status = 'Processing';

    const customerName = addr.name ||
        `${addr.first_name || ''} ${addr.last_name || ''}`.trim() || 'N/A';

    const tags = (order.tags || '').toLowerCase();
    const isRapidShyp = !tags.includes('docpharma: in-progress');

    return {
        platform: 'Shopify',
        id: order.name,                   // "#1234"
        originalId: order.id,             // "5869437960411"
        date: moment(order.created_at).tz('Asia/Kolkata').format('DD-MM-YYYY'),
        timestamp: moment(order.created_at).valueOf(), // <-- ADD THIS LINE
        name: customerName,
        total: parseFloat(order.total_price || 0),
        status,
        items: lineItems.map(i => ({ name: i.title || i.name, sku: i.sku, qty: i.quantity })),
        address: `${addr.address1 || ''}, ${addr.city || ''}`.replace(/^, /, '') || 'No address',
        paymentMethod: order.financial_status === 'paid' ? 'Prepaid' : 'COD',
        awb,
        isRapidShyp,
        tags: order.tags,
        shipping_address: addr,
        line_items: lineItems
    };
}

// (Amazon-order normalization removed 2026-07 — the Orders dashboard no longer merges Amazon orders.)

// ─────────────────────────────────────────────────────
// ROUTE: GET /api/get-orders
// Serves from Supabase (fast) — no MongoDB
// ─────────────────────────────────────────────────────
router.get('/get-orders', async (req, res) => {
    try {
        const thirtyDaysAgo = moment().subtract(30, 'days').toISOString();

        // ── 1. FETCH ALL DATA IN PARALLEL ──────────────────
        // (Amazon orders removed 2026-07 — the Orders dashboard is Shopify/EasyEcom only now; Amazon
        //  has its own dashboards. Skipping that query + payload makes this endpoint noticeably faster.)
        const [
            shopifyRes,
            shipmentRows,
            awbRows,
            trackingRows,
            easyecomRows,
            holdMarkRows
        ] = await Promise.all([
            // Shopify orders from Supabase with embedded line items + shipping address
            supabase
                .from('orders')
                .select(`
                    id, order_number, name, created_at, financial_status,
                    fulfillment_status, total_price, cancelled_at, tags,
                    awb_number, courier_name, tracking_status,
                    order_line_items(id, title, name, sku, quantity, price, total_discount, tax_total),
                    order_shipping_addresses(first_name, last_name, name, address1, address2, city, province, zip, phone)
                `)
                .gte('created_at', thirtyDaysAgo)
                .order('created_at', { ascending: false })
                .limit(500),

            // Supabase workflow caches (replaces MongoDB)
            supabase.from('shipment_cache_ecom').select('order_id, shipment_id'),
            supabase.from('awb_cache_ecom').select('*'),
            supabase.from('rapidshyp_tracking_ecom').select('awb, raw_status'),

            // EasyEcom orders — full rows for dashboard + mapping
            supabase
                .from('b2c_order_easycom')
                .select('*')
                .gte('order_date', thirtyDaysAgo)
                .order('order_date', { ascending: false })
                .limit(1000),

            // Live EasyEcom-hold marks (set/cleared by /easyecom/hold-order|unhold-order) — the
            // dashboard shows On-Hold instantly, without waiting for EasyEcom's own status to sync.
            supabase.from('order_marks_ecom').select('order_name, note, created_by, created_at').eq('mark_type', 'ee_hold')
        ]);

        if (shopifyRes.error) {
            console.error('[Supabase] orders error:', shopifyRes.error.message);
        }
        if (easyecomRows.error) {
            console.error('[Supabase] b2c_order_easycom error:', easyecomRows.error.message);
        }

        // ── 2. BUILD CACHE MAPS ────────────────────────────

        // EasyEcom map: key by reference_code / store_order_id (= Shopify order name like "TE25-21532")
        // value = { easyecom order_id (numeric), order_status }
        const easyecomMap = {};
        (easyecomRows.data || []).forEach(row => {
            const keys = [row.reference_code, row.store_order_id, row.marketplace_order_id].filter(Boolean);
            keys.forEach(k => {
                easyecomMap[String(k).trim()] = {
                    easyecomOrderId: String(row.order_id),
                    easyecomStatus:  row.order_status || ''
                };
            });
        });

        const shipmentCache = {};
        (shipmentRows.data || []).forEach(row => {
            if (row.order_id) shipmentCache[String(row.order_id)] = row;
        });

        const awbCache = {};
        (awbRows.data || []).forEach(row => {
            if (row.shipment_id) awbCache[String(row.shipment_id)] = row;
        });

        const trackingCache = {};
        (trackingRows.data || []).forEach(row => {
            if (row.awb) trackingCache[String(row.awb)] = row;
        });

        // ── 3. NORMALIZE ORDERS ─────────────────────────────
        const shopifyOrders  = (shopifyRes.data || []).map(normalizeSupabaseOrder);
        const easyecomOrders = (easyecomRows.data || []).map(dbRowToDashboard);

        // Merge: Start with Shopify, then add EasyEcom-only orders
        // (orders in EasyEcom that don't exist in Shopify by order name)
        const shopifyNameSet = new Set(shopifyOrders.map(o => String(o.id).trim()));

        // Also map EasyEcom ID onto matching Shopify orders
        shopifyOrders.forEach(o => {
            const ecMatch = easyecomMap[String(o.id)]
                         || easyecomMap[String(o.id).replace('#', '')]
                         || easyecomMap[String(o.originalId)]
                         || null;
            if (ecMatch) {
                o.easyecomOrderId = ecMatch.easyecomOrderId;
                o.easyecomStatus  = ecMatch.easyecomStatus;
            }
        });

        // EasyEcom-only orders = those whose display ID is NOT in Shopify
        // Shopify names have "#" prefix (e.g. "#TE25-22042"), EasyEcom reference_code doesn't
        const easyecomOnly = easyecomOrders.filter(o => {
            const ecId = String(o.id).trim();
            return !shopifyNameSet.has(ecId) && !shopifyNameSet.has('#' + ecId);
        });

        console.log(`[get-orders] Shopify: ${shopifyOrders.length}, EasyEcom-only: ${easyecomOnly.length} (total EC: ${easyecomOrders.length})`);

        let allOrders = [...shopifyOrders, ...easyecomOnly]
            .sort((a, b) => {
                // Priority: Use the exact millisecond timestamp we added
                if (a.timestamp && b.timestamp) {
                    return b.timestamp - a.timestamp;
                }

                // Fallback: Parse DD-MM-YYYY format for sorting (if timestamp is missing)
                const parseDate = d => {
                    if (!d) return 0;
                    const parts = d.split('-');
                    if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime();
                    return new Date(d).getTime();
                };
                
                return parseDate(b.date) - parseDate(a.date);
            });

        // Live EasyEcom-hold state by order name (without '#') — RECONCILED against the synced EasyEcom
        // status: if EasyEcom's row was refreshed AFTER we set the mark and no longer says "On Hold"
        // (e.g. someone released it inside the EasyEcom panel), the mark is stale → auto-clear it.
        const eeStatusByName = {};
        (easyecomRows.data || []).forEach(row => {
            [row.reference_code, row.store_order_id, row.marketplace_order_id].filter(Boolean).forEach(k => {
                eeStatusByName[String(k).trim()] = { status: row.order_status || '', syncedAt: row.updated_at || row.fetched_at || null };
            });
        });
        const holdByName = {}, staleMarks = [];
        (holdMarkRows.data || []).forEach(m => {
            const ee = eeStatusByName[m.order_name];
            if (ee && ee.syncedAt && m.created_at && new Date(ee.syncedAt) > new Date(m.created_at) && !/hold/i.test(ee.status)) {
                staleMarks.push(m.order_name);   // unheld directly in EasyEcom → drop the mark
                return;
            }
            holdByName[m.order_name] = { reason: m.note || '', by: m.created_by || null, at: m.created_at || null };
        });
        if (staleMarks.length) {
            supabase.from('order_marks_ecom').delete().in('order_name', staleMarks).eq('mark_type', 'ee_hold')
                .then(() => console.log(`[get-orders] auto-cleared ${staleMarks.length} stale hold mark(s): ${staleMarks.join(', ')}`))
                .catch(() => {});
        }

        // ── 4. ENRICH WITH SUPABASE WORKFLOW CACHE ──────────
        allOrders = allOrders.map(order => {
            const eeHold = holdByName[String(order.id || '').replace('#', '').trim()];
            if (eeHold) order.eeHold = eeHold;
            const shipmentData = shipmentCache[String(order.originalId)];
            const shipmentId = shipmentData ? shipmentData.shipment_id : null;

            const awbData  = shipmentId ? awbCache[String(shipmentId)] : null;
            const awbNumber = awbData ? awbData.awb : order.awb;

            order.shipmentId = shipmentId;
            order.awbData    = awbData;

            // Status from cache (overrides Supabase if more recent workflow state)
            if (order.status === 'New' || order.status === 'Processing') {
                if (awbData && awbData.pickup_scheduled) {
                    order.status = 'Shipped';
                } else if (awbData && awbData.awb) {
                    order.status = 'Ready To Ship';
                } else if (shipmentId) {
                    order.status = 'Processing';
                }
            }

            // Tracking status override from RapidShyp cache
            if (awbNumber && trackingCache[String(awbNumber)]) {
                const track = trackingCache[String(awbNumber)];
                const rawStatus = (track.raw_status || '').toUpperCase();

                if      (rawStatus.includes('RTO') || rawStatus.includes('RETURN')) order.status = 'RTO';
                else if (rawStatus === 'DELIVERED')                                  order.status = 'Delivered';
                else if (rawStatus === 'OUT_FOR_DELIVERY')                           order.status = 'Out For Delivery';
                else if (rawStatus === 'IN_TRANSIT')                                 order.status = 'In Transit';
                else if (rawStatus === 'SHIPPED')                                    order.status = 'Shipped';
                else if (['PICKUP_SCHEDULED', 'PICKUP_GENERATED'].includes(rawStatus)) order.status = 'Shipped';
            }

            // Also use Supabase tracking_status if no cache entry
            if (!awbNumber && order.tracking_status) {
                const ts = (order.tracking_status || '').toUpperCase();
                if      (ts.includes('RTO') || ts.includes('RETURN')) order.status = 'RTO';
                else if (ts === 'DELIVERED')                           order.status = 'Delivered';
                else if (ts === 'OUT_FOR_DELIVERY')                    order.status = 'Out For Delivery';
                else if (ts === 'IN_TRANSIT')                          order.status = 'In Transit';
                else if (ts === 'SHIPPED')                             order.status = 'Shipped';
            }

            return order;
        });

        res.json(allOrders);

    } catch (e) {
        console.error('CRITICAL ERROR in get-orders:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
