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

// ⚠⚠ WINDOW BASIS = THE TERMINAL STATUS DATE (delivered_at / rto_at), not the order date
// (changed on request, 2026-08-20). Freight is earned when the shipment CLOSES: a parcel ordered on
// 28 Jul and delivered on 3 Aug is August freight, and billing it to July would misstate both months.
// DocPharma Recon reaches the same place with two controls (an order-date range plus a separate
// "Delivered / RTO" range); this is the single-control version of that.
//
// Consequences, deliberately accepted and surfaced in the UI rather than hidden:
//   • A shipment still moving has NO terminal date, so it is not in any window — correct, because no
//     freight is due until it closes. `openShipments()` counts them so they are never simply invisible.
//   • `lost` shipments have neither timestamp and therefore never appear. There are ~3; when KwikShip
//     starts billing for lost parcels this needs its own date.
// (Not `awb_assigned_at`: KwikShip has 0 of 1,878. Not `dispatched_at`: 1,824 of 1,878, so 54 priced
// shipments would silently vanish.)
const COLS = 'awb, order_name, source, courier, outcome, is_final, order_date, dispatched_at, delivered_at, '
    + 'rto_at, payment_mode, zone, dest_state, dest_city, applied_weight, shipment_value, '
    + 'freight_total, freight_forward, freight_rto, cod_charges, charges_fetched_at, rto_no_attempt';

// One paged pass over a single date column. PostgREST caps every select at 1000 rows silently — the
// same truncation that made the PG recon report "1000 of 1000" for a 42,000-order window.
async function fetchByDate(col, fromISO, toISO) {
    const all = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('shipment_journey_ecom').select(COLS)
            .eq('source', 'kwikship').gte(col, fromISO).lte(col, toISO)
            .order(col, { ascending: false }).range(off, off + 999);
        if (error) throw new Error(error.message);
        all.push(...(data || []));
        if (!data || data.length < 1000 || all.length >= 60000) break;
    }
    return all;
}

// Delivered-in-window OR returned-in-window, de-duplicated by AWB. Two queries rather than one `.or()`
// because PostgREST cannot range-filter two columns inside a single or() cleanly, and a shipment that
// somehow carries both timestamps must be counted once, not twice.
async function fetchShipments(fromISO, toISO) {
    const [del, rto] = await Promise.all([
        fetchByDate('delivered_at', fromISO, toISO),
        fetchByDate('rto_at', fromISO, toISO),
    ]);
    const by = new Map();
    for (const r of [...del, ...rto]) if (!by.has(r.awb)) by.set(r.awb, r);
    return [...by.values()].sort((a, b) =>
        String(b.delivered_at || b.rto_at || '').localeCompare(String(a.delivered_at || a.rto_at || '')));
}

