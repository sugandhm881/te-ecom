const express = require('express');
const router = express.Router();
const moment = require('moment-timezone');
const { supabase } = require('../supabase');
const shopifyHold = require('./shopify_hold');

// Paginated fetch — Supabase caps EVERY response at 1000 rows, so a bare select (or .limit(3000))
// silently returns only the first 1000. `build(from, to)` must return the query with .range applied;
// resolves to the same { data, error } shape as a single query so consumers don't change.
async function fetchPaged(build, maxRows = 20000) {
    const all = [];
    for (let ofs = 0; ofs < maxRows; ofs += 1000) {
        const { data, error } = await build(ofs, Math.min(ofs + 999, maxRows - 1));
        if (error) return { data: all, error };
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return { data: all, error: null };
}

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
    // Influencer shipments carry the "Influencer" tag, an INFLUENCER company line, and an "(Influencer)"
    // suffix on the recipient name (the name is what actually prints on the label + invoice).
    const isInfluencer = tags.includes('influencer')
        || String(addr.company || '').toLowerCase().includes('influencer')
        || String(customerName || '').toLowerCase().includes('influencer');

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
        tracking_status: order.tracking_status || null,   // needed by the enrich loop's status derivation (was dropped → delivered/RTO stayed 'Shipped')
        isRapidShyp,
        tags: order.tags,
        customerType: isInfluencer ? 'Influencer' : 'Regular',
        isInfluencer,
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
        // Prefer an EXACT [from,to] window (so the KPI counts match the calendar range the user picked,
        // e.g. "Yesterday" = just yesterday, not a rolling 48h). Falls back to the rolling `days` window.
        const rangeFrom = req.query.from, rangeTo = req.query.to;
        const useRange = rangeFrom && rangeTo && moment(rangeFrom).isValid() && moment(rangeTo).isValid();
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
        const since = useRange ? moment(rangeFrom).toISOString() : moment().subtract(days, 'days').toISOString();
        const until = useRange ? moment(rangeTo).toISOString() : moment().add(1, 'day').toISOString();  // open-ended → no future orders exist, so effectively uncapped
        // Keep the TABLE light for a snappy render (KPI cards use the accurate full-window counts below,
        // so the table cap doesn't affect the headline numbers). 500 recent rows renders smoothly.
        const TABLE_LIMIT = 500;
        const K = () => supabase.from('orders').select('*', { count: 'exact', head: true }).gte('created_at', since).lte('created_at', until);

        // Status "bucket" for the TABLE query — so clicking a KPI card (e.g. Delivered / RTO) fetches THOSE
        // orders from the DB, not just filters the most-recent 500 (which are almost all New). Same
        // tracking_status conditions as the KPI count queries below, so the table matches the card's number.
        const bucket = String(req.query.bucket || '').toLowerCase();
        const applyBucket = q => {
            switch (bucket) {
                case 'new':       return q.is('tracking_status', null).is('cancelled_at', null);
                case 'delivered': return q.ilike('tracking_status', 'delivered');
                case 'rto':       return q.ilike('tracking_status', '%rto%');
                case 'cancelled': return q.or('cancelled_at.not.is.null,tracking_status.ilike.cancelled,tracking_status.ilike.lost').or('tracking_status.is.null,tracking_status.not.ilike.%rto%');
                case 'intransit': return q.not('tracking_status', 'is', null).not('tracking_status', 'ilike', 'delivered').not('tracking_status', 'ilike', '%rto%').not('tracking_status', 'ilike', 'cancelled').not('tracking_status', 'ilike', 'lost').is('cancelled_at', null);
                default:          return q;   // 'All' / unknown → no bucket
            }
        };

        // ── 1. FETCH ALL DATA IN PARALLEL ──────────────────
        // (Amazon orders removed 2026-07; EasyEcom-only orders removed 2026-07-17 — the Orders
        //  dashboard lists Shopify orders only. EasyEcom data is still fetched, but purely to map
        //  easyecomOrderId/status onto Shopify rows for the hold/unhold feature.)
        const [
            shopifyRes,
            shipmentRows,
            awbRows,
            easyecomRows,
            holdMarkRows,
            dpRejectedRows,
            routedMarkRows,
            cntTotal, cntDelivered, cntCancelled, cntRto, cntNew,
            heldEeRows
        ] = await Promise.all([
            // Shopify orders from Supabase with embedded line items + shipping address (bucket-filtered)
            applyBucket(supabase
                .from('orders')
                .select(`
                    id, order_number, name, created_at, financial_status,
                    fulfillment_status, total_price, cancelled_at, tags,
                    awb_number, courier_name, tracking_status,
                    order_line_items(id, title, name, sku, quantity, price, total_discount, tax_total),
                    order_shipping_addresses(first_name, last_name, name, address1, address2, city, province, zip, phone)
                `)
                .gte('created_at', since)
                .lte('created_at', until))
                .order('created_at', { ascending: false })
                .limit(TABLE_LIMIT),

            // Supabase workflow caches (replaces MongoDB) — paginated: these tables grow forever and a
            // bare select silently truncates at 1000, losing shipment/AWB enrichment for older orders.
            fetchPaged((f, t) => supabase.from('shipment_cache_ecom').select('order_id, shipment_id').order('order_id', { ascending: true }).range(f, t)),
            fetchPaged((f, t) => supabase.from('awb_cache_ecom').select('*').order('shipment_id', { ascending: true }).range(f, t)),   // keyed by shipment_id (no order_id column)
            // NOTE: rapidshyp_tracking_ecom is NO LONGER fetched whole here (it's 27k+ rows → ~2s).
            // It's fetched below, filtered to just the AWBs on this page. See "RapidShyp tracking".

            // EasyEcom rows — MAPPING ONLY (easyecomOrderId/status onto Shopify orders, for the
            // hold/unhold feature + hold-mark reconciliation). EasyEcom-only orders (Flipkart etc.)
            // are NOT listed on the Orders dashboard (removed 2026-07-17 per user).
            // Paginated — the old .limit(3000) was a lie (server caps at 1000), so ~2/3 of a 30-day
            // window lost their EasyEcom id/status → no hold controls, wrong holdable state.
            fetchPaged((f, t) => supabase
                .from('b2c_order_easycom')
                .select('order_id, reference_code, store_order_id, marketplace_order_id, order_status, location, awb_number, updated_at, fetched_at')
                .gte('order_date', since)
                .order('order_date', { ascending: false })
                .order('order_id', { ascending: true })   // unique tiebreak — stable pages on tied dates
                .range(f, t)),

            // Live EasyEcom-hold marks (set/cleared by /easyecom/hold-order|unhold-order) — the
            // dashboard shows On-Hold instantly, without waiting for EasyEcom's own status to sync.
            fetchPaged((f, t) => supabase.from('order_marks_ecom').select('order_name, note, created_by, created_at').eq('mark_type', 'ee_hold').order('order_name', { ascending: true }).range(f, t)),

            // DocPharma-rejected orders (the dp-to-mwh detection) → tag + red colour on the dashboard.
            fetchPaged((f, t) => supabase.from('dp_rejected_handled_ecom').select('order_name, routed_at').order('order_name', { ascending: true }).range(f, t)),

            // Warehouse-routed marks (set on a successful warehouse move) → "Moved: from → to" + disable button.
            fetchPaged((f, t) => supabase.from('order_marks_ecom').select('order_name, note, created_at').eq('mark_type', 'warehouse_routed').order('order_name', { ascending: true }).range(f, t)),

            // ── Accurate KPI counts over the FULL window (cheap head-only counts; classification by the
            //    synced tracking_status, matching the dashboard's status buckets closely) ──
            K(),                                                                                        // total
            K().ilike('tracking_status', 'delivered'),                                                 // delivered (exact — excludes 'RTO Delivered')
            // Cancelled (pure): cancelled/lost, EXCLUDING anything RTO (kept disjoint from the RTO count below).
            K().or('cancelled_at.not.is.null,tracking_status.ilike.cancelled,tracking_status.ilike.lost').or('tracking_status.is.null,tracking_status.not.ilike.%rto%'),
            K().ilike('tracking_status', '%rto%'),                                                      // RTO (returned to origin, incl. 'RTO Delivered')
            K().is('tracking_status', null).is('cancelled_at', null),                                   // new / processing (no tracking yet)

            // Authoritative held-orders list (EasyEcom order_status "On Hold") — a small dedicated query
            // so it's COMPLETE (the main easyecomRows above is capped and can miss older held orders).
            fetchPaged((f, t) => supabase.from('b2c_order_easycom').select('reference_code, store_order_id').ilike('order_status', '%hold%').gte('order_date', since).order('order_id', { ascending: true }).range(f, t))
        ]);
        // In-transit = everything else (has tracking, moving forward, not delivered/RTO/new).
        const kTotal = cntTotal.count || 0, kDelivered = cntDelivered.count || 0, kCancelled = cntCancelled.count || 0, kRto = cntRto.count || 0, kNew = cntNew.count || 0;
        const kpis = {
            total: kTotal, delivered: kDelivered, cancelled: kCancelled, rto: kRto, newProcessing: kNew,
            inTransit: Math.max(0, kTotal - kDelivered - kCancelled - kRto - kNew),
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

        // (trackingCache is built later, from a filtered fetch — see "RapidShyp tracking" below.)

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
        // RapidShyp tracking: fetch ONLY the rows for the AWBs actually on this page (was: the ENTIRE
        // 27k-row rapidshyp_tracking_ecom table on every request — the ~2s bottleneck in /get-orders).
        // Runs in parallel with the Shopify-hold marks query. Chunked so the .in() URL never gets too long.
        const awbSet = new Set();
        allOrders.forEach(o => { if (o.awb) awbSet.add(String(o.awb)); });
        Object.values(awbCache).forEach(a => { if (a && a.awb) awbSet.add(String(a.awb)); });   // tiny remap cache
        const awbList = [...awbSet];
        const awbChunks = [];
        for (let i = 0; i < awbList.length; i += 200) awbChunks.push(awbList.slice(i, i + 200));
        const [shopHoldRes, ...trackingChunks] = await Promise.all([
            supabase.from('order_marks_ecom').select('order_name, note, created_by, created_at').eq('mark_type', 'shopify_hold'),
            ...awbChunks.map(c => supabase.from('rapidshyp_tracking_ecom').select('awb, raw_status').in('awb', c))
        ]);
        const shopHoldRows = shopHoldRes.data;
        const trackingCache = {};
        trackingChunks.forEach(r => (r.data || []).forEach(row => { if (row.awb) trackingCache[String(row.awb)] = row; }));
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
                    order.status = 'Pickup Scheduled';
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
                else if (['PICKUP_SCHEDULED', 'PICKUP_GENERATED'].includes(rawStatus)) order.status = 'Pickup Scheduled';
            }

            // Fall back to the order's OWN synced tracking_status whenever there's no RapidShyp tracking-cache
            // entry (e.g. DocPharma orders never hit that cache) — otherwise a delivered/RTO order wrongly
            // keeps its stale 'Shipped' (fulfilled) status. Normalise separators so 'rto in transit' /
            // 'out for delivery' match too. (Was gated on !awbNumber, which skipped every AWB'd DP order.)
            if (!(awbNumber && trackingCache[String(awbNumber)]) && order.tracking_status) {
                const ts = (order.tracking_status || '').toUpperCase().replace(/[\s-]+/g, '_');
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
                || ['Pickup Scheduled', 'Shipped', 'In Transit', 'Out For Delivery', 'Delivered', 'RTO'].includes(order.status)
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
        // Truncated = we hit the row cap (there may be more). Bucketed views (e.g. Delivered=210 < cap)
        // return everything, so they're not flagged truncated even though kpis.total (full range) is larger.
        res.json({ orders: allOrders, kpis, total: kpis.total, shown: allOrders.length, truncated: allOrders.length >= TABLE_LIMIT, bucket: bucket || null, days });

    } catch (e) {
        console.error('CRITICAL ERROR in get-orders:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── Order Insights — accurate aggregates over the FULL selected range (not the capped table). ──────────
// Powers the Order Insights dashboard: KPIs (revenue/AOV/status split), daily trend, COD-vs-Prepaid, and
// top products/cities — all computed in SQL so they don't undercount like the old client-side rollup did.
router.get('/orders-insights', async (req, res) => {
    try {
        const from = req.query.from && moment(req.query.from).isValid() ? moment(req.query.from).toISOString() : moment().subtract(30, 'days').toISOString();
        const to = req.query.to && moment(req.query.to).isValid() ? moment(req.query.to).toISOString() : moment().add(1, 'day').toISOString();
        const [summary, trend, products, cities] = await Promise.all([
            supabase.rpc('orders_insights_summary', { p_from: from, p_to: to }),
            supabase.rpc('orders_insights_trend', { p_from: from, p_to: to }),
            supabase.rpc('orders_top_products', { p_from: from, p_to: to, p_limit: 10 }),
            supabase.rpc('orders_top_cities', { p_from: from, p_to: to, p_limit: 10 }),
        ]);
        if (summary.error) throw new Error(summary.error.message);
        res.json({
            success: true,
            summary: summary.data || {},
            trend: trend.data || [],
            topProducts: products.data || [],
            topCities: cities.data || [],
        });
    } catch (e) {
        console.error('[orders-insights] error:', e.message);
        res.status(500).json({ success: false, error: e.message });
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
    const [markRes, shopRes, eeRes, eeIdRes, relRes] = await Promise.all([
        // All five paginated — the server caps every response at 1000 rows, so the old .limit(2000)s
        // (and bare selects) silently truncated once the tables grew past 1000 → missing HOLD chips.
        fetchPaged((f, t) => supabase.from('order_marks_ecom').select('order_name, note, created_by, created_at').eq('mark_type', 'ee_hold').order('order_name', { ascending: true }).range(f, t)),
        fetchPaged((f, t) => supabase.from('order_marks_ecom').select('order_name, note, created_by, created_at').eq('mark_type', 'shopify_hold').order('order_name', { ascending: true }).range(f, t)),
        fetchPaged((f, t) => supabase.from('b2c_order_easycom').select('reference_code, store_order_id, awb_number, order_status, updated_at').ilike('order_status', '%hold%').gte('order_date', sinceHold).order('order_id', { ascending: true }).range(f, t)),
        // EasyEcom's text `order_status` is UNRELIABLE for holds — when an order is held from the panel it
        // often stays "Open"/"Shipped" while only the item is flagged, so the ilike above catches ~4 of ~65
        // real holds. The authoritative signal is `raw_data.order_status_id = 44` (On Hold) — filter on it
        // directly so panel-held orders actually surface. (Stale-cancelled id=44 rows are dropped below.)
        fetchPaged((f, t) => supabase.from('b2c_order_easycom').select('reference_code, store_order_id, awb_number, order_status, updated_at').filter('raw_data->>order_status_id', 'eq', '44').gte('order_date', sinceHold).order('order_id', { ascending: true }).range(f, t)),
        // Human EasyEcom releases (the `ee_hold_released` tombstone) — see the staleness rule below.
        fetchPaged((f, t) => supabase.from('order_marks_ecom').select('order_name, created_at').eq('mark_type', 'ee_hold_released').order('order_name', { ascending: true }).range(f, t)),
    ]);
    if (markRes.error) return res.status(500).json({ success: false, error: markRes.error.message });
    const nk = n => String(n || '').replace('#', '').trim();
    const map = {};
    // ⚠️ STALE-HOLD-AFTER-UNHOLD. `raw_data.order_status_id` is a SYNCED copy of EasyEcom's state, refreshed
    // only when the EasyEcom sync next touches the order. Unhold an order and the id stays 44 until then, so
    // the chip kept reading "EasyEcom hold" on an order that EasyEcom itself reports as unheld. (TE25-40985,
    // 2026-08-08: released 13:56 IST, row last synced 13:45 — the agent clicked Unhold five more times,
    // EasyEcom answering "Order is already in Unhold status" every time.)
    //
    // The `ee_hold_released` tombstone records the human release with a timestamp, so compare the two:
    // suppress the synced hold only while the tombstone is NEWER than the synced row. If the row was synced
    // AFTER the release, its id=44 is fresh evidence — someone re-held it in the EasyEcom panel — and the
    // chip must stand. (The local `ee_hold` mark can't collide: holding deletes the tombstone and releasing
    // deletes the mark, so only one of the pair ever exists; the timestamp test covers it regardless.)
    const releasedAt = {};
    (relRes.data || []).forEach(m => { const k = nk(m.order_name); if (k) releasedAt[k] = m.created_at; });
    const releasedAfter = (k, syncedAt) => {
        const rel = releasedAt[k]; if (!rel) return false;
        if (!syncedAt) return true;                       // no sync stamp → trust the human release
        return new Date(rel) > new Date(syncedAt);
    };
    // EasyEcom holds (local mark + synced "On Hold" text + order_status_id=44) → type 'ee'. Skip cancelled rows.
    (markRes.data || []).forEach(m => { const k = nk(m.order_name); if (!k || releasedAfter(k, m.created_at)) return;
        map[k] = { order_name: k, hold_type: 'ee', note: m.note, created_by: m.created_by, created_at: m.created_at }; });
    [...(eeRes.data || []), ...(eeIdRes.data || [])]
        .filter(r => !/cancel/i.test(r.order_status || ''))
        .forEach(r => { const k = nk(r.reference_code || r.store_order_id);
            if (k && !map[k] && !releasedAfter(k, r.updated_at)) map[k] = { order_name: k, hold_type: 'ee', note: 'Held in EasyEcom', created_by: null, created_at: null }; });
    // Shopify holds → type 'shopify' (or 'both' if also held in EasyEcom).
    (shopRes.data || []).forEach(m => { const k = nk(m.order_name); if (!k) return;
        if (map[k]) map[k].hold_type = 'both';
        else map[k] = { order_name: k, hold_type: 'shopify', note: m.note, created_by: m.created_by, created_at: m.created_at }; });
    // Drop holds for orders that have since been CANCELLED — a cancelled order can't ship, so its hold is
    // moot and a HOLD chip on it only misguides. Cancellation truth = `orders.cancelled_at` (the SAME source
    // the Orders dashboard uses for its "Cancelled" badge; `enriched_orders_ecom.cancelled_at` lags because
    // the data-sync skips terminal orders). This makes the chip disappear on EVERY dashboard reading /ee-hold-marks.
    // …and ALSO for orders that have MOVED ON. A held order by definition has not shipped, so anything
    // with an AWB, a courier scan, a fulfilled state or a terminal outcome cannot still be on hold.
    // ⚠️ This is the fix for stale chips after a RELEASE: releasing removes the `shopify_hold` mark, but
    // the EasyEcom side of this endpoint trusts `raw_data.order_status_id = 44`, which EasyEcom leaves at
    // 44 even after the order ships — its own status text says "Shipped" while the id still says On Hold.
    // Dropping only cancelled orders left released-then-shipped orders chipped forever (measured: 6 kept,
    // ALL already shipped, 4 of them delivered/RTO).
    const heldNames = Object.keys(map);
    if (heldNames.length) {
        const variants = heldNames.flatMap(k => ['#' + k, k]);
        const MOVED_RE = /IN.?TRANSIT|OUT.?FOR.?DELIVERY|\bOFD\b|DELIVERED|\bRTO\b|RETURN|PICKED.?UP|PICKUP.?COMPLETED|SORTING|DISPATCHED|\bLOST\b/i;
        const stale = new Set();
        for (let i = 0; i < variants.length; i += 300) {
            const { data } = await supabase.from('orders')
                .select('name, cancelled_at, awb_number, tracking_status, fulfillment_status')
                .in('name', variants.slice(i, i + 300));
            // NOTE: an AWB alone is deliberately NOT a drop reason. An order can be genuinely held in
            // EasyEcom after the AWB is assigned but before pickup (the Call Queue treats that state as
            // still holdable), so dropping on `awb_number` would hide real holds. Only a courier scan,
            // a fulfilled state or a cancellation proves the parcel is actually gone.
            (data || []).forEach(r => {
                const moved = r.cancelled_at
                    || MOVED_RE.test(String(r.tracking_status || ''))
                    || String(r.fulfillment_status || '').toLowerCase() === 'fulfilled';
                if (moved) stale.add(nk(r.name));
            });
        }
        stale.forEach(k => { delete map[k]; });
    }
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
