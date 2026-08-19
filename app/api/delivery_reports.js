// Delivery Performance API — aggregates shipment_journey_ecom into the 3 reports + KPIs.
// GET /api/delivery-performance?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Returns { range, kpis, statusBreakdown(partition), tat, zones, fasrTrend, rtoByCourier, ndrFunnel, shipments }.
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { supabase } = require('../supabase');
const { fetchRsShipment, fetchRsShipmentDetails, parseScanDate, parseDpDate } = require('./delivery_journey');
const { fetchKwikshipShipment, fetchKwikshipPublic, parseKwikDate } = require('./kwikship_sync');
const { fetchDocpharmaDetails, isCacheStale } = require('./helpers');
const { requirePermission } = require('../auth');
// Email-send routes below are gated by the 'send-escalation-emails' capability (admins pass via '*';
// other users only if the admin granted them this permission on the Users page). See server.js _VIEW_PERMS
// for the additional per-dashboard view gate on the claims routes.
const requireEmailSender = requirePermission('send-escalation-emails');
const { getEmailConfig, sendMail, recipientsFor } = require('./email_settings');
const { aiComplete, isConfigured: aiConfigured, lastAiError } = require('./ai');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0); // 1-dp percentage
// Calendar day in IST (en-CA → YYYY-MM-DD). Timestamps are stored as UTC instants; slicing the raw
// UTC string would mis-date orders placed 00:00–05:30 IST (they fall on the previous UTC day).
const dayKey = ts => (ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null);
// DD-MM-YYYY in IST — the display format for ALL report emails (subject + body). dayKey stays YYYY-MM-DD
// for internal grouping/sorting; dmy is used only where a human reads the date.
const dmy = ts => { const k = dayKey(ts); if (!k) return ''; const p = k.split('-'); return `${p[2]}-${p[1]}-${p[0]}`; };
// Turn a YYYY-MM-DD label (as produced by resolveRange's fmt) into DD-MM-YYYY.
const dmyLabel = ymd => { const p = String(ymd || '').split('-'); return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : String(ymd || ''); };

// Every shipment maps to EXACTLY ONE of these 5 states — the partition that sums to "tracked".
//   delivered_first + delivered_ndr + rto + ndr_pending + in_transit === total tracked
function stateOf(r) {
    if (r.outcome === 'delivered') return r.first_attempt_success ? 'delivered_first' : 'delivered_ndr';
    if (r.outcome === 'rto') return 'rto';
    if (r.outcome === 'lost') return 'lost';
    if (r.outcome === 'ndr_pending') return 'ndr_pending';
    return 'in_transit';   // in_transit + any not-yet-classified
}
const STATE_LABEL = {
    delivered_first: 'Delivered · 1st attempt',
    delivered_ndr: 'Delivered · after NDR',
    rto: 'RTO',
    lost: 'Lost',
    ndr_pending: 'NDR pending',
    in_transit: 'In-transit',
};

// Charges are deliberately NOT selected here. The expanded row reads them from /shipment/:awb (which
// selects them itself and can fetch live), so pulling 7 more columns for every one of ~5.5k rows would
// be paid on every page load and never used.
const _JOURNEY_COLS = 'awb, order_name, source, courier, outcome, attempts, ndr_count, reached_delivery, first_attempt_success, ndr_reasons, out_for_delivery_at, delivered_at, rto_at, dispatched_at, order_date, first_edd, status_code, payment_mode, zone, order_type, dest_state, dest_city, dest_pincode';
// Revenue helpers now live in ./order_value and are SHARED with the Last-Mile Funnel, so the two
// pages can never disagree about who may see ₹ or how an order's value is derived.
const { canSeeRevenue, attachOrderValue, sumV } = require('./order_value');

async function fetchJourneys(fromISO, toISO, source, payment, zone, courier, orderType, state) {
    const PAGE = 1000;
    // One filtered page query. `withCount` (page 0 only) makes Postgres return the TOTAL match count so the
    // remaining pages can be fetched in PARALLEL (was: sequential page-after-page — the main slowness here).
    const build = (offset, withCount) => {
        let q = supabase.from('shipment_journey_ecom');
        q = withCount ? q.select(_JOURNEY_COLS, { count: 'exact' }) : q.select(_JOURNEY_COLS);
        q = q.gte('order_date', fromISO).lte('order_date', toISO);
        if (source && source !== 'all') q = q.eq('source', source);      // 'rapidshyp' | 'docpharma' | 'kwikship'
        if (payment && payment !== 'all') q = q.ilike('payment_mode', payment); // 'COD' | 'prepaid'
        if (zone && zone !== 'all') q = q.eq('zone', zone);              // exact zone label
        if (courier && courier !== 'all') q = q.eq('courier', courier);  // exact courier name
        if (orderType && orderType !== 'all') q = q.eq('order_type', orderType); // 'new' | 'repeat'
        if (state && state !== 'all') q = q.ilike('dest_state', state);   // destination state (e.g. 'Kerala')
        return q.order('order_date', { ascending: false }).range(offset, offset + PAGE - 1);
    };
    const first = await build(0, true);
    if (first.error) throw new Error(first.error.message);
    const rows = first.data || [];
    const total = first.count != null ? first.count : rows.length;
    if (total > rows.length) {   // fetch the rest concurrently
        const reqs = [];
        for (let offset = PAGE; offset < total; offset += PAGE) reqs.push(build(offset, false));
        const pages = await Promise.all(reqs);
        for (const p of pages) { if (p.error) throw new Error(p.error.message); rows.push(...(p.data || [])); }
    }
    return rows;
}

// Difference between two timestamps in the requested unit (fractional), or null if missing/invalid.
function diff(a, b, unit) {
    if (!a || !b) return null;
    const t1 = new Date(a).getTime(), t2 = new Date(b).getTime();
    if (isNaN(t1) || isNaN(t2) || t2 < t1) return null;
    return (t2 - t1) / (unit === 'hrs' ? 3600000 : 86400000);
}

// Ordered bucket definitions (label + upper bound, inclusive). Last bucket = catch-all (Infinity).
const BUCKETS_HRS  = [{ label: '0-12', max: 12 }, { label: '12-24', max: 24 }, { label: '24-36', max: 36 }, { label: '36-48', max: 48 }, { label: '48+', max: Infinity }];
const BUCKETS_DAYS = [{ label: '0-1', max: 1 }, { label: '1-3', max: 3 }, { label: '3-5', max: 5 }, { label: '5+', max: Infinity }];

// Build a TAT summary { avg, unit, count, buckets:[{label,count}] } from a list of values (in `unit`).
function tatSummary(values, buckets, unit) {
    const vals = values.filter(v => v != null);
    const counts = buckets.map(b => ({ label: b.label, count: 0 }));
    vals.forEach(v => { const idx = buckets.findIndex(b => v <= b.max); counts[idx < 0 ? counts.length - 1 : idx].count++; });
    const avg = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : 0;
    return { avg, unit, count: vals.length, buckets: counts };
}

// A "silent" RTO means the courier NEVER ATTEMPTED DELIVERY — that is the claim we make against them,
// so it has to be evidence-based. It used to be inferred as "RTO with no NDR record"
// (`rto.length - ndrRto.length`), which held only for RapidShyp: that parser logs an NDR for every
// failed attempt. Kwikship does not — a parcel can go out for delivery and be returned without any NDR
// event ("Code verified cancellation"), and 139 of the 143 Kwikship RTOs labelled "silent · no
// attempt" on 2026-08-18 had an out-for-delivery scan in their own timeline (TE25-41826 among them).
// Only 4 were genuine.
//
// Now: silent = no evidence of an attempt ANYWHERE — no counted attempt, no OFD timestamp, no NDR.
// Note the claims report (`fetchSilentRto`) was never affected: it filters on the parser-set
// `rto_no_attempt` flag AND source='rapidshyp', so no wrong claim was ever emailed to a courier.
const hasAttemptEvidence = r => (r.attempts || 0) > 0 || !!r.out_for_delivery_at || (r.ndr_count || 0) > 0;
const isSilentRto = r => r.outcome === 'rto' && !hasAttemptEvidence(r);

// Full metric summary for a row set — used for the previous period in compare mode. Carries the KPI
// rates AND the partition counts / RTO split / TAT averages so the UI can show a delta everywhere.
function summarizeAll(rows) {
    const tracked = rows.length;
    const delivered = rows.filter(r => r.outcome === 'delivered');
    const rto = rows.filter(r => r.outcome === 'rto');
    const lost = rows.filter(r => r.outcome === 'lost');
    const inTransit = rows.filter(r => r.outcome === 'in_transit');
    const pending = rows.filter(r => r.outcome === 'ndr_pending');
    const firstAttempt = delivered.filter(r => r.first_attempt_success);
    const deliveredMulti = delivered.length - firstAttempt.length;
    const resolved = delivered.length + rto.length;
    const ndr = rows.filter(r => (r.ndr_count || 0) > 0);
    const ndrDelivered = ndr.filter(r => r.outcome === 'delivered');
    const ndrRto = ndr.filter(r => r.outcome === 'rto');
    const attemptsArr = [...delivered, ...rto].map(r => r.attempts || 0).filter(n => n > 0);
    const avgAttempts = attemptsArr.length ? Math.round((attemptsArr.reduce((a, b) => a + b, 0) / attemptsArr.length) * 100) / 100 : 0;

    // FIRST-ATTEMPT PARTITION — four buckets that add up to `tracked` EXACTLY, answering "what happened
    // at the door". They are mutually exclusive by construction:
    //   1 delivered on the first attempt      2 RTO with no NDR ever raised (includes silent RTOs)
    //   3 the NDR cohort                      4 whatever is still moving
    // ⚠️ Bucket 3 is `ndr_count > 0`, deliberately the SAME definition the NDR Recovery card uses as its
    // denominator, so the two cards state the same NDR total instead of two plausible different ones.
    // ⚠️ Bucket 4 is named "still in transit", NOT "not attempted": some of it HAS been attempted and is
    // going back out. Mislabelling a bucket by what most of it looks like is how "silent RTO" ended up
    // reporting 143 when the true figure was 4.
    const faNdrRows = rows.filter(r => (r.ndr_count || 0) > 0);
    const faRtoRows = rows.filter(r => r.outcome === 'rto' && (r.ndr_count || 0) === 0);
    const faTransitRows = rows.filter(r => !(r.outcome === 'delivered' && r.first_attempt_success)
        && (r.ndr_count || 0) === 0 && r.outcome !== 'rto');
    const otd = tatSummary(rows.map(r => diff(r.order_date, r.dispatched_at, 'hrs')), BUCKETS_HRS, 'hrs');
    const dtd = tatSummary(delivered.map(r => diff(r.dispatched_at, r.delivered_at, 'days')), BUCKETS_DAYS, 'days');
    const ndrPendingCohort = ndr.filter(r => r.outcome === 'ndr_pending');
    const ndrLostCohort = ndr.filter(r => r.outcome === 'lost');
    return {
        totalShipments: tracked, resolved, delivered: delivered.length, rto: rto.length, lost: lost.length,
        inTransit: inTransit.length, ndrPending: pending.length,
        firstAttempt: firstAttempt.length, deliveredMulti,
        firstAttemptCount: firstAttempt.length, ndrTotal: ndr.length, ndrRecovered: ndrDelivered.length,
        rtoAttempted: rto.length - rto.filter(isSilentRto).length, rtoSilent: rto.filter(isSilentRto).length,
        // First-attempt partition — these four sum to totalShipments exactly.
        faDelivered: firstAttempt.length, faRto: faRtoRows.length, faNdr: faNdrRows.length, faTransit: faTransitRows.length,
        fasr: pct(firstAttempt.length, tracked), rtoRate: pct(rto.length, resolved),
        deliveredRate: pct(delivered.length, tracked), ndrRecoveryRate: pct(ndrDelivered.length, ndr.length),
        avgAttempts, otdAvg: otd.avg, dtdAvg: dtd.avg,
        // NDR cohort split — the four outcomes an NDR shipment can end in. They sum to ndrTotal exactly,
        // which is the point: the recovery card shows all of them so the numbers reconcile on screen.
        ndrRtoCount: ndrRto.length, ndrPendingCount: ndrPendingCohort.length, ndrLostCount: ndrLostCohort.length,
        // ── Revenue lens (₹). Parallel to every count above; nothing here replaces a count field. ──
        rev: revSummary({ tracked: rows, delivered, rto, lost, inTransit, pending, firstAttempt,
            ndr, ndrDelivered, ndrRto, ndrPendingCohort, ndrLostCohort, resolvedRows: [...delivered, ...rto] }),
    };
}

// Revenue-weighted counterpart of the count metrics. Same definitions, same denominators — the only
// change is that each shipment contributes its order value instead of 1. Kept in ONE function so a
// rate can never be defined two different ways between the count view and the ₹ view.
function revSummary(g) {
    const trackedV = sumV(g.tracked), deliveredV = sumV(g.delivered), rtoV = sumV(g.rto);
    const resolvedV = deliveredV + rtoV;
    const firstV = sumV(g.firstAttempt), ndrV = sumV(g.ndr), ndrRecoveredV = sumV(g.ndrDelivered);
    const ndrRtoV = sumV(g.ndrRto), ndrPendingV = sumV(g.ndrPendingCohort), ndrLostV = sumV(g.ndrLostCohort);
    const pendingV = sumV(g.pending), inTransitV = sumV(g.inTransit), lostV = sumV(g.lost);
    return {
        tracked: trackedV, resolved: resolvedV, delivered: deliveredV, rto: rtoV, lost: lostV,
        inTransit: inTransitV, ndrPending: pendingV,
        firstAttempt: firstV, deliveredMulti: deliveredV - firstV,
        ndrTotal: ndrV, ndrRecovered: ndrRecoveredV,
        ndrRtoCount: ndrRtoV, ndrPendingCount: ndrPendingV, ndrLostCount: ndrLostV,
        fasr: pct(firstV, trackedV), rtoRate: pct(rtoV, resolvedV),
        deliveredRate: pct(deliveredV, trackedV), ndrRecoveryRate: pct(ndrRecoveredV, ndrV),
        // Money that has NOT yet landed and still could go either way — open NDRs + everything in transit.
        // This is the card that replaces "Avg Delivery Attempts" in ₹ mode, which has no rupee analogue.
        atRisk: pendingV + inTransitV,
        avgOrderValue: g.tracked.length ? Math.round(trackedV / g.tracked.length) : 0,
    };
}

