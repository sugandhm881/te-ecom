// ─────────────────────────────────────────────────────────────────────────────
// RapidShyp Reconciliation API.
//
// Membership = shipment_journey_ecom where source='rapidshyp' — every shipment RapidShyp actually
// carried. Charges are RapidShyp's OWN billed figures (freight_forward / freight_rto / cod_charges /
// applied_weight), pulled from their shipment_details API by the nightly syncChargesBatch. Nothing here
// is a hardcoded rate — unlike the DocPharma recon, which multiplies a manually-entered rate card.
//
// SO WHAT IS "EXPECTED"? RapidShyp prices per DELIVERY ZONE × 500 g SLAB, and does it consistently:
// within a zone+slab the billed freight is nearly always the same number (measured: zone A ₹27.14 flat,
// zone E ₹68.44, zone C ₹50.74 ≤500 g and ₹101.48 ≤1000 g — exactly 2× the slab). So the BENCHMARK RATE
// is derived from RapidShyp's own invoices: the MEDIAN billed freight for that zone+slab in the window.
// That keeps the rate card 100% RapidShyp's, self-updating when they revise pricing, and needs no API
// call per shipment (their serviceability endpoint quotes TODAY's rate, not what was billed months ago).
//
// A shipment is flagged when it deviates from RapidShyp's own norm:
//   over_rate     — billed forward freight > benchmark + tolerance  → the disputable overcharge
//   unpriced      — final (delivered/RTO) but no charge synced yet  → a billing gap
//   rto_not_rto   — an RTO leg billed on a shipment that never RTO'd
//   cod_on_prepaid— a COD collection fee billed on a prepaid order
//   no_weight     — billed with no applied weight, so it can't be rate-checked
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');

const SLAB_G = 500;                                   // RapidShyp bills per 500 g slab
const OVER_TOLERANCE = 0.10;                          // >10% above the zone+slab norm = flagged
const MIN_SAMPLES = 5;                                // a benchmark needs this many shipments to be trusted
const GST_RATE = 0.18;                                // RapidShyp bills 18% GST on freight

const num = v => (v == null ? null : Number(v));
const round2 = v => Math.round((Number(v) || 0) * 100) / 100;
const istDay = d => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istDate = ts => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null;
const slabOf = g => (g == null || !(g > 0)) ? null : Math.ceil(Number(g) / SLAB_G) * SLAB_G;
const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Pull rapidshyp shipments by RapidShyp's OWN awb_assigned_at (paginated — Supabase caps a response
// at 1000). THIS is the basis their billing report filters on, so it is the only window that can tie
// out to their invoice. Explicitly NOT the order date, NOT the delivery date, and NOT anything from
// EasyEcom — EasyEcom has no bearing on what RapidShyp bills.
// awb_assigned_at is captured from the same shipment_details call the charges sync already makes.
const JOURNEY_SEL = 'awb, order_name, order_date, outcome, is_final, payment_mode, zone, courier, dest_state, dest_city, '
    + 'applied_weight, shipment_value, freight_total, freight_forward, freight_rto, cod_charges, '
    + 'charges_fetched_at, delivered_at, rto_at, dispatched_at, order_type, awb_assigned_at';
async function fetchByColumn(col, fromISO, toISO) {
    const rows = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('shipment_journey_ecom').select(JOURNEY_SEL)
            .eq('source', 'rapidshyp')
            .gte(col, fromISO).lte(col, toISO)
            .order('awb', { ascending: true })            // unique key → gap-free pagination
            .range(off, off + 999);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return rows;
}
async function fetchShipments(fromISO, toISO) {
    return fetchByColumn('awb_assigned_at', fromISO, toISO);
}
// The date a shipment CLOSED (shown in the table); the WINDOW is keyed on awb_assigned_at instead.
const closeOf = r => r.delivered_at || r.rto_at || null;

