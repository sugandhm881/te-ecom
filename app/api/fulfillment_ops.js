const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const config  = require('../../config');
const { getRapidshypTimeline, fetchDocpharmaDetails, extractDocpharmaStatusString } = require('./helpers');
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

// Map a RapidShyp status → the closest Shopify FulfillmentEventStatus enum value.
// Returns null for statuses with no clean Shopify equivalent (e.g. reallocation) → no push.
function rsToShopifyEventStatus(rsStatus) {
    const s = (rsStatus || '').toLowerCase();
    if (!s) return null;
    if (s.includes('out for delivery'))                                   return 'OUT_FOR_DELIVERY';
    if (s.includes('deliver') && !s.includes('undeliver'))                return 'DELIVERED';
    // NDR / failed-attempt states (consignee unavailable, address issue, undelivered, NDR…)
    if (s.includes('attempt') || s.includes('undeliver') || s.includes('ndr') || s.includes('refused')
        || s.includes('unavailable') || s.includes('not attempted') || s.includes('consignee')) return 'ATTEMPTED_DELIVERY';
    if (s.includes('rto') || s.includes('return') || s.includes('lost') || s.includes('cancel')) return 'FAILURE';
    if (s.includes('pickup completed') || s.includes('picked up'))        return 'PICKED_UP';
    if (s.includes('transit') || s.includes('reached') || s.includes('shipped') || s.includes('dispatch') || s.includes('in_transit')) return 'IN_TRANSIT';
    // Packed & awaiting courier — manifested / ready to ship / pickup scheduled|generated|pending / awb assigned.
    // (Manifested means the label is generated, NOT yet shipped — so it's READY_FOR_PICKUP, not IN_TRANSIT.)
    if (s.includes('ready') || s.includes('pickup') || s.includes('awb') || s.includes('manifest')) return 'READY_FOR_PICKUP';
    if (s.includes('confirm'))                                            return 'CONFIRMED';
    return null;
}

// BULK push switch — the automatic/bulk sync (cron + `status-sync` command) is DISABLED.
// The manual AWB-click push still works (it passes opts.manual to bypass this).
// To resume bulk: set to true AND trim rsToShopifyEventStatus() to the statuses you want.
const STATUS_PUSH_ENABLED = false;

// Push a fulfillment event to Shopify so its status matches RapidShyp.
// Skips when pushing is disabled, no fulfillment, no clean mapping, already matching, or it
// would regress a Delivered order. opts.dryRun → preview WITHOUT writing to Shopify.
// Returns { pushed, wouldPush, from, to, error }.
async function pushShopifyFulfillmentStatus(fulfillmentId, currentDisplayStatus, rsStatus, opts = {}) {
    const target = rsToShopifyEventStatus(rsStatus);
    const current = (currentDisplayStatus || '').toUpperCase();
    if (!fulfillmentId || !target) return { pushed: false, reason: 'no-mapping' };
    if (target === current)        return { pushed: false, reason: 'already-matching' };
    if (current === 'DELIVERED' && target !== 'DELIVERED') return { pushed: false, reason: 'would-regress-delivered' };
    if (opts.dryRun)               return { pushed: false, wouldPush: true, from: current, to: target, rsStatus };
    // Bulk pushes are gated by the switch; the manual AWB-click (opts.manual) is always allowed.
    if (!STATUS_PUSH_ENABLED && !opts.manual) return { pushed: false, reason: 'bulk-push-disabled' };

    const mutation = `mutation($fid: ID!, $status: FulfillmentEventStatus!) {
        fulfillmentEventCreate(fulfillmentEvent: { fulfillmentId: $fid, status: $status }) {
            fulfillmentEvent { id status }
            userErrors { field message }
        }
    }`;
    try {
        const r = await axios.post(GQL_URL, { query: mutation, variables: { fid: fulfillmentId, status: target } }, {
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN }
        });
        const errs = r.data.errors || r.data.data?.fulfillmentEventCreate?.userErrors || [];
        if (errs.length) {
            console.error('[StatusPush] Shopify error:', JSON.stringify(errs).slice(0, 200));
            return { pushed: false, from: current, to: target, error: errs[0].message || 'push failed' };
        }
        console.log(`[StatusPush] ${current || '(none)'} → ${target}`);
        // Audit log (fire-and-forget) so every push is queryable in api_logs_ecom.
        supabase.from('api_logs_ecom').insert({
            action: 'status_push_shopify', status_code: 200,
            payload: { fulfillmentId, from: current, rsStatus }, response: { to: target }
        }).then(() => {}).catch(() => {});
        return { pushed: true, from: current, to: target };
    } catch (e) {
        console.error('[StatusPush] exception:', e.message);
        return { pushed: false, from: current, to: target, error: e.message };
    }
}

