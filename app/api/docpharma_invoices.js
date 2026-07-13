// DocPharma ledger — Invoices module.
//  • Goods-OUT invoices (The Element → DocPharma): stock we ship. Has product NAME + HSN + qty + rate (no SKU).
//  • Charge invoices (DocPharma → The Element): Service / RTO / COD-fee lines (qty × rate), billed per period.
// Upload: Excel/CSV (structured, reliable) or PDF (best-effort text extract → user reviews before save). Manual entry too.
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const ExcelJS = require('exceljs');
const csv = require('csvtojson');
// pdf-parse v2 exports a { PDFParse } class; older v1 exported a callable. Support both.
let pdfParse = null, PDFParseCls = null;
try { const _pp = require('pdf-parse'); if (typeof _pp === 'function') pdfParse = _pp; else if (_pp && _pp.PDFParse) PDFParseCls = _pp.PDFParse; } catch (_e) { /* optional */ }

const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ── Date parsing: "22-Jun-2026", "03/04/2026", "2026-06-22" → 'YYYY-MM-DD' ──
const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function parseInvDate(s) {
    s = clean(s); if (!s) return null;
    let m = s.match(/(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})/);              // 22-Jun-2026
    if (m) { const mm = MON[m[2].toLowerCase()]; return mm ? `${m[3]}-${mm}-${m[1].padStart(2, '0')}` : null; }
    m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);                          // 03/04/2026 (DD/MM/YYYY)
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/(\d{4})[-\/](\d{2})[-\/](\d{2})/);                                // 2026-06-22
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
}

// ─────────────────────────── PDF PARSERS (best-effort) ───────────────────────────
async function pdfText(buf) {
    if (pdfParse) { const r = await pdfParse(buf); return r.text || ''; }             // v1 callable
    if (PDFParseCls) { const p = new PDFParseCls({ data: buf }); try { const r = await p.getText(); return r.text || ''; } finally { try { await p.destroy(); } catch (_e) { } } }  // v2 class
    throw new Error('pdf-parse not available');
}

