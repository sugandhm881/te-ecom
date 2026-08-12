// Last-Mile Funnel — what happens to a parcel AFTER the courier takes it out for delivery.
//
// Delivery Performance answers "how did shipments end up". This answers a different question: of the
// parcels that actually reached the doorstep, how many landed, how many came back, and how fast — plus
// the ones that were returned WITHOUT the courier ever attempting delivery.
//
// Three transitions, all derivable from `shipment_journey_ecom` with no new capture:
//   OFD → Delivered    out_for_delivery_at set, outcome='delivered'
//   OFD → RTO          out_for_delivery_at set, outcome='rto'
//   In-Transit → RTO   NO out_for_delivery_at, outcome='rto'   (the courier never tried)
// The third matches the existing `rto_no_attempt` flag exactly — checked over 90 days on the active
// couriers: 2,742 / 129 with ZERO disagreement — so either signal is safe; we use the timestamp so the
// three definitions read off one field.
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const r1 = n => Math.round(n * 10) / 10;

// ⚠️⚠️ DOCPHARMA IS EXCLUDED, AND MUST STAY EXCLUDED.
// Its API returns status MILESTONES ONLY — no scan log — so `out_for_delivery_at` is never set for a
// DocPharma shipment. Every DocPharma RTO therefore looks like "returned without an attempt" when the
// truth is simply that we cannot see the attempt. Measured over 30 days: 216 of its 216 RTOs would land
// in that bucket, turning a real figure of 18 into 234 — a 92% fabrication in the headline number this
// dashboard exists to report. (It is also the courier being wound down.) The UI states the exclusion.
const LM_SOURCES = ['rapidshyp', 'kwikship'];