// Shipments that have NOT closed yet, so they belong to no window. Counted (not listed) so the page can
// say "N still moving, they will bill when they close" instead of leaving them unaccounted for.
async function openShipments() {
    const { data, error } = await supabase.from('shipment_journey_ecom')
        .select('freight_total', { count: 'exact' })
        .eq('source', 'kwikship').is('delivered_at', null).is('rto_at', null).limit(1000);
    if (error) return { count: 0, charge: 0 };
    return {
        count: (data || []).length,
        charge: round2((data || []).reduce((a, r) => a + num(r.freight_total), 0)),
    };
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
    // Shipment value has not synced yet: the COD fee and the expected remittance leave this row out.
    if (r.shipment_value == null) f.push('no_value');
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
        // ⚠️ The close date must AGREE WITH THE OUTCOME. The fetch matches on EITHER timestamp, so a
        // parcel that carries both (delivered after an RTO leg, or vice versa) is pulled in by one column
        // and would then be LABELLED by the other — across a month boundary that is an off-by-one which
        // looks exactly like a timezone bug. 1 shipment carries both today (TE25-42305, same month, so
        // currently harmless); this makes it correct before it is not.
        closed_at: (String(r.outcome || '') === 'rto' ? (r.rto_at || r.delivered_at) : (r.delivered_at || r.rto_at)) || null,
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
        const [raw, cfg, open] = await Promise.all([fetchShipments(fromISO, toISO), billingConfig(), openShipments()]);
        const rows = raw.map(shapeRow);
        res.json({
            success: true,
            range: { from, to },
            basis: 'closed_at',          // delivered_at / rto_at — see the note on fetchShipments
            open,                        // still moving: in no window until they close

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
        const head = ['AWB', 'Order', 'Order date', 'Dispatched', 'Closed (billing date)', 'Courier', 'Zone', 'Destination',
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

// ── GET /kwikship-recon/ledger — the two-sided account with KwikShip ─────────────────────────────
//
// ⚠️ THIS IS NOT A FREIGHT BILL LIST, AND READING IT AS ONE INVERTS THE ANSWER. KwikShip COLLECTS THE
// COD for us and remits it net of their freight, exactly the way DocPharma settles. A ledger that shows
// only the freight side reported "₹358.72 payable to KwikShip" for a month in which they were in fact
// holding ₹3.87 lakh of our money. Both sides are therefore carried per month, mirroring the DocPharma
// ledger column for column:
//     Receivable  = COD collected on DELIVERED COD shipments (an RTO collects no cash)
//     Payable     = freight + GST — the rate-card EXPECTATION and the INVOICED actual, kept apart
//     Net         = receivable − payable   (+ = KwikShip owes us)
//     Outstanding = net − payments applied
//
// Payable nets against receivables at the INVOICED figure only. A month KwikShip has not billed is not
// yet a liability, so the rate-card estimate rides along as a memo and never silently moves the net —
// the same rule the DocPharma ledger uses, and the reason `payableExpected` and `payableInvoiced` are
// two separate cards the user can re-base the net on.
const LZERO = () => ({
    shipments: 0, delivered: 0, rto: 0, other: 0, lost: 0,
    cod: 0, prepaid: 0, codDelivered: 0, codRto: 0,
    codCollected: 0, prepaidValue: 0, codRtoValue: 0,
    forward: 0, rtoFreight: 0, codFee: 0, charge: 0, unpriced: 0,
    invCharges: 0, invGst: 0, invGrand: 0, invoices: 0, invShipments: 0,
    paymentsIn: 0, paymentsOut: 0,
});
// Which month a KwikShip invoice belongs to: the period it states, else the date it was raised.
function ledgerInvoiceMonth(iv) {
    if (iv.period_from) return String(iv.period_from).slice(0, 7);
    if (iv.invoice_date) return String(iv.invoice_date).slice(0, 7);
    return 'unknown';
}
router.get('/kwikship-recon/ledger', async (req, res) => {
    try {
        const toStr = req.query.to || istDay(new Date());
        let fromStr = req.query.from;
        if (!fromStr) { const d = new Date(); d.setMonth(d.getMonth() - 6); fromStr = istDay(d); }
        // The invoices table is the one piece behind a migration; a missing table must degrade the
        // INVOICED column to blank, never take the whole ledger down with it.
        const invQ = supabase.from('kwikship_invoices').select('*')
            .then(r => (r.error ? { data: [] } : r), () => ({ data: [] }));
        const [raw, cfg, pay, inv] = await Promise.all([
            fetchShipments(`${fromStr}T00:00:00.000+05:30`, `${toStr}T23:59:59.999+05:30`),
            billingConfig(),
            supabase.from('kwikship_payments').select('*').order('payment_date', { ascending: true }),
            invQ,
        ]);
        const gstPct = num(cfg.gst_pct);
        const months = {};
        const bucket = m => months[m] || (months[m] = Object.assign({ month: m }, LZERO()));
        // Invoices and payments may create a month the shipments did not — but only INSIDE the window the
        // user asked for. Without this an August bill appears as a phantom −₹386 month on a July ledger.
        const mFrom = String(fromStr).slice(0, 7), mTo = String(toStr).slice(0, 7);
        const inWindow = m => m !== 'unknown' && m >= mFrom && m <= mTo;

        raw.map(shapeRow).forEach(r => {
            // Same basis as the table: the month a shipment CLOSED is the month it is billed in.
            const b = bucket(istDay(r.closed_at || r.order_date).slice(0, 7));
            const oc = String(r.outcome || '').toLowerCase();
            b.shipments++;
            if (oc === 'delivered') b.delivered++;
            else if (oc === 'rto') b.rto++;
            else { b.other++; if (oc === 'lost') b.lost++; }
            if (/prepaid/i.test(r.payment_mode || '')) { b.prepaid++; b.prepaidValue += r.value || 0; }
            else {
                b.cod++;
                // Only a DELIVERED COD parcel produces cash for KwikShip to hold and remit.
                if (oc === 'delivered') { b.codDelivered++; b.codCollected += r.value || 0; }
                else if (oc === 'rto') { b.codRto++; b.codRtoValue += r.value || 0; }
            }
            b.forward += r.forward; b.rtoFreight += r.rto; b.codFee += r.cod; b.charge += r.charge;
            if (r.is_final && !r.priced) b.unpriced++;
        });
        // Invoices and payments CREATE their month if no shipment did. A remittance in a month with no
        // closed shipment is still money that moved; dropping it (the old `if (months[m])`) hid it from
        // the balance entirely and made the account look further behind than it was.
        const invoices = (inv.data || []).map(iv => Object.assign({}, iv, { _month: ledgerInvoiceMonth(iv) }));
        invoices.forEach(iv => {
            if (!inWindow(iv._month)) return;
            const b = bucket(iv._month);
            const grand = num(iv.total_amount);
            const freight = iv.freight_amount == null ? round2(grand / (1 + gstPct / 100)) : num(iv.freight_amount);
            b.invCharges += freight;
            b.invGst += iv.gst_amount == null ? round2(grand - freight) : num(iv.gst_amount);
            b.invGrand += grand; b.invoices++; b.invShipments += Number(iv.shipments || 0);
        });
        const payments = (pay.data || []).map(p => Object.assign({}, p, {
            _month: (p.period_from ? String(p.period_from) : String(p.payment_date || '')).slice(0, 7) || 'unknown',
        }));
        payments.forEach(p => {
            if (!inWindow(p._month)) return;
            const b = bucket(p._month);
            // 'out'/'paid' = money we sent them; anything else is a remittance received.
            if (/^(out|paid)$/i.test(String(p.direction || ''))) b.paymentsOut += num(p.amount);
            else b.paymentsIn += num(p.amount);
        });

        const asc = Object.keys(months).filter(m => m !== 'unknown').sort();
        if (months.unknown) asc.push('unknown');
        asc.forEach(m => {
            const b = months[m];
            ['forward', 'rtoFreight', 'codFee', 'charge', 'codCollected', 'prepaidValue', 'codRtoValue',
                'invCharges', 'invGst', 'invGrand', 'paymentsIn', 'paymentsOut'].forEach(k => { b[k] = round2(b[k]); });
            b.gst = round2(b.charge * gstPct / 100);
            b.chargeInclGst = round2(b.charge + b.gst);
            b.payments = round2(b.paymentsIn - b.paymentsOut);
            b.payableExpected = b.chargeInclGst;
            b.payableActual = b.invGrand;                       // only what they actually billed is netted
            b.unInvoicedMemo = b.invoices ? 0 : b.chargeInclGst;
            b.receivable = b.codCollected;
            b.remitExpected = round2(b.receivable - b.payableActual);
            b.variance = b.invoices ? round2(b.invGrand - b.chargeInclGst) : null;
            b.shipmentVariance = (b.invoices && b.invShipments) ? b.invShipments - b.shipments : null;
        });
        // FIFO settlement. KwikShip remits irregular lump sums, not month-by-month, so the whole pool is
        // allocated oldest-first — how a partner actually applies money — and the frontier says how far
        // the account is genuinely settled instead of averaging the shortfall across every month.
        const poolTotal = round2(asc.reduce((s, m) => s + months[m].paymentsIn - months[m].paymentsOut, 0));
        let pool = poolTotal;
        const alloc = {};
        asc.forEach(m => {
            const owed = Math.max(0, months[m].remitExpected);
            const a = Math.min(owed, Math.max(0, pool));
            alloc[m] = round2(a); pool = round2(pool - a);
        });
        let settledThrough = null, unsettledTotal = 0, unsettledMonths = 0, past = false;
        asc.forEach(m => {
            const owed = Math.max(0, months[m].remitExpected); if (owed <= 0) return;
            const paid = alloc[m] || 0;
            if (!past && paid >= owed - 0.5) settledThrough = m;
            else { past = true; unsettledTotal += owed - paid; unsettledMonths++; }
        });

        let carried = 0;
        asc.forEach(m => {
            const b = months[m];
            b.paidNet = alloc[m] || 0;
            b.settled = b.remitExpected <= 0 ? 'na'
                : (b.paidNet >= b.remitExpected - 0.5 ? 'settled' : b.paidNet > 0 ? 'partial' : 'outstanding');
            b.outstanding = round2(b.remitExpected - b.paidNet);
            // Freight-only running balance, kept so the payable side still reads as a statement.
            carried = round2(carried + b.chargeInclGst - b.payments);
            b.balance = carried;                                // + = payable to KwikShip on freight alone
        });

        const list = asc.map(m => months[m]);
        const g = LZERO();
        list.forEach(b => Object.keys(g).forEach(k => { g[k] = round2(g[k] + (b[k] || 0)); }));
        const gCharge = round2(g.charge), gGst = round2(gCharge * gstPct / 100);
        const receivable = round2(g.codCollected);
        const payableExpected = round2(gCharge + gGst);
        const payableInvoiced = round2(g.invGrand);
        const paidNet = round2(g.paymentsIn - g.paymentsOut);
        res.json({
            success: true, months: list, payments, invoices,
            totals: {
                gstPct,
                shipments: g.shipments, delivered: g.delivered, rto: g.rto, lost: g.lost,
                codOrders: g.cod, codDelivered: g.codDelivered, codRto: g.codRto, prepaidOrders: g.prepaid,
                prepaidValue: round2(g.prepaidValue), codRtoValue: round2(g.codRtoValue),
                forward: round2(g.forward), rtoFreight: round2(g.rtoFreight), codFee: round2(g.codFee),
                charge: gCharge, gst: gGst, chargeInclGst: payableExpected,
                receivable, payableExpected, payableInvoiced,
                invCharges: round2(g.invCharges), invGst: round2(g.invGst), invoices: g.invoices,
                variance: g.invoices ? round2(payableInvoiced - payableExpected) : null,
                net: round2(receivable - payableInvoiced),
                netIfExpected: round2(receivable - payableExpected),
                paid: paidNet, paymentsIn: round2(g.paymentsIn), paymentsOut: round2(g.paymentsOut),
                outstanding: round2(receivable - payableInvoiced - paidNet),
                outstandingIfExpected: round2(receivable - payableExpected - paidNet),
                unpriced: g.unpriced,
                fifo: {
                    totalReceived: poolTotal, settledThrough, unsettledMonths,
                    unsettledTotal: round2(unsettledTotal), overpaid: round2(Math.max(0, pool)),
                },
            },
        });
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
            payment_date: b.payment_date, direction: b.direction || 'received',   // KwikShip remitting COD to us is the normal case amount,
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

// ── Invoices: the real KwikShip bill, held against what this page computes ───────────────────────
// Everything else here is an EXPECTATION from our own rate card. This is the other half — what they
// actually charged — so a per-period variance can be shown. That variance is the only way a wrong rate
// card is ever caught; without it the page just agrees with itself forever.
//
// Parsers are BORROWED from docpharma_invoices.js rather than rewritten: one definition of "read a PDF"
// and "parse an Indian invoice date", not two that drift. A parse NEVER saves — it returns fields for
// review, because a mis-read total silently entered as fact is worse than typing it by hand.
const { pdfText, parseInvDate, rowsFromExcel } = require('./docpharma_invoices');

const _n = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
const _c = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "Jul'26", "July 2026", "Jul-2026" → the whole calendar month. A service period stated as a month is
// the commonest form on these invoices, and it pins both ends exactly.
function monthPeriod(text) {
    const m = String(text || '').match(/([A-Za-z]{3,9})[\s'\-\/]*(\d{2,4})/);
    if (!m) return null;
    const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!mm) return null;
    let y = parseInt(m[2], 10);
    if (y < 100) y += 2000;
    if (y < 2000 || y > 2100) return null;
    const last = new Date(Date.UTC(y, mm, 0)).getUTCDate();
    const p = String(mm).padStart(2, '0');
    return { from: `${y}-${p}-01`, to: `${y}-${p}-${last}` };
}

// Read a rupee amount off a labelled line.
//
// Two traps, both of which produce a WRONG number rather than a blank -- the dangerous kind:
//   * THE RATE IS NOT THE AMOUNT. `CGST (9%) 29.43` and `CGST9 (9%) 4,265.79` both start with a 9.
//     Percentages are stripped first, then the LAST number on the line is the amount.
//   * A BILL STACKS SEVERAL TOTALS. This invoice reads `Sub Total 327.00` / `Total 386.00` /
//     `Balance Due 386.00`, and the other one `Total Taxable Amount 47,397.66` / `Total 55,929.00`.
//     Matching the first line containing "Total" therefore returns the PRE-TAX figure as the invoice
//     value -- wrong by exactly the GST, which is the single thing this page exists to check. `skip`
//     rejects the qualified labels so the bare one is the only one that answers.
function amountOnLine(text, label, skip) {
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!label.test(line)) continue;
        if (skip && skip.test(line)) continue;
        const nums = line.replace(/[\d.,]+\s*%/g, ' ').match(/[\d,]+\.\d{1,2}|\b\d[\d,]*\b/g) || [];
        if (!nums.length) continue;                       // a header or a words-only line -- keep looking
        const v = _n(nums[nums.length - 1]);
        if (v > 0) return v;
    }
    return null;
}

// Label-driven, deliberately generic: no KwikShip freight invoice has been seen yet, so this reads the
// labels Indian tax invoices actually use and leaves anything it cannot find null for the human to fill.
function parseInvoiceText(text) {
    const t = String(text || '');
    const grab = (...res) => { for (const re of res) { const m = t.match(re); if (m) return m[1]; } return null; };
    const inv = {
        invoice_no: _c(grab(/Invoice\s*(?:No|Number|#)\s*\.?\s*:?\s*([A-Z0-9][A-Z0-9\/\-]{3,})/i,
                            /\b((?:GK|KS|INV)[A-Z]*[\/\-][A-Z0-9\/\-]{3,})/i)) || null,
        invoice_date: parseInvDate(grab(/Invoice\s*Date\s*:?\s*([0-9A-Za-z\/\-\s]{6,20})/i, /\bDate\s*:?\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{4})/i) || ''),
        period_from: null, period_to: null,
        shipments: null, freight_amount: null, gst_amount: null, total_amount: null,
    };
    const per = grab(/(?:Service\s*Period|Period|Billing\s*Period|for\s*the\s*month\s*of)\s*:?\s*([A-Za-z0-9'\-\s\/]{4,25})/i);
    const mp = per ? monthPeriod(per) : null;
    if (mp) { inv.period_from = mp.from; inv.period_to = mp.to; }
    const ship = grab(/(?:No\.?\s*of\s*(?:Transactions|Shipments|Orders)|Shipments|Total\s*Shipments)\s*:?\s*([\d,]+)/i);
    if (ship) inv.shipments = Math.round(_n(ship));
    // Freight is the pre-tax base, under whichever label this layout happens to use. Tried in order of
    // how explicit each label is: "Taxable Amount" says what it is, "Sub Total" is the same figure by
    // position, and the line item itself ("Freight Charge 996511 1.00 327.00") is the last resort.
    inv.freight_amount = amountOnLine(t, /(?:total\s+)?taxable\s+(?:amount|value)/i)
        || amountOnLine(t, /\bsub[\s-]*total\b/i)
        || amountOnLine(t, /\bfreight\s*(?:charges?|amount)?\b/i);
    // GST may be one IGST line or a CGST+SGST pair - sum whatever is present.
    // WARNING: THE RATE IS NOT THE AMOUNT. A naive "first number after the label" reads
    // `CGST9 (9%) 4,265.79` as 9 and `IGST 18%` as 18 - numbers small enough to look like a plausible
    // GST figure and get saved without a second glance. Percentages are stripped first, then the LAST
    // number on the line is taken as the amount; a line carrying only a rate yields nothing at all,
    // because a blank the user must fill beats a wrong total they might not check.
    let gst = 0;
    for (const label of [/\bIGST\d*\b/i, /\bCGST\d*\b/i, /\bSGST\d*\b/i]) {
        const v = amountOnLine(t, label);
        if (v) gst += v;
    }
    if (gst > 0) inv.gst_amount = Math.round(gst * 100) / 100;
    // The payable figure, most explicit label first. "Balance Due" comes LAST: on a part-paid bill it is
    // smaller than the invoice, and the invoice is what a variance has to be measured against.
    const NOT_THE_TOTAL = /sub[\s-]*total|taxable|in\s+words/i;
    inv.total_amount = amountOnLine(t, /\bgrand\s*total\b/i)
        || amountOnLine(t, /\binvoice\s*(?:amount|total|value)\b/i)
        || amountOnLine(t, /\btotal\b/i, NOT_THE_TOTAL)
        || amountOnLine(t, /\bbalance\s*due\b/i);
    // Cross-check, because a total that is short by exactly the GST still looks like a real total.
    // Rounding is a line of its own on these bills (`Rounding 0.14`), so add it back before comparing.
    const rounding = amountOnLine(t, /^round(?:ing|\s*off)\b/i) || 0;
    const adds = inv.freight_amount == null ? null
        : Math.round((inv.freight_amount + (inv.gst_amount || 0) + rounding) * 100) / 100;
    if (adds != null && (inv.total_amount == null || inv.total_amount < adds - 1)) inv.total_amount = adds;
    return inv;
}

// POST /kwikship-invoices/parse — raw file in the body; returns fields for REVIEW, saves nothing.
router.post('/kwikship-invoices/parse', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
    try {
        const buf = req.body;
        if (!buf || !buf.length) return res.status(400).json({ success: false, error: 'Empty file.' });
        const fname = String(req.headers['x-filename'] || '');
        const isPdf = /\.pdf$/i.test(fname) || (buf[0] === 0x25 && buf[1] === 0x50);          // %P
        const isXls = /\.xlsx?$/i.test(fname) || (buf[0] === 0x50 && buf[1] === 0x4b);        // PK zip
        let text;
        if (isPdf) text = await pdfText(buf);
        else if (isXls) text = (await rowsFromExcel(buf)).map(r => r.join(' ')).join('\n');
        else text = buf.toString('utf8');
        const extracted = parseInvoiceText(text);
        extracted.source_file = fname || null;
        // The raw sample is returned so a wrong read can be diagnosed without re-uploading the file.
        res.json({ success: true, extracted, sample: String(text).slice(0, 1500) });
    } catch (e) {
        console.error('[KwikShip invoices parse]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /kwikship-invoices — every invoice, each with the charge WE computed for the same period.
router.get('/kwikship-invoices', async (_req, res) => {
    try {
        const { data, error } = await supabase.from('kwikship_invoices').select('*').order('invoice_date', { ascending: false });
        if (error) {
            // The table is the one piece that needs a migration; say so plainly instead of a raw 500.
            // PostgREST reports a missing table as PGRST205 ("Could not find the table ... in the schema
            // cache"), NOT as Postgres' 42P01 "relation does not exist" -- it never reaches Postgres.
            if (error.code === 'PGRST205' || error.code === '42P01' || /does not exist|schema cache/i.test(error.message || '')) {
                return res.json({ success: true, invoices: [], needsSetup: true });
            }
            throw new Error(error.message);
        }
        const cfg = await billingConfig();
        const gstPct = num(cfg.gst_pct);
        // Variance per invoice, computed ONLY when the invoice states a period — a guessed window would
        // invent a difference that is really just a date mismatch.
        const out = [];
        for (const inv of (data || [])) {
            let computed = null;
            if (inv.period_from && inv.period_to) {
                const rows = (await fetchShipments(`${inv.period_from}T00:00:00.000+05:30`, `${inv.period_to}T23:59:59.999+05:30`)).map(shapeRow);
                const charge = round2(rows.reduce((a, r) => a + r.charge, 0));
                computed = { shipments: rows.length, charge, gst: round2(charge * gstPct / 100), total: round2(charge * (1 + gstPct / 100)) };
            }
            out.push({ ...inv, computed,
                variance: computed ? round2(num(inv.total_amount) - computed.total) : null,
                shipmentVariance: (computed && inv.shipments != null) ? (inv.shipments - computed.shipments) : null });
        }
        res.json({ success: true, invoices: out });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/kwikship-invoices', express.json({ limit: '2mb' }), async (req, res) => {
    try {
        const b = req.body || {};
        const no = _c(b.invoice_no);
        if (!no) return res.status(400).json({ success: false, error: 'Invoice number is required.' });
        if (!(Number(b.total_amount) >= 0)) return res.status(400).json({ success: false, error: 'Total amount must be a number.' });
        const row = {
            invoice_no: no,
            invoice_date: b.invoice_date || null,
            period_from: b.period_from || null,
            period_to: b.period_to || null,
            shipments: b.shipments == null || b.shipments === '' ? null : Math.round(Number(b.shipments)),
            freight_amount: b.freight_amount == null || b.freight_amount === '' ? null : Number(b.freight_amount),
            gst_amount: b.gst_amount == null || b.gst_amount === '' ? null : Number(b.gst_amount),
            total_amount: Number(b.total_amount),
            notes: _c(b.notes) || null,
            source_file: _c(b.source_file) || null,
            created_by: (req.user && req.user.sub) || null,
        };
        // Upsert on the invoice number: re-uploading the same bill corrects it rather than duplicating.
        const { data, error } = await supabase.from('kwikship_invoices').upsert(row, { onConflict: 'invoice_no' }).select().single();
        if (error) throw new Error(error.message);
        res.json({ success: true, invoice: data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/kwikship-invoices/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('kwikship_invoices').delete().eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /kwikship-payments/parse — read a payment advice / UTR receipt (PDF or Excel) and return the
// fields for review. Same rule as invoices: it prefills the form, it never writes a payment by itself.
router.post('/kwikship-payments/parse', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
    try {
        const buf = req.body;
        if (!buf || !buf.length) return res.status(400).json({ success: false, error: 'Empty file.' });
        const fname = String(req.headers['x-filename'] || '');
        const isPdf = /\.pdf$/i.test(fname) || (buf[0] === 0x25 && buf[1] === 0x50);
        const isXls = /\.xlsx?$/i.test(fname) || (buf[0] === 0x50 && buf[1] === 0x4b);
        let text;
        if (isPdf) text = await pdfText(buf);
        else if (isXls) text = (await rowsFromExcel(buf)).map(r => r.join(' ')).join('\n');
        else text = buf.toString('utf8');
        const t = String(text);
        const grab = (...res_) => { for (const re of res_) { const m = t.match(re); if (m) return m[1]; } return null; };
        const amt = grab(/(?:Amount|Amt|Paid|Debit|Transfer\s*Amount)\s*:?\s*₹?\s*([\d,]+\.?\d*)/i, /₹\s*([\d,]+\.?\d*)/);
        const extracted = {
            payment_date: parseInvDate(grab(/(?:Value\s*Date|Payment\s*Date|Transaction\s*Date|Date)\s*:?\s*([0-9A-Za-z\/\-\s]{6,20})/i) || '') || null,
            amount: amt ? _n(amt) : null,
            reference: _c(grab(/(?:UTR|RRN|Reference(?:\s*No)?|Txn\s*(?:ID|No)|Transaction\s*ID)\s*\.?\s*:?\s*([A-Za-z0-9\-]{6,})/i)) || null,
            notes: null,
            source_file: fname || null,
        };
        res.json({ success: true, extracted, sample: t.slice(0, 1200) });
    } catch (e) {
        console.error('[KwikShip payment parse]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
module.exports.buckets = buckets;
module.exports.applyFilter = applyFilter;
module.exports.summarize = summarize;
module.exports.flagsOf = flagsOf;
