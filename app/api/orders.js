const express = require('express');
const router = express.Router();
const moment = require('moment-timezone');
const { supabase } = require('../supabase');
const shopifyHold = require('./shopify_hold');

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
        courier: order.courier_name || null,
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
        // Date-aware window (default 30d, clamp 1–90). The table is capped for performance; the KPI
        // cards get ACCURATE full-window counts from cheap count queries below, so 7-day and 30-day
        // views show genuinely different numbers even when the table itself is truncated.
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
        const since = moment().subtract(days, 'days').toISOString();
        // Keep the TABLE light for a snappy render (KPI cards use the accurate full-window counts below,
        // so the table cap doesn't affect the headline numbers). 500 recent rows renders smoothly.
        const TABLE_LIMIT = 500;
        const K = () => supabase.from('orders').select('*', { count: 'exact', head: true }).gte('created_at', since);

        // ── 1. FETCH ALL DATA IN PARALLEL ──────────────────
        // (Amazon orders removed 2026-07; EasyEcom-only orders removed 2026-07-17 — the Orders
        //  dashboard lists Shopify orders only. EasyEcom data is still fetched, but purely to map
        //  easyecomOrderId/status onto Shopify rows for the hold/unhold feature.)
        const [
            shopifyRes,
            shipmentRows,
            awbRows,
            trackingRows,
            easyecomRows,
            holdMarkRows,
            dpRejectedRows,
            routedMarkRows,
            cntTotal, cntDelivered, cntCancelled, cntNew,
            heldEeRows
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
                .gte('created_at', since)
                .order('created_at', { ascending: false })
                .limit(TABLE_LIMIT),

            // Supabase workflow caches (replaces MongoDB)
            supabase.from('shipment_cache_ecom').select('order_id, shipment_id'),
            supabase.from('awb_cache_ecom').select('*'),
            supabase.from('rapidshyp_tracking_ecom').select('awb, raw_status'),

            // EasyEcom rows — MAPPING ONLY (easyecomOrderId/status onto Shopify orders, for the
            // hold/unhold feature + hold-mark reconciliation). EasyEcom-only orders (Flipkart etc.)
            // are NOT listed on the Orders dashboard (removed 2026-07-17 per user).
            supabase
                .from('b2c_order_easycom')
                .select('order_id, reference_code, store_order_id, marketplace_order_id, order_status, location, awb_number, updated_at, fetched_at')
                .gte('order_date', since)
                .order('order_date', { ascending: false })
                .limit(3000),

            // Live EasyEcom-hold marks (set/cleared by /easyecom/hold-order|unhold-order) — the
            // dashboard shows On-Hold instantly, without waiting for EasyEcom's own status to sync.
            supabase.from('order_marks_ecom').select('order_name, note, created_by, created_at').eq('mark_type', 'ee_hold'),

            // DocPharma-rejected orders (the dp-to-mwh detection) → tag + red colour on the dashboard.
            supabase.from('dp_rejected_handled_ecom').select('order_name, routed_at'),

            // Warehouse-routed marks (set on a successful warehouse move) → "Moved: from → to" + disable button.
            supabase.from('order_marks_ecom').select('order_name, note, created_at').eq('mark_type', 'warehouse_routed'),

            // ── Accurate KPI counts over the FULL window (cheap head-only counts; classification by the
            //    synced tracking_status, matching the dashboard's status buckets closely) ──
            K(),                                                                                        // total
            K().ilike('tracking_status', 'delivered'),                                                 // delivered (exact — excludes 'RTO Delivered')
            K().or('cancelled_at.not.is.null,tracking_status.ilike.%rto%,tracking_status.ilike.cancelled,tracking_status.ilike.lost'), // cancelled / RTO
            K().is('tracking_status', null).is('cancelled_at', null),                                   // new / processing (no tracking yet)

            // Authoritative held-orders list (EasyEcom order_status "On Hold") — a small dedicated query
            // so it's COMPLETE (the main easyecomRows above is capped and can miss older held orders).
            supabase.from('b2c_order_easycom').select('reference_code, store_order_id').ilike('order_status', '%hold%').gte('order_date', since).limit(1000)
        ]);
        // In-transit = everything else (has tracking, moving forward, not delivered/RTO/new).
        const kTotal = cntTotal.count || 0, kDelivered = cntDelivered.count || 0, kCancelled = cntCancelled.count || 0, kNew = cntNew.count || 0;
        const kpis = {
            total: kTotal, delivered: kDelivered, cancelled: kCancelled, newProcessing: kNew,
            inTransit: Math.max(0, kTotal - kDelivered - kCancelled - kNew),
        };

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
                    easyecomStatus:  row.order_status || '',
                    shipPlatform:    row.location || ''      // 'rapidshyp' | 'docpharma' | warehouse name
                };
            });
        });

        // DocPharma-rejected + warehouse-routed lookup maps (keyed by normalized order name).
        const normKey = n => String(n || '').replace('#', '').trim();
        const dpRejectedMap = {};
        (dpRejectedRows.data || []).forEach(r => { dpRejectedMap[normKey(r.order_name)] = { routed: !!r.routed_at }; });
        const routedMap = {};
        (routedMarkRows.data || []).forEach(r => { routedMap[normKey(r.order_name)] = { change: r.note || '', at: r.created_at }; });

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

        // ── 3. NORMALIZE ORDERS — Shopify only ──────────────
        const shopifyOrders = (shopifyRes.data || []).map(normalizeSupabaseOrder);

        // Held orders need action, so they must ALWAYS be visible (Hold filter) — even if they fell
        // outside the 500-row table cap. Pull in any held order (local mark OR EasyEcom "On Hold") that
        // isn't already loaded.
        const heldNames = new Set();
        (holdMarkRows.data || []).forEach(m => heldNames.add(normKey(m.order_name)));
        (heldEeRows.data || []).forEach(r => [r.reference_code, r.store_order_id].filter(Boolean).forEach(x => heldNames.add(normKey(x))));
        const loadedNames = new Set(shopifyOrders.map(o => normKey(o.id)));
        const missingHeld = [...heldNames].filter(n => n && !loadedNames.has(n));
        if (missingHeld.length) {
            const variants = missingHeld.flatMap(n => [n, '#' + n]);
            const { data: extra } = await supabase.from('orders').select(`
                id, order_number, name, created_at, financial_status,
                fulfillment_status, total_price, cancelled_at, tags,
                awb_number, courier_name, tracking_status,
                order_line_items(id, title, name, sku, quantity, price, total_discount, tax_total),
                order_shipping_addresses(first_name, last_name, name, address1, address2, city, province, zip, phone)
            `).in('name', variants).limit(300);
            (extra || []).forEach(o => shopifyOrders.push(normalizeSupabaseOrder(o)));
        }

        // Map EasyEcom ID/status/platform + DocPharma-rejected + warehouse-routed onto matching Shopify orders.
        shopifyOrders.forEach(o => {
            const ecMatch = easyecomMap[String(o.id)]
                         || easyecomMap[String(o.id).replace('#', '')]
                         || easyecomMap[String(o.originalId)]
                         || null;
            if (ecMatch) {
                o.easyecomOrderId = ecMatch.easyecomOrderId;
                o.easyecomStatus  = ecMatch.easyecomStatus;
                o.shipPlatform    = ecMatch.shipPlatform;    // 'rapidshyp' | 'docpharma' | warehouse name
            }
            const nk = String(o.id).replace('#', '').trim();
            if (dpRejectedMap[nk]) { o.docpharmaRejected = true; o.dpRejectHandled = dpRejectedMap[nk].routed; }  // rejected; handled = auto-route already moved/verified it
            if (routedMap[nk]) o.warehouseChange = routedMap[nk];      // { change:'From → To', at } — a logged move
        });

        console.log(`[get-orders] Shopify: ${shopifyOrders.length} (EasyEcom-only orders are not listed)`);

        let allOrders = [...shopifyOrders]
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

        // Live EasyEcom-hold state by order name (without '#'). An order can be held any time BEFORE the
        // courier picks it up — even a Ready-To-Ship order that already has an AWB. So a hold mark is stale
        // (auto-cleared) ONLY once the order is genuinely PICKED UP / moving, decided from its REAL tracking
        // status in the enrich loop below (NOT the AWB and NOT EasyEcom's order_status, neither of which
        // reflects hold — parsing those wrongly wiped every active hold on each sync).
        const holdByName = {};
        (holdMarkRows.data || []).forEach(m => {
            holdByName[m.order_name] = { reason: m.note || '', by: m.created_by || null, at: m.created_at || null };
        });
        const staleMarks = [];
        // Shopify fulfillment holds (upstream of EasyEcom) — baked in too so the Orders dashboard shows a
        // hold chip / filters them, same as EE holds. Never shows a Shopify-held order as if it's normal.
        const shopHoldByName = {};
        const { data: shopHoldRows } = await supabase.from('order_marks_ecom').select('order_name, note, created_by, created_at').eq('mark_type', 'shopify_hold');
        (shopHoldRows || []).forEach(m => { shopHoldByName[m.order_name] = { reason: m.note || '', by: m.created_by || null, at: m.created_at || null }; });

        // ── 4. ENRICH WITH SUPABASE WORKFLOW CACHE ──────────
        allOrders = allOrders.map(order => {
            const shipmentData = shipmentCache[String(order.originalId)];
            const shipmentId = shipmentData ? shipmentData.shipment_id : null;

            const awbData  = shipmentId ? awbCache[String(shipmentId)] : null;
            const awbNumber = awbData ? awbData.awb : order.awb;

            order.shipmentId = shipmentId;
            order.awbData    = awbData;
            // Courier name for the dashboard: prefer the Shopify `courier_name`; fall back to the AWB cache.
            if (!order.courier && awbData && awbData.courier) order.courier = awbData.courier;

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

            // "Picked up" = the courier has actually scanned/moved it (real tracking), NOT merely
            // AWB-assigned / Shopify-fulfilled (which we map to 'Shipped' but is still holdable before
            // pickup). Decide purely from tracking signals; pre-pickup states (AWB generated, pickup
            // scheduled/generated, manifested, out-for-pickup, plain "shipped") stay holdable.
            const rawTs = String(order.tracking_status || '').toUpperCase();
            const cacheRaw = (awbNumber && trackingCache[String(awbNumber)]) ? String(trackingCache[String(awbNumber)].raw_status || '').toUpperCase() : '';
            const MOVE_RE = /IN.?TRANSIT|OUT.?FOR.?DELIVERY|DELIVERED|\bRTO\b|RETURN|REACHED|UNDELIVERED|PICKUP.?COMPLETED|\bLOST\b/;
            const pickedUp = MOVE_RE.test(rawTs) || MOVE_RE.test(cacheRaw) || order.status === 'Cancelled';

            // EasyEcom REJECTS a hold once the shipment is MANIFESTED (manifest / handover generated),
            // so the ⏸ Hold button must disappear at that point — not only after physical pickup.
            // Manifested-or-later = pickup scheduled, our status advanced to Shipped/In-Transit/OFD/
            // Delivered/RTO, or EasyEcom's own status literally says manifested/shipped. Pre-manifest
            // (New / Processing / Ready-To-Ship: AWB may be printed but pickup not yet scheduled) stays holdable.
            const eeStatusU = String(order.easyecomStatus || '').toUpperCase();
            const manifestedOrLater = pickedUp
                || ['Shipped', 'In Transit', 'Out For Delivery', 'Delivered', 'RTO'].includes(order.status)
                || /MANIFEST|SHIPPED/.test(eeStatusU)
                || !!(awbData && awbData.pickup_scheduled);
            order.holdable = !manifestedOrLater;   // frontend uses this to show/hide the ⏸ Hold button

            // Detect hold from EITHER source: (a) EasyEcom's synced order_status literally says "On Hold"
            // (authoritative — covers orders held directly in the EasyEcom panel), or (b) our local ee_hold
            // mark (held via our Hold button, before EasyEcom syncs). This is why holds weren't showing —
            // the filter only saw local marks, missing EasyEcom-side holds.
            const _hk = String(order.id || '').replace('#', '').trim();
            const heldInEE = /hold/i.test(order.easyecomStatus || '') || heldNames.has(_hk);   // authoritative held set
            const _mark = holdByName[_hk];
            if (heldInEE) {
                order.eeHold = _mark || { reason: 'Held in EasyEcom', by: null, at: null };
            } else if (_mark) {
                if (pickedUp) staleMarks.push(_hk);   // held via our button but now picked up → drop stale mark
                else order.eeHold = _mark;            // still holdable → show as ON HOLD
            }
            if (shopHoldByName[_hk]) order.shopifyHold = shopHoldByName[_hk];   // Shopify fulfillment hold

            return order;
        });

        // Clear hold marks for orders that have been picked up (no longer holdable).
        if (staleMarks.length) {
            supabase.from('order_marks_ecom').delete().in('order_name', staleMarks).eq('mark_type', 'ee_hold')
                .then(() => console.log(`[get-orders] auto-cleared ${staleMarks.length} picked-up hold mark(s)`))
                .catch(() => {});
        }

        // Object response: orders (capped table) + accurate full-window KPI counts + meta.
        // (Older callers that expected a bare array are handled by the frontend unwrapper.)
        res.json({ orders: allOrders, kpis, total: kpis.total, shown: allOrders.length, truncated: kpis.total > allOrders.length, days });

    } catch (e) {
        console.error('CRITICAL ERROR in get-orders:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── Live EasyEcom-hold marks — shared by EVERY dashboard's ⏸ HOLD indicator ──────────
// (Orders bakes them into /get-orders; Ops Control / Delivery Perf / Claims / Customer
//  Support fetch this endpoint and decorate rows client-side, so hold status is always
//  fresh even where responses are cached.) Any authenticated user may read it.
router.get('/ee-hold-marks', async (req, res) => {
    // Held = our local ee_hold mark OR EasyEcom's synced order_status "On Hold" (held directly in the
    // panel) OR a Shopify fulfillment hold (shopify_hold mark). Merge all three, each tagged with
    // hold_type ('ee' | 'shopify' | 'both'), so the HOLD chip shows on EVERY dashboard for any hold —
    // no dashboard ever shows a held order as if it's actionable.
    const sinceHold = moment().subtract(60, 'days').toISOString();
    const [markRes, shopRes, eeRes] = await Promise.all([
        supabase.from('order_marks_ecom').select('order_name, note, created_by, created_at').eq('mark_type', 'ee_hold'),
        supabase.from('order_marks_ecom').select('order_name, note, created_by, created_at').eq('mark_type', 'shopify_hold'),
        supabase.from('b2c_order_easycom').select('reference_code, store_order_id, awb_number, order_status').ilike('order_status', '%hold%').gte('order_date', sinceHold).limit(2000),
    ]);
    if (markRes.error) return res.status(500).json({ success: false, error: markRes.error.message });
    const nk = n => String(n || '').replace('#', '').trim();
    const map = {};
    // EasyEcom holds (local mark + synced "On Hold") → type 'ee'.
    (markRes.data || []).forEach(m => { const k = nk(m.order_name); if (k) map[k] = { order_name: k, hold_type: 'ee', note: m.note, created_by: m.created_by, created_at: m.created_at }; });
    (eeRes.data || []).forEach(r => { const k = nk(r.reference_code || r.store_order_id); if (k && !map[k]) map[k] = { order_name: k, hold_type: 'ee', note: 'Held in EasyEcom', created_by: null, created_at: null }; });
    // Shopify holds → type 'shopify' (or 'both' if also held in EasyEcom).
    (shopRes.data || []).forEach(m => { const k = nk(m.order_name); if (!k) return;
        if (map[k]) map[k].hold_type = 'both';
        else map[k] = { order_name: k, hold_type: 'shopify', note: m.note, created_by: m.created_by, created_at: m.created_at }; });
    res.json({ success: true, marks: Object.values(map) });
});

// ── Shopify fulfillment hold / release — SHARED (available from any dashboard, like the EasyEcom hold).
// Separate from the EasyEcom hold so each system is controlled independently. Takes the order NAME
// ("TE25-…"); resolves the Shopify numeric order id from the `orders` table (or accepts orderId directly).
async function resolveShopifyOrderId(orderName, orderId) {
    if (orderId && /^\d+$/.test(String(orderId))) return String(orderId);
    const clean = String(orderName || '').replace('#', '').trim();
    if (!clean) return null;
    const { data } = await supabase.from('orders').select('id, name').ilike('name', '%' + clean).limit(1).maybeSingle();
    return data ? String(data.id) : null;
}
router.post('/shopify-hold', async (req, res) => {
    try {
        const { orderName, orderId, reason } = req.body || {};
        if (!orderName) return res.status(400).json({ success: false, message: 'orderName is required.' });
        const sid = await resolveShopifyOrderId(orderName, orderId);
        if (!sid) return res.status(404).json({ success: false, message: `Shopify order not found for ${orderName}.` });
        const out = await shopifyHold.holdOrderManual(orderName, sid, req.user && req.user.sub, reason);
        if (!out.ok) return res.status(502).json({ success: false, message: out.error || 'Hold failed.' });
        res.json({ success: true, status: 'held' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
router.post('/shopify-unhold', async (req, res) => {
    try {
        const { orderName, orderId } = req.body || {};
        if (!orderName) return res.status(400).json({ success: false, message: 'orderName is required.' });
        const sid = await resolveShopifyOrderId(orderName, orderId);
        if (!sid) return res.status(404).json({ success: false, message: `Shopify order not found for ${orderName}.` });
        const out = await shopifyHold.releaseOrder(orderName, sid, req.user && req.user.sub);
        if (!out.ok) return res.status(502).json({ success: false, message: out.error || 'Release failed.' });
        res.json({ success: true, status: 'released' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
