// ─────────────────────────────────────────────────────────────────────────────
// KwikShip (GoKwik shipping) freight reconciliation.
//
// ⚠️⚠️ **THIS IS OUR COMPUTED EXPECTATION, NOT KWIKSHIP'S INVOICE.** That is the single most important
// thing to know about this dashboard, and it is said on every tab. Unlike RapidShyp Recon — where the
// charges are RapidShyp's OWN `freight_forward` / `freight_rto` / `cod_charges` pulled from their API,
// i.e. what they actually billed — KwikShip exposes no billing endpoint we can read. Every rupee here is
// computed BY US from the rate card the team entered (`kwikship_rate_card_ecom`) and the billing rules
// in `kwikship_billing_config_ecom`, applied by the SQL function `apply_kwikship_charges()` which writes
// the freight columns on `shipment_journey_ecom` after each sync.
//
// So this page answers "what SHOULD KwikShip charge us", and its job is to be the thing you hold a real
// invoice against. It must never be described as "what KwikShip charged" — that would turn a modelled
// number into a settled fact, which is exactly how a wrong rate card goes unnoticed for months.
//
// Pricing model (from kwikship_billing_config_ecom, all editable, no constant lives in this file):
//   • forward  — zone × weight slab: base up to `slab_switch_g`, then per-500g/1000g adders
//   • RTO      — its own zone rate; `rto_bills_forward` decides whether a return ALSO pays the forward leg
//   • COD fee  — `cod_pct` of shipment value, floored at `cod_min`; `cod_on_delivered_only` limits it to
//                delivered shipments (an RTO collects no cash, so it attracts no COD fee)
//   • GST      — `gst_pct`, always computed and shown SEPARATELY from the freight, never merged
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');

const ROW_CAP = 5000;
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const round2 = v => Math.round(num(v) * 100) / 100;
const istDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// ⚠️ WINDOW BASIS = `order_date`. KwikShip has NO `awb_assigned_at` (0 of 1,878 rows — that column is
// RapidShyp's, and RapidShyp Recon rightly windows on it because it is their billing pivot). Measured
// coverage here: order_date 1,878/1,878, dispatched_at 1,824/1,878. Windowing on dispatch would silently
// drop 54 shipments that exist and are priced, so the basis is the one field that is always present.
// Revisit this the day a real KwikShip invoice arrives and names its own period basis.
const COLS = 'awb, order_name, source, courier, outcome, is_final, order_date, dispatched_at, delivered_at, '
    + 'rto_at, payment_mode, zone, dest_state, dest_city, applied_weight, shipment_value, '
    + 'freight_total, freight_forward, freight_rto, cod_charges, charges_fetched_at, rto_no_attempt';

// Paged past PostgREST's 1000-row cap — the same silent truncation that made the PG recon report
// "1000 of 1000" for a 42,000-order window.
async function fetchShipments(fromISO, toISO) {
    const all = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('shipment_journey_ecom').select(COLS)
            .eq('source', 'kwikship').gte('order_date', fromISO).lte('order_date', toISO)
            .order('order_date', { ascending: false }).range(off, off + 999);
        if (error) throw new Error(error.message);
        all.push(...(data || []));
        if (!data || data.length < 1000 || all.length >= 60000) break;
    }
    return all;
}

// Per-shipment charge, read from the columns `apply_kwikship_charges()` wrote. Deliberately NOT
// recomputed here: the rate card is applied in ONE place (SQL), so the dashboard and the stored value
// can never disagree — the drift class that has bitten this codebase repeatedly.
function chargeOf(r) {
    const fwd = num(r.freight_forward), rto = num(r.freight_rto), cod = num(r.cod_charges);
    const total = r.freight_total != null ? num(r.freight_total) : round2(fwd + rto + cod);
    return { fwd, rto, cod, total };
}

// Flags worth a buyer's attention. `unpriced` means FINAL-but-unpriced only — an in-flight shipment has
// legitimately not been priced yet, and counting those as billing gaps is what made RapidShyp Recon
// report 1,131 "missing invoices" when the true number was 181.
function flagsOf(r) {
    const f = [];
    const oc = String(r.outcome || '').toLowerCase();
    if (r.is_final && r.freight_total == null) f.push('unpriced');
    if (r.applied_weight == null) f.push('no_weight');
    if (!r.zone) f.push('no_zone');
    // A COD fee on a prepaid shipment is a rate-card or data error — we already have the money.
    if (/prepaid/i.test(r.payment_mode || '') && num(r.cod_charges) > 0) f.push('cod_on_prepaid');
    // A return that never went out for delivery — the forward leg is disputable with any courier.
    if (oc === 'rto' && r.rto_no_attempt) f.push('rto_no_attempt');
    return f;
}

