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
// SHARED with Delivery Performance — same capability key, same derivation of an order's value, so the
// two pages can never disagree about who may see ₹ or what a shipment is worth. See ./order_value.
const { canSeeRevenue, attachOrderValue, sumV } = require('./order_value');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const r1 = n => Math.round(n * 10) / 10;
// Delivered + RTO + Pending are shown as a partition that "sums to 100%", and the page says so. Rounding
// the three independently breaks that promise about a third of the time — 51.1 + 27.0 + 22.0 = 100.1 on
// live data, and a strip that adds to 100.1% reads as broken however correct the underlying figures are.
// The residual (pending) is therefore DERIVED from the other two rather than rounded on its own, so the
// three always reconcile exactly. Same trick as rounding order value once at source.
const share3 = (a, b, total) => {
    if (!(total > 0)) return [0, 0, 0];
    const ra = pct(a, total), rb = pct(b, total);
    return [ra, rb, r1(100 - ra - rb)];
};

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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ⚠️ EACH PARCEL IS ATTRIBUTED TO EXACTLY ONE TRIP: THE ONE THAT DECIDED ITS OUTCOME.
//
// Two wrong rules were tried before this one; both are easy to fall back into, so both are recorded.
//
// 1. "First trip in the window" (the original). `out_for_delivery_at` holds only the FIRST OFD scan, so
//    a parcel that went out on the 9th, failed, and went out again on the 11th and 12th was cohorted on
//    the 9th and was INVISIBLE in every later window — including the day it was delivered. Over 30 days
//    that hid 388 of 2,798 delivered RapidShyp parcels (13.9%) and 47 of 395 Kwikship (11.9%).
//
// 2. "Any trip in the window" (2026-08-13, first attempt at a fix). It found those parcels, but a parcel
//    whose trips straddle a boundary then matched BOTH windows — TE25-41076 went out at 10 Aug 19:44 and
//    again at 11 Aug 08:53, so it appeared in 08–10 AND in 11–12, and its single delivery was counted
//    twice. 65 parcels were double-counted across just those two adjacent windows. **Two periods did not
//    add up to the combined period**, which makes every export impossible to stack.
//
// 3. "Decisive trip" (the last trip at or before the outcome). Additive, but it counts a parcel on the
//    day it DEPARTED, so an overnight delivery lands in the wrong window: TE25-39612 went out at 07-08
//    16:35 and delivered at 08-08 19:44, and was therefore counted on the 7th — invisible on the 8th,
//    where the money actually arrived, and ₹748 short in every 8th-onward total.
//
// 4. THE RULE: `attributed_at` — the date the outcome HAPPENED (delivered_at → rto_at), falling back to
//    the latest trip while the parcel is still unresolved. It is a GENERATED COLUMN in Postgres, so it
//    cannot drift from what a writer remembered to set, and the range query is one indexed scan.
//      · A parcel lands in exactly ONE window, so adjacent windows still ADD UP.
//      · "Delivered on the 8th" means the 8th — which is what a human, an invoice and EasyEcom all mean.
//      · Once resolved, attribution is FROZEN for ever: delivered_at/rto_at never change, so a past
//        report stays reproducible. Only still-open parcels move, and only forward.
//      · ⚠️ AN RTO IS COUNTED ON `rto_at`, WHICH CAN BE DAYS AFTER THE LAST DOOR TRIP (the parcel sits
//        before the return is raised — TE25-36926: last trip 28-07, RTO 08-08). That is deliberate and
//        symmetric with delivered: the window says WHEN WE LOST THE MONEY, not when the van went out.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const tripsOf = r => (Array.isArray(r.ofd_dates) && r.ofd_dates.length
    ? r.ofd_dates : (r.out_for_delivery_at ? [r.out_for_delivery_at] : []))
    .map(d => new Date(d)).filter(d => !isNaN(d.getTime())).sort((a, b) => a - b);