// RapidShyp's OWN rate card, learned from what they billed: median forward freight per zone+slab.
// Returned so the UI can show the derived card and the sample size behind each cell.
function buildBenchmark(rows) {
    const buckets = {};
    rows.forEach(r => {
        const slab = slabOf(r.applied_weight), f = num(r.freight_forward);
        if (!slab || !r.zone || !(f > 0)) return;
        const k = `${r.zone}|${slab}`;
        (buckets[k] = buckets[k] || []).push(f);
    });
    const table = {};
    Object.entries(buckets).forEach(([k, vals]) => {
        table[k] = { zone: k.split('|')[0], slab: Number(k.split('|')[1]), rate: round2(median(vals)), samples: vals.length };
    });
    return table;
}

function classify(r, bench) {
    const slab = slabOf(r.applied_weight);
    const fwd = num(r.freight_forward) || 0;
    const rto = num(r.freight_rto) || 0;
    const cod = num(r.cod_charges) || 0;
    const total = num(r.freight_total) != null ? num(r.freight_total) : round2(fwd + rto + cod);
    const isRto = String(r.outcome || '').toLowerCase() === 'rto';
    const isPrepaid = /prepaid/i.test(r.payment_mode || '');
    const b = (r.zone && slab) ? bench[`${r.zone}|${slab}`] : null;
    const expected = (b && b.samples >= MIN_SAMPLES) ? b.rate : null;   // only trust a well-sampled cell
    const variance = (expected != null && fwd > 0) ? round2(fwd - expected) : null;

    const flags = [];
    if (r.is_final && num(r.freight_total) == null) flags.push('unpriced');
    if (fwd > 0 && !slab) flags.push('no_weight');
    if (expected != null && fwd > expected * (1 + OVER_TOLERANCE)) flags.push('over_rate');
    if (rto > 0 && !isRto) flags.push('rto_not_rto');
    if (cod > 0 && isPrepaid) flags.push('cod_on_prepaid');
    return { slab, fwd, rto, cod, total, expected, variance, flags, isRto, isPrepaid };
}

