// DocPharma ledger — Payments + Receivable/Payable dashboard.
// Model: DocPharma collects COD on delivered COD orders (owes us), charges Service/RTO/COD fees (we owe them),
//        and remits the net (COD − charges). We record their charge invoices + the payments they remit.
//   Receivable   = COD collected on delivered COD orders (from docpharma_orders order value)
//   Payable(exp) = rate-card charges on delivered/RTO orders (our expectation)
//   Payable(inv) = DocPharma's charge invoices (actual, incl. tax)
//   Net remittance = COD collected − invoiced charges ; Outstanding = Net − payments received
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
const clean = s => String(s == null ? '' : s).trim();
const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const istMonth = ts => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7) : null;   // YYYY-MM

async function rateCard() {
    const { data } = await supabase.from('docpharma_rate_card').select('flat_service_charge, rto_charge, cod_collection_charge')
        .eq('is_active', true).order('effective_from', { ascending: false }).limit(1).maybeSingle();
    return data || { flat_service_charge: 0, rto_charge: 0, cod_collection_charge: 0 };
}
// Per-order economics using the rate card.
function orderEcon(o, rc) {
    const st = (o.order_status || '').toLowerCase();
    const isCOD = /cod/i.test(o.payment_type || '');
    const flat = num(rc.flat_service_charge), rtoC = num(rc.rto_charge), codC = num(rc.cod_collection_charge);
    let service = 0, rto = 0, cod = 0, codCollected = 0, lostComp = 0, prepaidValue = 0;
    if (st === 'delivered') { service = flat; if (isCOD) { cod = codC; codCollected = Math.round(num(o.order_value)); } else prepaidValue = Math.round(num(o.order_value)); }
    else if (st === 'rto') { service = flat; rto = rtoC; }
    else if (st === 'lost') { lostComp = Math.round(num(o.order_value)); }   // DocPharma compensates full value; no charges
    return { charges: service + rto + cod, service, rto, cod, codCollected, lostComp, prepaidValue, isCOD, st };
}
// Most-recent scan timestamp — the same "close date" fallback the recon dashboard uses.
const lastScanAt = o => (Array.isArray(o.scans) ? o.scans : []).reduce((m, s) => (s && s.at && (!m || s.at > m)) ? s.at : m, null);
// Which billing month an order's charge/compensation falls in.
// Mirrors recon's closeDate: delivered→delivered_date, rto→rto_at, else→last scan — each falling back to last scan so nothing is orphaned.
function orderMonth(o) {
    const st = (o.order_status || '').toLowerCase(); const last = lastScanAt(o);
    if (st === 'delivered') return istMonth(o.delivered_date || last);
    if (st === 'rto') return istMonth(o.rto_at || last);
    if (st === 'lost') return istMonth(last || o.rto_at || o.delivered_date || o.dispatched_at || o.order_date);
    if (st === 'rejected' || st === 'cancelled') return istMonth(o.order_date || last);   // never dispatched → bucket by order date
    return istMonth(last);
}
// Which month a DocPharma charge invoice belongs to (subject "Mar 2026" → period_from → invoice_date).
function invoiceMonth(inv) {
    let m = String(inv.subject || '').match(/([A-Za-z]{3})[a-z]*\s+(\d{4})/);
    if (m && MON[m[1].toLowerCase()]) return `${m[2]}-${MON[m[1].toLowerCase()]}`;
    if (inv.period_from) return String(inv.period_from).slice(0, 7);
    if (inv.invoice_date) return String(inv.invoice_date).slice(0, 7);
    return 'unknown';
}
const zero = () => ({ delivered: 0, rto: 0, rtoCod: 0, rtoPrepaid: 0, rtoValue: 0, lost: 0, rejected: 0, rejectedValue: 0, codOrders: 0, prepaidOrders: 0, prepaidValue: 0, expService: 0, expRto: 0, expCod: 0, expCharges: 0, codCollected: 0, lostComp: 0, invCharges: 0, invTax: 0, invGrand: 0, invoices: 0, paymentsIn: 0, paymentsOut: 0 });

