// Delivery Performance API — aggregates shipment_journey_ecom into the 3 reports + KPIs.
// GET /api/delivery-performance?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Returns { range, kpis, statusBreakdown(partition), tat, zones, fasrTrend, rtoByCourier, ndrFunnel, shipments }.
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { supabase } = require('../supabase');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0); // 1-dp percentage
const dayKey = ts => (ts ? String(ts).slice(0, 10) : null);

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

async function fetchJourneys(fromISO, toISO, source, payment, zone, courier, orderType) {
    const rows = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        let q = supabase
            .from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, outcome, attempts, ndr_count, reached_delivery, first_attempt_success, ndr_reasons, delivered_at, rto_at, dispatched_at, order_date, payment_mode, zone, order_type')
            .gte('order_date', fromISO)
            .lte('order_date', toISO);
        if (source && source !== 'all') q = q.eq('source', source);      // 'rapidshyp' | 'docpharma'
        if (payment && payment !== 'all') q = q.ilike('payment_mode', payment); // 'COD' | 'prepaid'
        if (zone && zone !== 'all') q = q.eq('zone', zone);              // exact zone label
        if (courier && courier !== 'all') q = q.eq('courier', courier);  // exact courier name
        if (orderType && orderType !== 'all') q = q.eq('order_type', orderType); // 'new' | 'repeat'
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
        const zone = req.query.zone || 'all';        // all | <zone label>
        const courier = req.query.courier || 'all';  // all | <courier name>
        const orderType = req.query.order_type || 'all'; // all | new | repeat
        const compare = req.query.compare === '1' || req.query.compare === 'true';

        // Fetch WITHOUT the courier filter so the courier dropdown always lists every courier in range;
        // then narrow to the selected courier in-memory (single query).
        const allRows = await fetchJourneys(fromISO, toISO, source, payment, zone, 'all', orderType);
        const courierCount = {};
        allRows.forEach(r => { const c = r.courier || 'Unknown'; courierCount[c] = (courierCount[c] || 0) + 1; });
        const couriers = Object.entries(courierCount).map(([c, n]) => ({ courier: c, count: n })).sort((a, b) => b.count - a.count);
        const rows = courier === 'all' ? allRows : allRows.filter(r => (r.courier || 'Unknown') === courier);

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
            const pRows = await fetchJourneys(pFromISO, pToISO, source, payment, zone, courier, orderType);
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
            fasr: pct(firstAttempt.length, tracked),      // First-Attempt ÷ Total Tracked
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

        // ── FASR trend (by day) — % of that day's RESOLVED shipments delivered on the first attempt ──
        const byDay = {};
        [...delivered, ...rto].forEach(r => {
            const k = dayKey(r.order_date); if (!k) return;
            (byDay[k] = byDay[k] || { resolved: 0, first: 0 });
            byDay[k].resolved++; if (r.outcome === 'delivered' && r.first_attempt_success) byDay[k].first++;
        });
        const fasrTrend = Object.keys(byDay).sort().map(k => ({ date: k, reached: byDay[k].resolved, first: byDay[k].first, fasr: pct(byDay[k].first, byDay[k].resolved) }));

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

        // ── Zones present in this window (for the Zone filter dropdown) ──
        const zoneSet = {};
        rows.forEach(r => { if (r.zone) zoneSet[r.zone] = (zoneSet[r.zone] || 0) + 1; });
        const zones = Object.entries(zoneSet).map(([z, n]) => ({ zone: z, count: n })).sort((a, b) => b.count - a.count);

        // ── Unified, searchable drill-down list — EVERY tracked shipment with its state, so the
        // table can filter to any segment (any status chip / funnel slice) and search by order/AWB.
        const CAP = 6000;
        const shipments = rows
            .map(r => ({
                order: r.order_name, awb: r.awb, source: r.source, courier: r.courier,
                state: stateOf(r), outcome: r.outcome,
                attempts: r.attempts || 0, ndr_count: r.ndr_count || 0,
                payment: r.payment_mode || null, zone: r.zone || null, order_type: r.order_type || null,
                reasons: (r.ndr_reasons || []).slice(0, 3),
                order_date: r.order_date ? String(r.order_date).slice(0, 10) : null,
                delivered_at: r.delivered_at ? String(r.delivered_at).slice(0, 10) : null,
                rto_at: r.rto_at ? String(r.rto_at).slice(0, 10) : null,
            }))
            .sort((a, b) => (b.order_date || '').localeCompare(a.order_date || ''));
        const shipmentsTruncated = shipments.length > CAP;

        res.json({
            success: true,
            range: { from: fmtLocal(from), to: fmtLocal(to) }, source, payment, zone, courier, orderType,
            compare: compareOut,
            kpis, statusBreakdown, tat, zones, couriers,
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

module.exports = router;