// GET /api/rapidshyp-recon?from=&to=&outcome=&payment=&zone=&flag=&search=
router.get('/rapidshyp-recon', async (req, res) => {
    try {
        const toStr = req.query.to || istDay(new Date());
        let fromStr = req.query.from;
        if (!fromStr) { const d = new Date(); d.setDate(d.getDate() - 30); fromStr = istDay(d); }
        const fromISO = `${fromStr}T00:00:00.000+05:30`;
        const toISO = `${toStr}T23:59:59.999+05:30`;

        const rows = await fetchShipments(fromISO, toISO);
        const bench = buildBenchmark(rows);

        let ships = rows.map(r => {
            const c = classify(r, bench);
            return {
                awb: r.awb, order: r.order_name || null,
                orderDate: istDate(r.order_date), closeDate: istDate(closeOf(r)),
                outcome: r.outcome || null, payment: r.payment_mode || null, orderType: r.order_type || null,
                zone: r.zone || null, courier: r.courier || null,
                dest_state: r.dest_state || null, dest_city: r.dest_city || null,
                weight: num(r.applied_weight), slab: c.slab, value: num(r.shipment_value),
                freight_forward: c.fwd, freight_rto: c.rto, cod_charges: c.cod, freight_total: c.total,
                expected: c.expected, variance: c.variance, flags: c.flags,
                priced: num(r.freight_total) != null, pricedAt: r.charges_fetched_at || null,
                isFinal: !!r.is_final,
            };
        });

        // ── filters ──
        const outF = String(req.query.outcome || 'all').toLowerCase();
        const payF = String(req.query.payment || 'all').toLowerCase();
        const zoneF = String(req.query.zone || 'all').toUpperCase();
        const flagF = String(req.query.flag || 'all').toLowerCase();
        const q = String(req.query.search || '').trim().toLowerCase();
        if (outF !== 'all') ships = ships.filter(s => String(s.outcome || '').toLowerCase() === outF);
        if (payF !== 'all') ships = ships.filter(s => payF === 'cod' ? !/prepaid/i.test(s.payment || '') : /prepaid/i.test(s.payment || ''));
        if (zoneF !== 'ALL') ships = ships.filter(s => String(s.zone || '').toUpperCase() === zoneF);
        if (flagF !== 'all') ships = ships.filter(s => flagF === 'any' ? s.flags.length : s.flags.includes(flagF));
        if (q) ships = ships.filter(s => (s.awb || '').toLowerCase().includes(q) || (s.order || '').toLowerCase().includes(q)
            || (s.courier || '').toLowerCase().includes(q) || (s.dest_city || '').toLowerCase().includes(q));

        ships.sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || '') || String(a.awb).localeCompare(String(b.awb)));

        res.json({
            success: true,
            range: { from: fromStr, to: toStr },
            benchmark: Object.values(bench).sort((a, b) => a.zone.localeCompare(b.zone) || a.slab - b.slab),
            rateSource: 'derived from RapidShyp billed freight (median per zone × 500g slab)',
            kpis: summarize(ships),
            shipments: ships.slice(0, 5000),
            truncated: ships.length > 5000,
            total: ships.length,
        });
    } catch (e) { console.error('[RapidShypRecon]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

function summarize(ships) {
    const k = {
        shipments: 0, delivered: 0, rto: 0, inTransit: 0, codShipments: 0, inFlight: 0,
        freightForward: 0, freightRto: 0, codFees: 0, billed: 0,
        unpriced: 0, flagged: 0, overRate: 0, overchargeTotal: 0, gmv: 0,
    };
    ships.forEach(s => {
        k.shipments++;
        const o = String(s.outcome || '').toLowerCase();
        if (o === 'delivered') k.delivered++; else if (o === 'rto') k.rto++; else k.inTransit++;
        if (!/prepaid/i.test(s.payment || '')) k.codShipments++;
        k.freightForward += s.freight_forward || 0;
        k.freightRto += s.freight_rto || 0;
        k.codFees += s.cod_charges || 0;
        k.billed += s.freight_total || 0;
        k.gmv += s.value || 0;
        // A billing gap is a shipment that has FINISHED but carries no charge. A parcel still in
        // transit is simply not billable yet — counting it as 'unpriced' made 763 in-flight
        // shipments look like missing invoices (the row flag and the ledger already had this right).
        if (!s.priced) { if (s.isFinal) k.unpriced++; else k.inFlight++; }
        if (s.flags.length) k.flagged++;
        if (s.flags.includes('over_rate')) { k.overRate++; k.overchargeTotal += Math.max(0, s.variance || 0); }
    });
    ['freightForward', 'freightRto', 'codFees', 'billed', 'overchargeTotal', 'gmv'].forEach(f => k[f] = round2(k[f]));
    k.gst = round2(k.billed * GST_RATE);                 // RapidShyp bills 18% GST on freight
    k.billedWithGst = round2(k.billed + k.gst);
    k.avgFreight = k.shipments ? round2(k.billed / k.shipments) : 0;
    return k;
}

// GET /api/rapidshyp-recon/benchmark — the derived rate card on its own (zone × slab + sample counts).
router.get('/rapidshyp-recon/benchmark', async (req, res) => {
    try {
        const toStr = req.query.to || istDay(new Date());
        let fromStr = req.query.from;
        if (!fromStr) { const d = new Date(); d.setDate(d.getDate() - 90); fromStr = istDay(d); }
        const rows = await fetchShipments(`${fromStr}T00:00:00.000+05:30`, `${toStr}T23:59:59.999+05:30`);
        const bench = buildBenchmark(rows);
        res.json({
            success: true, range: { from: fromStr, to: toStr },
            rateSource: 'derived from RapidShyp billed freight (median per zone × 500g slab)',
            minSamples: MIN_SAMPLES, tolerance: OVER_TOLERANCE,
            rates: Object.values(bench).sort((a, b) => a.zone.localeCompare(b.zone) || a.slab - b.slab),
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/rapidshyp-recon/shipment/:awb — expandable-row detail: charge split, milestone timeline
//    and the courier scan log. Reads OUR synced data only (no RapidShyp call), like the DocPharma detail.
router.get('/rapidshyp-recon/shipment/:awb', async (req, res) => {
    try {
        const awb = String(req.params.awb || '').trim();
        if (!awb) return res.status(400).json({ success: false, error: 'awb required' });
        const { data: j } = await supabase.from('shipment_journey_ecom')
            .select('awb, order_name, source, courier, outcome, zone, payment_mode, order_date, dispatched_at, out_for_delivery_at, delivered_at, rto_at, first_edd, ndr_reasons, attempts, ndr_count, dest_city, dest_state, dest_pincode, applied_weight, shipment_value, freight_total, freight_forward, freight_rto, cod_charges, raw')
            .eq('awb', awb).maybeSingle();
        if (!j) return res.json({ success: true, shipment: null });
        // Scan log: the RapidShyp cache holds the raw status; the journey `raw` holds the scan array when synced.
        let scans = [];
        const raw = j.raw || {};
        const arr = raw.scans || raw.shipment_track || raw.tracking || (raw.records && raw.records[0] && raw.records[0].scans);
        if (Array.isArray(arr)) {
            scans = arr.map(s => ({
                at: s.at || s.scan_date || s.date || s.timestamp || null,
                label: s.label || s.status || s.current_status || s.activity || '',
                location: s.location || s.city || null,
                reason: s.reason || s.remark || s.remarks || null,
            })).filter(s => s.at || s.label);
        }
        res.json({ success: true, shipment: { ...j, scans } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /api/rapidshyp-recon/ledger?from=&to= — charges (what RapidShyp billed) vs payments (what we
//    paid), month by month, with a running balance. RapidShyp's ledger is SEPARATE from DocPharma's.
router.get('/rapidshyp-recon/ledger', async (req, res) => {
    try {
        const toStr = req.query.to || istDay(new Date());
        let fromStr = req.query.from;
        if (!fromStr) { const d = new Date(); d.setMonth(d.getMonth() - 6); fromStr = istDay(d); }
        const rows = await fetchShipments(`${fromStr}T00:00:00.000+05:30`, `${toStr}T23:59:59.999+05:30`);
        const bench = buildBenchmark(rows);
        // Charges grouped by IST month of the order date, with the same per-shipment detail the
        // Reconciliation tab shows — so a month can be opened and explained, not just totalled.
        const months = {};
        rows.forEach(r => {
            const m = (istDate(r.awb_assigned_at) || '').slice(0, 7); if (!m) return;   // RapidShyp's billing period
            const b = months[m] || (months[m] = { month: m, shipments: 0, delivered: 0, rto: 0, other: 0,
                codShipments: 0, prepaidShipments: 0, codDelivered: 0, prepaidDelivered: 0,
                expectedCodRemittance: 0, prepaidValue: 0, codRtoValue: 0, valuePending: 0,
                forward: 0, rto_freight: 0, cod: 0, charges: 0, payments: 0,
                unpriced: 0, flagged: 0, overRate: 0, overcharge: 0, weight: 0, gmv: 0 });
            const c = classify(r, bench);
            const oc = String(r.outcome || '').toLowerCase();
            const isPrepaid = /prepaid/i.test(r.payment_mode || '');
            const val = num(r.shipment_value);
            b.shipments++;
            if (oc === 'delivered') b.delivered++; else if (oc === 'rto') b.rto++; else b.other++;
            if (isPrepaid) {
                b.prepaidShipments++;
                if (oc === 'delivered') b.prepaidDelivered++;
                b.prepaidValue += val || 0;                    // already collected by us at checkout
            } else {
                b.codShipments++;
                // COD cash is collected by the courier ONLY on delivery — an RTO collects nothing.
                // So the remittance RapidShyp owes us is the value of COD shipments that DELIVERED.
                if (oc === 'delivered') { b.codDelivered++; b.expectedCodRemittance += val || 0; }
                else if (oc === 'rto') b.codRtoValue += val || 0;   // returned — nothing to remit
            }
            if (val == null) b.valuePending++;                 // value arrives with the charges sync
            b.forward += c.fwd; b.rto_freight += c.rto; b.cod += c.cod; b.charges += c.total;
            b.weight += num(r.applied_weight) || 0;
            b.gmv += num(r.shipment_value) || 0;
            if (r.is_final && num(r.freight_total) == null) b.unpriced++;
            if (c.flags.length) b.flagged++;
            if (c.flags.includes('over_rate')) { b.overRate++; b.overcharge += Math.max(0, c.variance || 0); }
        });
        const { data: pays } = await supabase.from('rapidshyp_payments')
            .select('id, payment_date, direction, amount, reference, method, period_from, period_to, notes, created_at')
            .gte('payment_date', fromStr).lte('payment_date', toStr)
            .order('payment_date', { ascending: false });
        (pays || []).forEach(p => {
            const m = String(p.payment_date || '').slice(0, 7); if (!m) return;
            const b = months[m] || (months[m] = { month: m, shipments: 0, forward: 0, rto: 0, cod: 0, charges: 0, payments: 0 });
            b.payments += (String(p.direction) === 'received' ? -1 : 1) * (Number(p.amount) || 0);
        });
        const list = Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
        let bal = 0;
        list.forEach(b => {
            b.gst = round2(b.charges * GST_RATE);
            b.chargesWithGst = round2(b.charges + b.gst);
            b.avgFreight = b.shipments ? round2(b.charges / b.shipments) : 0;
            b.avgWeight = b.shipments ? Math.round(b.weight / b.shipments) : 0;
            b.freightPctOfGmv = b.gmv ? round2(b.chargesWithGst / b.gmv * 100) : null;
            ['forward', 'rto_freight', 'cod', 'charges', 'payments', 'overcharge', 'gmv', 'expectedCodRemittance', 'prepaidValue', 'codRtoValue'].forEach(f => b[f] = round2(b[f]));
            b.codDeliveryRate = b.codShipments ? Math.round(b.codDelivered / b.codShipments * 100) : 0;
            bal = round2(bal + b.chargesWithGst - b.payments);
            b.balance = bal;                                  // + = we still owe RapidShyp
        });

        // ── FIFO settlement: every payment clears the OLDEST unsettled month first, so each month
        //    carries its own settled/outstanding figure and an age. That is what turns a running total
        //    into a ledger you can act on ("July is 32 days unpaid"), rather than one net number.
        const totalPaid = round2((pays || []).reduce((s, p) => s + (String(p.direction) === 'received' ? -1 : 1) * (Number(p.amount) || 0), 0));
        let pool = totalPaid;
        list.forEach(b => {
            const applied = Math.max(0, Math.min(pool, b.chargesWithGst));
            pool = round2(pool - applied);
            b.settled = round2(applied);
            b.outstanding = round2(b.chargesWithGst - applied);
            b.settledPct = b.chargesWithGst ? Math.round(applied / b.chargesWithGst * 100) : 100;
            // age = days since the month ended (only meaningful while something is outstanding)
            const [y, mm] = b.month.split('-').map(Number);
            const monthEnd = new Date(y, mm, 0);
            b.ageDays = b.outstanding > 0 ? Math.max(0, Math.round((Date.now() - monthEnd.getTime()) / 86400000)) : 0;
        });
        const creditLeft = round2(pool);                       // paid more than billed → sitting as credit

        // Aging buckets over what is still outstanding.
        const aging = { current: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
        list.forEach(b => { if (!(b.outstanding > 0)) return;
            if (b.ageDays <= 30) aging.current += b.outstanding;
            else if (b.ageDays <= 60) aging.d31_60 += b.outstanding;
            else if (b.ageDays <= 90) aging.d61_90 += b.outstanding;
            else aging.d90plus += b.outstanding; });
        Object.keys(aging).forEach(k => aging[k] = round2(aging[k]));

        const totals = list.reduce((t, b) => ({
            shipments: t.shipments + b.shipments, delivered: t.delivered + b.delivered, rto: t.rto + b.rto,
            charges: round2(t.charges + b.charges), gst: round2(t.gst + b.gst),
            chargesWithGst: round2(t.chargesWithGst + b.chargesWithGst),
            payments: round2(t.payments + b.payments), outstanding: round2(t.outstanding + b.outstanding),
            unpriced: t.unpriced + b.unpriced, flagged: t.flagged + b.flagged,
            codShipments: t.codShipments + b.codShipments, prepaidShipments: t.prepaidShipments + b.prepaidShipments,
            codDelivered: t.codDelivered + b.codDelivered,
            expectedCodRemittance: round2(t.expectedCodRemittance + b.expectedCodRemittance),
            prepaidValue: round2(t.prepaidValue + b.prepaidValue),
            codRtoValue: round2(t.codRtoValue + b.codRtoValue), valuePending: t.valuePending + b.valuePending,
            overRate: t.overRate + b.overRate, overcharge: round2(t.overcharge + b.overcharge),
            gmv: round2(t.gmv + b.gmv),
        }), { shipments: 0, delivered: 0, rto: 0, charges: 0, gst: 0, chargesWithGst: 0, payments: 0,
              outstanding: 0, unpriced: 0, flagged: 0, overRate: 0, overcharge: 0, gmv: 0,
              codShipments: 0, prepaidShipments: 0, codDelivered: 0, expectedCodRemittance: 0,
              prepaidValue: 0, codRtoValue: 0, valuePending: 0 });
        totals.balance = round2(totals.chargesWithGst - totals.payments);
        totals.creditLeft = creditLeft;
        totals.avgFreight = totals.shipments ? round2(totals.charges / totals.shipments) : 0;
        totals.freightPctOfGmv = totals.gmv ? round2(totals.chargesWithGst / totals.gmv * 100) : null;
        totals.codDeliveryRate = totals.codShipments ? Math.round(totals.codDelivered / totals.codShipments * 100) : 0;
        // Net position: what RapidShyp owes us in COD cash, minus what we owe them in freight.
        totals.netPosition = round2(totals.expectedCodRemittance - totals.outstanding);

        res.json({ success: true, range: { from: fromStr, to: toStr },
            months: list.slice().reverse(), totals, aging, payments: pays || [],
            note: 'Charges are RapidShyp billed figures. Payments are recorded manually — RapidShyp exposes no wallet/billing API (verified: every billing path 404s and their published docs cover only serviceability, orders, returns, B2B, wrapper, tracking and pickup).' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Payments CRUD (RapidShyp's own ledger) ──
router.get('/rapidshyp-payments', async (req, res) => {
    try {
        const { data, error } = await supabase.from('rapidshyp_payments').select('*')
            .order('payment_date', { ascending: false }).limit(500);
        if (error) throw new Error(error.message);
        res.json({ success: true, payments: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/rapidshyp-payments', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const b = req.body || {};
        const amount = Number(b.amount);
        if (!b.payment_date) return res.status(400).json({ success: false, error: 'payment_date is required' });
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'amount must be greater than 0' });
        const row = {
            payment_date: b.payment_date,
            direction: String(b.direction) === 'received' ? 'received' : 'paid',
            amount, reference: b.reference || null, method: b.method || null,
            period_from: b.period_from || null, period_to: b.period_to || null,
            notes: b.notes || null, created_by: (req.user && (req.user.name || req.user.sub)) || 'portal',
        };
        const { data, error } = await supabase.from('rapidshyp_payments').insert(row).select().single();
        if (error) throw new Error(error.message);
        res.json({ success: true, payment: data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.delete('/rapidshyp-payments/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('rapidshyp_payments').delete().eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