function shapeRow(r) {
    const c = chargeOf(r);
    return {
        awb: r.awb, order_name: r.order_name, courier: r.courier || null,
        outcome: r.outcome || null, is_final: !!r.is_final,
        order_date: r.order_date, dispatched_at: r.dispatched_at,
        closed_at: r.delivered_at || r.rto_at || null,
        payment_mode: r.payment_mode || null, zone: r.zone || null,
        dest: [r.dest_city, r.dest_state].filter(Boolean).join(', ') || null,
        weight: r.applied_weight == null ? null : num(r.applied_weight),
        value: r.shipment_value == null ? null : num(r.shipment_value),
        forward: c.fwd, rto: c.rto, cod: c.cod, charge: c.total,
        priced: r.freight_total != null,
        flags: flagsOf(r),
    };
}

// Aggregates over EVERY row, keyed by the dimensions the table can filter on — so the count line states
// the truth for any selection while the table renders only a capped page. (The PG recon shipped without
// this and its header read "4,911 + 89" for a 5,592-order month: the cap, not the window.)
function buckets(rows) {
    const by = new Map();
    for (const r of rows) {
        const key = (r.zone || '?') + '|' + (r.outcome || '?') + '|' + (r.priced ? 1 : 0);
        let b = by.get(key);
        if (!b) { b = { zone: r.zone || null, outcome: r.outcome || null, priced: r.priced,
            shipments: 0, forward: 0, rto: 0, cod: 0, charge: 0, weight: 0, value: 0 }; by.set(key, b); }
        b.shipments++; b.forward += r.forward; b.rto += r.rto; b.cod += r.cod; b.charge += r.charge;
        b.weight += r.weight || 0; b.value += r.value || 0;
    }
    return [...by.values()].map(b => ({ ...b, forward: round2(b.forward), rto: round2(b.rto),
        cod: round2(b.cod), charge: round2(b.charge), value: round2(b.value) }));
}

// The table filter, defined ONCE so the CSV export and the screen cannot drift apart.
function applyFilter(rows, { zone = 'all', outcome = 'all', payment = 'all', flag = 'all', q = '' } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    return rows.filter(r => {
        if (zone !== 'all' && (r.zone || '') !== zone) return false;
        if (outcome !== 'all' && (r.outcome || '') !== outcome) return false;
        if (payment === 'cod' && !/cod/i.test(r.payment_mode || '')) return false;
        if (payment === 'prepaid' && !/prepaid/i.test(r.payment_mode || '')) return false;
        if (flag !== 'all' && !r.flags.includes(flag)) return false;
        if (needle && String(r.awb || '').toLowerCase().indexOf(needle) < 0
                   && String(r.order_name || '').toLowerCase().indexOf(needle) < 0
                   && String(r.courier || '').toLowerCase().indexOf(needle) < 0) return false;
        return true;
    });
}

async function billingConfig() {
    const { data } = await supabase.from('kwikship_billing_config_ecom').select('*').limit(1).maybeSingle();
    return data || { cod_min: 0, cod_pct: 0, gst_pct: 18, rto_bills_forward: true, cod_on_delivered_only: true, slab_switch_g: 2000 };
}

function summarize(rows, cfg) {
    const gstPct = num(cfg.gst_pct);
    const t = { shipments: rows.length, priced: 0, unpriced: 0, inFlight: 0,
        delivered: 0, rto: 0, other: 0, cod: 0, prepaid: 0,
        forward: 0, rtoFreight: 0, codFee: 0, charge: 0, weight: 0,
        codDelivered: 0, expectedCodRemittance: 0, prepaidValue: 0, codRtoValue: 0, valuePending: 0,
        flagged: 0, flagCounts: {} };
    for (const r of rows) {
        const oc = String(r.outcome || '').toLowerCase();
        const isPrepaid = /prepaid/i.test(r.payment_mode || '');
        if (r.priced) t.priced++; else if (r.is_final) t.unpriced++; else t.inFlight++;
        if (oc === 'delivered') t.delivered++; else if (oc === 'rto') t.rto++; else t.other++;
        if (isPrepaid) { t.prepaid++; t.prepaidValue += r.value || 0; }
        else {
            t.cod++;
            // COD cash reaches us only on delivery — an RTO collects nothing, so it owes no remittance.
            if (oc === 'delivered') { t.codDelivered++; t.expectedCodRemittance += r.value || 0; }
            else if (oc === 'rto') t.codRtoValue += r.value || 0;
        }
        if (r.value == null) t.valuePending++;
        t.forward += r.forward; t.rtoFreight += r.rto; t.codFee += r.cod; t.charge += r.charge;
        t.weight += r.weight || 0;
        if (r.flags.length) { t.flagged++; r.flags.forEach(f => { t.flagCounts[f] = (t.flagCounts[f] || 0) + 1; }); }
    }
    ['forward', 'rtoFreight', 'codFee', 'charge', 'expectedCodRemittance', 'prepaidValue', 'codRtoValue']
        .forEach(k => { t[k] = round2(t[k]); });
    // GST is computed and carried SEPARATELY — never folded into the freight figure.
    t.gstPct = gstPct;
    t.gst = round2(t.charge * gstPct / 100);
    t.chargeInclGst = round2(t.charge + t.gst);
    t.avgPerShipment = t.shipments ? round2(t.charge / t.shipments) : 0;
    return t;
}