// #1 — FASR vs NDR split by payment mode (Prepaid vs COD). COD typically has far worse NDR/RTO.
function paymentSplit(rows) {
    const groups = { COD: [], Prepaid: [] };
    rows.forEach(r => {
        const p = /cod/i.test(r.payment_mode || '') ? 'COD' : /prepaid|pre-?paid|paid/i.test(r.payment_mode || '') ? 'Prepaid' : null;
        if (p) groups[p].push(r);
    });
    const stat = arr => {
        const tracked = arr.length;
        const delivered = arr.filter(r => r.outcome === 'delivered');
        const first = delivered.filter(r => r.first_attempt_success);
        const rto = arr.filter(r => r.outcome === 'rto');
        const ndr = arr.filter(r => (r.ndr_count || 0) > 0);
        const ndrDelivered = ndr.filter(r => r.outcome === 'delivered');
        const trackedV = sumV(arr), deliveredV = sumV(delivered), rtoV = sumV(rto);
        const ndrV = sumV(ndr), firstV = sumV(first), ndrDeliveredV = sumV(ndrDelivered);
        return {
            tracked, delivered: delivered.length, ndrTotal: ndr.length, rto: rto.length,
            fasr: pct(first.length, tracked), ndrRate: pct(ndr.length, tracked),
            ndrRecoveryRate: pct(ndrDelivered.length, ndr.length), rtoRate: pct(rto.length, delivered.length + rto.length),
            deliveredRate: pct(delivered.length, tracked),
            // ₹ lens — same definitions, value-weighted
            trackedValue: trackedV, deliveredValue: deliveredV, rtoValue: rtoV, ndrValue: ndrV,
            fasrValue: pct(firstV, trackedV), ndrRateValue: pct(ndrV, trackedV),
            ndrRecoveryRateValue: pct(ndrDeliveredV, ndrV), rtoRateValue: pct(rtoV, deliveredV + rtoV),
            deliveredRateValue: pct(deliveredV, trackedV),
        };
    };
    return { COD: stat(groups.COD), Prepaid: stat(groups.Prepaid) };
}

