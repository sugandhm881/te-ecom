// Delivery Performance API — aggregates shipment_journey_ecom into the 3 reports + KPIs.
// GET /api/delivery-performance?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Returns { range, kpis, statusBreakdown(partition), tat, zones, fasrTrend, rtoByCourier, ndrFunnel, shipments }.
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { supabase } = require('../supabase');
const { fetchRsShipment, parseScanDate, parseDpDate } = require('./delivery_journey');
const { fetchDocpharmaDetails } = require('./helpers');
const { requirePermission } = require('../auth');
// Email-send routes below are gated by the 'send-escalation-emails' capability (admins pass via '*';
// other users only if the admin granted them this permission on the Users page). See server.js _VIEW_PERMS
// for the additional per-dashboard view gate on the claims routes.
const requireEmailSender = requirePermission('send-escalation-emails');
const { getEmailConfig, sendMail, recipientsFor } = require('./email_settings');
const { aiComplete, isConfigured: aiConfigured } = require('./ai');

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

async function fetchJourneys(fromISO, toISO, source, payment, zone, courier, orderType, state) {
    const rows = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        let q = supabase
            .from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, outcome, attempts, ndr_count, reached_delivery, first_attempt_success, ndr_reasons, out_for_delivery_at, delivered_at, rto_at, dispatched_at, order_date, first_edd, status_code, payment_mode, zone, order_type, dest_state, dest_city, dest_pincode')
            .gte('order_date', fromISO)
            .lte('order_date', toISO);
        if (source && source !== 'all') q = q.eq('source', source);      // 'rapidshyp' | 'docpharma'
        if (payment && payment !== 'all') q = q.ilike('payment_mode', payment); // 'COD' | 'prepaid'
        if (zone && zone !== 'all') q = q.eq('zone', zone);              // exact zone label
        if (courier && courier !== 'all') q = q.eq('courier', courier);  // exact courier name
        if (orderType && orderType !== 'all') q = q.eq('order_type', orderType); // 'new' | 'repeat'
        if (state && state !== 'all') q = q.ilike('dest_state', state);   // destination state (e.g. 'Kerala')
        const { data, error } = await q.order('order_date', { ascending: false }).range(offset, offset + PAGE - 1);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
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
    const otd = tatSummary(rows.map(r => diff(r.order_date, r.dispatched_at, 'hrs')), BUCKETS_HRS, 'hrs');
    const dtd = tatSummary(delivered.map(r => diff(r.dispatched_at, r.delivered_at, 'days')), BUCKETS_DAYS, 'days');
    return {
        totalShipments: tracked, resolved, delivered: delivered.length, rto: rto.length, lost: lost.length,
        inTransit: inTransit.length, ndrPending: pending.length,
        firstAttempt: firstAttempt.length, deliveredMulti,
        firstAttemptCount: firstAttempt.length, ndrTotal: ndr.length, ndrRecovered: ndrDelivered.length,
        rtoAttempted: ndrRto.length, rtoSilent: rto.length - ndrRto.length,
        fasr: pct(firstAttempt.length, tracked), rtoRate: pct(rto.length, tracked),
        deliveredRate: pct(delivered.length, tracked), ndrRecoveryRate: pct(ndrDelivered.length, ndr.length),
        avgAttempts, otdAvg: otd.avg, dtdAvg: dtd.avg,
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
        return {
            tracked, delivered: delivered.length, ndrTotal: ndr.length, rto: rto.length,
            fasr: pct(first.length, tracked), ndrRate: pct(ndr.length, tracked),
            ndrRecoveryRate: pct(ndrDelivered.length, ndr.length), rtoRate: pct(rto.length, tracked),
            deliveredRate: pct(delivered.length, tracked),
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
        const allRows = await fetchJourneys(fromISO, toISO, source, payment, 'all', 'all', orderType, 'all');
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

        // ── Compare mode: same filters over the immediately-preceding equal-length window ──
        let compareOut = null;
        if (compare) {
            const d0 = new Date(from.getFullYear(), from.getMonth(), from.getDate());
            const d1 = new Date(to.getFullYear(), to.getMonth(), to.getDate());
            const lenDays = Math.round((d1 - d0) / 86400000) + 1;      // inclusive day count
            const pTo = new Date(d0); pTo.setDate(pTo.getDate() - 1);   // day before current start
            const pFrom = new Date(pTo); pFrom.setDate(pFrom.getDate() - (lenDays - 1));
            const pFromISO = new Date(pFrom.getFullYear(), pFrom.getMonth(), pFrom.getDate()).toISOString();
            const pToISO = new Date(pTo.getFullYear(), pTo.getMonth(), pTo.getDate(), 23, 59, 59).toISOString();
            const pRows = (await fetchJourneys(pFromISO, pToISO, source, payment, 'all', 'all', orderType, 'all')).filter(matchFilters);
            compareOut = { range: { from: fmtLocal(pFrom), to: fmtLocal(pTo) }, kpis: summarizeAll(pRows) };
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
        const deliveredMulti = delivered.length - firstAttempt.length;        // Rest − First-Attempt (delivered after ≥1 NDR)

        // NDR cohort = shipments with ≥1 failed attempt, split by outcome (recovered vs lost vs pending)
        const ndr = rows.filter(r => (r.ndr_count || 0) > 0);
        const ndrDelivered = ndr.filter(r => r.outcome === 'delivered');
        const ndrRto = ndr.filter(r => r.outcome === 'rto');
        const ndrPending = ndr.filter(r => r.outcome === 'ndr_pending');
        // "Silent" RTOs — returned WITHOUT a recorded failed delivery attempt (RTO'd at pickup /
        // undeliverable pre-dispatch / cancelled in transit). These are in total RTO but NOT the NDR cohort.
        const directRto = rto.length - ndrRto.length;

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
            rtoRate: pct(rto.length, tracked),            // RTO ÷ Total Tracked
            deliveredRate: pct(delivered.length, tracked),
            avgAttempts,
            ndrTotal: ndr.length,
            ndrRecovered: ndrDelivered.length,
            ndrLost: ndrRto.length,
            ndrPending: ndrPending.length,
            ndrRecoveryRate: pct(ndrDelivered.length, ndr.length),   // recovered ÷ all-NDR (your 100/300)
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
            // explicit partition (each shipment counted once) for the reconciliation strip
            partition: [
                { key: 'delivered_first', label: STATE_LABEL.delivered_first, count: firstAttempt.length },
                { key: 'delivered_ndr',   label: STATE_LABEL.delivered_ndr,   count: deliveredMulti },
                { key: 'rto',             label: STATE_LABEL.rto,             count: rto.length },
                { key: 'lost',            label: STATE_LABEL.lost,            count: lost.length },
                { key: 'ndr_pending',     label: STATE_LABEL.ndr_pending,     count: pending.length },
                { key: 'in_transit',      label: STATE_LABEL.in_transit,      count: inTransit.length },
            ].filter(p => p.key !== 'lost' || p.count > 0),   // hide Lost bucket when there are none
        };

        // ── FASR trend (by day) — % of that day's TRACKED shipments delivered on the first attempt.
        //   Denominator = ALL tracked shipments that day (same base as the FASR card ÷ tracked), so the
        //   trend's weighted average equals the card exactly.
        const byDay = {};
        rows.forEach(r => {
            const k = dayKey(r.order_date); if (!k) return;
            (byDay[k] = byDay[k] || { tracked: 0, first: 0 });
            byDay[k].tracked++; if (r.outcome === 'delivered' && r.first_attempt_success) byDay[k].first++;
        });
        const fasrTrend = Object.keys(byDay).sort().map(k => ({ date: k, reached: byDay[k].tracked, first: byDay[k].first, fasr: pct(byDay[k].first, byDay[k].tracked) }));

        // ── RTO by courier (% of that courier's RESOLVED shipments) ──
        const courierMap = {};
        [...delivered, ...rto].forEach(r => {
            const c = r.courier || 'Unknown';
            (courierMap[c] = courierMap[c] || { total: 0, rto: 0 });
            courierMap[c].total++; if (r.outcome === 'rto') courierMap[c].rto++;
        });
        const rtoByCourier = Object.entries(courierMap)
            .map(([courier, v]) => ({ courier, total: v.total, rto: v.rto, rtoRate: pct(v.rto, v.total) }))
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
            supabase.from('order_marks_ecom').select('order_name').eq('mark_type', 'critical_mail_sent'),
        ]);
        const fakeSet = new Set((fmRes.data || []).map(m => m.order_name));
        const mailSet = new Set((msRes.data || []).map(m => m.order_name));
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
                attempts: r.attempts || 0, ndr_count: r.ndr_count || 0,
                payment: r.payment_mode || null, zone: r.zone || null, order_type: r.order_type || null,
                dest_state: r.dest_state || null, dest_city: r.dest_city || null, dest_pincode: r.dest_pincode || null,
                reasons: (r.ndr_reasons || []).slice(0, 5),
                status_code: r.status_code || null,
                edd: r.first_edd || null,                 // promise date (for the Promise column)
                pastPromise: pastPromise(r),
                marked_fake: fakeSet.has(r.order_name),   // manually flagged as a likely fake attempt
                mail_sent: mailSet.has(r.order_name),     // an escalation email was sent for this order
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

        res.json({
            success: true,
            range: { from: fmtLocal(from), to: fmtLocal(to) }, source, payment, courier, orderType, zone: zoneSel, state: stateSel,
            compare: compareOut,
            kpis, statusBreakdown, tat, zones, states, couriers,
            // Total RTO split by whether the courier ever attempted delivery — the 340/73 breakdown.
            rtoBreakdown: { attempted: ndrRto.length, silent: directRto, total: rto.length },
            // NDR funnel is the cohort with ≥1 failed attempt; directRto reconciles it to TOTAL RTO.
            ndrFunnel: { total: ndr.length, recovered: ndrDelivered.length, lost: ndrRto.length, pending: ndrPending.length, directRto, totalRto: rto.length },
            fasrTrend, rtoByCourier,
            byPayment: paymentSplit(rows),   // #1 — Prepaid vs COD FASR/NDR/RTO comparison
            shipments: shipments.slice(0, CAP), shipmentsTruncated, shipmentsTotal: shipments.length,
        });
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
            .select('awb, order_name, source, courier, outcome, status_code, order_date, dispatched_at, out_for_delivery_at, delivered_at, rto_at, first_edd, ndr_reasons, attempts, ndr_count, raw')
            .eq('awb', awb).maybeSingle();

        // Normalize any scan array → { at, desc, code, location }, oldest first.
        const norm = (scans) => (scans || []).map(s => ({
            at: parseScanDate(s.scan_datetime || s.date || s.timestamp || s.event_time || s.event_date) || null,
            desc: s.scan || s.status_desc || s.status || s.activity || s.remark || '',
            code: s.rapidshyp_status_code || s.status_code || '',
            location: s.scan_location || s.location || s.city || '',
        })).filter(x => x.desc).sort((a, b) => (a.at || '').localeCompare(b.at || ''));

        let scans = (j && j.raw && Array.isArray(j.raw.scans)) ? norm(j.raw.scans) : null;
        let live = false;
        let dpInfo = null;   // DocPharma-only: tracking link + current status + promise EDD (no scan log upstream)

        if (!scans || !scans.length) {
            if (j?.source !== 'docpharma') {                       // RapidShyp by AWB
                const rs = await fetchRsShipment(awb);
                if (rs.found && rs.scans && rs.scans.length) {
                    scans = norm(rs.scans); live = true;
                    if (j && !(j.raw && j.raw.scans)) {            // cache back so repeat views cost 0 API calls
                        supabase.from('shipment_journey_ecom')
                            .update({ raw: { scans: rs.scans, status: rs.status, status_code: rs.statusCode, captured_at: new Date().toISOString() } })
                            .eq('awb', awb).then(() => {}).catch(() => {});
                    }
                }
            }
            if ((!scans || !scans.length) && j?.order_name) {      // DocPharma fallback by order name
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

        res.json({
            success: true, awb, source: j ? j.source : null, live, scans: scans || [], dp: dpInfo,
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
const PLATFORM_LABEL = { rapidshyp: 'RapidShyp', docpharma: 'DocPharma' };

// Send a delivery report as SEPARATE emails per platform — RapidShyp rows go to the RapidShyp recipients,
// DocPharma rows to the DocPharma recipients (each configured in Settings → Email & Reports). `source`
// restricts to one platform; otherwise BOTH are attempted. A platform is skipped when it has no matching
// rows OR no recipient configured. fetchFn(fromISO,toISO,platform,extra) → rows; buildFn(rows,rangeLabel,
// platform,extra) → { subject, html }. Returns { ok, skipped?, reason?, to, count, results }.
async function sendReportPerPlatform({ fetchFn, buildFn, rg, source, extra }) {
    const platforms = source ? [source] : ['rapidshyp', 'docpharma'];
    const results = [];
    for (const p of platforms) {
        const rows = await fetchFn(rg.fromISO, rg.toISO, p, extra);
        if (!rows.length) { results.push({ platform: p, count: 0, skipped: true, reason: `${PLATFORM_LABEL[p] || p}: none in range` }); continue; }
        const rcpt = await recipientsFor(p);
        if (!rcpt.to.length) { results.push({ platform: p, count: rows.length, skipped: true, reason: `${PLATFORM_LABEL[p] || p}: no recipient set in Settings` }); continue; }
        const mail = buildFn(rows, emailRangeLabel(rg), p, extra);
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
    const rg = opts.fromISO ? opts : rangeEndingYesterday(opts.days || 7);
    const rows = await fetchSilentRto(rg.fromISO, rg.toISO);          // RapidShyp-only by design
    if (!rows.length) return { ok: false, skipped: true, reason: 'No silent-RTO shipments in the selected range.' };
    const mail = buildSilentRtoMail(rows, emailRangeLabel(rg));
    let to = opts.to, cc;
    if (!to) { const rcpt = await recipientsFor('rapidshyp'); to = rcpt.to; cc = rcpt.cc; }
    if (!to || !to.length) throw new Error('No RapidShyp recipient set — add it in Settings → Email & Reports.');
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
    return sendReportPerPlatform({ fetchFn: fetchLateDeliveries, buildFn: buildLateMail, rg, source: opts.source });
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
    return sendReportPerPlatform({ fetchFn: fetchIntransitLate, buildFn: buildIntransitMail, rg, source: opts.source });
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
    return sendReportPerPlatform({ fetchFn: fetchFirstOfdLate, buildFn: buildFirstOfdMail, rg, source: opts.source });
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
        const out = await sendSilentRtoReport({ ...rg });   // recipient comes from Settings (RapidShyp email), not req.body
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
        const out = await sendLateDeliveriesReport({ ...rg, source: (req.body && req.body.source) || undefined });
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
        const out = await sendIntransitLateReport({ ...rg, source: (req.body && req.body.source) || undefined });
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
        const out = await sendFirstOfdReport({ ...rg, source: (req.body && req.body.source) || undefined });
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

// Compose a critical escalation email from selected shipments; AI-polishes the wording (falls back to a
// built-in template when AI isn't configured). Returns the editable draft — NOT sent yet.
router.post('/critical-email/compose', requireEmailSender, async (req, res) => {
    try {
        const awbs = Array.isArray(req.body && req.body.awbs) ? req.body.awbs.filter(Boolean).slice(0, 60) : [];
        if (!awbs.length) return res.status(400).json({ success: false, message: 'No shipments selected — filter the table (e.g. Likely fake attempts) first.' });
        const { data } = await supabase.from('shipment_journey_ecom')
            .select('order_name, awb, courier, outcome, ndr_count, ndr_reasons, first_edd, order_date, payment_mode, zone, dest_city, dest_state')
            .in('awb', awbs);
        const rows = data || [];
        if (!rows.length) return res.status(400).json({ success: false, message: 'Selected shipments not found.' });
        const toneLine = MAIL_TONES[req.body && req.body.tone] || MAIL_TONES.formal;
        // Destination phrased unambiguously — "IDUKKI zone E" once made the AI write "the Idukki zone".
        const lines = rows.slice(0, 40).map(r => {
            const dest = [r.dest_city, r.dest_state].filter(Boolean).join(', ');
            return `- ${r.order_name} (AWB ${r.awb}), courier ${r.courier || 'unknown'}, status: ${OUTCOME_EN[r.outcome] || r.outcome}, failed attempts (NDRs): ${r.ndr_count || 0}${(r.ndr_reasons && r.ndr_reasons.length) ? ` ["${r.ndr_reasons.join('; ')}"]` : ''}${dest ? `, destination: ${dest}` : ''}${r.zone ? ` (delivery zone ${r.zone})` : ''}`;
        }).join('\n');
        const sys = `You are an operations manager at an Indian D2C skincare brand (The Element) writing an escalation email to the courier partner RapidShyp. Tone: ${toneLine} Be concise, specific and action-oriented. Do NOT invent facts beyond the data given. ${NO_CODES_RULE} Respond ONLY with strict JSON {"subject":"...","body":"..."} — body is plain text with \\n line breaks, under 180 words, no markdown.`;
        const usr = `Write an escalation email about likely FAKE delivery attempts. These ${rows.length} shipments were marked as failed/NDR ("customer unavailable" etc.) but the addresses were fine — several were delivered on the very next attempt. Ask RapidShyp to (1) investigate the delivery agents, (2) stop fake NDR markings, (3) reattempt and confirm. Reference the count, not each AWB (a table is attached).\n\nShipments:\n${lines}`;
        let draft = await aiComplete([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.4 });
        let subject, body;
        if (draft) { try { const j = JSON.parse(draft.replace(/```json?/gi, '').replace(/```/g, '').trim()); subject = j.subject; body = j.body; } catch (_) { body = draft; } }
        if (!subject) subject = `Escalation: ${rows.length} shipments with likely fake delivery attempts`;
        if (!body) body = `Hi RapidShyp team,\n\nWe've identified ${rows.length} shipments flagged with failed/NDR delivery attempts that appear to be fake — several were delivered successfully on the very next attempt to the same address. Please investigate the delivery agents involved, stop the fake "customer unavailable" markings, and ensure prompt reattempts with confirmation.\n\nThe affected shipments are listed in the table below.\n\nThank you,\nThe Element — Operations`;
        res.json({ success: true, subject, body, count: rows.length, aiUsed: !!draft, aiAvailable: aiConfigured(), tableHtml: buildCriticalTable(rows), orders: rows.map(r => ({ order_name: r.order_name, awb: r.awb })) });
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
        const sys = `You are an expert business-communication editor. Rewrite and polish the given escalation email draft from The Element (D2C skincare brand) to its courier partner. Tone: ${toneLine} Keep ALL facts intact — do not add, drop or alter order numbers, AWBs, counts or claims. ${NO_CODES_RULE} Respond ONLY with strict JSON {"subject":"...","body":"..."} — body is plain text with \\n line breaks, under 200 words, no markdown.`;
        const usr = `Polish this draft:\n\nSubject: ${subject || '(none)'}\n\nBody:\n${body}`;
        const draft = await aiComplete([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.4 });
        if (!draft) return res.status(502).json({ success: false, message: 'AI polish failed — please try again.' });
        let out = {};
        try { out = JSON.parse(draft.replace(/```json?/gi, '').replace(/```/g, '').trim()); } catch (_) { out = { subject, body: draft }; }
        res.json({ success: true, subject: out.subject || subject, body: out.body || body });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
router.post('/critical-email/send', requireEmailSender, async (req, res) => {
    try {
        const { subject, body, to, tableHtml } = req.body || {};
        if (!subject || !body) return res.status(400).json({ success: false, message: 'Subject and body are required.' });
        const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;max-width:840px;white-space:pre-wrap;line-height:1.5;">${esc(body)}</div>${tableHtml || ''}`;
        let recipient = to;
        if (!recipient) { const cfg = await getEmailConfig(); recipient = cfg && cfg.rapidshyp; }
        const r = await sendMail({ to: recipient || undefined, subject, html, text: body });
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