function rangeOf(req, defDays = 30) {
    const to = req.query.to || istDay(new Date());
    let from = req.query.from;
    if (!from) { const d = new Date(); d.setDate(d.getDate() - defDays); from = istDay(d); }
    return { from, to, fromISO: `${from}T00:00:00.000+05:30`, toISO: `${to}T23:59:59.999+05:30` };
}

// ── GET /kwikship-recon ──────────────────────────────────────────────────────────────────────────
router.get('/kwikship-recon', async (req, res) => {
    try {
        const { from, to, fromISO, toISO } = rangeOf(req);
        const [raw, cfg] = await Promise.all([fetchShipments(fromISO, toISO), billingConfig()]);
        const rows = raw.map(shapeRow);
        res.json({
            success: true,
            range: { from, to },
            basis: 'order_date',
            computed: true,   // ⚠️ the client prints "computed from the rate card, not an invoice" off this
            config: cfg,
            summary: summarize(rows, cfg),
            buckets: buckets(rows),
            zones: [...new Set(rows.map(r => r.zone).filter(Boolean))].sort(),
            couriers: [...new Set(rows.map(r => r.courier).filter(Boolean))].sort(),
            rows: rows.slice(0, ROW_CAP),
            rowsTotal: rows.length,
            capped: rows.length > ROW_CAP,
        });
    } catch (e) {
        console.error('[KwikShip recon] error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── GET /kwikship-recon/export.csv — filtered but NEVER capped ───────────────────────────────────
// Built server-side over the full window: the PG recon's export was assembled from the rendered page and
// silently produced 5,000 of 5,592 rows — a short file an accountant reconciles from and cannot tell is short.
router.get('/kwikship-recon/export.csv', async (req, res) => {
    try {
        const { from, to, fromISO, toISO } = rangeOf(req);
        const rows = applyFilter((await fetchShipments(fromISO, toISO)).map(shapeRow), req.query);
        const head = ['AWB', 'Order', 'Order date', 'Dispatched', 'Closed', 'Courier', 'Zone', 'Destination',
            'Payment', 'Outcome', 'Weight (g)', 'Shipment value', 'Forward', 'RTO', 'COD fee', 'Charge ex-GST', 'Priced', 'Flags'];
        const csv = [head.join(',')].concat(rows.map(r => [
            r.awb, r.order_name, String(r.order_date || '').slice(0, 10), String(r.dispatched_at || '').slice(0, 10),
            String(r.closed_at || '').slice(0, 10), '"' + String(r.courier || '').replace(/"/g, '""') + '"',
            r.zone || '', '"' + String(r.dest || '').replace(/"/g, '""') + '"', r.payment_mode || '', r.outcome || '',
            r.weight == null ? '' : r.weight, r.value == null ? '' : r.value,
            r.forward, r.rto, r.cod, r.charge, r.priced ? 'yes' : 'no', '"' + r.flags.join(' ') + '"',
        ].join(','))).join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="kwikship-recon_${from}_to_${to}.csv"`);
        res.send(csv);
    } catch (e) {
        console.error('[KwikShip recon] export error:', e.message);
        res.status(500).send('Export failed: ' + e.message);
    }
});

// ── GET /kwikship-recon/rates — the rate card + billing rules the charges come from ──────────────
router.get('/kwikship-recon/rates', async (_req, res) => {
    try {
        const [{ data: card }, cfg] = await Promise.all([
            supabase.from('kwikship_rate_card_ecom').select('*').order('rate_kind').order('zone').order('effective_from'),
            billingConfig(),
        ]);
        // Pivot to zone × rate-kind so the UI renders a grid rather than 30 loose rows. Effective-dated:
        // the NEWEST row on or before today wins, and older ones stay visible as history.
        const today = istDay(new Date());
        const live = {}, history = [];
        (card || []).forEach(r => {
            if (String(r.effective_from) > today) { history.push({ ...r, future: true }); return; }
            const k = r.rate_kind + '|' + r.zone;
            if (!live[k] || String(r.effective_from) > String(live[k].effective_from)) {
                if (live[k]) history.push(live[k]);
                live[k] = r;
            } else history.push(r);
        });
        res.json({ success: true, config: cfg, rates: Object.values(live), history });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /kwikship-recon/ledger — month by month expected charge vs payments ──────────────────────
router.get('/kwikship-recon/ledger', async (req, res) => {
    try {
        const toStr = req.query.to || istDay(new Date());
        let fromStr = req.query.from;
        if (!fromStr) { const d = new Date(); d.setMonth(d.getMonth() - 6); fromStr = istDay(d); }
        const [raw, cfg, pay] = await Promise.all([
            fetchShipments(`${fromStr}T00:00:00.000+05:30`, `${toStr}T23:59:59.999+05:30`),
            billingConfig(),
            supabase.from('kwikship_payments').select('*').order('payment_date', { ascending: true }),
        ]);
        const gstPct = num(cfg.gst_pct);
        const months = {};
        raw.map(shapeRow).forEach(r => {
            const m = istDay(r.order_date).slice(0, 7);
            const b = months[m] || (months[m] = { month: m, shipments: 0, delivered: 0, rto: 0, other: 0,
                cod: 0, prepaid: 0, codDelivered: 0, expectedCodRemittance: 0, prepaidValue: 0, codRtoValue: 0,
                forward: 0, rtoFreight: 0, codFee: 0, charge: 0, unpriced: 0, payments: 0 });
            const oc = String(r.outcome || '').toLowerCase();
            b.shipments++;
            if (oc === 'delivered') b.delivered++; else if (oc === 'rto') b.rto++; else b.other++;
            if (/prepaid/i.test(r.payment_mode || '')) { b.prepaid++; b.prepaidValue += r.value || 0; }
            else {
                b.cod++;
                if (oc === 'delivered') { b.codDelivered++; b.expectedCodRemittance += r.value || 0; }
                else if (oc === 'rto') b.codRtoValue += r.value || 0;
            }
            b.forward += r.forward; b.rtoFreight += r.rto; b.codFee += r.cod; b.charge += r.charge;
            if (r.is_final && !r.priced) b.unpriced++;
        });
        (pay.data || []).forEach(p => {
            const m = String(p.payment_date).slice(0, 7);
            if (months[m]) months[m].payments += num(p.amount);
        });
        // FIFO settlement — a payment clears the oldest outstanding month first, which is how a partner
        // actually applies money received; a running balance built any other way misstates the aging.
        const list = Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
        let carried = 0;
        list.forEach(b => {
            ['forward', 'rtoFreight', 'codFee', 'charge', 'expectedCodRemittance', 'prepaidValue', 'codRtoValue']
                .forEach(k => { b[k] = round2(b[k]); });
            b.gst = round2(b.charge * gstPct / 100);
            b.chargeInclGst = round2(b.charge + b.gst);
            b.payments = round2(b.payments);
            carried = round2(carried + b.chargeInclGst - b.payments);
            b.balance = carried;   // + = payable to KwikShip
        });
        const totalPaid = round2((pay.data || []).reduce((a, p) => a + num(p.amount), 0));
        const totalCharge = round2(list.reduce((a, b) => a + b.chargeInclGst, 0));
        res.json({ success: true, months: list, payments: pay.data || [],
            totals: { charge: totalCharge, paid: totalPaid, outstanding: round2(totalCharge - totalPaid), gstPct } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Payments to KwikShip — hand-entered (they expose no billing/wallet API we can read) ──────────
router.get('/kwikship-payments', async (_req, res) => {
    try {
        const { data, error } = await supabase.from('kwikship_payments').select('*').order('payment_date', { ascending: false });
        if (error) throw new Error(error.message);
        res.json({ success: true, payments: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/kwikship-payments', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const b = req.body || {};
        const amount = Number(b.amount);
        if (!b.payment_date) return res.status(400).json({ success: false, error: 'payment_date is required.' });
        if (!isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'amount must be a positive number.' });
        const { data, error } = await supabase.from('kwikship_payments').insert({
            payment_date: b.payment_date, direction: b.direction || 'out', amount,
            reference: b.reference || null, method: b.method || null,
            period_from: b.period_from || null, period_to: b.period_to || null,
            notes: b.notes || null, created_by: (req.user && req.user.sub) || null,
        }).select().single();
        if (error) throw new Error(error.message);
        res.json({ success: true, payment: data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/kwikship-payments/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('kwikship_payments').delete().eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
module.exports.buckets = buckets;
module.exports.applyFilter = applyFilter;
module.exports.summarize = summarize;
module.exports.flagsOf = flagsOf;
