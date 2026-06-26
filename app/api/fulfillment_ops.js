const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const config  = require('../../config');
const { getRapidshypTimeline } = require('./helpers');
const { supabase } = require('../supabase');

const GQL_URL = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2025-01/graphql.json`;

const RS_URL  = 'https://api.rapidshyp.com/rapidshyp/apis/v1/track_order';
const RS_HDR  = () => ({ 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' });

// Supabase/PostgREST chokes on a single .in() over thousands of values (URL length +
// the 1000-row default cap), erroring out so NO statuses load. Chunk the lookup so
// every AWB's cached status comes back.
async function fetchRsTrackingByAwbs(awbs, columns = 'awb, raw_status, updated_at') {
    const uniq = [...new Set(awbs.filter(Boolean))];
    const CHUNK = 200;
    const slices = [];
    for (let i = 0; i < uniq.length; i += CHUNK) slices.push(uniq.slice(i, i + CHUNK));
    const batches = await Promise.all(slices.map(async slice => {
        const { data, error } = await supabase
            .from('rapidshyp_tracking_ecom')
            .select(columns)
            .in('awb', slice);
        if (error) { console.error('[FulfillmentOps] RS cache chunk error:', error.message); return []; }
        return data || [];
    }));
    return batches.flat();
}

async function enrichAWBsBackground(awbs) {
    for (const awb of awbs) {
        try {
            const res = await axios.post(RS_URL, { awb }, { headers: RS_HDR(), timeout: 8000 });
            if (res.data.success && res.data.records && res.data.records.length) {
                const sd = res.data.records[0].shipment_details;
                const ship = Array.isArray(sd) && sd.length ? sd[0] : (sd && typeof sd === 'object' ? sd : res.data.records[0]);
                const rawStatus = ship.current_tracking_status_desc || ship.shipment_status || '';
                if (rawStatus) {
                    await supabase.from('rapidshyp_tracking_ecom').upsert(
                        { awb, raw_status: rawStatus, last_checked: new Date().toISOString(), updated_at: new Date().toISOString() },
                        { onConflict: 'awb' }
                    );
                    console.log(`[RS Sync] ${awb} → ${rawStatus}`);
                }
            }
        } catch (e) {
            console.error(`[RS Sync] ${awb} failed:`, e.message);
        }
        await new Promise(r => setTimeout(r, 1000)); // 1 req/sec to avoid overload
    }
    console.log(`[RS Sync] Background sync done for ${awbs.length} AWBs`);
}

const OPS_FULFILLMENT_FILTER = '(fulfillment_status:shipped OR fulfillment_status:partial OR fulfillment_status:scheduled OR fulfillment_status:on_hold OR fulfillment_status:request_declined)';
const OPS_DELIVERY_FILTER    = '(delivery_status:tracking_added OR delivery_status:no_status OR delivery_status:ready_for_recipient_pickup)';

function buildQuery(start, end, cursor, mode) {
    const after = cursor ? `, after:"${cursor}"` : '';
    let q = `processed_at:>='${start}' AND processed_at:<='${end}T23:59:59Z'`;
    if (mode === 'ops') {
        q += ` AND status:open AND ${OPS_FULFILLMENT_FILTER} AND ${OPS_DELIVERY_FILTER}`;
    }
    return `{orders(first:250,sortKey:PROCESSED_AT,reverse:true,query:"${q}"${after}){edges{node{id name processedAt cancelledAt displayFinancialStatus displayFulfillmentStatus fulfillments{displayStatus trackingInfo{number company}}totalPriceSet{shopMoney{amount}}customer{displayName phone email}tags}}pageInfo{hasNextPage endCursor}}}`;
}

router.post('/orders', async (req, res) => {
    const { start, end, mode } = req.body;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start and end required' });

    const allOrders = [];
    let cursor  = null;
    let hasNext = true;

    try {
        while (hasNext) {
            const resp = await axios.post(
                GQL_URL,
                { query: buildQuery(start, end, cursor, mode) },
                { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN } }
            );
            const gql = resp.data;
            if (gql.errors) throw new Error(gql.errors[0].message);
            const { edges, pageInfo } = gql.data.orders;
            edges.forEach(e => allOrders.push(e.node));
            hasNext = pageInfo.hasNextPage;
            cursor  = pageInfo.endCursor;
        }
        // Enrich with EasyEcom status (more real-time than Shopify's displayFulfillmentStatus)
        const awbs = allOrders.map(o => {
            const f = o.fulfillments || [];
            if (!f.length) return null;
            const ti = f[0].trackingInfo || [];
            return ti.length ? ti[0].number : null;
        }).filter(Boolean);

        // Read RapidShyp statuses from the DB cache ONLY — no live API calls on Fetch.
        // The cache is kept fresh by the scheduled crons (syncLast7Days / syncMTD) and
        // the click-to-track endpoints; the dashboard fetch just reads what's saved.
        const rsMap = {};
        if (awbs.length) {
            const rsRows = await fetchRsTrackingByAwbs(awbs);
            (rsRows || []).forEach(r => { rsMap[r.awb] = r; });

            allOrders.forEach(o => {
                const f = o.fulfillments || [];
                if (!f.length) return;
                const ti = f[0].trackingInfo || [];
                if (!ti.length) return;
                const awb = ti[0].number;
                if (awb && rsMap[awb]) o.rapidshypStatus = rsMap[awb].raw_status;
            });
        }

        res.json({ success: true, orders: allOrders });
    } catch (e) {
        console.error('[FulfillmentOps]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Lightweight status-only endpoint — checks cache first, calls RS only if stale
router.get('/status/:awb', async (req, res) => {
    const { awb } = req.params;
    try {
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const { data: cached } = await supabase
            .from('rapidshyp_tracking_ecom')
            .select('raw_status, updated_at')
            .eq('awb', awb)
            .maybeSingle();

        if (cached && cached.updated_at > sixHoursAgo) {
            return res.json({ success: true, awb, rsStatus: cached.raw_status, fromCache: true });
        }

        const rsRes = await axios.post(
            'https://api.rapidshyp.com/rapidshyp/apis/v1/track_order',
            { awb },
            { headers: { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' }, timeout: 8000 }
        );
        const data = rsRes.data;
        let rawStatus = '';
        if (data.success && data.records && data.records.length) {
            const sd = data.records[0].shipment_details;
            const shipment = Array.isArray(sd) && sd.length ? sd[0] : (sd && typeof sd === 'object' ? sd : data.records[0]);
            rawStatus = shipment.current_tracking_status_desc || shipment.shipment_status || '';
            if (rawStatus) {
                supabase.from('rapidshyp_tracking_ecom').upsert(
                    { awb, raw_status: rawStatus, last_checked: new Date().toISOString(), updated_at: new Date().toISOString() },
                    { onConflict: 'awb' }
                ).then(() => {}).catch(() => {});
            }
        }
        res.json({ success: true, awb, rsStatus: rawStatus });
    } catch (e) {
        res.json({ success: false, awb, rsStatus: '' });
    }
});

router.get('/track/:awb', async (req, res) => {
    const { awb } = req.params;
    if (!awb) return res.status(400).json({ success: false, error: 'AWB required' });
    try {
        // ── 1. RapidShyp (with logging so we can see what it returns) ──────────
        let events = [];
        let rsLiveStatus = '';
        try {
            const rsRes = await axios.post(
                'https://api.rapidshyp.com/rapidshyp/apis/v1/track_order',
                { awb },
                { headers: { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 }
            );
            const data = rsRes.data;
            if (data.success && data.records && data.records.length) {
                const rec = data.records[0];
                const sd  = rec.shipment_details;
                const shipment = Array.isArray(sd) && sd.length ? sd[0] : (sd && typeof sd === 'object' ? sd : rec);
                const history =
                    shipment.track_scans         ||
                    shipment.tracking_history     ||
                    shipment.tracking_events      ||
                    rec.track_scans               ||
                    rec.tracking_history          || [];
                events = history.map(ev => ({
                    status:    ev.scan || ev.status_desc || ev.status || ev.activity || '',
                    timestamp: ev.scan_datetime || ev.date || ev.timestamp || ev.event_time || '',
                    location:  ev.scan_location || ev.location || ev.city || ''
                })).filter(ev => ev.status).reverse();
                // Cache the live status so future ops-dashboard fetches see it.
                // Fall back to the latest scan when the summary fields are empty.
                const rawStatus = shipment.current_tracking_status_desc || shipment.shipment_status || (events[0] && events[0].status) || '';
                if (rawStatus) {
                    rsLiveStatus = rawStatus;
                    supabase.from('rapidshyp_tracking_ecom').upsert(
                        { awb, raw_status: rawStatus, last_checked: new Date().toISOString(), updated_at: new Date().toISOString() },
                        { onConflict: 'awb' }
                    ).then(() => {}).catch(() => {});
                }
            }
        } catch (rsErr) {
            console.error(`[Track] RapidShyp error for ${awb}:`, rsErr.message);
        }

        // ── 2. EasyEcom from Supabase ─────────────────────────────────────────
        const { data: eeRow } = await supabase
            .from('b2c_order_easycom')
            .select('order_status, courier_name, updated_at')
            .eq('awb_number', awb)
            .maybeSingle();

        const easyecomStatus = eeRow ? eeRow.order_status : null;
        // EasyEcom as a single confirmation entry (always appended if available)
        const eeEvent = eeRow ? [{ status: eeRow.order_status, timestamp: eeRow.updated_at, location: '', source: 'EasyEcom' }] : [];

        res.json({ success: true, awb, events, eeEvent, easyecomStatus, rsStatus: rsLiveStatus });
    } catch (e) {
        console.error('[FulfillmentOps Track]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Click-triggered: fetch latest AWB for the order from Shopify, then sync RS and save to DB
router.get('/track-order/:numericId', async (req, res) => {
    const { numericId } = req.params;
    const orderId = `gid://shopify/Order/${numericId}`;
    try {
        // 1. Get latest fulfillment AWB from Shopify
        const gql = `{ order(id: "${orderId}") { name cancelledAt fulfillments { displayStatus trackingInfo { number company } } } }`;
        const shopResp = await axios.post(GQL_URL, { query: gql }, {
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN }
        });
        const order = shopResp.data.data?.order;
        if (!order) return res.json({ success: false, error: 'Order not found' });
        const ti = (order.fulfillments || [])[0]?.trackingInfo || [];
        if (!ti.length) return res.json({ success: false, error: 'No tracking info on this order' });
        const latestAWB = ti[0].number;

        // 2. Call RapidShyp for latest status + events
        let events = [], rsStatus = '';
        try {
            const rsRes = await axios.post(RS_URL, { awb: latestAWB }, { headers: RS_HDR(), timeout: 10000 });
            const data  = rsRes.data;
            if (data.success && data.records && data.records.length) {
                const rec  = data.records[0];
                const sd   = rec.shipment_details;
                const ship = Array.isArray(sd) && sd.length ? sd[0] : (sd && typeof sd === 'object' ? sd : rec);
                const history = ship.track_scans || ship.tracking_history || ship.tracking_events || rec.track_scans || rec.tracking_history || [];
                events = history.map(ev => ({
                    status:    ev.scan || ev.status_desc || ev.status || ev.activity || '',
                    timestamp: ev.scan_datetime || ev.date || ev.timestamp || ev.event_time || '',
                    location:  ev.scan_location || ev.location || ev.city || ''
                })).filter(ev => ev.status).reverse();
                // Fall back to the latest scan when the summary fields are empty, so a
                // real status (e.g. "Consignee refused…") still gets surfaced & cached.
                rsStatus = ship.current_tracking_status_desc || ship.shipment_status || (events[0] && events[0].status) || '';
            }
        } catch (rsErr) {
            console.error(`[TrackOrder] RS error for ${latestAWB}:`, rsErr.message);
        }

        // 3. Save latest AWB + status to DB
        if (latestAWB) {
            await supabase.from('rapidshyp_tracking_ecom').upsert(
                { awb: latestAWB, raw_status: rsStatus || null, last_checked: new Date().toISOString(), updated_at: new Date().toISOString() },
                { onConflict: 'awb' }
            );
            console.log(`[TrackOrder] ${order.name} → AWB ${latestAWB} → ${rsStatus || '(no status)'}`);
        }

        // 4. If Shopify order is cancelled → cancel in RapidShyp too
        let rsCancelled = false, rsCancelMsg = '';
        if (order.cancelledAt && latestAWB) {
            const TERMINAL_RS = ['deliver', 'rto', 'return', 'cancel'];
            const alreadyTerminal = TERMINAL_RS.some(t => (rsStatus || '').toLowerCase().includes(t));
            if (!alreadyTerminal) {
                try {
                    const cancelRes = await axios.post(
                        'https://api.rapidshyp.com/rapidshyp/apis/v1/cancel_order',
                        { awbs: [latestAWB] },
                        { headers: RS_HDR(), timeout: 8000 }
                    );
                    rsCancelled  = cancelRes.data.success === true;
                    rsCancelMsg  = cancelRes.data.message || (rsCancelled ? 'Cancelled in RapidShyp' : 'RS cancel failed');
                    console.log(`[TrackOrder] RS cancel ${latestAWB}: ${rsCancelMsg}`);
                } catch (cancelErr) {
                    rsCancelMsg = cancelErr.message;
                    console.error(`[TrackOrder] RS cancel error for ${latestAWB}:`, cancelErr.message);
                }
            } else {
                rsCancelMsg = `Shipment already ${rsStatus} — no cancel needed`;
            }
        }

        res.json({ success: true, latestAWB, rsStatus, events, orderName: order.name, shopifyCancelled: !!order.cancelledAt, rsCancelled, rsCancelMsg });
    } catch (e) {
        console.error('[TrackOrder]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Fetches AWBs from Shopify for the given date range, then syncs only AWBs missing from the DB
async function syncAWBsForDateRange(start, end, label) {
    console.log(`[RS Sync][${label}] Fetching Shopify orders ${start} → ${end}…`);
    const awbs = [];
    let cursor = null, hasNext = true;
    const AWB_QUERY = (s, e, after) => {
        const a = after ? `, after:"${after}"` : '';
        return `{orders(first:50,sortKey:PROCESSED_AT,reverse:true,query:"processed_at:>='${s}' AND processed_at:<='${e}T23:59:59Z'"${a}){edges{node{fulfillments{trackingInfo{number}}}}pageInfo{hasNextPage endCursor}}}`;
    };
    try {
        while (hasNext) {
            const resp = await axios.post(
                GQL_URL,
                { query: AWB_QUERY(start, end, cursor) },
                { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN } }
            );
            const { edges, pageInfo } = resp.data.data.orders;
            edges.forEach(e => {
                const ti = (e.node.fulfillments || [])[0]?.trackingInfo || [];
                if (ti.length && ti[0].number) awbs.push(ti[0].number);
            });
            hasNext = pageInfo.hasNextPage;
            cursor  = pageInfo.endCursor;
        }
    } catch (e) {
        console.error(`[RS Sync][${label}] Shopify fetch error:`, e.message);
        return;
    }

    if (!awbs.length) { console.log(`[RS Sync][${label}] No AWBs found`); return; }

    // Only sync AWBs that have NO row in the database yet. Anything already saved
    // is left as-is (the click-to-track action refreshes individual shipments on demand).
    const cached = await fetchRsTrackingByAwbs(awbs, 'awb');
    const cachedAwbs = new Set((cached || []).map(r => r.awb));
    const toSync = awbs.filter(awb => !cachedAwbs.has(awb));

    if (!toSync.length) { console.log(`[RS Sync][${label}] All ${awbs.length} AWBs already in DB — nothing to fetch`); return; }
    console.log(`[RS Sync][${label}] Syncing ${toSync.length}/${awbs.length} AWBs missing from DB…`);
    await enrichAWBsBackground(toSync);
    console.log(`[RS Sync][${label}] Done`);
}

function fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

let _rsSyncRunning = false;

async function syncLast7Days() {
    if (_rsSyncRunning) { console.log('[RS Sync] last7 skipped — another sync in progress'); return; }
    _rsSyncRunning = true;
    try {
        const end   = fmtDate(new Date());
        const start = fmtDate(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
        await syncAWBsForDateRange(start, end, 'last7');
    } finally {
        _rsSyncRunning = false;
    }
}

async function syncMTD() {
    if (_rsSyncRunning) { console.log('[RS Sync] MTD skipped — another sync in progress'); return; }
    _rsSyncRunning = true;
    try {
        const now   = new Date();
        const start = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1));
        const end   = fmtDate(now);
        await syncAWBsForDateRange(start, end, 'mtd');
    } finally {
        _rsSyncRunning = false;
    }
}

module.exports = { router, syncLast7Days, syncMTD };
