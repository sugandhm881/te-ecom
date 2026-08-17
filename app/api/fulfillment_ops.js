const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const config  = require('../../config');
const { getRapidshypTimeline, fetchDocpharmaDetails, extractDocpharmaStatusString } = require('./helpers');
const { fetchKwikshipShipment, fetchKwikshipPublic } = require('./kwikship_sync');
const { supabase } = require('../supabase');

const GQL_URL = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2025-01/graphql.json`;

// Kwikship (GoKwik) live-tracking fallback — RapidShyp 400s on GoKwik AWBs, so when RapidShyp/DocPharma
// yield nothing, ask Kwikship by AWB (returns nothing for non-Kwikship AWBs → null, so this is safe to
// try for any order). Returns { events (newest-first), status } | null.
//
// ⚠️ PUBLIC v2 FIRST. The authenticated v1 endpoint does NOT know every shipment — it answered `found:false`
// for AWB 47607613096671 (order TE25-40596) while v2 returned all 16 scans, so the modal showed "No tracking
// events yet" on a parcel that was plainly moving. This was the last v1-only call site; the sync, the
// Delivery-Performance scan log and the webhook were all switched to v2-first earlier. v1 stays as the
// fallback for the reverse case.
async function kwikshipTrack(awb) {
    try {
        let ks = await fetchKwikshipPublic(awb);
        if (!(ks && ks.found && ks.statusHistory && ks.statusHistory.length)) ks = await fetchKwikshipShipment(awb);
        if (!ks || !ks.found || !ks.statusHistory || !ks.statusHistory.length) return null;
        const human = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        // The two endpoints name the same fields differently — v1 {datetime, description}, v2
        // {status_datetime, shipper_remark}. Read both, or v2's events render with blank timestamps and a
        // generic status name instead of the real remark ("Shipment picked up", "Consignee Unavailable").
        const events = ks.statusHistory
            .map(h => ({
                status: h.shipper_remark || h.description || human(h.status),
                timestamp: h.status_datetime || h.datetime || h.date || h.creation_datetime || '',
                location: h.location || '',
            }))
            .filter(ev => ev.status)
            .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));   // newest first
        return { events, status: human(ks.status) || (events[0] && events[0].status) || '' };
    } catch (_e) { return null; }
}

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

// ── Delivery status for shipments RapidShyp does not carry ───────────────────────────────────────
// `rapidshyp_tracking_ecom` is a RAPIDSHYP-ONLY cache: RapidShyp 400s on a Kwikship/DocPharma AWB, so
// nothing is ever written for those, `o.rapidshypStatus` stays undefined, and the table falls back to
// Shopify's `displayFulfillmentStatus` — which reads **"Confirmed"** forever no matter where the parcel
// actually is. That is why Fulfillment Ops showed 386 Confirmed / 0 in transit / 0 delivered while
// Kwikship orders were mid-route and delivered.
//
// `shipment_journey_ecom` already holds the truth for all three platforms (kept fresh by the Kwikship
// webhook + 2 AM cron and the RapidShyp/DocPharma syncs), so use it to FILL THE GAPS — never to override
// a RapidShyp cache hit, which is the fresher signal for RapidShyp's own shipments.
//
// The frontend classifier (`fopsGetDS`) is a substring matcher over this string, so emit phrases it
// already understands rather than raw codes.
async function fetchJourneyByAwbs(awbs) {
    const uniq = [...new Set(awbs.filter(Boolean))];
    const out = {};
    for (let i = 0; i < uniq.length; i += 200) {
        const { data, error } = await supabase.from('shipment_journey_ecom')
            .select('awb, source, outcome, status_code').in('awb', uniq.slice(i, i + 200));
        if (error) { console.error('[FulfillmentOps] journey chunk error:', error.message); continue; }
        (data || []).forEach(r => { out[r.awb] = r; });
    }
    return out;
}
function journeyStatusText(j) {
    if (!j) return null;
    const code = String(j.status_code || '').toLowerCase();
    switch (String(j.outcome || '')) {
        case 'delivered': return 'Delivered';
        case 'rto':       return 'RTO';
        case 'ndr_pending': return 'Undelivered — delivery attempted';
        // Not a delivery outcome, but it needs a human either way — surface it under Attempted (action
        // needed) instead of letting it fall back to a placid "Confirmed".
        case 'lost':      return 'Undelivered — shipment lost';
        case 'in_transit':
            if (code === 'out_for_delivery') return 'Out for Delivery';
            // `out_for_pickup` means the courier hasn't collected it yet — Shopify's own state is correct
            // there, so leave it alone rather than claiming movement that hasn't happened.
            if (code === 'out_for_pickup') return null;
            return 'In Transit';
        default: return null;
    }
}

// AWBs RapidShyp itself has rejected as unknown (HTTP 400) — i.e. shipments booked with ANOTHER carrier
// (Delhivery direct, GoKwik/Kwikship, DocPharma). Remembered for the life of the process so we stop
// re-asking about them every sync. Deliberately keyed on RapidShyp's OWN verdict rather than the courier
// name: 13 of 181 GoKwik AWBs and 28 non-RapidShyp-journey AWBs ARE tracked by RapidShyp, so filtering by
// aggregator/courier would have wrongly skipped real shipments and lost their tracking.
const notRapidshypAwbs = new Set();

// …and the same verdict, persisted, because an in-process Set forgets everything on restart. The sync
// only fetches AWBs with no row in rapidshyp_tracking_ecom, and a foreign AWB never gets one — so it
// stayed on the todo list forever. Measured 2026-08-17: 1,438 of 1,449 AWBs in the 7-day window were
// foreign (708 GoKwik + 730 with no aggregator) against 11 real ones, and the job spent ~14 minutes
// every 2 hours re-asking about all of them. Reloading the verdict from the DB skips them outright.
const UNKNOWN_TBL = 'rapidshyp_unknown_awbs_ecom';

async function loadKnownForeignAwbs(awbs) {
    try {
        for (let i = 0; i < awbs.length; i += 200) {
            const { data, error } = await supabase.from(UNKNOWN_TBL).select('awb').in('awb', awbs.slice(i, i + 200));
            if (error) throw new Error(error.message);
            (data || []).forEach(r => notRapidshypAwbs.add(r.awb));
        }
    } catch (e) {
        // Non-fatal: without the list we simply re-ask RapidShyp, exactly as before this table existed.
        console.warn(`[RS Sync] could not read ${UNKNOWN_TBL} (${e.message}) — proceeding without the skip list`);
    }
}

async function rememberForeignAwb(awb) {
    notRapidshypAwbs.add(awb);
    try { await supabase.from(UNKNOWN_TBL).upsert({ awb }, { onConflict: 'awb' }); }
    catch (e) { console.warn(`[RS Sync] could not persist ${awb} as non-RapidShyp: ${e.message}`); }
}

// 8000 was too tight — RapidShyp routinely answers slower than that under load, and the same API is
// given 25s by fetchRsLive() in warehouse_slack_report.js, which does not suffer these timeouts.
const RS_TIMEOUT_MS = parseInt(process.env.RS_TIMEOUT_MS, 10) || 25000;
// Consecutive AWB failures that mean "RapidShyp is down" rather than "this AWB is odd". Each AWB gets
// two attempts, so 6 here is 12 failed calls in a row — far past random flakiness — and bounds a dead-
// API run to ~5 min instead of letting it walk hundreds of AWBs at ~27s each.
const RS_ABORT_AFTER = parseInt(process.env.RS_ABORT_AFTER, 10) || 6;
const isTransient = e => !e.response || e.response.status === 429 || e.response.status >= 500;

async function enrichAWBsBackground(awbs) {
    await loadKnownForeignAwbs(awbs);   // skip AWBs RapidShyp has already disowned, across restarts
    let skipped = 0, ok = 0, failed = 0, consecutive = 0, aborted = false;
    const reasons = new Map();   // message → count, for ONE summary line instead of a line per AWB
    for (const awb of awbs) {
        if (notRapidshypAwbs.has(awb)) { skipped++; continue; }   // already told us it isn't theirs
        let done = false;
        // One retry: a timeout here is usually RapidShyp being briefly slow, and giving up on the first
        // one threw away an AWB that would have answered a second later.
        for (let attempt = 1; attempt <= 2 && !done; attempt++) {
            try {
                const res = await axios.post(RS_URL, { awb }, { headers: RS_HDR(), timeout: RS_TIMEOUT_MS });
                if (res.data.success && res.data.records && res.data.records.length) {
                    const sd = res.data.records[0].shipment_details;
                    const ship = Array.isArray(sd) && sd.length ? sd[0] : (sd && typeof sd === 'object' ? sd : res.data.records[0]);
                    const rawStatus = ship.current_tracking_status_desc || ship.shipment_status || '';
                    if (rawStatus) {
                        await supabase.from('rapidshyp_tracking_ecom').upsert(
                            { awb, raw_status: rawStatus, last_checked: Date.now() / 1000, updated_at: new Date().toISOString() },
                            { onConflict: 'awb' }
                        );
                        console.log(`[RS Sync] ${awb} → ${rawStatus}`);
                    }
                }
                done = true; ok++; consecutive = 0;
            } catch (e) {
                // 400 = RapidShyp doesn't know this AWB → it was booked with another carrier. That's a normal
                // fact about a multi-courier catalogue, NOT a failure: nothing was ever going to be written for
                // it, so the data is identical either way. Logged at warn (never console.error) so it stops
                // raising cron-failure alerts, and remembered so later runs skip it entirely.
                const status = e && e.response && e.response.status;
                if (status === 400) {
                    await rememberForeignAwb(awb);   // remembered in the DB, so restarts don't re-ask
                    console.warn(`[RS Sync] ${awb} — not a RapidShyp shipment (400); skipping from now on`);
                    done = true; consecutive = 0;
                } else if (attempt === 1 && isTransient(e)) {
                    await new Promise(r => setTimeout(r, 2000));   // brief backoff, then one more go
                } else {
                    failed++; consecutive++;
                    reasons.set(e.message, (reasons.get(e.message) || 0) + 1);
                    done = true;
                }
            }
        }
        // RapidShyp is down, not this AWB. Keep walking the list at ~27s each and the job runs for half
        // an hour to achieve nothing, overlapping the next 2-hourly trigger.
        if (consecutive >= RS_ABORT_AFTER) {
            aborted = true;
            console.error(`[RS Sync] RapidShyp unreachable — ${consecutive} consecutive failures, aborting this run (${ok} synced first). Remaining AWBs retry on the next run.`);
            break;
        }
        await new Promise(r => setTimeout(r, 1000)); // 1 req/sec to avoid overload
    }

    // A per-AWB console.error made every isolated timeout a red "Cron failed" card, which is wrong twice
    // over: the sync only fetches AWBs with NO row yet, so anything that failed is simply picked up by
    // the next run 2 hours later — nothing is lost and nothing needs a human. So scattered failures are
    // summarised at WARN, and only a genuine outage (already aborted above, or most of the batch
    // failing) escalates to the error that raises a card.
    const attempted = ok + failed;
    if (failed && !aborted) {
        const detail = [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${n}× ${m}`).join(' | ');
        const badRate = attempted >= 5 && failed / attempted >= 0.25;
        const line = `[RS Sync] ${failed}/${attempted} AWB(s) did not sync (they retry on the next run): ${detail}`;
        if (badRate) console.error(line); else console.warn(line);
    }
    console.log(`[RS Sync] Background sync done — ${ok} synced, ${failed} failed of ${awbs.length} AWBs`
        + (skipped ? ` (skipped ${skipped} known non-RapidShyp)` : '')
        + (aborted ? ' [ABORTED EARLY]' : ''));
    return { ok, failed, skipped, aborted };
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

            // GAP FILL — every AWB the RapidShyp cache has nothing for (Kwikship / DocPharma / anything
            // RapidShyp 400s on) gets its status from shipment_journey_ecom instead. Without this those
            // orders read "Confirmed" for their whole life. Still zero live API calls: one indexed table read.
            const missing = awbs.filter(a => !(rsMap[a] && rsMap[a].raw_status));
            if (missing.length) {
                const jMap = await fetchJourneyByAwbs(missing);
                let filled = 0;
                allOrders.forEach(o => {
                    if (o.rapidshypStatus) return;
                    const f = o.fulfillments || [];
                    if (!f.length) return;
                    const ti = f[0].trackingInfo || [];
                    if (!ti.length) return;
                    const txt = journeyStatusText(jMap[ti[0].number]);
                    if (txt) { o.rapidshypStatus = txt; o.statusSource = (jMap[ti[0].number] || {}).source || 'journey'; filled++; }
                });
                if (filled) console.log(`[FulfillmentOps] filled ${filled}/${missing.length} statuses from shipment_journey_ecom (non-RapidShyp shipments)`);
            }
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
                    { awb, raw_status: rawStatus, last_checked: Date.now() / 1000, updated_at: new Date().toISOString() },
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
                        { awb, raw_status: rawStatus, last_checked: Date.now() / 1000, updated_at: new Date().toISOString() },
                        { onConflict: 'awb' }
                    ).then(() => {}).catch(() => {});
                }
            }
        } catch (rsErr) {
            console.error(`[Track] RapidShyp error for ${awb}:`, rsErr.message);
        }

        // ── 1b. Kwikship (GoKwik) fallback — RapidShyp 400s on GoKwik AWBs ─────
        if (!events.length) {
            const ks = await kwikshipTrack(awb);
            if (ks && ks.events.length) {
                events = ks.events;
                if (ks.status) {
                    rsLiveStatus = ks.status;
                    supabase.from('rapidshyp_tracking_ecom').upsert(
                        { awb, raw_status: ks.status, last_checked: Date.now() / 1000, updated_at: new Date().toISOString() },
                        { onConflict: 'awb' }
                    ).then(() => {}).catch(() => {});
                }
            }
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
    // RTO / return / lost / cancel FIRST — "RTO Delivered", "RTO Out for delivery" etc. are the RETURN
    // leg, NOT a customer delivery. Checking these before the deliver/OFD branches is critical: otherwise
    // "RTO Delivered" matches includes('deliver') → DELIVERED → a FALSE customer "delivered" email.
    if (s.includes('rto') || s.includes('return') || s.includes('lost') || s.includes('cancel')) return 'FAILURE';
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
    // NEVER push DELIVERED — Shopify's native "shipment delivered" email is shop-level and cannot be
    // disabled, so marking a fulfillment Delivered emails the customer. We must never trigger that from
    // our sync (and a mis-mapped RTO could email someone who never received the order). Shopify still
    // tracks delivery itself; our dashboard shows the true status from RapidShyp.
    if (target === 'DELIVERED')    return { pushed: false, reason: 'delivered-push-blocked' };
    if (target === current)        return { pushed: false, reason: 'already-matching' };
    // No-regression guard: never move a fulfillment BACKWARDS in its lifecycle. Shopify can be ahead
    // of the cached RapidShyp status, and pushing the older value would drag it back — that's what
    // produced the bad pushes before. Only forward (or same-rank lateral, e.g. NDR) is allowed.
    const LIFECYCLE_RANK = { CONFIRMED: 1, READY_FOR_PICKUP: 2, FULFILLED: 3, PICKED_UP: 3, IN_TRANSIT: 3, ATTEMPTED_DELIVERY: 4, FAILURE: 4, OUT_FOR_DELIVERY: 4, DELIVERED: 5 };
    if ((LIFECYCLE_RANK[target] || 0) < (LIFECYCLE_RANK[current] || 0)) {
        return { pushed: false, reason: 'would-regress', from: current, to: target };
    }
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

        // 2. Call RapidShyp for latest status + events.
        // `statusFrom` records WHICH source produced `rsStatus`. Only 'rapidshyp' may be pushed to Shopify
        // (see 3b) — every other source is display-and-cache only.
        let events = [], rsStatus = '', fromDocpharma = false, statusFrom = null;
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
                if (rsStatus) statusFrom = 'rapidshyp';
            }
        } catch (rsErr) {
            console.error(`[TrackOrder] RS error for ${latestAWB}:`, rsErr.message);
        }

        // 2b. DocPharma fallback — DocPharma-dispatched orders aren't in RapidShyp (it 400s on their
        //     AWB). If RapidShyp returned NO status, ask DocPharma. If DocPharma also has nothing,
        //     leave it blank.
        if (!rsStatus) {
            try {
                const dp = await fetchDocpharmaDetails((order.name || '').replace('#', '').trim());
                const dpStatus = extractDocpharmaStatusString(dp);
                if (dpStatus) {
                    rsStatus = dpStatus;
                    fromDocpharma = true; statusFrom = 'docpharma';   // display + cache only — never pushed
                    if (!events.length) events = [{ status: dpStatus, timestamp: '', location: 'DocPharma' }];
                    console.log(`[TrackOrder] ${order.name} → RapidShyp empty → DocPharma: ${dpStatus}`);
                } else {
                    console.log(`[TrackOrder] ${order.name} → no status from RapidShyp or DocPharma — trying Kwikship…`);
                }
            } catch (dpErr) {
                console.error(`[TrackOrder] DocPharma fallback error for ${order.name}:`, dpErr.message);
            }
        }

        // 2c. Kwikship (GoKwik) fallback — RapidShyp 400s on GoKwik AWBs. Try Kwikship's API by AWB.
        if (!rsStatus || !events.length) {
            const ks = await kwikshipTrack(latestAWB);
            if (ks && ks.events.length) {
                events = ks.events;
                if (ks.status) { rsStatus = ks.status; statusFrom = 'kwikship'; }   // display + cache only — never pushed
                console.log(`[TrackOrder] ${order.name} → Kwikship: ${ks.status || '(events only)'} (${events.length} events)`);
            }
        }

        // 2d. Last resort — our own journey table. Every platform's sync writes here, so if all three live
        //     lookups came back empty (API blip, auth expiry, a courier we don't call directly) we still
        //     know where the parcel is and the row shows it instead of a false "Confirmed".
        //     Display + cache only: `statusFrom = 'journey'` keeps it out of the Shopify push at 3b.
        if (!rsStatus && latestAWB) {
            const j = (await fetchJourneyByAwbs([latestAWB]))[latestAWB];
            const txt = journeyStatusText(j);
            if (txt) { rsStatus = txt; statusFrom = 'journey'; console.log(`[TrackOrder] ${order.name} → journey (${j.source}): ${txt}`); }
        }

        // 3. Save latest AWB + status to DB
        if (latestAWB) {
            await supabase.from('rapidshyp_tracking_ecom').upsert(
                { awb: latestAWB, raw_status: rsStatus || null, last_checked: Date.now() / 1000, updated_at: new Date().toISOString() },
                { onConflict: 'awb' }
            );
            console.log(`[TrackOrder] ${order.name} → AWB ${latestAWB} → ${rsStatus || '(no status)'}`);
        }

        // 3b. Push RapidShyp status to Shopify when they don't match (keeps Shopify in sync
        //     with the courier — e.g. RapidShyp "Ready to Ship" but Shopify still "Confirmed").
        // ⚠️ RAPIDSHYP-SOURCED STATUSES ONLY — by explicit instruction (2026-08-08): we do NOT push
        // DocPharma, Kwikship or journey-derived statuses to Shopify. This is the ONLY writer here, and
        // `statusFrom` gates it, so the Kwikship/journey lookups added above stay strictly read-only:
        // they fix what the DASHBOARD shows and never change the customer-facing order on Shopify.
        // (Historically this was gated by `!fromDocpharma`, which no longer covers the new sources.)
        let statusPush = { pushed: false, reason: 'not-rapidshyp' };
        if (fulfillment && rsStatus && !order.cancelledAt && statusFrom === 'rapidshyp') {
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
            awb: result.awb, raw_status: result.status || null, last_checked: Date.now() / 1000, updated_at: new Date().toISOString()
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
