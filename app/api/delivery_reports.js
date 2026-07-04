// Delivery Performance API — aggregates shipment_journey_ecom into the 3 reports + KPIs.
// GET /api/delivery-performance?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Returns { range, kpis, statusBreakdown(partition), tat, zones, fasrTrend, rtoByCourier, ndrFunnel, shipments }.
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { supabase } = require('../supabase');
const { fetchRsShipment, parseScanDate } = require('./delivery_journey');
const { fetchDocpharmaDetails } = require('./helpers');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0); // 1-dp percentage
// Calendar day in IST (en-CA → YYYY-MM-DD). Timestamps are stored as UTC instants; slicing the raw
// UTC string would mis-date orders placed 00:00–05:30 IST (they fall on the previous UTC day).
const dayKey = ts => (ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null);

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
        const shipments = rows
            .map(r => ({
                order: r.order_name, awb: r.awb, source: r.source, courier: r.courier,
                state: stateOf(r), outcome: r.outcome,
                attempts: r.attempts || 0, ndr_count: r.ndr_count || 0,
                payment: r.payment_mode || null, zone: r.zone || null, order_type: r.order_type || null,
                dest_state: r.dest_state || null, dest_city: r.dest_city || null, dest_pincode: r.dest_pincode || null,
                reasons: (r.ndr_reasons || []).slice(0, 5),
                status_code: r.status_code || null,
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
                    const hist = (dp && dp.suborders && dp.suborders[0] && dp.suborders[0].logistic_details && dp.suborders[0].logistic_details.tracking_history)
                        || (dp && dp.tracking_history) || [];
                    if (hist.length) { scans = norm(hist); live = true; }
                } catch (_e) { /* ignore */ }
            }
        }

        res.json({
            success: true, awb, source: j ? j.source : null, live, scans: scans || [],
            journey: j ? {
                order_name: j.order_name, courier: j.courier, outcome: j.outcome, status_code: j.status_code,
                attempts: j.attempts, ndr_count: j.ndr_count, ndr_reasons: j.ndr_reasons || [],
                ts: { order: j.order_date, dispatched: j.dispatched_at, ofd: j.out_for_delivery_at, delivered: j.delivered_at, rto: j.rto_at, edd: j.first_edd },
            } : null,
        });
    } catch (e) {
        console.error('[ShipmentDetail] error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