// GET /api/docpharma-ledger  → monthly ledger + grand totals + invoice/payment lists
router.get('/docpharma-ledger', async (req, res) => {
    try {
        const rc = await rateCard();
        // 1. All DocPharma orders → per-month expected charges + COD collected.
        const byMonth = {};
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.from('docpharma_orders')
                .select('order_status, payment_type, order_value, delivered_date, rto_at, dispatched_at, order_date, scans')
                .in('order_status', ['delivered', 'rto', 'lost', 'rejected', 'cancelled']).range(off, off + 999);
            if (error) throw new Error(error.message);
            (data || []).forEach(o => {
                const e = orderEcon(o, rc);
                const mk = orderMonth(o) || 'unknown';
                const b = byMonth[mk] || (byMonth[mk] = zero());
                const isCOD = /cod/i.test(o.payment_type || '');
                if (e.st === 'delivered') { b.delivered++; if (e.codCollected) b.codOrders++; else { b.prepaidOrders++; b.prepaidValue += e.prepaidValue; } }
                else if (e.st === 'rto') { b.rto++; b.rtoValue += Math.round(num(o.order_value)); if (isCOD) b.rtoCod++; else b.rtoPrepaid++; }
                else if (e.st === 'lost') b.lost++;
                else if (e.st === 'rejected' || e.st === 'cancelled') { b.rejected++; b.rejectedValue += Math.round(num(o.order_value)); }   // rejected + cancelled combined
                b.expService += e.service; b.expRto += e.rto; b.expCod += e.cod; b.expCharges += e.charges; b.codCollected += e.codCollected; b.lostComp += e.lostComp;
            });
            if (!data || data.length < 1000) break;
        }
        // 2. Charge invoices → per-month actuals.
        const { data: charges } = await supabase.from('docpharma_charge_invoices').select('*').order('invoice_date', { ascending: false });
        (charges || []).forEach(iv => {
            const mk = invoiceMonth(iv); iv._month = mk; const b = byMonth[mk] || (byMonth[mk] = zero());
            b.invCharges += num(iv.total_charges); b.invTax += num(iv.tax_amount); b.invGrand += num(iv.grand_total) || (num(iv.total_charges) + num(iv.tax_amount)); b.invoices++;
        });
        // 3. Payments → per-month.
        const { data: payments } = await supabase.from('docpharma_payments').select('*').order('payment_date', { ascending: false });
        (payments || []).forEach(p => {
            const mk = p.period_from ? String(p.period_from).slice(0, 7) : istMonth(p.payment_date) || 'unknown';
            p._month = mk; const b = byMonth[mk] || (byMonth[mk] = zero());
            if ((p.direction || 'received') === 'received') b.paymentsIn += num(p.amount); else b.paymentsOut += num(p.amount);
        });

        // 4. Build monthly rows + grand totals.
        const months = Object.keys(byMonth).filter(m => m !== 'unknown').sort().reverse();   // newest-first for display
        if (byMonth.unknown) months.push('unknown');
        // Per-month base figures (net DocPharma should remit).
        const base = {};
        // Payable we net against receivables = ONLY DocPharma's actual invoiced charges (incl tax). Un-invoiced months are
        // not yet a real liability, so nothing is deducted for them from Net/Outstanding until DocPharma actually bills.
        months.forEach(mk => { const b = byMonth[mk]; const payableActual = b.invGrand; const receivable = b.codCollected + b.lostComp; base[mk] = { payableActual, receivable, remitExpected: receivable - payableActual }; });
        // FIFO settlement: DocPharma remits irregular lump sums, not month-by-month. Pool ALL received payments
        // and allocate them to each month's positive net-owed oldest-first, so we can see what's actually settled.
        const totalReceived = months.reduce((s, mk) => s + (byMonth[mk].paymentsIn - byMonth[mk].paymentsOut), 0);
        const ascMonths = months.filter(m => m !== 'unknown').sort().concat(byMonth.unknown ? ['unknown'] : []);
        const alloc = {}; let pool = totalReceived;
        ascMonths.forEach(mk => { const owed = Math.max(0, base[mk].remitExpected); const a = Math.min(owed, Math.max(0, pool)); alloc[mk] = a; pool -= a; });
        // Settlement frontier (oldest-first): last fully-settled month before the first shortfall.
        let settledThrough = null, unsettledTotal = 0, unsettledMonths = 0, frontierPassed = false;
        for (const mk of ascMonths) {
            const owed = Math.max(0, base[mk].remitExpected); if (owed <= 0) continue;
            const paid = alloc[mk] || 0;
            if (!frontierPassed && paid >= owed - 0.5) settledThrough = mk;
            else { frontierPassed = true; unsettledTotal += owed - paid; unsettledMonths++; }
        }
        const overpaid = Math.max(0, pool);
        const grand = zero();
        const rows = months.map(mk => {
            const b = byMonth[mk];
            Object.keys(grand).forEach(k => grand[k] += b[k]);
            const { payableActual, receivable, remitExpected } = base[mk];
            const owed = Math.max(0, remitExpected);
            const paidNet = alloc[mk] || 0;                            // FIFO-allocated (not the payment's nominal month)
            const settled = owed <= 0 ? 'na' : (paidNet >= owed - 0.5 ? 'settled' : paidNet > 0 ? 'partial' : 'outstanding');
            const totalOrders = b.delivered + b.rto + b.lost + b.rejected;
            return { month: mk, ...b, totalOrders, receivable, payableActual, remitExpected, paidNet, settled, outstanding: remitExpected - paidNet, variance: b.invoices ? b.invCharges - b.expCharges : null };
        });
        const gPayableActual = grand.invGrand;   // only invoiced charges are a real liability
        const gReceivable = grand.codCollected + grand.lostComp;
        const summary = {
            receivable: gReceivable, codCollected: grand.codCollected, codOrders: grand.codOrders,
            prepaidOrders: grand.prepaidOrders, prepaidValue: grand.prepaidValue,
            lostCompensation: grand.lostComp, lostCount: grand.lost,
            payableExpected: grand.expCharges, payableExpectedGst: Math.round(grand.expCharges * 1.18), payableInvoiced: grand.invCharges,
            payableInvGrand: grand.invGrand, invTax: grand.invTax, netExpected: gReceivable - gPayableActual,
            paymentsReceived: grand.paymentsIn - grand.paymentsOut, outstanding: (gReceivable - gPayableActual) - (grand.paymentsIn - grand.paymentsOut),
            expService: grand.expService, expRto: grand.expRto, expCod: grand.expCod,
            serviceOrders: grand.delivered + grand.rto, rtoOrders: grand.rto, deliveredOrders: grand.delivered,
            fifo: { totalReceived, settledThrough, unsettledTotal: Math.round(unsettledTotal), unsettledMonths, overpaid: Math.round(overpaid) },
        };
        res.json({ success: true, rateCard: rc, summary, rows, charges: charges || [], payments: payments || [] });
    } catch (e) { console.error('[DP Ledger]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── Payments CRUD ──
router.get('/docpharma-payments', async (req, res) => {
    try { const { data, error } = await supabase.from('docpharma_payments').select('*').order('payment_date', { ascending: false }).limit(500); if (error) throw new Error(error.message); res.json({ success: true, payments: data || [] }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/docpharma-payments', express.json({ limit: '2mb' }), async (req, res) => {
    try {
        const b = req.body || {};
        const row = { payment_date: b.payment_date || null, direction: b.direction || 'received', amount: num(b.amount), reference: clean(b.reference) || null, method: clean(b.method) || null, period_from: b.period_from || null, period_to: b.period_to || null, notes: clean(b.notes) || null };
        if (b.id) { const { error } = await supabase.from('docpharma_payments').update(row).eq('id', b.id); if (error) throw new Error(error.message); }
        else { const { error } = await supabase.from('docpharma_payments').insert(row); if (error) throw new Error(error.message); }
        res.json({ success: true });
    } catch (e) { console.error('[DP Payments save]', e.message); res.status(500).json({ success: false, error: e.message }); }
});
router.delete('/docpharma-payments/:id', async (req, res) => {
    try { const { error } = await supabase.from('docpharma_payments').delete().eq('id', req.params.id); if (error) throw new Error(error.message); res.json({ success: true }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/docpharma-ledger-pdf → real downloadable PDF of the visible ledger (branded, The Element logo).
router.post('/docpharma-ledger-pdf', express.json({ limit: '4mb' }), (req, res) => {
    try {
        const { period = 'All periods', totals = {}, rows = [] } = req.body || {};
        const inr = v => 'Rs ' + Math.round(Number(v) || 0).toLocaleString('en-IN');
        const n = v => Math.round(Number(v) || 0).toLocaleString('en-IN');   // plain number for table cells (no "Rs " → no wrapping)
        const stLabel = { settled: 'Settled', partial: 'Partial', outstanding: 'Pending', na: '-' };
        const M = 28, R = 567;                                          // A4 margins (595.28 wide)
        const doc = new PDFDocument({ margin: M, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=docpharma-ledger.pdf');
        doc.pipe(res);

        const drawHeader = () => {
            const logo = ['../static/assets/te-logo.png', '../static/assets/ecom-logo.png'].map(p => path.join(__dirname, p)).find(fs.existsSync);
            const titleX = logo ? 90 : M;
            if (logo) doc.image(logo, M, 22, { width: 54 });          // te-logo is ~2:1, so 54w ≈ 27h
            doc.font('Helvetica-Bold').fontSize(16).fillColor([34, 44, 67]).text('DocPharma Ledger', titleX, 26);
            doc.font('Helvetica').fontSize(9).fillColor([120, 120, 120]).text('The Element  ·  Shifupro Technologies Pvt Ltd', titleX, 46);
            doc.font('Helvetica').fontSize(9).fillColor([120, 120, 120]).text(`Receivable vs Payable  ·  ${period}`, M, 26, { align: 'right', width: R - M });
            doc.text(`Generated ${moment().tz('Asia/Kolkata').format('DD MMM YYYY, hh:mm A')}`, M, 40, { align: 'right', width: R - M });
            doc.save().moveTo(M, 66).lineTo(R, 66).strokeColor([224, 224, 224]).stroke().restore();
        };

        // Column layout (13 cols, sum = 498 ≤ usable 539). Short single-line headers; amounts are plain numbers (Rs noted below).
        const cols = [['Month', 58, 'left'], ['Tot', 26, 'right'], ['Del', 26, 'right'], ['RTO', 22, 'right'], ['Rej', 22, 'right'], ['Exp chg', 40, 'right'], ['Invoiced', 46, 'right'], ['COD coll', 48, 'right'], ['Lost', 32, 'right'], ['Net rem', 42, 'right'], ['Paid', 42, 'right'], ['Status', 40, 'center'], ['Outstanding', 54, 'right']];
        const STATUS_COL = 11;
        const rowH = 17;
        const drawTableHeader = () => {
            const y = doc.y;
            doc.rect(M, y, R - M, rowH).fill([67, 56, 202]);
            doc.font('Helvetica-Bold').fontSize(6).fillColor('white');
            let x = M; cols.forEach(c => { doc.text(c[0].toUpperCase(), x + 3, y + 6, { width: c[1] - 6, align: c[2], lineBreak: false }); x += c[1]; });
            doc.y = y + rowH; doc.fillColor('black');
        };
        const drawRow = (cells, opts = {}) => {
            if (doc.y + rowH > doc.page.height - 52) { doc.addPage(); drawHeader(); doc.y = 80; drawTableHeader(); }
            const y = doc.y;
            if (opts.total) doc.rect(M, y, R - M, rowH).fill([234, 236, 245]);
            else if (opts.fill) doc.rect(M, y, R - M, rowH).fill([248, 249, 252]);
            doc.font(opts.total ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor(opts.total ? [20, 20, 20] : [55, 55, 55]);
            let x = M; cols.forEach((c, i) => {
                const cell = cells[i] || '';
                if (i === STATUS_COL && cell.color) doc.fillColor(cell.color);
                doc.text(cell.t != null ? cell.t : cell, x + 3, y + 5.5, { width: c[1] - 6, align: c[2], lineBreak: false });
                doc.fillColor(opts.total ? [20, 20, 20] : [55, 55, 55]); x += c[1];
            });
            doc.save().moveTo(M, y + rowH).lineTo(R, y + rowH).strokeColor([234, 236, 240]).lineWidth(0.5).stroke().restore();
            doc.y = y + rowH;
        };

        drawHeader();
        doc.y = 80;
        // KPI band
        const kpis = [['Receivable', totals.receivable, [16, 122, 87]], ['Payable (invoiced)', totals.payableInvoiced, [190, 40, 40]], ['Net should remit', totals.net, [67, 56, 202]], ['Payments', totals.paid, [16, 122, 87]], ['Outstanding', totals.outstanding, [217, 119, 6]]];
        const kw = (R - M) / kpis.length, ky = doc.y;
        doc.roundedRect(M, ky, R - M, 52, 6).fill([247, 248, 251]);
        kpis.forEach((k, i) => {
            const x = M + kw * i;
            if (i) doc.save().moveTo(x, ky + 10).lineTo(x, ky + 42).strokeColor([224, 226, 232]).lineWidth(0.5).stroke().restore();
            doc.font('Helvetica').fontSize(7).fillColor([120, 120, 128]).text(k[0].toUpperCase(), x + 10, ky + 11, { width: kw - 16 });
            doc.font('Helvetica-Bold').fontSize(12).fillColor(k[2]).text(inr(k[1]), x + 10, ky + 26, { width: kw - 16 });
        });
        doc.y = ky + 66;

        drawTableHeader();
        const t = { total: 0, delivered: 0, rto: 0, rejected: 0, expCharges: 0, inv: 0, codCollected: 0, lostComp: 0, remitExpected: 0, paidNet: 0, outstanding: 0 };
        rows.forEach((m, idx) => {
            ['total', 'delivered', 'rto', 'rejected', 'expCharges', 'codCollected', 'lostComp', 'remitExpected', 'paidNet', 'outstanding'].forEach(k => t[k] += Number(m[k]) || 0);
            t.inv += m.invoiced != null ? Number(m.invoiced) || 0 : 0;
            const stColor = { settled: [16, 122, 87], partial: [180, 120, 0], outstanding: [190, 40, 40] }[m.settled] || [150, 150, 150];
            drawRow([m.month, String(m.total || 0), String(m.delivered), String(m.rto), String(m.rejected || 0), n(m.expCharges), m.invoiced != null ? n(m.invoiced) : '-', n(m.codCollected), m.lostComp ? n(m.lostComp) : '-', n(m.remitExpected), m.paidNet ? n(m.paidNet) : '-', { t: stLabel[m.settled] || '-', color: stColor }, n(m.outstanding)], { fill: idx % 2 === 1 });
        });
        drawRow(['TOTAL', String(t.total), String(t.delivered), String(t.rto), String(t.rejected), n(t.expCharges), n(t.inv), n(t.codCollected), n(t.lostComp), n(t.remitExpected), n(t.paidNet), { t: '', color: [20, 20, 20] }, n(t.outstanding)], { total: true });

        // Footnote (ASCII hyphen — Helvetica has no minus/box glyph).
        if (doc.y + 30 > doc.page.height - 44) { doc.addPage(); drawHeader(); doc.y = 80; }
        doc.y += 10;
        doc.font('Helvetica').fontSize(7.5).fillColor([150, 150, 150]).text("All amounts in Rs. Payable counts only DocPharma's actual invoiced charges (incl tax). Rej = rejected + cancelled (never dispatched). Outstanding = Receivable - invoiced payable - payments received.", M, doc.y, { width: R - M });

        // Footer — margins.bottom=0 so absolute-positioned text can't spill onto a new page.
        const range = doc.bufferedPageRange();
        for (let i = 0; i < range.count; i++) {
            doc.switchToPage(range.start + i);
            doc.page.margins.bottom = 0;
            const fy = doc.page.height - 26;
            doc.save().moveTo(M, fy - 7).lineTo(R, fy - 7).strokeColor([234, 236, 240]).lineWidth(0.5).stroke().restore();
            doc.font('Helvetica').fontSize(7.5).fillColor([160, 160, 160]);
            doc.text('The Element  ·  DocPharma settlement statement', M, fy, { width: (R - M) / 2, align: 'left', lineBreak: false });
            doc.text(`Page ${i + 1} of ${range.count}`, M + (R - M) / 2, fy, { width: (R - M) / 2, align: 'right', lineBreak: false });
        }
        doc.end();
    } catch (e) { console.error('[DP Ledger PDF]', e); if (!res.headersSent) res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