// The last trip at or before `outcomeAt`. Also what durations are measured from: anchoring on the FIRST
// trip would report "OFD → delivered" as several days for a reattempted parcel, measuring the idle time
// between failed attempts rather than the delivery run.
const lastTripBefore = (r, outcomeAt) => {
    const trips = tripsOf(r);
    if (!trips.length) return null;
    if (!outcomeAt) return trips[trips.length - 1].toISOString();
    const end = new Date(outcomeAt).getTime();
    let best = null;
    for (const d of trips) if (d.getTime() <= end) best = d;
    return (best || trips[0]).toISOString();
};
// The trip that produced the outcome. NOT the attribution date any more (see rule 4) — it is what the
// duration is measured from, and what the explorer shows as the parcel's last departure.
const decisiveTrip = r => lastTripBefore(r, r.delivered_at || r.rto_at || null);

async function fetchWindow(fromISO, toISO) {
    const rows = [];
    for (let off = 0; ; off += 1000) {
        // ONE indexed range scan on the generated `attributed_at`. No in-memory correction afterwards:
        // the previous version filtered on trip dates and fixed up in memory, which could never reach a
        // parcel that departed before the window and resolved inside it — exactly the TE25-39612 case.
        // `out_for_delivery_at is not null` still gates the cohort: this page is about parcels that
        // actually reached a doorstep, so a shipment with no OFD scan must never enter it.
        const { data, error } = await supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, zone, dest_state, dest_city, payment_mode, order_type, order_date, out_for_delivery_at, ofd_dates, last_ofd_at, attributed_at, delivered_at, rto_at, outcome, attempts, ndr_count, ndr_reasons, first_edd')
            .in('source', LM_SOURCES)
            .not('out_for_delivery_at', 'is', null)
            .gte('attributed_at', fromISO).lte('attributed_at', toISO)
            .range(off, off + 999);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return rows.map(r => ({ ...r, ofd_in_window: r.attributed_at, lastTrip: decisiveTrip(r), trips: tripsOf(r).length }));
}
// The never-attempted returns, anchored on RTO DATE — they have no OFD timestamp to cohort by, which is
// the whole point of the category. Kept as a separate pull so it can never contaminate the OFD cohort.
async function fetchNoAttempt(fromISO, toISO) {
    const rows = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, zone, dest_state, dest_city, payment_mode, order_date, rto_at, outcome, attempts, ndr_count, ndr_reasons, order_type, first_edd')
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
//
// TWO DENOMINATORS ARE RETURNED, AND BOTH ARE NEEDED — do not delete either.
//   *RateAll   ÷ the whole OFD cohort   → the HEADLINE (requested 2026-08-13: "755/1243").
//   *Rate      ÷ resolved only          → shown in each card's footer as the maturity-adjusted figure.
// The cohort basis is what a reader intuitively expects, and its three shares (delivered + RTO + pending)
// sum to exactly 100% — which is why the "Pending" card is mandatory beside them. Its cost is that a
// young cohort reads low: on 12 Aug, 130 of 241 (54%) were still open, so cohort-basis reported 39%
// delivered on a day that was going fine. The Pending card and the footer are what keep that honest —
// if either is ever removed, the headline becomes a lie about recent days.
function summarise(rows) {
    const ofd = rows.length;
    const delivered = rows.filter(r => r.outcome === 'delivered');
    const rto = rows.filter(r => r.outcome === 'rto');
    const open = rows.filter(r => r.outcome !== 'delivered' && r.outcome !== 'rto');
    const resolved = delivered.length + rto.length;
    // Durations run from the trip that PRODUCED the outcome, not from the parcel's first ever trip.
    const durDel = delivered.map(r => hoursBetween(lastTripBefore(r, r.delivered_at), r.delivered_at)).filter(v => v != null).sort((a, b) => a - b);
    const durRto = rto.map(r => hoursBetween(lastTripBefore(r, r.rto_at), r.rto_at)).filter(v => v != null).sort((a, b) => a - b);
    const sameDay = delivered.filter(r => { const h = hoursBetween(lastTripBefore(r, r.delivered_at), r.delivered_at); return h != null && h <= 24; });
    const firstGo = delivered.filter(r => (r.ndr_count || 0) === 0);
    const [dRate, rRate, oRate] = share3(delivered.length, rto.length, ofd);
    const revOfd = sumV(rows), revDel = sumV(delivered), revRto = sumV(rto), revOpen = sumV(open);
    const [dRateV, rRateV, oRateV] = share3(revDel, revRto, revOfd);
    return {
        ofd, delivered: delivered.length, rto: rto.length, open: open.length, resolved,
        // ── Headline basis: ÷ the whole cohort. These three sum to EXACTLY 100% (see share3). ──
        deliveredRateAll: dRate,
        rtoRateAll: rRate,
        openRateAll: oRate,
        // ── Maturity-adjusted basis: ÷ resolved. Shown as the footer line on each card. ──
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
        // ── The ₹ lens. Same partition, same denominators — only the unit changes, so a reader switching
        // Orders ⇄ Revenue is looking at one dataset counted two ways, never two different datasets.
        // Populated only when the caller may see revenue; stripped entirely otherwise.
        rev: {
            ofd: revOfd, delivered: revDel, rto: revRto, open: revOpen,
            resolved: revDel + revRto,
            deliveredRateAll: dRateV, rtoRateAll: rRateV, openRateAll: oRateV,
            deliveredRate: pct(revDel, revDel + revRto),
            rtoRate: pct(revRto, revDel + revRto),
            avgOrderValue: rows.length ? Math.round(revOfd / rows.length) : 0,
        },
    };
}

// Attempt-wise outcome. `attempts` is the courier's own count of doorstep attempts and is always ≥ 1 on
// an OFD cohort (verified: 0 rows with attempts = 0 over 7 days), so bucket 1 really is "resolved on the
// first knock". Read the two halves of each bucket differently:
//   attempts = 1, delivered → landed first time.
//   attempts = 1, RTO       → the courier gave up after ONE attempt. This is the claimable half.
// Bucket 3 is 3-or-more so nothing falls off the end and the buckets partition the cohort exactly.
function byAttempt(rows) {
    const bucket = n => (n >= 3 ? 3 : n >= 1 ? n : 1);
    const out = [1, 2, 3].map(n => ({ attempt: n, ofd: 0, delivered: 0, rto: 0, open: 0, resolved: 0, deliveredRate: 0, rtoRate: 0,
        rev: { ofd: 0, delivered: 0, rto: 0, open: 0, resolved: 0, deliveredRate: 0, rtoRate: 0 } }));
    rows.forEach(r => {
        const b = out[bucket(r.attempts || 1) - 1], v = Number(r.order_value) || 0;
        b.ofd++; b.rev.ofd += v;
        if (r.outcome === 'delivered') { b.delivered++; b.rev.delivered += v; }
        else if (r.outcome === 'rto') { b.rto++; b.rev.rto += v; }
        else { b.open++; b.rev.open += v; }
    });
    out.forEach(b => {
        b.rev.resolved = b.rev.delivered + b.rev.rto;
        b.rev.deliveredRate = pct(b.rev.delivered, b.rev.resolved);
        b.rev.rtoRate = pct(b.rev.rto, b.rev.resolved);
        b.resolved = b.delivered + b.rto;
        // Within an attempt bucket the split is delivered-vs-RTO, so RESOLVED is the only sane
        // denominator — an open parcel has not yet chosen a side. This is not the headline basis.
        b.deliveredRate = pct(b.delivered, b.resolved);
        b.rtoRate = pct(b.rto, b.resolved);
    });
    return out;
}

// Group by a dimension. Returns both denominators, same as summarise().
function cut(rows, keyFn) {
    const g = {};
    rows.forEach(r => {
        const k = keyFn(r); if (!k) return;
        (g[k] = g[k] || { ofd: 0, delivered: 0, rto: 0, open: 0, hrs: [], rv: 0, rvD: 0, rvR: 0, rvO: 0 });
        const val = Number(r.order_value) || 0;
        g[k].ofd++; g[k].rv += val;
        if (r.outcome === 'delivered') { g[k].delivered++; g[k].rvD += val; const h = hoursBetween(lastTripBefore(r, r.delivered_at), r.delivered_at); if (h != null) g[k].hrs.push(h); }
        else if (r.outcome === 'rto') { g[k].rto++; g[k].rvR += val; }
        else { g[k].open++; g[k].rvO += val; }
    });
    return Object.entries(g).map(([key, v]) => {
        const resolved = v.delivered + v.rto, revResolved = v.rvD + v.rvR;
        const s = v.hrs.sort((a, b) => a - b);
        return { key, ofd: v.ofd, delivered: v.delivered, rto: v.rto, open: v.open, resolved,
            deliveredRateAll: pct(v.delivered, v.ofd), rtoRateAll: pct(v.rto, v.ofd),
            deliveredRate: pct(v.delivered, resolved), rtoRate: pct(v.rto, resolved),
            medianHrs: s.length ? r1(percentile(s, 0.5)) : null,
            rev: { ofd: v.rv, delivered: v.rvD, rto: v.rvR, open: v.rvO, resolved: revResolved,
                deliveredRateAll: pct(v.rvD, v.rv), rtoRateAll: pct(v.rvR, v.rv),
                deliveredRate: pct(v.rvD, revResolved), rtoRate: pct(v.rvR, revResolved) } };
    }).sort((a, b) => b.ofd - a.ofd);
}

// Remove every ₹ field from a response, at any depth. Key-name based on purpose: a revenue field added
// anywhere in this payload later is stripped automatically as long as it is called `rev`/`value`, so the
// gate cannot be defeated by someone forgetting to update a list of paths.
function stripRevenue(node) {
    if (Array.isArray(node)) { node.forEach(stripRevenue); return; }
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
        if (k === 'rev' || k === 'prevRev' || k === 'value' || k === 'valueCoverage') { delete node[k]; continue; }
        stripRevenue(node[k]);
    }
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

        // ── ₹ lens ──────────────────────────────────────────────────────────────────────────────
        // ⚠️ ENFORCED HERE, NOT ONLY IN THE UI. Hiding a toggle stops the button being pressed; it does
        // not stop anyone reading the JSON off an endpoint they already have `last-mile` access to. When
        // the capability is absent the lookup is SKIPPED ENTIRELY — no order price is read from the
        // database at all, so there is nothing to leak rather than something hidden.
        const maySeeRevenue = canSeeRevenue(req);
        let valueStat = null;
        if (maySeeRevenue) {
            const [vs] = await Promise.all([
                attachOrderValue(rows), attachOrderValue(prev),
                attachOrderValue(noAttempt), attachOrderValue(noAttemptP),
            ]);
            valueStat = vs;
        }

        // Option lists from the UNFILTERED window, so picking one never empties the others.
        const uniq = (arr, f) => { const c = {}; arr.forEach(r => { const k = f(r); if (k) c[k] = (c[k] || 0) + 1; });
            return Object.entries(c).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count); };

        // Daily trend, on IST calendar days, over the OFD cohort.
        // Grouped on the DECISIVE trip — the same date the parcel was cohorted on, so the bars sum to
        // the headline and no parcel is charted on a day outside the chart's own x-axis.
        const byDay = {};
        rows.forEach(r => { const k = istDay(r.ofd_in_window); if (!k) return;
            (byDay[k] = byDay[k] || { ofd: 0, delivered: 0, rto: 0, open: 0, rev: { ofd: 0, delivered: 0, rto: 0, open: 0 } });
            const val = Number(r.order_value) || 0;
            byDay[k].ofd++; byDay[k].rev.ofd += val;
            if (r.outcome === 'delivered') { byDay[k].delivered++; byDay[k].rev.delivered += val; }
            else if (r.outcome === 'rto') { byDay[k].rto++; byDay[k].rev.rto += val; }
            else { byDay[k].open++; byDay[k].rev.open += val; } });
        const trend = Object.keys(byDay).sort().map(d => ({ date: d, ...byDay[d],
            deliveredRate: pct(byDay[d].delivered, byDay[d].delivered + byDay[d].rto) }));

        const summary = summarise(rows), prevSummary = summarise(prev);
        // Reasons the courier gave on parcels that went out and still came back — the actionable list.
        const reasonCount = {}, reasonRev = {};
        rows.filter(r => r.outcome === 'rto').forEach(r => (r.ndr_reasons || []).forEach(x => {
            const k = String(x || '').trim(); if (!k) return;
            reasonCount[k] = (reasonCount[k] || 0) + 1;
            // A reason on a multi-reason parcel gets the parcel's full value, so this column ranks
            // "value exposed to this reason" — it is intentionally NOT a partition of RTO revenue.
            reasonRev[k] = (reasonRev[k] || 0) + (Number(r.order_value) || 0); }));
        const rtoReasons = Object.entries(reasonCount).map(([reason, count]) => ({ reason, count, rev: reasonRev[reason] || 0 }))
            .sort((a, b) => b.count - a.count).slice(0, 10);

        const payload = {
            success: true,
            range: { from: fmtLocal(from), to: fmtLocal(to), days: lenDays },
            previousRange: { from: fmtLocal(pFrom), to: fmtLocal(pTo) },
            filters: { source, courier, zone, payment },
            summary, previous: prevSummary,
            // Anchored on RTO date, not OFD — these have no OFD by definition. Reported separately so it
            // is never mistaken for part of the OFD cohort's arithmetic.
            // The list is emitted in the SAME row shape as `shipments` so the explorer can render it with
            // one code path when the "Returned without an attempt" filter is chosen — but it is kept in a
            // separate array, never concatenated, because these rows have no OFD and would corrupt every
            // cohort denominator above if they leaked in.
            noAttempt: { count: noAttempt.length, prevCount: noAttemptP.length,
                rev: sumV(noAttempt), prevRev: sumV(noAttemptP),
                byCourier: uniq(noAttempt, r => r.courier || 'Unknown').slice(0, 8),
                list: noAttempt.slice(0, 1000).map(r => ({ order: r.order_name, awb: r.awb, source: r.source,
                    courier: r.courier, zone: r.zone, state: r.dest_state, city: r.dest_city,
                    payment: r.payment_mode, order_type: r.order_type, outcome: 'rto_no_attempt',
                    attempts: r.attempts || 0, ndr_count: r.ndr_count || 0, reasons: (r.ndr_reasons || []).slice(0, 4),
                    ofd_at: null, delivered_at: null, rto_at: r.rto_at, hrs: null,
                    value: r.order_value, order_date: r.order_date, edd: r.first_edd })) },
            trend, rtoReasons,
            byAttempt: byAttempt(rows),
            byCourier: cut(rows, r => r.courier || 'Unknown'),
            byZone: cut(rows, r => r.zone).sort((a, b) => String(a.key).localeCompare(String(b.key))),
            byState: cut(rows, r => (r.dest_state || '').trim()).slice(0, 25),
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
                // `ofd_at` is the ATTRIBUTION date — when the outcome happened (or the last trip, while
                // unresolved). `last_trip_at` is the departure that produced it and `first_ofd_at` the
                // first ever trip, so a parcel that went out days earlier explains itself on the row.
                ofd_at: r.ofd_in_window, last_trip_at: r.lastTrip, first_ofd_at: r.out_for_delivery_at, trips: r.trips || 1,
                delivered_at: r.delivered_at, rto_at: r.rto_at,
                hrs: hoursBetween(lastTripBefore(r, r.delivered_at || r.rto_at), r.delivered_at || r.rto_at),
                value: r.order_value, order_date: r.order_date, edd: r.first_edd,
            })),
            shipmentsTotal: rows.length,
            // The UI shows the Orders/Revenue toggle only when this is true, and the ₹ figures are absent
            // from the payload entirely when it is false — see stripRevenue below.
            revenueAllowed: maySeeRevenue,
            // Lets the page SAY the ₹ totals are incomplete rather than quietly under-report them.
            valueCoverage: valueStat || { total: 0, matched: 0, failedBatches: 0, complete: true },
        };
        // Without the capability no price was ever read, so every ₹ field would serialise as a hard 0 —
        // which renders as a confident "₹0" rather than "not available". Remove them outright so the
        // client cannot draw a number that does not exist.
        if (!maySeeRevenue) stripRevenue(payload);
        res.json(payload);
    } catch (e) { console.error('[LastMile]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// GET /last-mile/shipment/:awb — the scan log behind one row, fetched only when a row is expanded.
//
// Deliberately NOT folded into the main payload: 3,000 shipments × ~20 scans is a megabyte of JSON
// nobody reads, on a page that already re-fetches on every filter change.
//
// WHERE THE LOG ACTUALLY LIVES (measured over a 7-day window, RapidShyp + KwikShip):
//   RapidShyp → order_tracking.tracking_details.records[].shipment_details[].track_scans — 791/797 rows.
//   KwikShip  → shipment_journey_ecom.raw.status_history — but only 49/642 rows (7.6%) carry it, since
//               only the webhook writes raw and it overwrites rather than accumulates.
//   shipment_journey_ecom.raw for RapidShyp — 13/797. Not a usable source; do not switch to it.
// So the response ALWAYS includes a milestone timeline synthesised from the journey's own timestamp
// columns, and adds the courier scan log on top when one exists. `scanSource` says which you got, and
// the UI must show it — a KwikShip parcel with no log must not look like a parcel that never moved.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// RapidShyp stamps scans "DD-MM-YYYY HH:MM:SS" IN IST.
// ⚠️ `new Date("11-08-2026 10:22:34")` is Invalid Date in V8 — this exact format has already caused a
// silent data bug in this codebase (/get-orders `date`). Verified against the journey's own UTC column:
// scan "11-08-2026 10:22:34" ↔ out_for_delivery_at 2026-08-11T04:52:34Z, i.e. IST, exactly +05:30.
function istStampToISO(s) {
    const raw = String(s == null ? '' : s).trim();
    if (!raw) return null;      // ⚠️ NOT `new Date(null)` — that is the epoch, and a missing scan time
                                // would silently render as 01-01-1970 at the bottom of the timeline.
    const m = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
    if (!m) { const d = new Date(raw); return isNaN(d.getTime()) ? null : d.toISOString(); }
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    const utcMs = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +(ss || 0)) - 5.5 * 3600000;
    const d = new Date(utcMs);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
// Pull the scan array for THIS awb out of RapidShyp's nested envelope. A record can carry several
// shipments (split orders), so match on awb and only fall back to the first when nothing matches.
function rapidshypScans(details, awb) {
    const recs = details && Array.isArray(details.records) ? details.records : [];
    let match = null, first = null;
    recs.forEach(rec => (Array.isArray(rec.shipment_details) ? rec.shipment_details : []).forEach(sd => {
        if (!first) first = sd;
        if (String(sd.awb || '').trim() === String(awb).trim()) match = sd;
    }));
    const sd = match || first;
    if (!sd || !Array.isArray(sd.track_scans)) return [];
    return sd.track_scans.map(s => ({
        at: istStampToISO(s.scan_datetime),
        label: String(s.scan || '').trim() || '—',
        location: String(s.scan_location || '').trim() || null,
        code: s.rapidshyp_status_code || null,
        note: null,
    })).filter(s => s.at);
}
function kwikshipScans(hist) {
    if (!Array.isArray(hist)) return [];
    return hist.map(s => {
        const ts = s.status_datetime || s.creation_datetime;
        if (!ts) return null;                       // `new Date(null)` is the epoch, not Invalid Date
        const d = new Date(ts);
        return isNaN(d.getTime()) ? null : {
            at: d.toISOString(),
            label: String(s.shipper_remark || s.shipper_status || s.status || '').trim() || '—',
            location: String(s.location || '').trim() || null,
            code: s.status || null,
            note: String(s.description || '').trim() || null,
        };
    }).filter(Boolean);
}
// Always-available fallback: the journey row's own timestamps, in the order they must occur.
function milestones(j) {
    return [
        [j.order_date, 'Order placed', null],
        [j.awb_assigned_at, 'AWB assigned', j.courier],
        [j.dispatched_at, 'Dispatched', null],
        [j.out_for_delivery_at, 'Out for delivery', null],
        [j.delivered_at, 'Delivered', null],
        [j.rto_at, 'RTO', null],
        // last_scan_at is only worth a line when it is not already one of the above.
        [(j.last_scan_at && j.last_scan_at !== j.delivered_at && j.last_scan_at !== j.rto_at
          && j.last_scan_at !== j.out_for_delivery_at) ? j.last_scan_at : null, 'Last courier scan', null],
    ].filter(([ts]) => ts).map(([ts, label, note]) => ({
        at: new Date(ts).toISOString(), label, location: null, code: null, note: note || null,
    })).sort((a, b) => (a.at < b.at ? 1 : -1));
}

router.get('/last-mile/shipment/:awb', async (req, res) => {
    try {
        const awb = String(req.params.awb || '').trim();
        if (!awb) return res.status(400).json({ success: false, error: 'awb required' });

        const { data: js, error: jErr } = await supabase.from('shipment_journey_ecom')
            .select('*').eq('awb', awb).in('source', LM_SOURCES).limit(1);
        if (jErr) throw new Error(jErr.message);
        const j = (js || [])[0];
        if (!j) return res.status(404).json({ success: false, error: 'Shipment not found' });

        let scans = [], scanSource = 'milestones';
        if (j.source === 'rapidshyp') {
            const { data: ot } = await supabase.from('order_tracking')
                .select('tracking_details, last_tracked_at').eq('awb_number', awb).limit(1);
            const td = (ot || [])[0] && (ot || [])[0].tracking_details;
            const got = td && typeof td === 'object' ? rapidshypScans(td, awb) : [];
            if (got.length) { scans = got; scanSource = 'courier'; }
        } else if (j.raw && Array.isArray(j.raw.status_history)) {
            const got = kwikshipScans(j.raw.status_history);
            if (got.length) { scans = got; scanSource = 'courier'; }
        }
        scans.sort((a, b) => (a.at < b.at ? 1 : -1));      // newest first

        res.json({
            success: true, scanSource, scans,
            // Shown alongside the log regardless — the timestamps every rate on this page is computed
            // from, so a disagreement between the two is visible rather than hidden.
            milestones: milestones(j),
            shipment: {
                awb: j.awb, order: j.order_name, source: j.source, courier: j.courier,
                outcome: j.outcome, statusCode: j.status_code, attempts: j.attempts || 0,
                ndrCount: j.ndr_count || 0, reasons: j.ndr_reasons || [],
                firstAttemptSuccess: j.first_attempt_success, rtoNoAttempt: j.rto_no_attempt,
                zone: j.zone, state: j.dest_state, city: j.dest_city, pincode: j.dest_pincode,
                payment: j.payment_mode, orderType: j.order_type,
                orderDate: j.order_date, awbAssignedAt: j.awb_assigned_at, dispatchedAt: j.dispatched_at,
                ofdAt: j.out_for_delivery_at, deliveredAt: j.delivered_at, rtoAt: j.rto_at,
                // Every door trip — the panel lists them, so a parcel that appears in a window days after
                // its first dispatch can be explained on the spot instead of looking like a bug.
                ofdDates: tripsOf(j).map(d => d.toISOString()), trips: tripsOf(j).length,
                lastScanAt: j.last_scan_at, edd: j.first_edd,
                freightTotal: j.freight_total, freightForward: j.freight_forward, freightRto: j.freight_rto,
                codCharges: j.cod_charges, shipmentValue: j.shipment_value, appliedWeight: j.applied_weight,
                hrsOfdToOutcome: hoursBetween(j.out_for_delivery_at, j.delivered_at || j.rto_at),
            },
        });
    } catch (e) { console.error('[LastMile/shipment]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