// Click-triggered: fetch latest AWB for the order from Shopify, then sync RS and save to DB
router.get('/track-order/:numericId', async (req, res) => {
    const { numericId } = req.params;
    const orderId = `gid://shopify/Order/${numericId}`;
    try {
        // 1. Get latest fulfillment AWB from Shopify
        const gql = `{ order(id: "${orderId}") { name cancelledAt fulfillments { id displayStatus trackingInfo { number company } } } }`;
        const shopResp = await axios.post(GQL_URL, { query: gql }, {
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN }
        });
        const order = shopResp.data.data?.order;
        if (!order) return res.json({ success: false, error: 'Order not found' });
        const fulfillment = (order.fulfillments || [])[0] || null;
        const ti = fulfillment?.trackingInfo || [];
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

        // 3b. Push RapidShyp status to Shopify when they don't match (keeps Shopify in sync
        //     with the courier — e.g. RapidShyp "Ready to Ship" but Shopify still "Confirmed").
        let statusPush = { pushed: false };
        if (fulfillment && rsStatus && !order.cancelledAt) {
            statusPush = await pushShopifyFulfillmentStatus(fulfillment.id, fulfillment.displayStatus, rsStatus, { manual: true });
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

        res.json({ success: true, latestAWB, rsStatus, events, orderName: order.name, shopifyCancelled: !!order.cancelledAt, rsCancelled, rsCancelMsg, statusPush });
    } catch (e) {
        console.error('[TrackOrder]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Fetch AWB for an order that has none in Shopify (e.g. DocPharma-served) ──────────────
// Tries DocPharma first, then RapidShyp; saves the AWB+source; creates a Shopify fulfillment
// with the tracking number and pushes the current status. Manual, single-order (button).

// DocPharma → { awb, source:'DP', status, url, courier } | null
async function fetchAwbFromDocpharma(orderName) {
    const dp = await fetchDocpharmaDetails(String(orderName).replace('#', ''));
    if (!dp) return null;
    const sub = (dp.suborders || [])[0] || {};
    const ld  = sub.logistic_details || {};
    const awb = ld.tracking_number || null;
    if (!awb) return null;
    return {
        awb,
        source:  'DP',
        status:  String(ld.current_status || sub.status || dp.status || '').toUpperCase(),
        url:     ld.tracking_url || null,
        courier: ld.delivery_partner_name || 'DocPharma'
    };
}

// RapidShyp resolves order → AWB via track_order with `orderId` = the seller order id
// (the Shopify order NAME, no "#" — NOT the numeric id, NOT order_id snake_case).
// Returns { awb, source:'RapidShyp', status, courier } | null.
async function fetchAwbFromRapidshyp(orderName) {
    const clean = String(orderName).replace('#', '').trim();
    if (!clean) return null;
    try {
        const r = await axios.post(RS_URL, { orderId: clean }, { headers: RS_HDR(), timeout: 15000, validateStatus: () => true });
        const rec = r.data && r.data.success && (r.data.records || [])[0];
        if (!rec) return null;
        const sd = rec.shipment_details;
        const ship = Array.isArray(sd) && sd.length ? sd[0] : (sd && typeof sd === 'object' ? sd : rec);
        const awb = ship.awb || ship.awb_number || null;
        if (!awb) return null;
        return {
            awb,
            source: 'RapidShyp',
            status: ship.current_tracking_status_desc || ship.shipment_status || '',
            url: null,
            courier: ship.courier_name || ship.child_courier_name || null
        };
    } catch (e) { return null; }
}

// Create a Shopify fulfillment (with tracking) for an unfulfilled order's open fulfillment order.
async function createShopifyFulfillment(fulfillmentOrderId, awb, company, url) {
    const mutation = `mutation($f: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $f) {
            fulfillment { id status }
            userErrors { field message }
        }
    }`;
    const trackingInfo = { number: awb };
    if (company) trackingInfo.company = company;
    if (url)     trackingInfo.url = url;
    const variables = { f: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }],
        trackingInfo,
        notifyCustomer: false   // never email the customer from this tool
    }};
    const r = await axios.post(GQL_URL, { query: mutation, variables }, {
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN }
    });
    const errs = r.data.errors || r.data.data?.fulfillmentCreate?.userErrors || [];
    if (errs.length) return { ok: false, error: errs[0].message || 'fulfillment create failed' };
    return { ok: true, fulfillmentId: r.data.data.fulfillmentCreate.fulfillment.id };
}