// Percentile over a numeric array (linear interpolation). Used for the OFD→outcome timings, where the
// MEDIAN is the honest centre — a handful of week-long stragglers drag a mean badly.
function percentile(sorted, p) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const hoursBetween = (a, b) => {
    if (!a || !b) return null;
    const t1 = new Date(a).getTime(), t2 = new Date(b).getTime();
    if (isNaN(t1) || isNaN(t2) || t2 < t1) return null;   // negative = bad data, drop rather than distort
    return (t2 - t1) / 3600000;
};
// IST calendar day for a timestamp. Grouping on the raw UTC date would split an Indian evening across
// two days — the same +05:30 trap that has bitten this codebase before.
const istDay = ts => {
    if (!ts) return null;
    const d = new Date(new Date(ts).getTime() + 5.5 * 3600000);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

async function fetchWindow(fromISO, toISO) {
    const rows = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, zone, dest_state, dest_city, payment_mode, order_type, order_date, out_for_delivery_at, delivered_at, rto_at, outcome, attempts, ndr_count, ndr_reasons, first_edd')
            .in('source', LM_SOURCES)
            .gte('out_for_delivery_at', fromISO).lte('out_for_delivery_at', toISO)
            .range(off, off + 999);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return rows;
}
// The never-attempted returns, anchored on RTO DATE — they have no OFD timestamp to cohort by, which is
// the whole point of the category. Kept as a separate pull so it can never contaminate the OFD cohort.
async function fetchNoAttempt(fromISO, toISO) {
    const rows = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, zone, dest_state, dest_city, payment_mode, order_date, rto_at, outcome')
            .in('source', LM_SOURCES)
            .is('out_for_delivery_at', null).eq('outcome', 'rto')
            .gte('rto_at', fromISO).lte('rto_at', toISO)
            .range(off, off + 999);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return rows;
}

// Summarise one OFD cohort.
// ⚠️ RATES ARE ON **RESOLVED**, NOT ON THE WHOLE COHORT. A parcel that went out this morning has not had
// its chance yet: on 12 Aug, 130 of 241 (54%) were still open, and dividing by the cohort would have
// reported a 39% delivery rate for a day that was going fine. Still-open is returned as its own number
// and shown as its own slice — never folded into a denominator.
function summarise(rows) {
    const ofd = rows.length;
    const delivered = rows.filter(r => r.outcome === 'delivered');
    const rto = rows.filter(r => r.outcome === 'rto');
    const open = rows.filter(r => r.outcome !== 'delivered' && r.outcome !== 'rto');
    const resolved = delivered.length + rto.length;
    const durDel = delivered.map(r => hoursBetween(r.out_for_delivery_at, r.delivered_at)).filter(v => v != null).sort((a, b) => a - b);
    const durRto = rto.map(r => hoursBetween(r.out_for_delivery_at, r.rto_at)).filter(v => v != null).sort((a, b) => a - b);
    const sameDay = delivered.filter(r => { const h = hoursBetween(r.out_for_delivery_at, r.delivered_at); return h != null && h <= 24; });
    const firstGo = delivered.filter(r => (r.ndr_count || 0) === 0);
    return {
        ofd, delivered: delivered.length, rto: rto.length, open: open.length, resolved,
        // On resolved — the honest base while a cohort is still maturing.
        deliveredRate: pct(delivered.length, resolved),
        rtoRate: pct(rto.length, resolved),
        openRate: pct(open.length, ofd),                       // share of the cohort still in flight
        sameDayRate: pct(sameDay.length, delivered.length),    // landed within 24h of going out
        firstGoRate: pct(firstGo.length, delivered.length),    // delivered with no failed attempt
        medianHrsToDeliver: durDel.length ? r1(percentile(durDel, 0.5)) : null,
        p90HrsToDeliver: durDel.length ? r1(percentile(durDel, 0.9)) : null,
        medianDaysToRto: durRto.length ? r1(percentile(durRto, 0.5) / 24) : null,
        avgAttempts: resolved ? r1(rows.filter(r => r.outcome === 'delivered' || r.outcome === 'rto')
            .reduce((a, r) => a + (r.attempts || 0), 0) / resolved) : 0,
    };
}

// Group by a dimension, rates on resolved.
function cut(rows, keyFn) {
    const g = {};
    rows.forEach(r => {
        const k = keyFn(r); if (!k) return;
        (g[k] = g[k] || { ofd: 0, delivered: 0, rto: 0, open: 0, hrs: [] });
        g[k].ofd++;
        if (r.outcome === 'delivered') { g[k].delivered++; const h = hoursBetween(r.out_for_delivery_at, r.delivered_at); if (h != null) g[k].hrs.push(h); }
        else if (r.outcome === 'rto') g[k].rto++;
        else g[k].open++;
    });
    return Object.entries(g).map(([key, v]) => {
        const resolved = v.delivered + v.rto;
        const s = v.hrs.sort((a, b) => a - b);
        return { key, ofd: v.ofd, delivered: v.delivered, rto: v.rto, open: v.open, resolved,
            deliveredRate: pct(v.delivered, resolved), rtoRate: pct(v.rto, resolved),
            medianHrs: s.length ? r1(percentile(s, 0.5)) : null };
    }).sort((a, b) => b.ofd - a.ofd);
}

// GET /api/last-mile?from=YYYY-MM-DD&to=YYYY-MM-DD&source=&courier=&zone=&payment=
router.get('/last-mile', async (req, res) => {
    try {
        const today = new Date();
        const parse = (v, fb) => { const d = v ? new Date(v) : fb; return isNaN(d.getTime()) ? fb : d; };
        const to = parse(req.query.to, today);
        const from = parse(req.query.from, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6));
        // Local calendar bounds — slicing toISOString() would shift an IST morning back a day.
        const fromISO = new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString();
        const toISO = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).toISOString();
        const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        // Previous window of EQUAL length, immediately before — so deltas compare like with like.
        const lenDays = Math.round((new Date(to.getFullYear(), to.getMonth(), to.getDate()) - new Date(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000) + 1;
        const pTo = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
        const pFrom = new Date(pTo.getFullYear(), pTo.getMonth(), pTo.getDate() - (lenDays - 1));
        const pFromISO = new Date(pFrom.getFullYear(), pFrom.getMonth(), pFrom.getDate()).toISOString();
        const pToISO = new Date(pTo.getFullYear(), pTo.getMonth(), pTo.getDate(), 23, 59, 59, 999).toISOString();

        const [curRaw, prevRaw, noAttemptRaw, noAttemptPrev] = await Promise.all([
            fetchWindow(fromISO, toISO), fetchWindow(pFromISO, pToISO),
            fetchNoAttempt(fromISO, toISO), fetchNoAttempt(pFromISO, pToISO),
        ]);

        // Filters are applied in memory so the dropdowns can always list every option in range.
        const source = req.query.source || 'all', courier = req.query.courier || 'all';
        const zone = req.query.zone || 'all', payment = req.query.payment || 'all';
        const match = r =>
            (source === 'all' || r.source === source) &&
            (courier === 'all' || (r.courier || 'Unknown') === courier) &&
            (zone === 'all' || r.zone === zone) &&
            (payment === 'all' || (payment === 'COD' ? /cod/i.test(r.payment_mode || '') : !/cod/i.test(r.payment_mode || '')));
        const rows = curRaw.filter(match), prev = prevRaw.filter(match);
        const noAttempt = noAttemptRaw.filter(match), noAttemptP = noAttemptPrev.filter(match);

        // Option lists from the UNFILTERED window, so picking one never empties the others.
        const uniq = (arr, f) => { const c = {}; arr.forEach(r => { const k = f(r); if (k) c[k] = (c[k] || 0) + 1; });
            return Object.entries(c).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count); };

        // Daily trend, on IST calendar days, over the OFD cohort.
        const byDay = {};
        rows.forEach(r => { const k = istDay(r.out_for_delivery_at); if (!k) return;
            (byDay[k] = byDay[k] || { ofd: 0, delivered: 0, rto: 0, open: 0 });
            byDay[k].ofd++;
            if (r.outcome === 'delivered') byDay[k].delivered++;
            else if (r.outcome === 'rto') byDay[k].rto++;
            else byDay[k].open++; });
        const trend = Object.keys(byDay).sort().map(d => ({ date: d, ...byDay[d],
            deliveredRate: pct(byDay[d].delivered, byDay[d].delivered + byDay[d].rto) }));

        const summary = summarise(rows), prevSummary = summarise(prev);
        // Reasons the courier gave on parcels that went out and still came back — the actionable list.
        const reasonCount = {};
        rows.filter(r => r.outcome === 'rto').forEach(r => (r.ndr_reasons || []).forEach(x => {
            const k = String(x || '').trim(); if (k) reasonCount[k] = (reasonCount[k] || 0) + 1; }));
        const rtoReasons = Object.entries(reasonCount).map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count).slice(0, 10);

        res.json({
            success: true,
            range: { from: fmtLocal(from), to: fmtLocal(to), days: lenDays },
            previousRange: { from: fmtLocal(pFrom), to: fmtLocal(pTo) },
            filters: { source, courier, zone, payment },
            summary, previous: prevSummary,
            // Anchored on RTO date, not OFD — these have no OFD by definition. Reported separately so it
            // is never mistaken for part of the OFD cohort's arithmetic.
            noAttempt: { count: noAttempt.length, prevCount: noAttemptP.length,
                byCourier: uniq(noAttempt, r => r.courier || 'Unknown').slice(0, 8),
                list: noAttempt.slice(0, 200).map(r => ({ order: r.order_name, awb: r.awb, source: r.source,
                    courier: r.courier, zone: r.zone, state: r.dest_state, city: r.dest_city,
                    payment: r.payment_mode, rto_at: r.rto_at, order_date: r.order_date })) },
            trend, rtoReasons,
            byCourier: cut(rows, r => r.courier || 'Unknown'),
            byZone: cut(rows, r => r.zone).sort((a, b) => String(a.key).localeCompare(String(b.key))),
            byState: cut(rows, r => (r.dest_state || '').trim()).slice(0, 15),
            byPayment: cut(rows, r => /cod/i.test(r.payment_mode || '') ? 'COD' : (r.payment_mode ? 'Prepaid' : null)),
            couriers: uniq(curRaw, r => r.courier || 'Unknown'),
            zones: uniq(curRaw, r => r.zone).sort((a, b) => String(a.key).localeCompare(String(b.key))),
            sources: uniq(curRaw, r => r.source),
            coverage: { sources: LM_SOURCES,
                note: 'RapidShyp and KwikShip only. DocPharma provides status milestones with no scan log, so it has no out-for-delivery event at all — including it would report every DocPharma return as "never attempted" (216 of 216 over 30 days) and inflate that figure roughly thirteenfold.' },
            shipments: rows.slice(0, 3000).map(r => ({
                order: r.order_name, awb: r.awb, source: r.source, courier: r.courier,
                zone: r.zone, state: r.dest_state, city: r.dest_city, payment: r.payment_mode,
                order_type: r.order_type, outcome: r.outcome, attempts: r.attempts || 0, ndr_count: r.ndr_count || 0,
                reasons: (r.ndr_reasons || []).slice(0, 4),
                ofd_at: r.out_for_delivery_at, delivered_at: r.delivered_at, rto_at: r.rto_at,
                hrs: hoursBetween(r.out_for_delivery_at, r.delivered_at || r.rto_at),
                order_date: r.order_date, edd: r.first_edd,
            })),
            shipmentsTotal: rows.length,
        });
    } catch (e) { console.error('[LastMile]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