// DocPharma charge invoice → { invoice_no, invoice_date, subject, lines[], totals }
function parseChargePdf(text) {
    const inv = { invoice_no: null, invoice_date: null, due_date: null, subject: null, service_qty: 0, service_rate: 0, service_total: 0, rto_qty: 0, rto_rate: 0, rto_total: 0, cod_qty: 0, cod_rate: 0, cod_fee_total: 0, tax_amount: 0, total_charges: 0, grand_total: 0 };
    let m;
    if ((m = text.match(/#\s*:?\s*(INV[-\/A-Za-z0-9]+)/i))) inv.invoice_no = clean(m[1]);
    if ((m = text.match(/Invoice Date\s*:?\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{4})/i))) inv.invoice_date = parseInvDate(m[1]);
    if ((m = text.match(/Due Date\s*:?\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{4})/i))) inv.due_date = parseInvDate(m[1]);
    if ((m = text.match(/Subject\s*:?\s*([^\n]+)/i))) inv.subject = clean(m[1]);
    else if ((m = text.match(/([A-Za-z]{3,}\s+\d{4})\s+Service Charge/i))) inv.subject = clean(m[0]);
    // Service (non-RTO) line: "Service Charges 996729 997.00 65.00 18% 11,664.90 64,805.00"
    if ((m = text.match(/Service Charges(?!\s*RTO)[^\d]*\d{6}\s+([\d.,]+)\s+([\d.,]+)\s+\d+%\s+([\d.,]+)\s+([\d.,]+)/i))) { inv.service_qty = num(m[1]); inv.service_rate = num(m[2]); inv.tax_amount += num(m[3]); inv.service_total = num(m[4]); }
    // RTO line
    if ((m = text.match(/RTO[^\d]*\d{6}\s+([\d.,]+)\s+([\d.,]+)\s+\d+%\s+([\d.,]+)\s+([\d.,]+)/i))) { inv.rto_qty = num(m[1]); inv.rto_rate = num(m[2]); inv.tax_amount += num(m[3]); inv.rto_total = num(m[4]); }
    // COD line
    if ((m = text.match(/COD[^\d]*\d{6}\s+([\d.,]+)\s+([\d.,]+)\s+\d+%\s+([\d.,]+)\s+([\d.,]+)/i))) { inv.cod_qty = num(m[1]); inv.cod_rate = num(m[2]); inv.tax_amount += num(m[3]); inv.cod_fee_total = num(m[4]); }
    if ((m = text.match(/Sub[\s-]*Total\s*[₹Rs.\s]*([\d.,]+)/i))) inv.total_charges = num(m[1]);
    else inv.total_charges = inv.service_total + inv.rto_total + inv.cod_fee_total;
    // Grand total: prefer "Balance Due", else a "Total" that is NOT "Sub Total".
    if ((m = text.match(/Balance Due\s*[₹Rs.\s]*([\d,]+\.\d{2})/i)) || (m = text.match(/(?<!Sub[\s-])(?:Grand\s*)?Total\s*[₹Rs.\s]*([\d,]+\.\d{2})/i))) inv.grand_total = num(m[1]);
    else inv.grand_total = inv.total_charges + inv.tax_amount;
    return inv;
}

// The Element goods invoice → { invoice_no, invoice_date, po_number, items[], totals }
function parseGoodsPdf(text) {
    const inv = { invoice_no: null, invoice_date: null, po_number: null, total_qty: 0, taxable_amount: 0, tax_amount: 0, total_value: 0, items: [] };
    let m;
    if ((m = text.match(/INVOICE\s*NO\s*\n?\s*([A-Z0-9\/\-]+)/i)) || (m = text.match(/(TE\/\d{4}-\d{2}\/\d+)/i))) inv.invoice_no = clean(m[1]);
    if ((m = text.match(/DATE\s*\n?\s*(\d{1,2}[-\s][A-Za-z]{3}[a-z]*[-\s]\d{4})/i))) inv.invoice_date = parseInvDate(m[1]);
    if ((m = text.match(/PO\s*Number\s*#?\s*([A-Za-z0-9\-]+)/i))) inv.po_number = clean(m[1]);
    if ((m = text.match(/Total\s*Quan\w*\s*([\d,]+)/i))) inv.total_qty = num(m[1]);
    if ((m = text.match(/Taxable Amount\s*([\d.,]+)/i))) inv.taxable_amount = num(m[1]);
    if ((m = text.match(/(?:Total Tax|Add:\s*IGST|IGST)\s*([\d.,]+)/i))) inv.tax_amount = num(m[1]);
    if ((m = text.match(/GRAND TOTAL\s*[Rs.₹\s]*([\d.,]+)/i))) inv.total_value = num(m[1]);

    // Line items — each block is: wrapped product name → "SKU: <code>" → a numbers row (HSN qty rate [disc tax%] taxable taxAmt total).
    const isNumTok = t => /^[\d.,]+$/.test(t) && /\d/.test(t);
    const lines = text.split('\n').map(s => s.replace(/ /g, ' ').trim());
    let started = false, nameParts = [], sku = null;
    for (let ln of lines) {
        if (!ln) continue;
        if (/PARTICULARS/i.test(ln) && /HSN/i.test(ln)) { started = true; nameParts = []; sku = null; continue; }   // items begin after the table header
        if (!started) continue;
        if (/^(Total\s*Quan|Taxable Amount|Add:\s*IGST|Total Tax|GRAND TOTAL|In Words|BANK DETAILS|Authorised)/i.test(ln)) break;   // items end
        const ms = ln.match(/SKU:?\s*([A-Za-z0-9_\-\/.]+)/i);
        if (ms) { sku = clean(ms[1]); ln = ln.replace(/SKU:?\s*[A-Za-z0-9_\-\/.]+/i, '').trim(); if (!ln) continue; }
        const toks = ln.split(/\s+/);
        const hsnIdx = toks.findIndex(t => /^\d{6,8}$/.test(t));
        const L = toks.length;
        const isRow = hsnIdx >= 0 && L - hsnIdx >= 6 && isNumTok(toks[hsnIdx + 1]) && isNumTok(toks[hsnIdx + 2]) && isNumTok(toks[L - 1]) && isNumTok(toks[L - 2]) && isNumTok(toks[L - 3]);
        if (isRow) {
            if (hsnIdx > 0) nameParts.push(toks.slice(0, hsnIdx).join(' '));                                          // name text sharing the row line
            const taxTok = toks.slice(hsnIdx).find(t => /^\d+(\.\d+)?%$/.test(t));
            inv.items.push({
                hsn: toks[hsnIdx], qty: num(toks[hsnIdx + 1]), rate: num(toks[hsnIdx + 2]),
                tax_pct: taxTok ? num(taxTok) : null, taxable: num(toks[L - 3]), tax_amt: num(toks[L - 2]), amount: num(toks[L - 1]),
                name: nameParts.join(' ').replace(/\s+/g, ' ').trim() || null, sku: sku || null,
            });
            nameParts = []; sku = null;
        } else {
            nameParts.push(ln);                                                                                       // wrapped product-name line
        }
    }
    // Fallback: numbers-only regex if the block parse found nothing.
    if (!inv.items.length) {
        const rowRe = /(\d{6,8})\s+([\d,]+)\s+([\d.,]+)\s+-?\s*(\d+)%\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/g; let r;
        while ((r = rowRe.exec(text))) inv.items.push({ hsn: r[1], qty: num(r[2]), rate: num(r[3]), tax_pct: num(r[4]), taxable: num(r[5]), tax_amt: num(r[6]), amount: num(r[7]), name: null, sku: null });
    }
    if (!inv.total_qty && inv.items.length) inv.total_qty = inv.items.reduce((s, it) => s + (it.qty || 0), 0);
    return inv;
}

// ─────────────────────────── EXCEL / CSV PARSERS ───────────────────────────
async function rowsFromExcel(buf) {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ws = wb.worksheets[0]; const rows = [];
    ws.eachRow(r => rows.push(r.values.slice(1).map(c => (c && c.text != null) ? c.text : c)));
    return rows;
}
async function rowsFromCsv(text) { const arr = await csv({ output: 'csv' }).fromString(text); return arr; }

// Map a header→index and pull rows for goods items.
function goodsItemsFromRows(rows) {
    if (!rows.length) return [];
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const header = rows[0].map(norm);
    const col = (...a) => { for (const x of a) { const i = header.indexOf(x); if (i >= 0) return i; } return -1; };
    const iSku = col('sku', 'skucode'), iName = col('name', 'particulars', 'product', 'description', 'item'),
        iHsn = col('hsn', 'hsnsac'), iQty = col('qty', 'quantity'), iRate = col('rate', 'price'),
        iAmt = col('total', 'amount', 'value'), iBatch = col('batch');
    const out = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; if (!r || !r.some(c => clean(c))) continue;
        const name = iName >= 0 ? clean(r[iName]) : ''; const qty = iQty >= 0 ? num(r[iQty]) : 0;
        if (!name && !qty) continue;
        out.push({ sku: iSku >= 0 ? clean(r[iSku]) || null : null, name, hsn: iHsn >= 0 ? clean(r[iHsn]) || null : null, qty, rate: iRate >= 0 ? num(r[iRate]) : 0, amount: iAmt >= 0 ? num(r[iAmt]) : 0, batch: iBatch >= 0 ? clean(r[iBatch]) || null : null });
    }
    return out;
}

// POST /parse?type=goods|charge  — body is the raw file; returns extracted JSON for review (NOT saved).
router.post('/docpharma-invoices/parse', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
    try {
        const type = (req.query.type || 'goods').toLowerCase();
        const fname = String(req.headers['x-filename'] || '').toLowerCase();
        const buf = req.body; if (!buf || !buf.length) return res.status(400).json({ success: false, error: 'empty file' });
        const isPdf = fname.endsWith('.pdf') || (buf[0] === 0x25 && buf[1] === 0x50); // %P
        const isXlsx = fname.endsWith('.xlsx') || fname.endsWith('.xls') || (buf[0] === 0x50 && buf[1] === 0x4b); // PK zip
        let extracted;
        if (isPdf) {
            const text = await pdfText(buf);
            extracted = type === 'charge' ? parseChargePdf(text) : parseGoodsPdf(text);
            extracted._rawTextSample = text.slice(0, 1200);   // helps tune the parser if fields are off
        } else {
            const rows = isXlsx ? await rowsFromExcel(buf) : await rowsFromCsv(buf.toString('utf8'));
            if (type === 'charge') return res.status(400).json({ success: false, error: 'charge invoices: use PDF or manual entry' });
            extracted = { invoice_no: null, invoice_date: null, po_number: null, items: goodsItemsFromRows(rows) };
        }
        res.json({ success: true, type, extracted });
    } catch (e) { console.error('[DP Invoices parse]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ─────────────────────────── GOODS invoices CRUD ───────────────────────────
router.get('/docpharma-invoices/goods', async (req, res) => {
    try {
        const { data: invs, error } = await supabase.from('docpharma_goods_invoices').select('*').order('invoice_date', { ascending: false }).limit(500);
        if (error) throw new Error(error.message);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, invoices: invs || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.get('/docpharma-invoices/goods/:id', async (req, res) => {
    try {
        const { data: inv } = await supabase.from('docpharma_goods_invoices').select('*').eq('id', req.params.id).maybeSingle();
        const { data: items } = await supabase.from('docpharma_goods_invoice_items').select('*').eq('invoice_id', req.params.id).order('id');
        res.json({ success: true, invoice: inv, items: items || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/docpharma-invoices/goods', express.json({ limit: '5mb' }), async (req, res) => {
    try {
        const b = req.body || {}; const items = Array.isArray(b.items) ? b.items : [];
        const total_qty = items.reduce((s, it) => s + (num(it.qty)), 0);
        const total_value = num(b.total_value) || items.reduce((s, it) => s + num(it.amount), 0);
        const row = { invoice_no: clean(b.invoice_no) || null, invoice_date: b.invoice_date || null, po_number: clean(b.po_number) || null, taxable_amount: num(b.taxable_amount), tax_amount: num(b.tax_amount), total_qty, total_value, notes: clean(b.notes) || null, source: b.source || 'manual', updated_at: new Date().toISOString() };
        const { data: inv, error } = await supabase.from('docpharma_goods_invoices').upsert(row, { onConflict: 'invoice_no' }).select().single();
        if (error) throw new Error(error.message);
        await supabase.from('docpharma_goods_invoice_items').delete().eq('invoice_id', inv.id);
        if (items.length) await supabase.from('docpharma_goods_invoice_items').insert(items.map(it => ({ invoice_id: inv.id, sku: clean(it.sku) || null, name: clean(it.name) || null, hsn: clean(it.hsn) || null, qty: num(it.qty), rate: num(it.rate), amount: num(it.amount), tax_pct: it.tax_pct != null ? num(it.tax_pct) : null, taxable: it.taxable != null ? num(it.taxable) : null, tax_amt: it.tax_amt != null ? num(it.tax_amt) : null, batch: clean(it.batch) || null })));
        res.json({ success: true, id: inv.id });
    } catch (e) { console.error('[DP Invoices goods save]', e.message); res.status(500).json({ success: false, error: e.message }); }
});
router.delete('/docpharma-invoices/goods/:id', async (req, res) => {
    try { const { error } = await supabase.from('docpharma_goods_invoices').delete().eq('id', req.params.id); if (error) throw new Error(error.message); res.json({ success: true }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─────────────────────────── CHARGE invoices CRUD ───────────────────────────
router.get('/docpharma-invoices/charge', async (req, res) => {
    try {
        const { data, error } = await supabase.from('docpharma_charge_invoices').select('*').order('invoice_date', { ascending: false }).limit(500);
        if (error) throw new Error(error.message);
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, invoices: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/docpharma-invoices/charge', express.json({ limit: '5mb' }), async (req, res) => {
    try {
        const b = req.body || {};
        const service_total = num(b.service_total), rto_total = num(b.rto_total), cod_fee_total = num(b.cod_fee_total), other_total = num(b.other_total);
        const total_charges = num(b.total_charges) || (service_total + rto_total + cod_fee_total + other_total);
        const row = {
            invoice_no: clean(b.invoice_no) || null, invoice_date: b.invoice_date || null, due_date: b.due_date || null,
            period_from: b.period_from || null, period_to: b.period_to || null, subject: clean(b.subject) || null,
            service_qty: num(b.service_qty), service_rate: num(b.service_rate), service_total,
            rto_qty: num(b.rto_qty), rto_rate: num(b.rto_rate), rto_total,
            cod_qty: num(b.cod_qty), cod_rate: num(b.cod_rate), cod_fee_total, other_total, total_charges,
            tax_amount: num(b.tax_amount), grand_total: num(b.grand_total) || (total_charges + num(b.tax_amount)),
            cod_collected: num(b.cod_collected), cod_remitted: num(b.cod_remitted),
            notes: clean(b.notes) || null, source: b.source || 'manual', updated_at: new Date().toISOString(),
        };
        const { data: inv, error } = await supabase.from('docpharma_charge_invoices').upsert(row, { onConflict: 'invoice_no' }).select().single();
        if (error) throw new Error(error.message);
        res.json({ success: true, id: inv.id });
    } catch (e) { console.error('[DP Invoices charge save]', e.message); res.status(500).json({ success: false, error: e.message }); }
});
router.delete('/docpharma-invoices/charge/:id', async (req, res) => {
    try { const { error } = await supabase.from('docpharma_charge_invoices').delete().eq('id', req.params.id); if (error) throw new Error(error.message); res.json({ success: true }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