// POST /api/fulfillment-ops/fetch-awb   body: { numericId }
router.post('/fetch-awb', async (req, res) => {
    const { numericId } = req.body;
    if (!numericId) return res.status(400).json({ success: false, error: 'numericId required' });
    const orderId = `gid://shopify/Order/${numericId}`;
    try {
        // 1. Current Shopify state
        const gql = `{ order(id: "${orderId}") { name displayFulfillmentStatus
            fulfillments { id trackingInfo { number } }
            fulfillmentOrders(first: 5) { edges { node { id status } } } } }`;
        const sr = await axios.post(GQL_URL, { query: gql }, { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN } });
        const order = sr.data.data?.order;
        if (!order) return res.json({ success: false, error: 'Order not found' });

        // Already has an AWB? nothing to do.
        const existing = order.fulfillments?.[0]?.trackingInfo?.[0]?.number;
        if (existing) return res.json({ success: true, alreadyHadAwb: true, awb: existing, source: 'shopify' });

        // 2. Fetch AWB — DocPharma first, then RapidShyp (track_order by orderId = order name)
        let result = await fetchAwbFromDocpharma(order.name);
        if (!result) result = await fetchAwbFromRapidshyp(order.name);
        if (!result) return res.json({ success: true, found: false, message: 'No AWB yet in DocPharma or RapidShyp — left as is' });

        // 3. Save to DB
        const normName = String(order.name).replace('#', '');
        await supabase.from('order_awb_ecom').upsert({
            order_name: normName, awb: result.awb, source: result.source, status: result.status || null,
            tracking_url: result.url || null, courier: result.courier || null, updated_at: new Date().toISOString()
        }, { onConflict: 'order_name' });
        await supabase.from('rapidshyp_tracking_ecom').upsert({
            awb: result.awb, raw_status: result.status || null, last_checked: new Date().toISOString(), updated_at: new Date().toISOString()
        }, { onConflict: 'awb' });

        // 4. Update Shopify — create a fulfillment with the tracking number, then push status
        let shopify = { ok: false };
        const fo = (order.fulfillmentOrders?.edges || []).map(e => e.node).find(n => n.status === 'OPEN');
        if (fo) {
            shopify = await createShopifyFulfillment(fo.id, result.awb, result.courier || result.source, result.url);
            if (shopify.ok) {
                await supabase.from('order_awb_ecom').update({ shopify_fulfilled: true }).eq('order_name', normName);
                // Reflect the courier status (e.g. DELIVERED) on the new fulfillment.
                const target = rsToShopifyEventStatus(result.status);
                if (target) await pushShopifyFulfillmentStatus(shopify.fulfillmentId, 'CONFIRMED', result.status, { manual: true });
            }
        } else {
            shopify = { ok: false, error: order.fulfillments?.length ? 'Order already fulfilled' : 'No open fulfillment order' };
        }

        return res.json({ success: true, found: true, awb: result.awb, source: result.source, status: result.status, courier: result.courier, shopify });
    } catch (e) {
        console.error('[FetchAWB]', e.message);
        return res.status(500).json({ success: false, error: e.message });
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

// ─── Cron: push RapidShyp + DocPharma statuses → Shopify (automates the AWB-click push) ───
// For open orders in the window: take the RapidShyp cached status (or DocPharma for no-RS
// orders) and, when it doesn't match Shopify's fulfillment status, push a fulfillment event.
// Reuses pushShopifyFulfillmentStatus() so the same mapping/guards as the manual click apply.
let _statusSyncRunning = false;

async function syncStatusesToShopify(windowDays = 30, opts = {}) {
    if (_statusSyncRunning) { console.log('[StatusSync] skipped — already running'); return; }
    _statusSyncRunning = true;
    const dryRun     = !!opts.dryRun;            // preview only — no Shopify writes
    const MAX_PUSHES = opts.maxPushes || 400;   // bound Shopify writes per run
    const MAX_DP     = opts.maxDocpharma || 100; // bound DocPharma calls per run
    const PUSH_DELAY = 500;                       // ms between Shopify writes (stay under cost budget)
    const DP_DELAY   = 1100;                       // ms between DocPharma calls (1 req/sec)

    try {
        const end = new Date();
        const start = new Date(end.getTime() - windowDays * 86400000);
        const startStr = fmtDate(start), endStr = fmtDate(end);
        console.log(`[StatusSync]${dryRun ? ' [DRY-RUN]' : ''} Syncing RapidShyp/DocPharma → Shopify for open orders ${startStr} → ${endStr}…`);

        // 1. Fetch open orders with fulfillment id + displayStatus + AWB
        const orders = [];
        let cursor = null, hasNext = true;
        while (hasNext) {
            const after = cursor ? `, after:"${cursor}"` : '';
            const q = `processed_at:>='${startStr}' AND processed_at:<='${endStr}T23:59:59Z' AND status:open`;
            const gql = `{orders(first:250,sortKey:PROCESSED_AT,reverse:true,query:"${q}"${after}){edges{node{name tags fulfillments{id displayStatus trackingInfo{number}}}}pageInfo{hasNextPage endCursor}}}`;
            const resp = await axios.post(GQL_URL, { query: gql }, {
                headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN }
            });
            if (resp.data.errors) throw new Error(resp.data.errors[0].message);
            const { edges, pageInfo } = resp.data.data.orders;
            edges.forEach(e => orders.push(e.node));
            hasNext = pageInfo.hasNextPage;
            cursor  = pageInfo.endCursor;
        }
        console.log(`[StatusSync] Fetched ${orders.length} open orders`);

        // 2. RapidShyp cached statuses (chunked)
        const awbs = orders.map(o => {
            const f = (o.fulfillments || [])[0];
            const ti = f && (f.trackingInfo || [])[0];
            return ti && ti.number;
        }).filter(Boolean);
        const rsRows = await fetchRsTrackingByAwbs(awbs, 'awb, raw_status');
        const rsMap = {};
        rsRows.forEach(r => { rsMap[r.awb] = r.raw_status; });

        // 3. Push only the orders that actually need it (status differs from Shopify).
        //    RapidShyp comes from the cache (no per-order API call). DocPharma is checked LIVE
        //    but ONLY for DocPharma-tagged orders — avoids wasteful 400s on RapidShyp orders.
        let pushed = 0, dpChecked = 0, skipped = 0;
        for (const o of orders) {
            if (pushed >= MAX_PUSHES) { console.log(`[StatusSync] Reached ${MAX_PUSHES}-push cap — stopping (will continue next run)`); break; }
            const f = (o.fulfillments || [])[0];
            if (!f || !f.id) continue;
            if ((f.displayStatus || '').toUpperCase() === 'DELIVERED') continue; // already final in Shopify

            const awb = (f.trackingInfo || [])[0]?.number;
            let status = awb ? rsMap[awb] : null;

            // Only fall back to DocPharma for actual DocPharma orders (tagged) that have no RapidShyp tracking.
            const isDocpharma = (o.tags || []).some(t => String(t).toLowerCase().includes('docpharma'));
            if (!status && isDocpharma && dpChecked < MAX_DP) {
                dpChecked++;
                const dp = await fetchDocpharmaDetails((o.name || '').replace('#', ''));
                status = extractDocpharmaStatusString(dp);
                await new Promise(r => setTimeout(r, DP_DELAY));
            }
            if (!status) { skipped++; continue; }

            // pushShopifyFulfillmentStatus is a no-op (no Shopify write) unless the status truly differs.
            const result = await pushShopifyFulfillmentStatus(f.id, f.displayStatus, status, { dryRun });
            if (result.pushed || result.wouldPush) {
                pushed++;
                console.log(`[StatusSync]${dryRun ? ' [DRY]' : ''} ${o.name}: ${result.from || '(none)'} → ${result.to}   (RS: "${status}")`);
                if (result.pushed) await new Promise(r => setTimeout(r, PUSH_DELAY));
            }
        }

        console.log(`[StatusSync]${dryRun ? ' [DRY-RUN]' : ''} Done — ${dryRun ? 'would push' : 'pushed'} ${pushed} update(s), DocPharma-checked ${dpChecked}, skipped ${skipped}`);
        return { pushed, dpChecked };
    } catch (e) {
        console.error('[StatusSync] Error:', e.message);
    } finally {
        _statusSyncRunning = false;
    }
}

module.exports = { router, syncLast7Days, syncMTD, syncStatusesToShopify };

// --- Manual run ---
//   node app/api/fulfillment_ops.js status-sync 7        → push for last 7 days
//   node app/api/fulfillment_ops.js status-sync 7 dry    → DRY-RUN: print what WOULD be pushed, no writes
if (require.main === module && process.argv[2] === 'status-sync') {
    const rest = process.argv.slice(3);
    const dryRun = rest.some(a => String(a).toLowerCase() === 'dry');
    const daysArg = rest.find(a => /^\d+$/.test(a));
    const days = daysArg ? parseInt(daysArg, 10) : 30;
    syncStatusesToShopify(days, { dryRun })
        .then(() => process.exit(0))
        .catch(e => { console.error(e.message); process.exit(1); });
}