router.get('/delivery-performance', async (req, res) => {
    try {
        const now = new Date();
        const to = req.query.to ? new Date(req.query.to) : now;
        const from = req.query.from ? new Date(req.query.from) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
        const fromISO = new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString();
        const toISO = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59).toISOString();
        // Display the LOCAL calendar dates the user picked (slicing toISOString() would shift IST midnight back a day).
        const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const source = req.query.source || 'all';   // all | rapidshyp | docpharma
        const payment = req.query.payment || 'all';  // all | COD | prepaid
        const courier = req.query.courier || 'all';  // all | <courier name>
        const orderType = req.query.order_type || 'all'; // all | new | repeat
        // Zone + State are MULTI-select: comma-separated lists ('' / 'all' → no filter).
        const csv = v => String(v || '').split(',').map(s => s.trim()).filter(s => s && s !== 'all');
        const zoneSel = csv(req.query.zone);         // e.g. ['A','B'] — empty = all
        const stateSel = csv(req.query.state);        // e.g. ['Kerala','Karnataka'] — empty = all
        const compare = req.query.compare === '1' || req.query.compare === 'true';

        // Fetch WITHOUT zone/state/courier filters so all three dropdowns list every option in range;
        // then narrow in-memory (single query). Zone + State match ANY of the selected values.
        // Compute the previous equal-length window up-front so it fetches in PARALLEL with the current one
        // (compare mode) instead of after it — halving the DB wait when comparing.
        let prevWin = null;
        if (compare) {
            const d0 = new Date(from.getFullYear(), from.getMonth(), from.getDate());
            const d1 = new Date(to.getFullYear(), to.getMonth(), to.getDate());
            const lenDays = Math.round((d1 - d0) / 86400000) + 1;      // inclusive day count
            const pTo = new Date(d0); pTo.setDate(pTo.getDate() - 1);   // day before current start
            const pFrom = new Date(pTo); pFrom.setDate(pFrom.getDate() - (lenDays - 1));
            prevWin = { from: pFrom, to: pTo,
                fromISO: new Date(pFrom.getFullYear(), pFrom.getMonth(), pFrom.getDate()).toISOString(),
                toISO: new Date(pTo.getFullYear(), pTo.getMonth(), pTo.getDate(), 23, 59, 59).toISOString() };
        }
        const [allRows, prevRowsRaw] = await Promise.all([
            fetchJourneys(fromISO, toISO, source, payment, 'all', 'all', orderType, 'all'),
            prevWin ? fetchJourneys(prevWin.fromISO, prevWin.toISO, source, payment, 'all', 'all', orderType, 'all') : Promise.resolve(null),
        ]);
        // Attach ₹ order value for the revenue lens (both windows, in parallel). Additive: every count
        // metric below is unchanged whether this succeeds or not — a failed lookup just leaves values at 0.
        // Skipped outright for users without `delivery-perf-revenue`, so no price is ever read for them.
        const revAllowed = canSeeRevenue(req);
        const [valueStat] = revAllowed
            ? await Promise.all([attachOrderValue(allRows), prevRowsRaw ? attachOrderValue(prevRowsRaw) : Promise.resolve(null)])
            : [null];
        const courierCount = {}, stateCount = {}, stateDisp = {}, zoneCount = {};
        allRows.forEach(r => {
            const c = r.courier || 'Unknown'; courierCount[c] = (courierCount[c] || 0) + 1;
            if (r.zone) zoneCount[r.zone] = (zoneCount[r.zone] || 0) + 1;
            if (r.dest_state) {                              // dedupe by lowercase so casing never duplicates a state
                const k = r.dest_state.trim().toLowerCase();
                if (!stateDisp[k]) stateDisp[k] = r.dest_state.trim();
                stateCount[k] = (stateCount[k] || 0) + 1;
            }
        });
        const couriers = Object.entries(courierCount).map(([c, n]) => ({ courier: c, count: n })).sort((a, b) => b.count - a.count);
        const zones = Object.entries(zoneCount).map(([z, n]) => ({ zone: z, count: n })).sort((a, b) => a.zone.localeCompare(b.zone));
        const states = Object.entries(stateCount).map(([k, n]) => ({ state: stateDisp[k], count: n })).sort((a, b) => b.count - a.count);
        const zoneSet = new Set(zoneSel), stateSet = new Set(stateSel.map(s => s.toLowerCase()));
        const matchFilters = r =>
            (courier === 'all' || (r.courier || 'Unknown') === courier) &&
            (zoneSet.size === 0 || zoneSet.has(r.zone)) &&
            (stateSet.size === 0 || stateSet.has(String(r.dest_state || '').toLowerCase()));
        const rows = allRows.filter(matchFilters);

        // ── Compare mode: previous equal-length window (already fetched in parallel above) ──
        let compareOut = null;
        if (compare && prevRowsRaw) {
            const pRows = prevRowsRaw.filter(matchFilters);
            compareOut = { range: { from: fmtLocal(prevWin.from), to: fmtLocal(prevWin.to) }, kpis: summarizeAll(pRows) };
        }

        // ── KPIs — denominator is TOTAL SHIPPED (= resolved: delivered + RTO). In-transit shown apart.
        //   Total Shipped − RTO = Rest ;  Rest − NDR(multi-attempt) = First-Attempt.
        const delivered   = rows.filter(r => r.outcome === 'delivered');
        const rto         = rows.filter(r => r.outcome === 'rto');
        const lost        = rows.filter(r => r.outcome === 'lost');          // terminal loss (neither delivered nor RTO)
        const inTransit   = rows.filter(r => r.outcome === 'in_transit');
        const pending     = rows.filter(r => r.outcome === 'ndr_pending');   // reached delivery, NDR, not yet resolved
        const resolved    = delivered.length + rto.length;                    // "Total Shipped" for the rates
        const firstAttempt   = delivered.filter(r => r.first_attempt_success);
        const deliveredMultiRows = delivered.filter(r => !r.first_attempt_success);  // same set, kept for ₹ sums
        const deliveredMulti = delivered.length - firstAttempt.length;        // Rest − First-Attempt (delivered after ≥1 NDR)

        // NDR cohort = shipments with ≥1 failed attempt, split by outcome (recovered vs lost vs pending)
        const ndr = rows.filter(r => (r.ndr_count || 0) > 0);
        const ndrDelivered = ndr.filter(r => r.outcome === 'delivered');
        const ndrRto = ndr.filter(r => r.outcome === 'rto');
        const ndrPending = ndr.filter(r => r.outcome === 'ndr_pending');
        const ndrLostCohort = ndr.filter(r => r.outcome === 'lost');   // rare, but must be shown or the split won't sum
        // "Silent" RTOs — returned WITHOUT a recorded failed delivery attempt (RTO'd at pickup /
        // undeliverable pre-dispatch / cancelled in transit). These are in total RTO but NOT the NDR cohort.
        const directRto = rto.length - ndrRto.length;          // reconciles the NDR funnel to total RTO
        const silentRto = rto.filter(isSilentRto);              // genuinely never attempted (see isSilentRto)

        // FIRST-ATTEMPT PARTITION — four mutually exclusive buckets summing to `tracked` (see the same
        // block in summarizeAll for why bucket 3 is ndr_count>0 and bucket 4 is not called "not attempted").
        // ⚠️ Defined here AND in summarizeAll because those build different periods; a field added to only
        // one leaves the other period blank, which is exactly what happened on the first attempt at this.
        const faNdrRows = rows.filter(r => (r.ndr_count || 0) > 0);
        const faRtoRows = rows.filter(r => r.outcome === 'rto' && (r.ndr_count || 0) === 0);
        const faTransitRows = rows.filter(r => !(r.outcome === 'delivered' && r.first_attempt_success)
            && (r.ndr_count || 0) === 0 && r.outcome !== 'rto');
        const transitRetry = inTransit.filter(hasAttemptEvidence);           // tried once, going back out

        const attemptsArr = [...delivered, ...rto].map(r => r.attempts || 0).filter(n => n > 0);
        const avgAttempts = attemptsArr.length ? Math.round((attemptsArr.reduce((a, b) => a + b, 0) / attemptsArr.length) * 100) / 100 : 0;

        const tracked = rows.length;                      // denominator for ALL rates — every tracked shipment
        const kpis = {
            totalShipments: rows.length,                  // all tracked (RapidShyp + DocPharma)
            resolved,                                     // delivered + RTO (kept for reference)
            delivered: delivered.length,
            rto: rto.length,
            lost: lost.length,
            inTransit: inTransit.length,
            pending: pending.length,
            firstAttemptCount: firstAttempt.length,
            deliveredMulti,                               // "NDR" in the model (delivered after a failed attempt)
            fasr: pct(firstAttempt.length, tracked),      // First-Attempt ÷ Total Tracked (the trend uses the same base)
            fasrNumerator: firstAttempt.length,
            // First-attempt partition — sums to totalShipments exactly. faNdr uses the same definition
            // as the NDR Recovery card's denominator so the two cards never state different NDR totals.
            faDelivered: firstAttempt.length, faRto: faRtoRows.length, faNdr: faNdrRows.length, faTransit: faTransitRows.length,
// ⚠️ RTO RATE IS MEASURED ON SETTLED SHIPMENTS, NOT ALL TRACKED (changed 2026-08-08 by request):
//     RTO% = RTO ÷ (delivered on 1st attempt + delivered after NDR + RTO) = RTO ÷ `resolved`.
// A parcel still in transit or sitting on an open NDR has not had its chance to come back yet, so
// counting it in the denominator drags the rate down and makes it move whenever shipping VOLUME moves
// rather than when returns do. On the live 30-day window that is 735/2983 = 24.6% instead of
// 735/3808 = 19.3% — the same returns, honestly measured against the orders that actually finished.
// Applied to every RTO-rate computation (headline KPI, previous-period comparison, COD/Prepaid split)
// so the dashboard never shows two different definitions of the same number.
            rtoRate: pct(rto.length, resolved),           // RTO ÷ (delivered + RTO)
            deliveredRate: pct(delivered.length, tracked),
            avgAttempts,
            ndrTotal: ndr.length,
            ndrRecovered: ndrDelivered.length,
            ndrLost: ndrRto.length,
            ndrPending: ndrPending.length,
            ndrRecoveryRate: pct(ndrDelivered.length, ndr.length),   // recovered ÷ all-NDR (your 100/300)
            // ── NDR cohort, fully partitioned (added 2026-08-12) ──────────────────────────────────
            // The card used to show recovery alone; recovery without the other three is only a third of
            // the story — on the live 30-day window 60.4% of the NDR cohort RTO'd against 28.4% recovered.
            // These four sum to ndrTotal EXACTLY, so the split can be read off the card and checked.
            ndrRtoCount: ndrRto.length, ndrRtoRate: pct(ndrRto.length, ndr.length),
            ndrPendingCount: ndrPending.length, ndrPendingRate: pct(ndrPending.length, ndr.length),
            ndrLostCount: ndrLostCohort.length, ndrLostRate: pct(ndrLostCohort.length, ndr.length),
            // ── Revenue lens (₹) — parallel to every count above, replaces nothing ──
            rev: revSummary({ tracked: rows, delivered, rto, lost, inTransit, pending, firstAttempt,
                ndr, ndrDelivered, ndrRto, ndrPendingCohort: ndrPending, ndrLostCohort,
                resolvedRows: [...delivered, ...rto] }),
        };

        // Detailed status breakdown — a TRUE PARTITION: the five states sum to `total` (tracked).
        //   delivered_first + delivered_ndr + rto + ndr_pending + in_transit === total
        const statusBreakdown = {
            total: rows.length, resolved,
            firstAttempt: firstAttempt.length,
            deliveredMulti,
            delivered: delivered.length,
            rto: rto.length,
            lost: lost.length,
            inTransit: inTransit.length,
            ndrPending: pending.length,
            // ₹ counterparts of every count above — same sets, summed by order value.
            firstAttemptValue: sumV(firstAttempt), deliveredMultiValue: sumV(deliveredMultiRows),
            deliveredValue: sumV(delivered), rtoValue: sumV(rto), lostValue: sumV(lost),
            inTransitValue: sumV(inTransit), ndrPendingValue: sumV(pending),
            // explicit partition (each shipment counted once) for the reconciliation strip
            // `value` mirrors `count` for the ₹ lens — the partition sums to totalValue exactly as the
            // counts sum to total, so the reconciliation strip stays honest in either mode.
            partition: [
                { key: 'delivered_first', label: STATE_LABEL.delivered_first, count: firstAttempt.length, value: sumV(firstAttempt) },
                { key: 'delivered_ndr',   label: STATE_LABEL.delivered_ndr,   count: deliveredMulti,      value: sumV(deliveredMultiRows) },
                { key: 'rto',             label: STATE_LABEL.rto,             count: rto.length,          value: sumV(rto) },
                { key: 'lost',            label: STATE_LABEL.lost,            count: lost.length,         value: sumV(lost) },
                { key: 'ndr_pending',     label: STATE_LABEL.ndr_pending,     count: pending.length,      value: sumV(pending) },
                { key: 'in_transit',      label: STATE_LABEL.in_transit,      count: inTransit.length,    value: sumV(inTransit) },
            ].filter(p => p.key !== 'lost' || p.count > 0),   // hide Lost bucket when there are none
            totalValue: sumV(rows), resolvedValue: sumV([...delivered, ...rto]),
        };

        // ── FASR trend (by day) — % of that day's TRACKED shipments delivered on the first attempt.
        //   Denominator = ALL tracked shipments that day (same base as the FASR card ÷ tracked), so the
        //   trend's weighted average equals the card exactly.
        const byDay = {};
        rows.forEach(r => {
            const k = dayKey(r.order_date); if (!k) return;
            (byDay[k] = byDay[k] || { tracked: 0, first: 0, trackedV: 0, firstV: 0 });
            const v = Number(r.order_value) || 0;
            byDay[k].tracked++; byDay[k].trackedV += v;
            if (r.outcome === 'delivered' && r.first_attempt_success) { byDay[k].first++; byDay[k].firstV += v; }
        });
        const fasrTrend = Object.keys(byDay).sort().map(k => ({
            date: k, reached: byDay[k].tracked, first: byDay[k].first, fasr: pct(byDay[k].first, byDay[k].tracked),
            // ₹ lens: same day, same definition, value-weighted
            reachedValue: byDay[k].trackedV, firstValue: byDay[k].firstV,   // already whole rupees
            fasrValue: pct(byDay[k].firstV, byDay[k].trackedV),
        }));

        // ── RTO by courier (% of that courier's RESOLVED shipments) ──
        const courierMap = {};
        [...delivered, ...rto].forEach(r => {
            const c = r.courier || 'Unknown';
            (courierMap[c] = courierMap[c] || { total: 0, rto: 0, totalV: 0, rtoV: 0 });
            const v = Number(r.order_value) || 0;
            courierMap[c].total++; courierMap[c].totalV += v;
            if (r.outcome === 'rto') { courierMap[c].rto++; courierMap[c].rtoV += v; }
        });
        const rtoByCourier = Object.entries(courierMap)
            .map(([courier, v]) => ({ courier, total: v.total, rto: v.rto, rtoRate: pct(v.rto, v.total),
                totalValue: v.totalV, rtoValue: v.rtoV, rtoRateValue: pct(v.rtoV, v.totalV) }))
            .sort((a, b) => b.rto - a.rto).slice(0, 12);

        // ── TAT (Turn-Around-Time) — Order→Dispatch and Dispatch→Delivery, in day buckets ──
        // Order→Dispatch: how fast we hand the parcel to the courier (order_date → dispatched_at).
        // Dispatch→Delivery: courier leg (dispatched_at → delivered_at). Only delivered shipments.
        const orderToDispatch = tatSummary(rows.map(r => diff(r.order_date, r.dispatched_at, 'hrs')), BUCKETS_HRS, 'hrs');
        const dispatchToDelivery = tatSummary(delivered.map(r => diff(r.dispatched_at, r.delivered_at, 'days')), BUCKETS_DAYS, 'days');
        const tat = { orderToDispatch, dispatchToDelivery };

        // (zones/states/couriers lists are built above from the unfiltered window, so the multi-select
        //  dropdowns always show every option regardless of the current selection.)

        // ── Unified, searchable drill-down list — EVERY tracked shipment with its state, so the
        // table can filter to any segment (any status chip / funnel slice) and search by order/AWB.
        const CAP = 6000;
        // Manual per-order marks → flag shipments so the dashboard shows a badge + can filter on them.
        const [fmRes, msRes] = await Promise.all([
            supabase.from('order_marks_ecom').select('order_name').eq('mark_type', 'likely_fake'),
            // mark_type is selected so email and sheet escalations stay DISTINCT — a sheet push shown
            // with the ✉️ badge told the agent a mail was sent that never was (user, 2026-08-19).
            supabase.from('order_marks_ecom').select('order_name, mark_type').in('mark_type', ['critical_mail_sent', 'sheet_escalated']),
        ]);
        const fakeSet = new Set((fmRes.data || []).map(m => m.order_name));
        const mailSet = new Set((msRes.data || []).filter(m => m.mark_type === 'critical_mail_sent').map(m => m.order_name));
        const sheetSet = new Set((msRes.data || []).filter(m => m.mark_type === 'sheet_escalated').map(m => m.order_name));
        // Broke its promise date? Delivered later than EDD, or still in-transit past EDD (RTO/lost = n/a).
        const nowMs = Date.now();
        const pastPromise = r => {
            if (!r.first_edd) return false;
            const eddMs = new Date(r.first_edd).getTime();
            if (r.outcome === 'delivered') return r.delivered_at ? new Date(r.delivered_at).getTime() > eddMs : false;
            if (r.outcome === 'rto' || r.outcome === 'lost') return false;
            return eddMs < nowMs;   // in-transit / ndr_pending → overdue once the promise passed
        };
        const shipments = rows
            .map(r => ({
                order: r.order_name, awb: r.awb, source: r.source, courier: r.courier,
                state: stateOf(r), outcome: r.outcome,
                value: Number(r.order_value) || 0,        // ₹ order total — powers the revenue lens + table column
                attempts: r.attempts || 0, ndr_count: r.ndr_count || 0,
                // The SERVER decides silent-vs-attempted and ships the verdict, so the explorer's row
                // filter cannot drift from the chips above it. Re-deriving it client-side is exactly how
                // the two disagreed: the KPI said 4 while the list still returned 143.
                silent: isSilentRto(r),
                // Reattempting = the courier already tried, failed, and the parcel is moving again.
                // Shipped as a verdict for the same reason as `silent`: the explorer must never
                // re-derive a rule the cards above it own.
                reattempting: r.outcome === 'in_transit' && hasAttemptEvidence(r),
                // RTO that never entered the NDR process — the "RTO 1st" bucket on the FASR card.
                // A DIFFERENT cut of the same RTO total than silent/attempted: this one splits by
                // whether an NDR was ever raised, and it CONTAINS the silent ones.
                rto_first: r.outcome === 'rto' && (r.ndr_count || 0) === 0,
                payment: r.payment_mode || null, zone: r.zone || null, order_type: r.order_type || null,
                dest_state: r.dest_state || null, dest_city: r.dest_city || null, dest_pincode: r.dest_pincode || null,
                reasons: (r.ndr_reasons || []).slice(0, 5),
                status_code: r.status_code || null,
                edd: r.first_edd || null,                 // promise date (for the Promise column)
                pastPromise: pastPromise(r),
                marked_fake: fakeSet.has(r.order_name),   // manually flagged as a likely fake attempt
                mail_sent: mailSet.has(r.order_name),     // an escalation email was sent for this order
                sheet_pushed: sheetSet.has(r.order_name), // pushed to the courier-shared escalation sheet
                otdHrs: diff(r.order_date, r.dispatched_at, 'hrs'),   // Order→Dispatch hours (null if not yet dispatched)
                order_date: dayKey(r.order_date),        // IST calendar day (see dayKey)
                delivered_at: dayKey(r.delivered_at),
                rto_at: dayKey(r.rto_at),
                // Full ISO timestamps for the click-to-expand detail timeline (formatted client-side).
                ts: { order: r.order_date || null, dispatched: r.dispatched_at || null, ofd: r.out_for_delivery_at || null,
                      delivered: r.delivered_at || null, rto: r.rto_at || null, edd: r.first_edd || null },
            }))
            .sort((a, b) => (b.order_date || '').localeCompare(a.order_date || ''));
        const shipmentsTruncated = shipments.length > CAP;

        // Strip EVERY ₹ field for users without the capability. The lookup was already skipped so these
        // are all zeros rather than real prices, but shipping a zeroed shadow of a restricted metric is
        // still confusing — and deleting by SHAPE (`rev`, `*Value`, `value`) means any revenue field added
        // to this payload in future is withheld automatically, instead of leaking until someone remembers
        // to add it to a list. Scoped to this response object only, which contains no other such keys.
        const stripRevenue = (o) => {
            if (Array.isArray(o)) { o.forEach(stripRevenue); return o; }
            if (!o || typeof o !== 'object') return o;
            for (const k of Object.keys(o)) {
                if (k === 'rev' || k === 'value' || k === 'valueCoverage' || /Value$/.test(k)) { delete o[k]; continue; }
                stripRevenue(o[k]);
            }
            return o;
        };
        const payload = {
            success: true,
            range: { from: fmtLocal(from), to: fmtLocal(to) }, source, payment, courier, orderType, zone: zoneSel, state: stateSel,
            compare: compareOut,
            kpis, statusBreakdown, tat, zones, states, couriers,
            // Coverage of the ₹ lens. `complete:false` means a lookup batch failed and the revenue
            // figures are UNDERSTATED — the UI says so rather than presenting a confident wrong total.
            valueCoverage: valueStat || { total: 0, matched: 0, failedBatches: 0, complete: true },
            // Total RTO split by whether the courier ever attempted delivery — the 340/73 breakdown.
            rtoBreakdown: { attempted: rto.length - silentRto.length, silent: silentRto.length, total: rto.length,
                attemptedValue: sumV(rto) - sumV(silentRto), silentValue: sumV(silentRto), totalValue: sumV(rto),
                // A SECOND, independent cut of the same total: by whether an NDR was ever raised.
                // first + afterNdr = total, just as attempted + silent = total. The two cuts overlap —
                // `first` includes every silent RTO — so they must never be added together.
                first: faRtoRows.length, afterNdr: rto.length - faRtoRows.length,
                firstValue: sumV(faRtoRows), afterNdrValue: sumV(rto) - sumV(faRtoRows) },
            // In-transit split the same way the RTO row splits: parcels the courier has already tried and
            // is carrying back out, versus ones it has not reached yet. 518 of 574 never attempted is a
            // pickup/linehaul story; the 56 reattempting are a delivery story. One number hid both.
            transitBreakdown: { total: inTransit.length,
                reattempting: transitRetry.length, fresh: inTransit.length - transitRetry.length,
                totalValue: sumV(inTransit), reattemptingValue: sumV(transitRetry),
                freshValue: sumV(inTransit) - sumV(transitRetry) },
            // NDR funnel is the cohort with ≥1 failed attempt; directRto reconciles it to TOTAL RTO.
            ndrFunnel: { total: ndr.length, recovered: ndrDelivered.length, lost: ndrRto.length, pending: ndrPending.length, directRto, totalRto: rto.length,
                totalValue: sumV(ndr), recoveredValue: sumV(ndrDelivered), lostValue: sumV(ndrRto),
                pendingValue: sumV(ndrPending), directRtoValue: sumV(rto) - sumV(ndrRto), totalRtoValue: sumV(rto) },
            fasrTrend, rtoByCourier,
            byPayment: paymentSplit(rows),   // #1 — Prepaid vs COD FASR/NDR/RTO comparison
            shipments: shipments.slice(0, CAP), shipmentsTruncated, shipmentsTotal: shipments.length,
            // The client hides the ₹ toggle and the Value column on this, and also treats a missing flag
            // as "not allowed" — but the stripping above is what actually enforces it.
            revenueAllowed: revAllowed,
        };
        res.json(revAllowed ? payload : stripRevenue(payload));
    } catch (e) {
        console.error('[DeliveryPerf] error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Excel report: RTO WITHOUT ATTEMPT ───────────────────────────────────────────────────────────
// RTO shipments that were returned with NO "Out for Delivery" scan (rto_no_attempt) — the courier
// never attempted delivery (a "silent RTO"). Sheet 1 = one row per order; Sheet 2 = the full scan
// log (evidence) captured from RapidShyp.
router.get('/reports/rto-no-attempt', async (req, res) => {
    try {
        const now = new Date();
        const to = req.query.to ? new Date(req.query.to) : now;
        const from = req.query.from ? new Date(req.query.from) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
        const fromISO = new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString();
        const toISO = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59).toISOString();
        const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        // Pull all flagged rows in the window (paginated).
        const rows = [];
        const PAGE = 1000;
        for (let offset = 0; ; offset += PAGE) {
            const { data, error } = await supabase
                .from('shipment_journey_ecom')
                .select('order_name, awb, source, courier, payment_mode, zone, order_date, rto_at, attempts, ndr_count, raw')
                .eq('rto_no_attempt', true)
                .gte('order_date', fromISO).lte('order_date', toISO)
                .order('rto_at', { ascending: false })
                .range(offset, offset + PAGE - 1);
            if (error) throw new Error(error.message);
            rows.push(...(data || []));
            if (!data || data.length < PAGE) break;
        }

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Ecom Central';
        const HEAD = { bold: true, color: { argb: 'FFFFFFFF' } };
        const HFILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };

        // Sheet 1 — summary
        const s1 = wb.addWorksheet('RTO · No Attempt');
        s1.columns = [
            { header: 'Order', key: 'order', width: 16 },
            { header: 'AWB', key: 'awb', width: 22 },
            { header: 'Courier', key: 'courier', width: 20 },
            { header: 'Source', key: 'source', width: 12 },
            { header: 'Payment', key: 'payment', width: 10 },
            { header: 'Zone', key: 'zone', width: 8 },
            { header: 'Order Date', key: 'order_date', width: 14 },
            { header: 'RTO Date', key: 'rto_at', width: 16 },
            { header: 'Attempts', key: 'attempts', width: 10 },
            { header: 'Scans on record', key: 'scancount', width: 16 },
        ];
        s1.getRow(1).eachCell(c => { c.font = HEAD; c.fill = HFILL; });
        rows.forEach(r => {
            const scans = (r.raw && Array.isArray(r.raw.scans)) ? r.raw.scans : [];
            s1.addRow({
                order: r.order_name || '—', awb: r.awb || '—', courier: r.courier || '—',
                source: r.source || '—', payment: r.payment_mode || '—', zone: r.zone || '—',
                order_date: r.order_date ? String(r.order_date).slice(0, 10) : '—',
                rto_at: r.rto_at ? String(r.rto_at).slice(0, 10) : '—',
                attempts: r.attempts || 0, scancount: scans.length,
            });
        });

        // Sheet 2 — the scan log (evidence), one row per scan
        const s2 = wb.addWorksheet('Scan Log');
        s2.columns = [
            { header: 'Order', key: 'order', width: 16 },
            { header: 'AWB', key: 'awb', width: 22 },
            { header: '#', key: 'n', width: 5 },
            { header: 'Scan Time', key: 'time', width: 22 },
            { header: 'Code', key: 'code', width: 10 },
            { header: 'Status / Scan', key: 'scan', width: 40 },
            { header: 'Location', key: 'loc', width: 30 },
        ];
        s2.getRow(1).eachCell(c => { c.font = HEAD; c.fill = HFILL; });
        rows.forEach(r => {
            const scans = (r.raw && Array.isArray(r.raw.scans)) ? r.raw.scans : [];
            if (!scans.length) {
                s2.addRow({ order: r.order_name || '—', awb: r.awb || '—', n: '', time: '', code: '', scan: '(scan log not yet captured — will populate on next refresh)', loc: '' });
                return;
            }
            // chronological (oldest first)
            const ordered = [...scans].sort((a, b) => String(a.scan_datetime || '').localeCompare(String(b.scan_datetime || '')));
            ordered.forEach((sc, i) => s2.addRow({
                order: i === 0 ? (r.order_name || '—') : '', awb: i === 0 ? (r.awb || '—') : '',
                n: i + 1, time: sc.scan_datetime || sc.date || '', code: sc.rapidshyp_status_code || '',
                scan: sc.scan || sc.status_desc || sc.status || '', loc: sc.scan_location || sc.location || '',
            }));
        });

        const fname = `rto-without-attempt_${fmtLocal(from)}_to_${fmtLocal(to)}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) {
        console.error('[NoAttemptReport] error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Per-shipment detail (click-to-expand) — timeline is instant from the stored journey; the full
//    scan log is served from cache if present, else fetched live ONCE (1 API call) and cached back. ──
router.get('/delivery-performance/shipment/:awb', async (req, res) => {
    const awb = String(req.params.awb || '').trim();
    if (!awb) return res.status(400).json({ success: false, error: 'awb required' });
    try {
        const { data: j } = await supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, outcome, status_code, order_date, dispatched_at, out_for_delivery_at, delivered_at, rto_at, last_scan_at, first_edd, ndr_reasons, attempts, ndr_count, raw, freight_total, freight_forward, freight_rto, cod_charges, shipment_value, applied_weight, charges_fetched_at')
            .eq('awb', awb).maybeSingle();

        // Normalize any scan array → { at, desc, code, location }, oldest first.
        const norm = (scans) => (scans || []).map(s => ({
            at: parseScanDate(s.scan_datetime || s.date || s.timestamp || s.event_time || s.event_date) || null,
            desc: s.scan || s.status_desc || s.status || s.activity || s.remark || '',
            code: s.rapidshyp_status_code || s.status_code || '',
            location: s.scan_location || s.location || s.city || '',
        })).filter(x => x.desc).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
        // Kwikship status_history → { at, desc, code, location } (its own shape; used for both cache-read + live).
        const ksHuman = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        // Accepts BOTH Kwikship shapes: v1 (auth) {datetime, description} and v2 (public)
        // {status_datetime, shipper_remark}. `shipper_remark` is the human reason a support agent needs
        // ("Consignee Unavailable"); v1's `description` is a courier code ("UD_EOD-11_Pending") that says
        // nothing — so prefer the remark and keep the code as the fallback.
        const ksScans = (hist) => (hist || [])
            .map(h => ({
                at: parseKwikDate(h.status_datetime || h.datetime || h.date || h.creation_datetime),
                desc: h.shipper_remark || h.description || ksHuman(h.status),
                code: h.status || '',
                location: h.location || '',
            }))
            .filter(x => x.desc).sort((a, b) => (a.at || '').localeCompare(b.at || ''));

        // The cached scan log — raw.scans (RapidShyp) or raw.status_history (Kwikship).
        const cachedScans = (j && j.raw && Array.isArray(j.raw.scans)) ? norm(j.raw.scans)
            : (j && j.raw && Array.isArray(j.raw.status_history)) ? ksScans(j.raw.status_history)
            : null;

        // ⚠️ This cache was WRITE-ONCE-READ-FOREVER and silently froze the timeline (fixed 2026-08-17).
        // It was written the first time anyone opened a shipment and then served verbatim for the life of
        // the row, because the live fetch below only ran when the cache was EMPTY. TE25-40754 was captured
        // on 13 Aug at 13:06 IST, so its log ended at "Out for delivery 11:32" — while the shipment had
        // gone RTO at 16:17 the same day and the journey row had `last_scan_at` four days newer. Support
        // and Delivery Performance read the same endpoint, so both showed the same frozen log. Measured at
        // the fix: 79 of the 189 cached logs were stale (45 Kwikship + 34 RapidShyp) — and they are stale
        // precisely on the shipments people looked at, which are the ones being chased.
        //
        // `last_scan_at` is the free half of this: the webhook/cron already records when the courier last
        // moved, so a newer value than `captured_at` PROVES the cache is behind without spending an API
        // call. The TTL only covers rows where that signal is missing. Decided by the shared
        // isCacheStale() rule in helpers.js — read the note there before adding another cache.
        const SCAN_TTL_MIN = parseInt(process.env.SCAN_CACHE_TTL_MIN, 10) || 30;
        const cacheStale = isCacheStale({
            capturedAt: j && j.raw && j.raw.captured_at,
            signalAt:   j && j.last_scan_at,
            ttlMs:      SCAN_TTL_MIN * 60000,
            frozen:     j && j.outcome === 'delivered',   // delivered = nothing further will happen
        });

        let scans = cacheStale ? null : cachedScans;
        let live = false;
        let dpInfo = null;   // DocPharma-only: tracking link + current status + promise EDD (no scan log upstream)

        if (!scans || !scans.length) {
            if (j?.source === 'kwikship') {                        // Kwikship — real status_history timeline (by AWB)
                // PUBLIC v2 first: same timeline, plus the per-scan `shipper_remark`, and no auth needed.
                // Falls back to the authenticated v1 if v2 is unavailable.
                let ks = await fetchKwikshipPublic(awb);
                if (!(ks.found && ks.statusHistory && ks.statusHistory.length)) ks = await fetchKwikshipShipment(awb);
                if (ks.found && ks.statusHistory && ks.statusHistory.length) {
                    scans = ksScans(ks.statusHistory); live = true;
                    // Always re-cache, never only-when-empty: refreshing without writing back would
                    // leave the stale copy in place and re-fetch on every single view.
                    if (j) {
                        supabase.from('shipment_journey_ecom')
                            .update({ raw: { ...(j.raw || {}), status_history: ks.statusHistory, status: ks.status, captured_at: new Date().toISOString() } })
                            .eq('awb', awb).then(() => {}).catch(() => {});
                    }
                }
            } else if (j?.source !== 'docpharma') {                // RapidShyp by AWB
                const rs = await fetchRsShipment(awb);
                if (rs.found && rs.scans && rs.scans.length) {
                    scans = norm(rs.scans); live = true;
                    if (j) {                                       // always re-cache (see the Kwikship note above)
                        supabase.from('shipment_journey_ecom')
                            .update({ raw: { ...(j.raw || {}), scans: rs.scans, status: rs.status, status_code: rs.statusCode, captured_at: new Date().toISOString() } })
                            .eq('awb', awb).then(() => {}).catch(() => {});
                    }
                }
            }
            // The courier didn't answer. A stale log beats an empty panel — and beats the synthesized
            // DocPharma milestones below, which would otherwise replace a real timeline with a stub.
            if ((!scans || !scans.length) && cachedScans && cachedScans.length) scans = cachedScans;
            if ((!scans || !scans.length) && j?.source !== 'kwikship' && j?.order_name) {      // DocPharma fallback by order name
                try {
                    const dp = await fetchDocpharmaDetails(String(j.order_name).replace('#', '').trim());
                    const so = (dp && dp.suborders && dp.suborders[0]) || {};
                    const ld = so.logistic_details || {};
                    const hist = ld.tracking_history || (dp && dp.tracking_history) || [];
                    if (hist.length) { scans = norm(hist); live = true; }     // (DocPharma never actually sends this today)
                    else if (dp) {
                        // DocPharma has NO granular scan log — only status milestones. Synthesize what it does give:
                        // order placed → current status → any re-attempt. Plus tracking link + promise EDD.
                        const human = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                        const syn = [];
                        if (j.order_date) syn.push({ at: j.order_date, desc: 'Order placed', code: '', location: '' });
                        if (ld.current_status) syn.push({ at: parseDpDate(so.created_at), desc: human(ld.current_status), code: '', location: '' });
                        if ((ld.reattempt_count || 0) > 0 && ld.reattempt_date) syn.push({ at: parseDpDate(ld.reattempt_date), desc: 'Re-attempt' + (ld.reason ? ` — ${ld.reason}` : ''), code: '', location: '' });
                        scans = syn.filter(x => x.desc); live = true;
                        const showReason = (ld.reason && (/rto|return/i.test(j.outcome || '') || (ld.reattempt_count || 0) > 0)) ? ld.reason : null;
                        dpInfo = {
                            tracking_url: ld.tracking_url || null,
                            tracking_number: ld.tracking_number || null,
                            current_status: ld.current_status ? human(ld.current_status) : null,
                            edd: parseDpDate(so.eta || dp.eta) || null,
                            reason: showReason,
                            note: 'DocPharma provides status milestones and a live tracking link — not a scan-by-scan log like RapidShyp.',
                        };
                    }
                } catch (_e) { /* ignore */ }
            }
        }

        // ── Shipment charges for the expanded row ────────────────────────────────────────────────
        // Stored charges cover FINAL shipments (delivered 89% / RTO 88%) but almost no live ones
        // (in-transit 0%, NDR-pending 3%) because the charges sync only prices final shipments. Those
        // live ones are exactly what the explorer is used to chase, so when a RapidShyp shipment has no
        // stored charge we fetch it ON DEMAND — one call, only when a human actually expands the row —
        // and persist it so the next expand (and the recon) costs nothing.
        let charges = null, chargesLive = false;
        if (j) {
            // "Already attempted" is `charges_fetched_at`, NOT the presence of a freight number:
            // RapidShyp only prices a shipment once it is FINAL, so a live in-transit fetch legitimately
            // returns shipment value + applied weight with freight still null. Keying off freight would
            // re-call their API on every expand forever; keying off the stamp means one call per shipment,
            // and the nightly charges sync fills the freight in once the shipment settles.
            if (j.charges_fetched_at || j.freight_total != null) {
                charges = { freight_total: j.freight_total, freight_forward: j.freight_forward, freight_rto: j.freight_rto,
                    cod_charges: j.cod_charges, shipment_value: j.shipment_value, applied_weight: j.applied_weight,
                    fetched_at: j.charges_fetched_at || null };
            } else if (j.source === 'rapidshyp') {
                try {
                    const c = await fetchRsShipmentDetails(awb);
                    if (c.found) {
                        charges = { freight_total: c.freight_total, freight_forward: c.freight_forward, freight_rto: c.freight_rto,
                            cod_charges: c.cod_charges, shipment_value: c.shipment_value, applied_weight: c.applied_weight,
                            fetched_at: new Date().toISOString() };
                        chargesLive = true;
                        // Persist so this is a one-time cost per shipment.
                        supabase.from('shipment_journey_ecom').update({
                            freight_total: c.freight_total, freight_forward: c.freight_forward, freight_rto: c.freight_rto,
                            cod_charges: c.cod_charges, shipment_value: c.shipment_value, applied_weight: c.applied_weight,
                            charges_fetched_at: new Date().toISOString(),
                        }).eq('awb', awb).then(() => {}, () => {});
                    }
                } catch (_e) { /* charges are a nice-to-have — never fail the detail view */ }
            }
        }

        res.json({
            success: true, awb, source: j ? j.source : null, live, scans: scans || [], dp: dpInfo,
            charges, chargesLive,
            journey: j ? {
                order_name: j.order_name, courier: j.courier, outcome: j.outcome, status_code: j.status_code,
                attempts: j.attempts, ndr_count: j.ndr_count, ndr_reasons: j.ndr_reasons || [],
                // Prefer the live DocPharma EDD when the stored journey doesn't have one yet.
                ts: { order: j.order_date, dispatched: j.dispatched_at, ofd: j.out_for_delivery_at, delivered: j.delivered_at, rto: j.rto_at, edd: j.first_edd || (dpInfo && dpInfo.edd) || null },
            } : null,
        });
    } catch (e) {
        console.error('[ShipmentDetail] error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ═══════════════ Silent-RTO Claims (#2) & Late Deliveries (#5) ═══════════════
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const inr = n => '₹' + round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Resolve a { from, to } query (from req.query or a plain object) into ISO instants + display labels.
function resolveRange(src, defaultDays = 30) {
    const q = (src && src.query) || src || {};
    const now = new Date();
    const to = q.to ? new Date(q.to) : now;
    const from = q.from ? new Date(q.from) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - defaultDays);
    const fromISO = new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString();
    const toISO = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59).toISOString();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { fromISO, toISO, fromLabel: fmt(from), toLabel: fmt(to), rangeLabel: `${fmt(from)} → ${fmt(to)}`, rangeLabelDMY: `${dmyLabel(fmt(from))} → ${dmyLabel(fmt(to))}` };
}
// A rolling window of `days` that ENDS yesterday (used by the scheduled report crons — "till yesterday").
function rangeEndingYesterday(days) {
    const now = new Date();
    const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const from = new Date(yest.getFullYear(), yest.getMonth(), yest.getDate() - (days - 1));
    const fromISO = new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString();
    const toISO = new Date(yest.getFullYear(), yest.getMonth(), yest.getDate(), 23, 59, 59).toISOString();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { fromISO, toISO, fromLabel: fmt(from), toLabel: fmt(yest), rangeLabel: `${fmt(from)} → ${fmt(yest)}`, rangeLabelDMY: `${dmyLabel(fmt(from))} → ${dmyLabel(fmt(yest))}` };
}
// Given a range object (from resolveRange/rangeEndingYesterday), the DMY label for email display.
const emailRangeLabel = rg => rg.rangeLabelDMY || dmyLabel(rg.fromLabel) + ' → ' + dmyLabel(rg.toLabel);
const PLATFORM_LABEL = { rapidshyp: 'RapidShyp', docpharma: 'DocPharma', kwikship: 'KwikShip' };

// ── AUTOMATIC MAIL BLOCKLIST ─────────────────────────────────────────────────────────────────────
// Couriers that must NEVER receive an UNATTENDED (cron) report. Manual sends from the dashboard are
// deliberately unaffected — this is about mail that goes out with nobody watching.
//
// ⚠️ ENFORCED IN THE SENDERS, NOT IN THE CRONS. The first attempt at this excluded RapidShyp from the
// one DAILY cron only, and the weekly Silent-RTO + fortnightly Late-Deliveries kept mailing them,
// because each cron carries its own recipient logic. A per-cron opt-out is something you must remember
// three times over, and again for every report added later. Blocking at the send path makes a blocked
// courier silent by default — a new report cannot forget it.
// To resume mail to a courier: remove it from this set. One line, one place.
//
// ⚠️ THE DEFAULT IS "AUTOMATIC". A sender is treated as unattended unless the caller explicitly says
// `manual: true`, which only the dashboard's own /send routes do. The first version had this the other
// way round — crons opted IN with `auto: true` — and it failed exactly as an opt-in scheme does: the
// Intransit-Late cron was added to that list by nobody, so it kept mailing RapidShyp daily after the
// other three were stopped. Fail safe: a NEW cron is silent to a blocked courier without anyone
// remembering to wire it up.
const AUTO_MAIL_BLOCKED = new Set(['rapidshyp']);
const autoBlocked = (platform, manual) => !manual && AUTO_MAIL_BLOCKED.has(platform);

// Send a delivery report as SEPARATE emails per platform — RapidShyp rows go to the RapidShyp recipients,
// DocPharma rows to the DocPharma recipients (each configured in Settings → Email & Reports). `source`
// restricts to one platform; otherwise BOTH are attempted. A platform is skipped when it has no matching
// rows OR no recipient configured. fetchFn(fromISO,toISO,platform,extra) → rows; buildFn(rows,rangeLabel,
// platform,extra) → { subject, html }. Returns { ok, skipped?, reason?, to, count, results }.
async function sendReportPerPlatform({ fetchFn, buildFn, rg, source, extra, exclude, manual, dryRun }) {
    const skip = new Set(exclude || []);
    const platforms = (source ? [source] : ['rapidshyp', 'docpharma', 'kwikship']).filter(p => !skip.has(p));
    const results = [];
    for (const p of platforms) {
        if (autoBlocked(p, manual)) { results.push({ platform: p, count: 0, skipped: true, reason: `${PLATFORM_LABEL[p] || p}: automatic mail disabled` }); continue; }
        const rows = await fetchFn(rg.fromISO, rg.toISO, p, extra);
        if (!rows.length) { results.push({ platform: p, count: 0, skipped: true, reason: `${PLATFORM_LABEL[p] || p}: none in range` }); continue; }
        const rcpt = await recipientsFor(p);
        if (!rcpt.to.length) { results.push({ platform: p, count: rows.length, skipped: true, reason: `${PLATFORM_LABEL[p] || p}: no recipient set in Settings` }); continue; }
        const mail = buildFn(rows, emailRangeLabel(rg), p, extra);
        // dryRun → build everything, send nothing. See the note on sendSilentRtoReport: this is how you
        // verify a report's routing without putting mail in a courier's inbox.
        if (dryRun) { results.push({ platform: p, count: rows.length, to: rcpt.to, dryRun: true }); continue; }
        const r = await sendMail({ to: rcpt.to, cc: rcpt.cc, subject: mail.subject, html: mail.html });
        results.push({ platform: p, count: rows.length, to: r.to });
    }
    const sent = results.filter(r => !r.skipped);
    if (!sent.length) return { ok: false, skipped: true, reason: results.map(r => r.reason).join(' · '), results };
    return { ok: true, to: [...new Set(sent.flatMap(r => r.to || []))], count: sent.reduce((a, r) => a + r.count, 0), results };
}

// ── #2 Silent RTO: returned to origin with ZERO delivery attempts → freight is disputable with RapidShyp.
async function fetchSilentRto(fromISO, toISO) {
    const rows = []; const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, order_date, rto_at, updated_at, payment_mode, zone, dest_state, dest_city, freight_total, freight_forward, freight_rto, cod_charges, shipment_value, charges_fetched_at')
            .eq('source', 'rapidshyp').eq('outcome', 'rto').eq('rto_no_attempt', true)
            .gte('order_date', fromISO).lte('order_date', toISO)
            .order('order_date', { ascending: false }).range(offset, offset + PAGE - 1);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return rows;
}
function silentRtoSummary(rows) {
    const priced = rows.filter(r => r.freight_total != null);
    return {
        count: rows.length, priced: priced.length,
        totalFreight: round2(rows.reduce((a, r) => a + (Number(r.freight_total) || 0), 0)),
        totalValue: round2(rows.reduce((a, r) => a + (Number(r.shipment_value) || 0), 0)),
    };
}
function buildSilentRtoMail(rows, rangeLabel) {
    const s = silentRtoSummary(rows);
    const body = rows.map((r, i) => `<tr style="background:${i % 2 ? '#f8fafc' : '#fff'}">
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.order_name)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.awb)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.courier || '')}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${dmy(r.order_date)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;text-align:right;">${r.freight_total != null ? inr(r.freight_total) : '—'}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;text-align:right;">${r.shipment_value != null ? inr(r.shipment_value) : '—'}</td></tr>`).join('');
    const totalRow = `<tr style="font-weight:700;background:#eef2ff"><td colspan="4" style="padding:9px 10px;">Total — ${s.count} shipments</td><td style="padding:9px 10px;text-align:right;">${inr(s.totalFreight)}</td><td style="padding:9px 10px;text-align:right;">${inr(s.totalValue)}</td></tr>`;
    const foot = s.priced < s.count ? `${s.count - s.priced} shipment(s) not yet priced by RapidShyp — shown as "—" and excluded from the freight total.` : '';
    const html = mailShell('Silent RTO — Claim Report',
        'Shipments returned to origin with no delivery attempt. Forward + RTO freight is disputable.',
        rangeLabel,
        ['Order', 'AWB', 'Courier', 'Order date', 'Shipping cost', 'Invoice value'],
        [4, 5], body + totalRow, foot);
    return { subject: `Silent RTO Claim — ${s.count} shipments, ${inr(s.totalFreight)} freight (${rangeLabel})`, html };
}
async function sendSilentRtoReport(opts = {}) {
    // This report is RapidShyp-only and addresses them directly (it never goes through
    // sendReportPerPlatform), so the blocklist has to be applied here too — this is the weekly mail that
    // kept going after the daily one was stopped.
    if (autoBlocked('rapidshyp', opts.manual)) return { ok: false, skipped: true, reason: 'RapidShyp: automatic mail disabled' };
    const rg = opts.fromISO ? opts : rangeEndingYesterday(opts.days || 7);
    const rows = await fetchSilentRto(rg.fromISO, rg.toISO);          // RapidShyp-only by design
    if (!rows.length) return { ok: false, skipped: true, reason: 'No silent-RTO shipments in the selected range.' };
    const mail = buildSilentRtoMail(rows, emailRangeLabel(rg));
    let to = opts.to, cc;
    if (!to) { const rcpt = await recipientsFor('rapidshyp'); to = rcpt.to; cc = rcpt.cc; }
    if (!to || !to.length) throw new Error('No RapidShyp recipient set — add it in Settings → Email & Reports.');
    // dryRun → resolve recipients and build the mail, but DO NOT send. Added after a verification run of the
    // "stop mailing RapidShyp" change called this function directly and put a real report in their inbox:
    // there was no way to exercise the path without sending. Never test a sender without this.
    if (opts.dryRun) return { ok: true, dryRun: true, to, count: rows.length };
    const r = await sendMail({ to, cc, subject: mail.subject, html: mail.html });
    return { ok: true, to: r.to, count: rows.length };
}

// ── #5 Late deliveries: DELIVERED after the promised EDD (delivered_at > first_edd), only delivered.
async function fetchLateDeliveries(fromISO, toISO, source) {
    const rows = []; const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        let q = supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, order_date, first_edd, delivered_at, payment_mode, zone, dest_state, dest_city, shipment_value')
            .eq('outcome', 'delivered')                            // both platforms (RapidShyp + DocPharma)
            .not('first_edd', 'is', null).not('delivered_at', 'is', null)
            .gte('order_date', fromISO).lte('order_date', toISO);
        if (source) q = q.eq('source', source);                    // honor the dashboard's platform filter
        const { data, error } = await q.order('order_date', { ascending: false }).range(offset, offset + PAGE - 1);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return rows.map(r => { const late = lateDays(r.first_edd, r.delivered_at); return late > 0 ? { ...r, days_late: late } : null; })
        .filter(Boolean).sort((a, b) => b.days_late - a.days_late);
}
// Whole days delivered PAST the promised EDD, by IST calendar date (edd is stamped end-of-day 23:59:59).
function lateDays(edd, delivered) {
    const e = dayKey(edd), d = dayKey(delivered);
    if (!e || !d || d <= e) return 0;
    return Math.round((new Date(d + 'T00:00:00Z') - new Date(e + 'T00:00:00Z')) / 86400000);
}
function lateSummary(rows) {
    const n = rows.length;
    const buckets = { '1 day': 0, '2-3 days': 0, '4-7 days': 0, '8+ days': 0 };
    rows.forEach(r => { const x = r.days_late; buckets[x === 1 ? '1 day' : x <= 3 ? '2-3 days' : x <= 7 ? '4-7 days' : '8+ days']++; });
    return { count: n, avgDaysLate: n ? round2(rows.reduce((a, r) => a + r.days_late, 0) / n) : 0, maxDaysLate: rows.reduce((m, r) => Math.max(m, r.days_late), 0), buckets };
}
function buildLateMail(rows, rangeLabel, platform) {
    const s = lateSummary(rows);
    const pTag = platform ? ` · ${PLATFORM_LABEL[platform] || platform}` : '';
    const body = rows.map((r, i) => `<tr style="background:${i % 2 ? '#f8fafc' : '#fff'}">
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.order_name)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.awb)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.courier || '')}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${dmy(r.first_edd)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${dmy(r.delivered_at)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;text-align:right;font-weight:700;color:${r.days_late >= 4 ? '#b91c1c' : '#b45309'};">${r.days_late}</td></tr>`).join('');
    const html = mailShell('Late Deliveries — Promise Date Exceeded',
        'Orders delivered AFTER their promised delivery date (delivered only).',
        rangeLabel,
        ['Order', 'AWB', 'Courier', 'Promised (EDD)', 'Delivered', 'Days late'],
        [5], body,
        `${s.count} late · avg ${s.avgDaysLate} days · worst ${s.maxDaysLate} days.`);
    return { subject: `Late Deliveries${pTag} — ${s.count} orders past promise date (${rangeLabel})`, html };
}
async function sendLateDeliveriesReport(opts = {}) {
    const rg = opts.fromISO ? opts : rangeEndingYesterday(opts.days || 30);
    return sendReportPerPlatform({ fetchFn: fetchLateDeliveries, buildFn: buildLateMail, rg, source: opts.source, manual: opts.manual, dryRun: opts.dryRun });
}

// ── In-transit but PAST promise date: overdue shipments not yet delivered/RTO (proactive chase list).
function overdueDays(edd) {
    const e = dayKey(edd), t = dayKey(new Date().toISOString());
    if (!e || !t || t <= e) return 0;
    return Math.round((new Date(t + 'T00:00:00Z') - new Date(e + 'T00:00:00Z')) / 86400000);
}
async function fetchIntransitLate(fromISO, toISO, source) {
    const nowISO = new Date().toISOString();
    const rows = []; const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        let q = supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, order_date, first_edd, payment_mode, zone, dest_state, dest_city, outcome, status_code, ndr_count, shipment_value')
            .in('outcome', ['in_transit', 'ndr_pending'])          // still on the way (not delivered/rto/lost)
            .not('first_edd', 'is', null).lt('first_edd', nowISO)   // promise date already passed
            .gte('order_date', fromISO).lte('order_date', toISO);
        if (source) q = q.eq('source', source);                    // honor the dashboard's platform filter
        const { data, error } = await q.order('first_edd', { ascending: true }).range(offset, offset + PAGE - 1);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return rows.map(r => ({ ...r, days_overdue: overdueDays(r.first_edd) }))
        .filter(r => r.days_overdue > 0).sort((a, b) => b.days_overdue - a.days_overdue);
}
function intransitSummary(rows) {
    const n = rows.length;
    const buckets = { '1-2 days': 0, '3-5 days': 0, '6-10 days': 0, '10+ days': 0 };
    rows.forEach(r => { const x = r.days_overdue; buckets[x <= 2 ? '1-2 days' : x <= 5 ? '3-5 days' : x <= 10 ? '6-10 days' : '10+ days']++; });
    return { count: n, avgOverdue: n ? round2(rows.reduce((a, r) => a + r.days_overdue, 0) / n) : 0, maxOverdue: rows.reduce((m, r) => Math.max(m, r.days_overdue), 0), severe: buckets['6-10 days'] + buckets['10+ days'], buckets };
}
function buildIntransitMail(rows, rangeLabel, platform) {
    const s = intransitSummary(rows);
    const pTag = platform ? ` · ${PLATFORM_LABEL[platform] || platform}` : '';
    const body = rows.map((r, i) => `<tr style="background:${i % 2 ? '#f8fafc' : '#fff'}">
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.order_name)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.awb)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.courier || '')}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${dmy(r.order_date)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${dmy(r.first_edd)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;text-align:right;font-weight:700;color:${r.days_overdue >= 6 ? '#b91c1c' : '#b45309'};">${r.days_overdue}</td></tr>`).join('');
    const html = mailShell('In-Transit — Overdue (Promise Date Passed)',
        'Shipments still in transit whose promised delivery date has already passed — please chase.',
        rangeLabel,
        ['Order', 'AWB', 'Courier', 'Order date', 'Promised (EDD)', 'Days overdue'],
        [5], body,
        `${s.count} overdue · avg ${s.avgOverdue} days · worst ${s.maxOverdue} days · ${s.severe} over 5 days.`);
    return { subject: `In-Transit Overdue${pTag} — ${s.count} shipments past promise date (${rangeLabel})`, html };
}
async function sendIntransitLateReport(opts = {}) {
    const rg = opts.fromISO ? opts : resolveRange({ from: null, to: null }, 30);
    return sendReportPerPlatform({ fetchFn: fetchIntransitLate, buildFn: buildIntransitMail, rg, source: opts.source, manual: opts.manual, dryRun: opts.dryRun });
}

// ── First-OFD Late (RTO / SLA claim): the courier's FIRST out-for-delivery scan happened AFTER the
//    promised EDD — delivery wasn't even ATTEMPTED until the promise had already passed. This is a courier
//    SLA breach, claimable regardless of the final outcome (Delivered or RTO). Unlike the other reports,
//    the date range filters on the TERMINAL-STAGE DATE (rto_at), NOT order date — so it reports on
//    shipments that RTO'd within the window. RTO-only: an RTO whose first attempt was already late is the
//    claimable case (a late DELIVERY is covered by the Late-Deliveries report). first_edd = promise EDD;
//    out_for_delivery_at = first OFD.
async function fetchFirstOfdLate(fromISO, toISO, source) {
    const out = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        let q = supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, order_date, first_edd, out_for_delivery_at, delivered_at, rto_at, payment_mode, zone, dest_state, dest_city, outcome, ndr_count, attempts, shipment_value')
            .eq('outcome', 'rto')
            .not('out_for_delivery_at', 'is', null).not('first_edd', 'is', null)
            .gte('rto_at', fromISO).lte('rto_at', toISO);
        if (source) q = q.eq('source', source);                        // honor the platform filter
        const { data, error } = await q.order('rto_at', { ascending: false }).range(offset, offset + PAGE - 1);
        if (error) throw new Error(error.message);
        out.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    // Keep only shipments whose FIRST OFD is LATER than the promised EDD (compared by IST calendar day, as
    // first_edd is stamped end-of-day). ofd_late = whole days the first attempt slipped past the promise.
    return out.map(r => {
        const ofd_late = lateDays(r.first_edd, r.out_for_delivery_at);
        if (ofd_late <= 0) return null;
        return { ...r, ofd_late, terminal_at: r.rto_at, terminal_stage: 'RTO' };
    }).filter(Boolean).sort((a, b) => b.ofd_late - a.ofd_late);
}
function firstOfdSummary(rows) {
    const n = rows.length;
    const buckets = { '1 day': 0, '2-3 days': 0, '4-7 days': 0, '8+ days': 0 };
    rows.forEach(r => { const x = r.ofd_late; buckets[x === 1 ? '1 day' : x <= 3 ? '2-3 days' : x <= 7 ? '4-7 days' : '8+ days']++; });
    return { count: n, rto: n, severe: rows.filter(r => r.ofd_late >= 4).length, avgLate: n ? round2(rows.reduce((a, r) => a + r.ofd_late, 0) / n) : 0, maxLate: rows.reduce((m, r) => Math.max(m, r.ofd_late), 0), buckets };
}
function buildFirstOfdMail(rows, rangeLabel, platform) {
    const s = firstOfdSummary(rows);
    const pTag = platform ? ` · ${PLATFORM_LABEL[platform] || platform}` : '';
    const body = rows.map((r, i) => `<tr style="background:${i % 2 ? '#f8fafc' : '#fff'}">
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.order_name)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.awb)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${esc(r.courier || '')}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${dmy(r.first_edd)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${dmy(r.out_for_delivery_at)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;">${dmy(r.terminal_at)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #eef2f7;text-align:right;font-weight:700;color:${r.ofd_late >= 4 ? '#b91c1c' : '#b45309'};">${r.ofd_late}</td></tr>`).join('');
    const html = mailShell('First-OFD Late — RTO, First Attempt After Promised EDD',
        'RTO shipments whose FIRST out-for-delivery scan happened after the promised delivery date — delivery was not even attempted until the promise had already passed.',
        rangeLabel,
        ['Order', 'AWB', 'Courier', 'Promised (EDD)', 'First OFD', 'RTO date', 'Days late (OFD)'],
        [6], body,
        `${s.count} RTOs · avg ${s.avgLate} days late · worst ${s.maxLate} days · ${s.severe} over 4 days late.`,
        'RTO-date window');
    return { subject: `First-OFD Late${pTag} — ${s.count} RTOs, first attempt after promise EDD (${rangeLabel})`, html };
}
async function sendFirstOfdReport(opts = {}) {
    const rg = opts.fromISO ? opts : rangeEndingYesterday(opts.days || 30);
    return sendReportPerPlatform({ fetchFn: fetchFirstOfdLate, buildFn: buildFirstOfdMail, rg, source: opts.source, exclude: opts.exclude, manual: opts.manual, dryRun: opts.dryRun });
}

// Shared email chrome — a titled card with a striped table; `rightCols` are right-aligned header cells.
function mailShell(title, subtitle, rangeLabel, headers, rightCols, bodyRows, footNote, windowLabel) {
    const th = headers.map((h, i) => `<th style="text-align:${rightCols.includes(i) ? 'right' : 'left'};padding:8px 10px;border-bottom:2px solid #cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#475569;">${esc(h)}</th>`).join('');
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;max-width:840px;">
      <h2 style="margin:0 0 4px;font-size:18px;">${esc(title)}</h2>
      <p style="margin:0 0 2px;color:#64748b;font-size:13px;">${esc(subtitle)}</p>
      <p style="margin:0 0 16px;color:#94a3b8;font-size:12px;">${esc(windowLabel || 'Order window')}: ${esc(rangeLabel)}</p>
      <table style="border-collapse:collapse;width:100%;font-size:12px;"><thead><tr>${th}</tr></thead><tbody>${bodyRows}</tbody></table>
      ${footNote ? `<p style="margin:14px 0 0;color:#94a3b8;font-size:11px;">${esc(footNote)}</p>` : ''}
      <p style="margin:18px 0 0;color:#94a3b8;font-size:11px;">— Ecom Central</p></div>`;
}

// ── Endpoints ───────────────────────────────────────────────────────────────
router.get('/silent-rto-claims', async (req, res) => {
    try {
        const rg = resolveRange(req);
        const rows = await fetchSilentRto(rg.fromISO, rg.toISO);
        res.json({ success: true, range: { from: rg.fromLabel, to: rg.toLabel }, summary: silentRtoSummary(rows), rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/silent-rto-claims/send', requireEmailSender, async (req, res) => {
    try {
        const rg = resolveRange(req.body || {});
        const out = await sendSilentRtoReport({ ...rg, manual: true });   // recipient comes from Settings (RapidShyp email), not req.body
        if (out.skipped) return res.status(400).json({ success: false, message: out.reason });
        res.json({ success: true, message: `Sent ${out.count} claim(s) to ${out.to.join(', ')}` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
router.get('/late-deliveries', async (req, res) => {
    try {
        const rg = resolveRange(req);
        const rows = await fetchLateDeliveries(rg.fromISO, rg.toISO);
        res.json({ success: true, range: { from: rg.fromLabel, to: rg.toLabel }, summary: lateSummary(rows), rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/late-deliveries/send', requireEmailSender, async (req, res) => {
    try {
        const rg = resolveRange(req.body || {});
        const out = await sendLateDeliveriesReport({ ...rg, source: (req.body && req.body.source) || undefined, manual: true });
        if (out.skipped) return res.status(400).json({ success: false, message: out.reason });
        res.json({ success: true, message: `Sent ${out.count} row(s) to ${out.to.join(', ')}` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
router.get('/intransit-late', async (req, res) => {
    try {
        const rg = resolveRange(req);
        const rows = await fetchIntransitLate(rg.fromISO, rg.toISO);
        res.json({ success: true, range: { from: rg.fromLabel, to: rg.toLabel }, summary: intransitSummary(rows), rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/intransit-late/send', requireEmailSender, async (req, res) => {
    try {
        const rg = resolveRange(req.body || {});
        const out = await sendIntransitLateReport({ ...rg, source: (req.body && req.body.source) || undefined, manual: true });
        if (out.skipped) return res.status(400).json({ success: false, message: out.reason });
        res.json({ success: true, message: `Sent ${out.count} row(s) to ${out.to.join(', ')}` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
router.get('/first-ofd-late', async (req, res) => {
    try {
        const rg = resolveRange(req);
        const source = req.query.source && req.query.source !== 'all' ? req.query.source : undefined;
        const rows = await fetchFirstOfdLate(rg.fromISO, rg.toISO, source);   // RTO-only
        res.json({ success: true, range: { from: rg.fromLabel, to: rg.toLabel }, summary: firstOfdSummary(rows), rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/first-ofd-late/send', requireEmailSender, async (req, res) => {
    try {
        const rg = resolveRange(req.body || {});
        const out = await sendFirstOfdReport({ ...rg, source: (req.body && req.body.source) || undefined, manual: true });
        if (out.skipped) return res.status(400).json({ success: false, message: out.reason });
        res.json({ success: true, message: `Sent ${out.count} row(s) to ${out.to.join(', ')}` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── #4 Critical escalation email (AI-polished) ──────────────────────────────
function buildCriticalTable(rows) {
    const body = rows.map((r, i) => `<tr style="background:${i % 2 ? '#f8fafc' : '#fff'}">
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;">${esc(r.order_name)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;">${esc(r.awb)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;">${esc(r.courier || '')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;">${esc((r.outcome || '').replace('_', ' '))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:right;">${r.ndr_count || 0}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;">${esc((r.ndr_reasons || []).join('; '))}</td></tr>`).join('');
    return `<table style="border-collapse:collapse;width:100%;font-size:12px;margin-top:16px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
      <thead><tr>${['Order', 'AWB', 'Courier', 'Status', 'NDRs', 'NDR reasons'].map(h => `<th style="text-align:left;padding:7px 10px;border-bottom:2px solid #cbd5e1;font-size:11px;text-transform:uppercase;color:#475569;">${h}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table>`;
}
// Email tones the admin can pick in the compose modal (default: formal).
const MAIL_TONES = {
    polite: 'Polite and courteous — respectful, collaborative, assumes good faith, yet still requests concrete corrective action.',
    direct: 'Straightforward and firm — short sentences, minimal pleasantries, states the problem plainly and demands specific corrective action with a clear timeline.',
    formal: 'Formal business escalation — professional corporate register, well structured, references the partnership and service-level expectations.',
};
// Internal outcome values → plain business English (internal codes must NEVER appear in an external email).
const OUTCOME_EN = { delivered: 'delivered', rto: 'returned to origin (RTO)', ndr_pending: 'still undelivered after failed attempt(s)', in_transit: 'in transit', lost: 'lost in transit' };
const NO_CODES_RULE = 'Write in plain business English — NEVER use internal system codes or field values (e.g. "ndr_pending", "in_transit", "rto_no_attempt"); describe statuses naturally. Keep every order number, AWB and count EXACTLY as given.';

// Escalations are NOT always about fake delivery attempts — the selected shipments could be stuck with
// no scan/movement, or stuck on repeated failed attempts, etc. Detect the dominant issue from the DATA
// and build the matching subject + AI instruction + template fallback, so the email always fits reality.
const ESCALATION_KINDS = {
    fake: {
        subject: n => `Escalation: ${n} shipment${n !== 1 ? 's' : ''} with likely fake delivery attempts`,
        ai: `These shipments were marked as failed/NDR ("customer unavailable" etc.) but the addresses were fine — several were delivered on the very next attempt. Ask RapidShyp to (1) investigate the delivery agents, (2) stop fake NDR markings, and (3) reattempt and confirm.`,
        intro: n => `We've identified ${n} shipment${n !== 1 ? 's' : ''} flagged with failed/NDR delivery attempts that appear to be fake — several were delivered successfully on the very next attempt to the same address. Please investigate the delivery agents involved, stop the fake "customer unavailable" markings, and ensure prompt reattempts with confirmation.`,
    },
    stuck: {
        subject: n => `Escalation: ${n} shipment${n !== 1 ? 's' : ''} stuck with no recent scan / movement`,
        ai: `These shipments have had NO scan update or movement for several days and appear stuck in transit, with no delivery attempt recorded. Ask RapidShyp to (1) locate the shipments, (2) explain the lack of movement, and (3) resume delivery with a committed timeline.`,
        intro: n => `We've identified ${n} shipment${n !== 1 ? 's' : ''} that have had no scan update or movement for several days and appear stuck in transit, with no delivery attempt recorded. Please locate these shipments, explain the delay, and resume delivery with a committed timeline.`,
    },
    ndr: {
        subject: n => `Escalation: ${n} shipment${n !== 1 ? 's' : ''} with repeated failed delivery attempts`,
        ai: `These shipments have repeated failed delivery attempts (NDRs) and are still undelivered. Ask RapidShyp to (1) reattempt promptly, (2) contact the customer before marking any attempt failed, and (3) confirm each attempt with proof of contact.`,
        intro: n => `We've identified ${n} shipment${n !== 1 ? 's' : ''} with repeated failed delivery attempts (NDRs) that remain undelivered. Please reattempt promptly, contact the customer before marking any attempt failed, and confirm each attempt with proof of contact.`,
    },
    general: {
        subject: n => `Escalation: ${n} problematic shipment${n !== 1 ? 's' : ''} needing urgent attention`,
        ai: `These shipments have delivery problems (failed attempts, delays, or no movement) — see the per-order status and reasons. Ask RapidShyp to investigate each, resolve the issue, and confirm next steps with a committed delivery timeline.`,
        intro: n => `We've identified ${n} shipment${n !== 1 ? 's' : ''} with delivery problems that need urgent attention. Please investigate each, resolve the issue, and confirm the next steps with a committed delivery timeline.`,
    },
};
// Decide the escalation kind from the selected shipments. A caller can HINT 'fake_attempts' (the
// Likely-Fake insight) — honored only if the data actually shows a fake signal (delivered-after-NDR).
function classifyEscalation(rows, hint) {
    let fake = 0, ndr = 0, stuck = 0;
    for (const r of rows) {
        const nd = r.ndr_count || 0;
        if (r.outcome === 'delivered' && nd > 0) fake++;      // delivered on a later attempt after a "failed" one
        else if (nd > 0) ndr++;                               // repeated failed attempts, still not delivered
        else stuck++;                                         // no NDR + not delivered → no scan / stuck in transit
    }
    if (hint === 'fake_attempts' && fake > 0) return 'fake';
    const max = Math.max(fake, ndr, stuck);
    if (max === 0) return 'general';
    if (fake === max) return 'fake';
    if (stuck === max) return 'stuck';
    if (ndr === max) return 'ndr';
    return 'general';
}
// Parse the AI's {"subject","body"} reply ROBUSTLY. LLMs frequently (a) wrap it in ```json fences and
// (b) put LITERAL newlines inside the "body" string, which makes strict JSON.parse fail — the old code
// then dumped the raw JSON (fences and all) into the email. Strip fences, try strict parse, then fall
// back to tolerant regex extraction (unescaping \n etc.), and only as a last resort use the plain text.
// Escape raw control chars that appear INSIDE JSON string values (LLMs emit unescaped newlines in the
// "body"), while leaving structural whitespace alone — so JSON.parse then succeeds.
function sanitizeJsonStrings(s) {
    let out = '', inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (esc) { out += c; esc = false; continue; }
        if (c === '\\') { out += c; esc = true; continue; }
        if (c === '"') { inStr = !inStr; out += c; continue; }
        if (inStr && (c === '\n' || c === '\r' || c === '\t')) { out += (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t'); continue; }
        out += c;
    }
    return out;
}
function parseAiEmail(draft) {
    if (!draft) return { subject: null, body: null };
    let s = String(draft).replace(/```json?/gi, '').replace(/```/g, '').trim();
    // Isolate the JSON object and DROP any prose/commentary before or after it — models sometimes append
    // notes like "*Word Count Check*: ..." which must NEVER leak into the email.
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
    // Strict parse, then again with raw newlines inside strings escaped.
    for (const cand of [s, sanitizeJsonStrings(s)]) {
        try { const j = JSON.parse(cand); if (j && typeof j === 'object' && (j.subject != null || j.body != null)) return { subject: j.subject || null, body: j.body || null }; } catch (_) {}
    }
    // Regex fallback — extract ONLY the two fields from inside the object (never dump the whole response).
    const unesc = t => t == null ? null : String(t).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    const subjM = s.match(/"subject"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const bodyM = s.match(/"body"\s*:\s*"([\s\S]*?)"\s*\}\s*$/);
    return { subject: subjM ? unesc(subjM[1]) : null, body: bodyM ? unesc(bodyM[1]) : null };
}

// Compose a critical escalation email from selected shipments; AI-polishes the wording (falls back to a
// built-in template when AI isn't configured). Returns the editable draft — NOT sent yet.
router.post('/critical-email/compose', requireEmailSender, async (req, res) => {
    try {
        const awbs = Array.isArray(req.body && req.body.awbs) ? req.body.awbs.filter(Boolean).slice(0, 60) : [];
        if (!awbs.length) return res.status(400).json({ success: false, message: 'No shipments selected — filter the table (e.g. Likely fake attempts) first.' });
        const { data } = await supabase.from('shipment_journey_ecom')
            .select('order_name, awb, courier, source, outcome, ndr_count, ndr_reasons, first_edd, order_date, payment_mode, zone, dest_city, dest_state')
            .in('awb', awbs);
        const rows = data || [];
        if (!rows.length) return res.status(400).json({ success: false, message: 'Selected shipments not found.' });
        // ── Route to the courier platform the order is ACTUALLY on ────────────────────────────────────
        // Was: DocPharma rows → DocPharma, "everything else (RapidShyp / Kwikship) → RapidShyp". So every
        // KwikShip escalation was addressed to RapidShyp — a courier with no visibility of the shipment.
        // Now each of the three routes to its own recipients, taken from the shipment's `source`.
        //
        // ⚠️ MIXED BATCHES ARE REFUSED, not averaged. The old rule let the DOMINANT source win, so a basket
        // of 6 RapidShyp + 5 KwikShip orders sent all 11 to RapidShyp — the exact cross-delivery this is
        // meant to prevent, and easy to hit now that the basket collects orders across a whole shift.
        // One email, one courier: the agent escalates each platform separately.
        const PLATFORM_LABEL = { rapidshyp: 'RapidShyp', docpharma: 'DocPharma', kwikship: 'KwikShip' };
        const platformOf = r => (r.source === 'docpharma' || r.source === 'kwikship') ? r.source : 'rapidshyp';
        const counts = {};
        rows.forEach(r => { const p = platformOf(r); counts[p] = (counts[p] || 0) + 1; });
        const present = Object.keys(counts);
        if (present.length > 1) {
            const split = present.map(p => `${counts[p]} ${PLATFORM_LABEL[p]}`).join(' + ');
            return res.status(400).json({ success: false,
                message: `This selection mixes couriers (${split}). An escalation goes to ONE courier — send them separately so no order is raised with a partner that never carried it.`,
                mixed: counts });
        }
        const platform = present[0] || 'rapidshyp';
        const rcpt = await recipientsFor(platform);
        // An unmapped platform must fail loudly here rather than silently fall back to another courier.
        if (!rcpt.to || !rcpt.to.length) {
            return res.status(400).json({ success: false,
                message: `No escalation email is mapped for ${PLATFORM_LABEL[platform]}. Add it in Settings → Email (${platform === 'kwikship' ? 'KwikShip' : PLATFORM_LABEL[platform]} To).` });
        }
        const toHint = (rcpt.to || []).join(', ');
        const toneLine = MAIL_TONES[req.body && req.body.tone] || MAIL_TONES.formal;
        // Pick the narrative from the ACTUAL data (fake / stuck-no-scan / repeated-NDR / general) — not
        // always "fake". A 'fake_attempts' hint from the Likely-Fake insight is honored only if the data agrees.
        const kind = classifyEscalation(rows, req.body && req.body.kind);
        const K = ESCALATION_KINDS[kind] || ESCALATION_KINDS.general;
        const n = rows.length, plu = n !== 1 ? 's' : '';
        // Destination phrased unambiguously — "IDUKKI zone E" once made the AI write "the Idukki zone".
        const lines = rows.slice(0, 40).map(r => {
            const dest = [r.dest_city, r.dest_state].filter(Boolean).join(', ');
            return `- ${r.order_name} (AWB ${r.awb}), courier ${r.courier || 'unknown'}, status: ${OUTCOME_EN[r.outcome] || r.outcome}, failed attempts (NDRs): ${r.ndr_count || 0}${(r.ndr_reasons && r.ndr_reasons.length) ? ` ["${r.ndr_reasons.join('; ')}"]` : ''}${dest ? `, destination: ${dest}` : ''}${r.zone ? ` (delivery zone ${r.zone})` : ''}`;
        }).join('\n');
        // Order + AWB reference: LIST them inline for a few shipments (so they're visible in the body);
        // for many, point to the attached table. (The full table is always attached on send either way.)
        const FEW = 6;
        const refText = n <= FEW
            ? `Affected shipment${plu} (order — AWB):\n` + rows.map(r => `- ${r.order_name} — AWB ${r.awb}`).join('\n')
            : `The ${n} affected shipments are listed in the table below.`;
        const idRule = n <= FEW
            ? `IMPORTANT: list each order number with its AWB in the body so they are clearly visible (a table with full details is also attached).`
            : `Reference the count, not each AWB (a table with all details is attached).`;
        // ⚠️ Name the ACTUAL partner. This prompt hardcoded "RapidShyp", so the AI opened every draft with
        // "Hi RapidShyp team" — including KwikShip escalations the routing had correctly addressed to
        // GoKwik. Right envelope, wrong letter, which is worse than either mistake alone.
        const partnerName = PLATFORM_LABEL[platform] || 'the courier partner';
        const sys = `You are an operations manager at an Indian D2C skincare brand (The Element) writing an escalation email to the courier partner ${partnerName}. Address them as "${partnerName}" and never name any other courier. Tone: ${toneLine} Be concise, specific and action-oriented. Do NOT invent facts beyond the data given — describe the problem exactly as the data shows it, do not assume fake attempts unless the data indicates it. ${NO_CODES_RULE} Respond with ONLY the raw JSON object {"subject":"...","body":"..."} and NOTHING else — no markdown, no code fences, no word-count notes or commentary before or after. Body is plain text with \\n line breaks, under 180 words.`;
        const usr = `Write an escalation email. ${K.ai} ${idRule}\n\nShipments:\n${lines}`;
        let draft = await aiComplete([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.4 });
        const p = parseAiEmail(draft);
        let subject = p.subject, body = p.body;
        if (!subject) subject = K.subject(n);
        if (!body) body = `Hi ${partnerName} team,\n\n${K.intro(n)}\n\n${refText}\n\nThank you,\nThe Element — Operations`;
        res.json({ success: true, subject, body, count: rows.length, kind, platform, toHint, aiUsed: !!draft, aiAvailable: aiConfigured(), aiError: draft ? null : lastAiError(), tableHtml: buildCriticalTable(rows), orders: rows.map(r => ({ order_name: r.order_name, awb: r.awb })) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
// Re-polish the admin's CURRENT (possibly hand-edited) draft in the chosen tone. Pure rewrite — facts,
// order numbers, AWBs and counts must survive verbatim. Polishing IS the AI action, so no template fallback.
router.post('/critical-email/polish', requireEmailSender, async (req, res) => {
    try {
        const { subject, body, tone } = req.body || {};
        if (!body || !String(body).trim()) return res.status(400).json({ success: false, message: 'Nothing to polish — the message is empty.' });
        if (!aiConfigured()) return res.status(400).json({ success: false, message: 'AI is not configured — set AI_API_KEY / AI_API_URL / AI_MODEL in .env.' });
        const toneLine = MAIL_TONES[tone] || MAIL_TONES.formal;
        const sys = `You are an expert business-communication editor. Rewrite and polish the given escalation email draft from The Element (D2C skincare brand) to its courier partner. Tone: ${toneLine} Keep ALL facts intact — do not add, drop or alter order numbers, AWBs, counts or claims. ${NO_CODES_RULE} Respond with ONLY the raw JSON object {"subject":"...","body":"..."} and NOTHING else — no markdown, no code fences, no word-count notes or commentary before or after. Body is plain text with \\n line breaks, under 200 words.`;
        const usr = `Polish this draft:\n\nSubject: ${subject || '(none)'}\n\nBody:\n${body}`;
        const draft = await aiComplete([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.4 });
        if (!draft) { const why = lastAiError(); return res.status(502).json({ success: false, message: why ? `AI polish failed — ${why}.` : 'AI polish failed — please try again.' }); }
        const out = parseAiEmail(draft);
        res.json({ success: true, subject: out.subject || subject, body: out.body || body });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
router.post('/critical-email/send', requireEmailSender, async (req, res) => {
    try {
        const { subject, body, to, tableHtml } = req.body || {};
        if (!subject || !body) return res.status(400).json({ success: false, message: 'Subject and body are required.' });
        const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;max-width:840px;white-space:pre-wrap;line-height:1.5;">${esc(body)}</div>${tableHtml || ''}`;
        // TO = the courier partner this shipment is actually on (RapidShyp / DocPharma / KwikShip);
        // CC = our team. A hand-typed recipient overrides the TO; the platform's CC is always applied.
        // The platform comes from the draft, which derived it from the shipments' own `source` — so the
        // send cannot address a different courier than the one the draft was written for.
        const PLATFORMS = ['rapidshyp', 'docpharma', 'kwikship'];
        const platform = PLATFORMS.includes(req.body && req.body.platform) ? req.body.platform : 'rapidshyp';
        const rcpt = await recipientsFor(platform);
        // Never fall back to another courier's list — that is how a KwikShip escalation reached RapidShyp.
        if (!to && (!rcpt.to || !rcpt.to.length)) {
            return res.status(400).json({ success: false, message: `No escalation email is mapped for ${platform}. Add it in Settings → Email.` });
        }
        const toList = to ? to : (rcpt.to && rcpt.to.length ? rcpt.to : null);
        const r = await sendMail({ to: toList || undefined, cc: rcpt.cc, subject, html, text: body });
        // Log which orders were escalated (audit + the row shows "mail sent", prevents accidental dupes).
        const orders = Array.isArray(req.body.orders) ? req.body.orders.filter(o => o && o.order_name) : [];
        if (orders.length) {
            const now = new Date().toISOString();
            const marks = orders.map(o => ({ order_name: String(o.order_name).trim(), awb: (o.awb || '') || null, mark_type: 'critical_mail_sent', created_by: req.user.sub, updated_at: now }));
            await supabase.from('order_marks_ecom').upsert(marks, { onConflict: 'order_name,mark_type' }).then(() => {}).catch(() => {});
        }
        // Log the thread so inbox replies can be matched back (reply tracking + AI resolution scoring).
        await require('./email_replies').logSentEscalation({ messageId: r.messageId, subject, to: r.to, body, orders });
        res.json({ success: true, message: `Sent to ${r.to.join(', ')}` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── #4b Escalation → Google Sheet (the tracker shared WITH the courier) ──────────────────────────
// The basket's second exit. The team keeps a Google Sheet shared with RapidShyp ("TE <> Rapidshyp
// Escalations") and works escalations as rows in it — same basket/selection as the critical email,
// but the output is appended rows, not a mail (user, 2026-08-19: "don't send email — required details
// should be push in this google sheet").
// Auth: the GOOGLE_CREDENTIALS service account; the sheet must be shared with its client_email as
// Editor. ⚠️ googleapis' JWT MUST be constructed with the OPTIONS OBJECT — positional args
// (email, null, key, scopes) silently drop the key and every call fails 403 "unregistered callers",
// which reads like a sharing problem and is not (burned an hour on exactly this).
const ESCALATION_SHEET_ID = process.env.ESCALATION_SHEET_ID || '1LEJxeq5bg7fP2i1tRdCpqxs4BG6fjZEjZ5Scim31Oa8';
const ESCALATION_SHEET_TAB = process.env.ESCALATION_SHEET_TAB || 'Sheet1';
let _gSheetsClient = null;
function gSheets() {
    if (_gSheetsClient) return _gSheetsClient;
    const { google } = require('googleapis');   // lazy — heavy module, only this feature needs it
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
    if (!creds.client_email || !creds.private_key) throw new Error('GOOGLE_CREDENTIALS is not configured');
    const auth = new google.auth.JWT({ email: creds.client_email,
        key: String(creds.private_key).replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    _gSheetsClient = google.sheets({ version: 'v4', auth });
    return _gSheetsClient;
}
// The Agent column is a DROPDOWN (data validation: Diksha / Shaveta / Sugandh / …), so writing the raw
// portal username ("sugandhm881") gets the red "not an item on the list" flag on every pushed row
// (reported 2026-08-19). The sheet's own list is the truth — read the validation rule off the column
// and match the portal user against it, so the team renaming/adding agents needs no code change.
function matchAgentOption(portalUser, opts) {
    const local = String(portalUser || '').split('@')[0].toLowerCase();
    let best = null;
    for (const o of opts || []) {
        const k = String(o).toLowerCase().replace(/\s+/g, '');
        // "sugandhm881" starts with "sugandh" — the longest such option wins (Sugandh over Su…).
        if (k && (local.startsWith(k) || k.startsWith(local)) && (!best || k.length > best.k.length)) best = { o, k };
    }
    return best ? best.o : local;   // no match → raw local part, same as before (visible, not silent)
}
// Read a column's dropdown (data-validation) option list off the sheet — ONE_OF_LIST inline values,
// or ONE_OF_RANGE resolved from its helper range ("=Agents!A1:A20"). Cached per cell for 10 min.
const _dvCache = {};   // a1 → { at, opts }
async function readValidationList(sheets, a1) {
    const c = _dvCache[a1];
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.opts;
    const meta = await sheets.spreadsheets.get({ spreadsheetId: ESCALATION_SHEET_ID,
        ranges: [`${ESCALATION_SHEET_TAB}!${a1}`], fields: 'sheets.data.rowData.values.dataValidation' });
    const dv = (((((meta.data.sheets || [])[0] || {}).data || [])[0] || {}).rowData || [])
        .flatMap(r => r.values || []).map(v => v.dataValidation).find(Boolean);
    let opts = [];
    if (dv && dv.condition && dv.condition.type === 'ONE_OF_LIST') {
        opts = (dv.condition.values || []).map(v => v.userEnteredValue).filter(Boolean);
    } else if (dv && dv.condition && dv.condition.type === 'ONE_OF_RANGE') {
        const ref = String(((dv.condition.values || [])[0] || {}).userEnteredValue || '').replace(/^=/, '');
        if (ref) { const r = await sheets.spreadsheets.values.get({ spreadsheetId: ESCALATION_SHEET_ID, range: ref });
            opts = ((r.data && r.data.values) || []).flat().filter(Boolean); }
    }
    _dvCache[a1] = { at: Date.now(), opts };
    return opts;
}
async function sheetAgentName(sheets, portalUser) {
    let opts = [];
    try { opts = await readValidationList(sheets, 'B2:B2'); }
    catch (_) { /* validation unreadable → fall through to the raw name */ }
    return matchAgentOption(portalUser, opts);
}
// The sheet names the LAST-MILE courier ("Ekart", "Delhivery"), not our aggregator or the full service
// string ("DelhiveryDirectSurface500G", "Ekart Brands") — normalise so their filters keep working.
function sheetCourierName(courier) {
    const c = String(courier || '');
    for (const [re, label] of [[/delhivery/i, 'Delhivery'], [/ekart/i, 'Ekart'], [/amazon/i, 'Amazon'],
        [/blue\s*dart/i, 'Bluedart'], [/xpress\s*bee/i, 'Xpressbees'], [/shadowfax/i, 'Shadowfax'],
        [/ecom\s*exp/i, 'Ecom Express'], [/dtdc/i, 'DTDC']]) if (re.test(c)) return label;
    return c.split(/[\s(]/)[0] || '—';
}
// IST calendar helpers — the sheet writes "19/8" dates by hand, so match that exactly.
const _istD = iso => new Date(new Date(iso || Date.now()).getTime() + 5.5 * 3600 * 1000);
const sheetToday = () => { const d = _istD(); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
const sheetEdd = iso => { if (!iso) return ''; const d = _istD(iso); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };
// Per-shipment escalation type in the sheet's own vocabulary, derived from the journey — the agent can
// override for the whole batch, but the default must describe what the data actually shows.
function sheetTypeFor(j) {
    if ((j.ndr_count || 0) > 0) return 'Reattempt/Fake NDR';
    if (j.first_edd && new Date(j.first_edd).getTime() < Date.now()) return 'EDD Breached_no attempt';
    return 'Escalation';
}
function sheetReasonFor(j) {
    const rs = Array.isArray(j.ndr_reasons) ? j.ndr_reasons.filter(Boolean) : [];
    if (rs.length) return String(rs[rs.length - 1]).slice(0, 120);   // the latest NDR reason
    if (j.first_edd && new Date(j.first_edd).getTime() < Date.now()) return `EDD ${sheetEdd(j.first_edd)} passed, no attempt`;
    return 'status is not update';   // the team's own phrasing for a stalled parcel
}

// POST /escalation-sheet/push { awbs: [...], type?: <batch override>, reason?: <batch override> }
// Appends one row per shipment; never blocks on a repeat — the sheet has a Duplicate column, so a
// re-push is APPENDED AND MARKED "Duplicate" rather than silently skipped (their own workflow).
router.post('/escalation-sheet/push', requireEmailSender, async (req, res) => {
    try {
        const awbs = Array.isArray(req.body && req.body.awbs) ? req.body.awbs.filter(Boolean).slice(0, 60) : [];
        if (!awbs.length) return res.status(400).json({ success: false, message: 'No shipments selected.' });
        const typeOverride = String((req.body && req.body.type) || '').trim() || null;
        const reasonOverride = String((req.body && req.body.reason) || '').trim() || null;
        // Per-AWB reasons, typed by the agent when the order went INTO the basket — the person adding
        // it knows why. Wins over the batch override, which wins over the auto-derived reason.
        const perAwbReason = (req.body && typeof req.body.reasons === 'object' && req.body.reasons) || {};
        // Per-AWB TYPE, chosen in the add-to-basket popup. Wins over the batch override, over auto.
        const perAwbType = (req.body && typeof req.body.types === 'object' && req.body.types) || {};
        const { data } = await supabase.from('shipment_journey_ecom')
            .select('order_name, awb, courier, source, payment_mode, ndr_count, ndr_reasons, first_edd, outcome')
            .in('awb', awbs);
        const all = data || [];
        if (!all.length) return res.status(400).json({ success: false, message: 'Selected shipments not found.' });
        // ⚠️ RAPIDSHYP SHIPMENTS ONLY (user, 2026-08-19). This sheet is shared WITH RapidShyp — a
        // KwikShip or DocPharma AWB on it is an escalation to a partner who never carried the parcel,
        // the same wrong-courier class the email routing had to be fixed for. Non-RapidShyp shipments
        // are NOT dropped: they are reported back and stay in the basket for the email flow, which
        // routes by platform. Same principle as the email's mixed-batch refusal, but the sheet can
        // push its own subset because the remainder still has a working exit.
        const rows = all.filter(j => String(j.source || '').toLowerCase() === 'rapidshyp');
        const skippedRows = all.filter(j => String(j.source || '').toLowerCase() !== 'rapidshyp');
        const skipped = {};
        skippedRows.forEach(j => { const k = String(j.source || 'unknown').toLowerCase(); skipped[k] = (skipped[k] || 0) + 1; });
        if (!rows.length) {
            const split = Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join(' + ');
            return res.status(400).json({ success: false, message: `No RapidShyp shipments in this selection (${split}) — the sheet belongs to RapidShyp; escalate other couriers by email.` });
        }
        const sheets = gSheets();
        // Existing AWBs (column C) → the Duplicate flag.
        const cur = await sheets.spreadsheets.values.get({ spreadsheetId: ESCALATION_SHEET_ID, range: `${ESCALATION_SHEET_TAB}!C2:C` });
        const have = new Set(((cur.data && cur.data.values) || []).flat().map(v => String(v).trim()).filter(Boolean));
        const agent = await sheetAgentName(sheets, (req.user && req.user.sub) || '');
        let dups = 0;
        // Columns A–P, exactly the sheet's own header order:
        // Date · Agent · AWB · Duplicate · MOP · Courier · Escalation type · Follow-up stage ·
        // Reason · EDD · Remarks · Remarks · Escalation status · comment · Unboxing · Packing
        const values = rows.map(j => {
            const dup = have.has(String(j.awb).trim()); if (dup) dups++;
            return [sheetToday(), agent, String(j.awb),
                dup ? 'Duplicate' : '',
                String(j.payment_mode || '').toLowerCase() === 'cod' ? 'COD' : 'PPD',
                sheetCourierName(j.courier),
                String(perAwbType[String(j.awb)] || '').trim() || typeOverride || sheetTypeFor(j), '',
                // An entry in `reasons` is used VERBATIM — including '' (the agent chose Skip, so the
                // cell stays blank). Auto text only when the agent was never asked for this AWB.
                Object.prototype.hasOwnProperty.call(perAwbReason, String(j.awb))
                    ? String(perAwbReason[String(j.awb)] || '').trim()
                    : (reasonOverride || sheetReasonFor(j)),
                '' /* EDD — deliberately NOT filled from our side (user, 2026-08-19); the team maintains it */,
                '', '', 'Under Follow up', '', '', ''];
        });
        await sheets.spreadsheets.values.append({
            spreadsheetId: ESCALATION_SHEET_ID, range: `${ESCALATION_SHEET_TAB}!A1`,
            valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
            requestBody: { values },
        });
        // Audit — the explorer's "escalated" badge reads these marks alongside critical_mail_sent.
        const now = new Date().toISOString();
        const marks = rows.map(j => ({ order_name: String(j.order_name).trim(), awb: j.awb, mark_type: 'sheet_escalated', created_by: (req.user && req.user.sub) || null, updated_at: now }));
        await supabase.from('order_marks_ecom').upsert(marks, { onConflict: 'order_name,mark_type' }).then(() => {}).catch(() => {});
        res.json({ success: true, pushed: values.length, duplicates: dups,
            pushedAwbs: rows.map(j => String(j.awb)), skipped, skippedAwbs: skippedRows.map(j => String(j.awb)) });
    } catch (e) {
        const msg = /permission|403/i.test(String(e.message)) ? 'Sheet access denied — share the escalation sheet (Editor) with the service account in GOOGLE_CREDENTIALS.' : e.message;
        res.status(500).json({ success: false, message: msg });
    }
});

// GET /escalation-sheet/options — the sheet's OWN dropdown lists, for the add-to-basket popup.
// The Escalation-type column carries 19 validation values; a hardcoded subset in the UI went stale the
// day it shipped (user, 2026-08-19: "show all as per google sheet dropdown"). The sheet is the truth.
router.get('/escalation-sheet/options', async (_req, res) => {
    try {
        const sheets = gSheets();
        const types = await readValidationList(sheets, 'G2:G2');
        res.json({ success: true, types });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /escalation-sheet/thread/:awb — this AWB's rows on the escalation sheet, thread-style.
// The sheet is where RapidShyp RESPONDS (Remarks / Escalation status / comment columns), so the
// expanded shipment row can show that conversation the way it shows email replies. Whole-sheet read,
// cached 60s — one Sheets call a minute however many rows the agent expands.
let _sheetRowsCache = { at: 0, rows: [] };
router.get('/escalation-sheet/thread/:awb', async (req, res) => {
    try {
        if (Date.now() - _sheetRowsCache.at > 60 * 1000) {
            const sheets = gSheets();
            const v = await sheets.spreadsheets.values.get({ spreadsheetId: ESCALATION_SHEET_ID, range: `${ESCALATION_SHEET_TAB}!A2:N` });
            _sheetRowsCache = { at: Date.now(), rows: (v.data && v.data.values) || [] };
        }
        const awb = String(req.params.awb || '').trim();
        const entries = _sheetRowsCache.rows
            .map((r, i) => ({ rowNum: i + 2, date: r[0] || '', agent: r[1] || '', awb: String(r[2] || '').trim(),
                duplicate: r[3] || '', mop: r[4] || '', courier: r[5] || '', type: r[6] || '', stage: r[7] || '',
                reason: r[8] || '', edd: r[9] || '', remarks: [r[10], r[11]].filter(x => String(x || '').trim()),
                status: r[12] || '', comment: r[13] || '' }))
            .filter(e => e.awb === awb);
        res.json({ success: true, entries });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Manual per-order marks (Likely-Fake) + insight ──────────────────────────
// Toggle a mark on/off for an order. Any dashboard user may mark (it's an ops judgement call).
router.post('/order-marks', async (req, res) => {
    try {
        const b = req.body || {};
        const order_name = String(b.order_name || '').trim();
        const mark_type = String(b.mark_type || 'likely_fake').trim();
        if (!order_name) return res.status(400).json({ success: false, message: 'order_name required' });
        const { data: existing } = await supabase.from('order_marks_ecom').select('id').eq('order_name', order_name).eq('mark_type', mark_type).maybeSingle();
        if (existing) { await supabase.from('order_marks_ecom').delete().eq('id', existing.id); return res.json({ success: true, marked: false }); }
        const { error } = await supabase.from('order_marks_ecom').insert({ order_name, awb: (b.awb || '').trim() || null, mark_type, note: (b.note || '').trim() || null, created_by: req.user.sub });
        if (error) return res.status(500).json({ success: false, message: error.message });
        res.json({ success: true, marked: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
router.get('/order-marks', async (req, res) => {
    try {
        const type = req.query.type || 'likely_fake';
        const { data, error } = await supabase.from('order_marks_ecom').select('order_name, awb, mark_type, created_by, created_at, note').eq('mark_type', type).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ success: false, message: error.message });
        res.json({ success: true, marks: data || [] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
// Insight: of orders manually marked "likely fake", how many actually got DELIVERED (= the fake attempt
// is proven), how many RTO'd, how many still moving — plus how many were escalated by email.
router.get('/likely-fake-insight', async (req, res) => {
    try {
        const { data: marks } = await supabase.from('order_marks_ecom').select('order_name, awb, created_at, created_by').eq('mark_type', 'likely_fake').order('created_at', { ascending: false });
        const list = marks || [];
        // Email marks ONLY — a sheet push must never wear the mail badge (same rule as the explorer).
        const { data: mailMarks } = await supabase.from('order_marks_ecom').select('order_name').eq('mark_type', 'critical_mail_sent');
        const mailSet = new Set((mailMarks || []).map(m => m.order_name));
        const names = list.map(m => m.order_name);
        const jByName = {};
        for (let i = 0; i < names.length; i += 300) {
            const { data: js } = await supabase.from('shipment_journey_ecom')
                .select('order_name, awb, courier, outcome, delivered_at, first_attempt_success, zone, payment_mode')
                .in('order_name', names.slice(i, i + 300));
            (js || []).forEach(j => { jByName[j.order_name] = j; });
        }
        let delivered = 0, rto = 0, inTransit = 0, other = 0;
        const rows = list.map(m => {
            const j = jByName[m.order_name] || {};
            const oc = j.outcome || 'unknown';
            if (oc === 'delivered') delivered++;
            else if (oc === 'rto') rto++;
            else if (oc === 'in_transit' || oc === 'ndr_pending') inTransit++;
            else other++;
            return { order_name: m.order_name, awb: m.awb || j.awb || null, courier: j.courier || null, zone: j.zone || null,
                payment_mode: j.payment_mode || null, outcome: oc, marked_at: m.created_at, marked_by: m.created_by, mail_sent: mailSet.has(m.order_name) };
        });
        const total = list.length;
        res.json({ success: true, summary: {
            total, delivered, rto, inTransit, other, mailsSent: mailSet.size,
            conversionPct: pct(delivered, total),   // marked → delivered = the flagged attempt was fake
            rtoPct: pct(rto, total),
        }, rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Expose the send helpers for the scheduled crons (router is a function → attaching props is safe).
router.sendSilentRtoReport = sendSilentRtoReport;
router.sendLateDeliveriesReport = sendLateDeliveriesReport;
router.sendIntransitLateReport = sendIntransitLateReport;
router.sendFirstOfdReport = sendFirstOfdReport;

module.exports = router;
