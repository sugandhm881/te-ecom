// PO Approvals (Inventory → PO Approvals) — maker-checker for purchase orders, 2026-08-27.
//
// A purchase order no longer goes straight to EasyEcom: the New PO form SUBMITS it here
// (status 'pending'), approvers are emailed, and only an approver's Approve fires the actual
// EasyEcom CreatePurchaseOrder — through performPoCreate, the SAME implementation the direct route
// uses, so validation, the vendor_id trap and the status read-back can never drift.
//
// status: pending -> created  (approved + EasyEcom write succeeded; easyecom_po_id recorded)
//                 -> rejected (with note)
//                 -> failed   (approved but the EasyEcom write failed — the request STAYS actionable,
//                              Approve retries it; a half-done approval must never vanish)
//
// Permissions: SUBMIT rides purchase-orders-write ("may draft a PO"); the dashboard + decisions ride
// the new `po-approvals` view permission (admins always). A non-admin approver cannot approve their
// OWN submission — maker and checker must be different people; admins may (they could use the direct
// route anyway).
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../supabase');
const { performPoCreate, fetchProductMaster } = require('./purchase_orders');
const { rawVendors } = require('./grn');

// Our company block, as EasyEcom's own PO document prints it (taken from a real EE PO PDF).
const COMPANY = {
    name: 'SHIFUPRO TECHNOLOGIES PVT. LTD.',
    gst: '06ABOCS1954R1ZG',
    addr: ['Shop 19, AIPL Boulevard, Sector 70A', 'Gurgaon ,Haryana - 122101', 'India'],
    phone: '9560307930',
    state: 'Haryana',
};

const isAdminReq = req => { const u = req.user || {};
    return (u.role === undefined && u.permissions === undefined) || u.role === 'admin'
        || (Array.isArray(u.permissions) && u.permissions.includes('*')); };
const canApprove = req => { const u = req.user || {};
    if (isAdminReq(req)) return true;
    return Array.isArray(u.permissions) && u.permissions.includes('po-approvals'); };
const canSubmit = req => { const u = req.user || {};
    if (isAdminReq(req)) return true;
    return Array.isArray(u.permissions) && u.permissions.includes('purchase-orders-write'); };

const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());

// ── Notify approvers — IN-APP ONLY ───────────────────────────────────────────────────────────────
// ⚠️ EMAIL NOTIFICATION WAS REMOVED THE DAY IT SHIPPED (user: "this is disaster — i want they
// received notification on ecom, not anywhere else"). It had also leaked: the shared sendMail
// helper AUTO-FILLS THE CONFIGURED REPORT CC LIST when no `cc` is passed, so the "approvers-only"
// mail went to the whole report audience. Lesson for every future sendMail call: pass `cc: []`
// explicitly unless the report CC list is genuinely intended.
// The in-app channel: approvers' dashboards poll GET /po-approvals/pending-count (below) — a badge
// on the PO Approvals nav item + a toast when the count rises. Nothing leaves Pravidhi.
router.get('/po-approvals/pending-count', async (req, res) => {
    try {
        const { data, error } = await supabase.from('po_approvals_ecom')
            .select('total_value').in('status', ['pending', 'failed']);
        if (error) throw new Error(error.message);
        res.json({ success: true, count: (data || []).length,
            value: Math.round((data || []).reduce((a, r) => a + (Number(r.total_value) || 0), 0) * 100) / 100 });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── SUBMIT ───────────────────────────────────────────────────────────────────────────────────────
// POST /api/po-approvals/submit — body is the exact CreatePurchaseOrder body the form used to send
// to /purchase-orders/create, plus vendorName for the queue display. Validated NOW so a broken cart
// never sits in the queue looking approvable.
router.post('/po-approvals/submit', async (req, res) => {
    if (!canSubmit(req)) return res.status(403).json({ success: false, error: 'You do not have permission to draft purchase orders.' });
    try {
        const b = req.body || {};
        const items = Array.isArray(b.items) ? b.items : [];
        const errs = [];
        if (!parseInt(b.vendorId, 10) && !String(b.vendorCode || '').trim()) errs.push('a supplier is required');
        if (!String(b.referenceCode || '').trim()) errs.push('referenceCode is required');
        if (!isoDate(b.expDeliveryDate)) errs.push('expDeliveryDate must be YYYY-MM-DD');
        if (!items.length) errs.push('at least one line item is required');
        items.forEach((it, i) => {
            if (!String(it.sku || '').trim()) errs.push(`item ${i + 1}: sku is required`);
            if (!(Number(it.quantity) > 0)) errs.push(`item ${i + 1}: quantity must be greater than 0`);
            if (!(Number(it.unitPrice) >= 0)) errs.push(`item ${i + 1}: unitPrice must be 0 or more`);
        });
        if (errs.length) return res.status(400).json({ success: false, error: errs.join(' · '), errors: errs });

        const u = req.user || {};
        const totalValue = Math.round(items.reduce((a, i) => a + num(i.quantity) * num(i.unitPrice), 0) * 100) / 100;
        const row = {
            status: 'pending',
            requested_by: u.sub || 'unknown',
            requested_by_name: u.name || null,
            payload: b,
            vendor_name: String(b.vendorName || '').trim() || null,
            ref_code: String(b.referenceCode).trim(),
            total_value: totalValue,
            total_qty: items.reduce((a, i) => a + num(i.quantity), 0),
            line_count: items.length,
        };
        const { data, error } = await supabase.from('po_approvals_ecom').insert(row).select().single();
        if (error) throw new Error(error.message);
        console.log(`[PO approvals] request ${data.id} submitted · ${row.vendor_name} · ₹${totalValue} · by ${row.requested_by}`);
        // Approvers learn of it IN-APP (badge + toast via /pending-count) — no email, by request.
        res.json({ success: true, id: data.id, message: 'Sent for approval.' });
    } catch (e) {
        console.error('[PO approvals submit]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── LIST ─────────────────────────────────────────────────────────────────────────────────────────
// GET /api/po-approvals — pending queue (all of it) + recent history. Approver-only (server gate).
router.get('/po-approvals', async (req, res) => {
    try {
        const [{ data: pending, error: e1 }, { data: recent, error: e2 }] = await Promise.all([
            supabase.from('po_approvals_ecom').select('*').in('status', ['pending', 'failed']).order('requested_at', { ascending: true }),
            supabase.from('po_approvals_ecom').select('*').in('status', ['created', 'rejected']).order('decided_at', { ascending: false }).limit(50),
        ]);
        if (e1 || e2) throw new Error((e1 || e2).message);
        // decided_by is stored as the login email; the display name lives on app_users_ecom. Joined
        // here so the history shows a PERSON, not an email local-part ("sugandhm881", user-reported)
        // — and old rows decided before names were joined get theirs too.
        const names = {};
        try {
            const { data: us } = await supabase.from('app_users_ecom').select('email, name');
            (us || []).forEach(u => { if (u.email && u.name) names[u.email] = u.name; });
        } catch (_) {}
        const withNames = r => ({ ...r,
            decided_by_name: names[r.decided_by] || null,
            requested_by_name: r.requested_by_name || names[r.requested_by] || null });
        res.json({ success: true, me: (req.user || {}).sub || null, isAdmin: isAdminReq(req),
            pending: (pending || []).map(withNames), recent: (recent || []).map(withNames) });
    } catch (e) {
        console.error('[PO approvals list]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── DECIDE ───────────────────────────────────────────────────────────────────────────────────────
async function loadRequest(id) {
    const { data, error } = await supabase.from('po_approvals_ecom').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
}

// POST /api/po-approvals/:id/approve — fires the REAL EasyEcom create. On failure the request moves
// to 'failed' (not back to pending): the error is recorded and Approve acts as Retry.
router.post('/po-approvals/:id/approve', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const row = await loadRequest(id);
        if (!row) return res.status(404).json({ success: false, error: `Request ${id} not found` });
        if (!['pending', 'failed'].includes(row.status)) return res.status(400).json({ success: false, error: `Request ${id} is already ${row.status}` });
        const u = req.user || {};
        // Maker-checker: the requester cannot approve their own PO unless they are an admin.
        if (!isAdminReq(req) && row.requested_by === u.sub) {
            return res.status(403).json({ success: false, error: 'You submitted this PO — a different approver has to release it.' });
        }
        const out = await performPoCreate(row.payload, u.sub);
        const ok = out.http === 200 && out.body && out.body.success;
        await supabase.from('po_approvals_ecom').update(ok ? {
            status: 'created', decided_by: u.sub || 'unknown', decided_at: new Date().toISOString(),
            decision_note: String((req.body || {}).note || '').trim() || null,
            easyecom_po_id: out.body.poId || null, easyecom_status: out.body.statusLabel || null, create_error: null,
        } : {
            status: 'failed', decided_by: u.sub || 'unknown', decided_at: new Date().toISOString(),
            create_error: (out.body && out.body.error) || `HTTP ${out.http}`,
        }).eq('id', id);
        console.log(`[PO approvals] request ${id} ${ok ? `approved → EasyEcom PO ${out.body.poId}` : `EE create FAILED: ${(out.body && out.body.error) || out.http}`} · by ${u.sub}`);
        if (ok) return res.json({ success: true, id, poId: out.body.poId, statusLabel: out.body.statusLabel, warning: out.body.warning || null });
        res.status(502).json({ success: false, id, error: (out.body && out.body.error) || `create failed (HTTP ${out.http})`,
            message: 'Approval recorded but the PO could not be created — fix the cause and press Approve again to retry.' });
    } catch (e) {
        console.error('[PO approvals approve]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/po-approvals/:id/reject   { note }
router.post('/po-approvals/:id/reject', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const row = await loadRequest(id);
        if (!row) return res.status(404).json({ success: false, error: `Request ${id} not found` });
        if (!['pending', 'failed'].includes(row.status)) return res.status(400).json({ success: false, error: `Request ${id} is already ${row.status}` });
        const u = req.user || {};
        await supabase.from('po_approvals_ecom').update({
            status: 'rejected', decided_by: u.sub || 'unknown', decided_at: new Date().toISOString(),
            decision_note: String((req.body || {}).note || '').trim() || null,
        }).eq('id', id);
        console.log(`[PO approvals] request ${id} rejected · by ${u.sub}`);
        res.json({ success: true, id });
    } catch (e) {
        console.error('[PO approvals reject]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── DRAFT PO DOCUMENT (PDF) ──────────────────────────────────────────────────────────────────────
// GET /api/po-approvals/:id/pdf — EASYECOM'S OWN PO LAYOUT, reproduced from a real EE document
// (PO-2177045.pdf, user-supplied 2026-08-27): bordered sheet, GST header, vendor/meta blocks,
// Billing/Shipping boxes, item grid WITH PRODUCT IMAGES, Item Total / Tax / Grand Total, value in
// words (their exact quirky phrasing — "twenty thousands ... point three eight Paise"), signatory.
// The PO number cell carries OUR reference code — the EasyEcom id does not exist until approval.
// ⚠️ Helvetica has NO ₹ GLYPH — the first render printed "¹101.1". A system font that carries
// U+20B9 is registered when one exists (Arial Bold on Windows, DejaVu on the Ubuntu VPS); with
// neither, amounts degrade to "Rs " rather than a wrong character.
const RUPEE_FONT = ['C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']
    .find(p => { try { return require('fs').existsSync(p); } catch (_) { return false; } }) || null;
const rupeeText = s => RUPEE_FONT ? s : String(s).replace(/₹/g, 'Rs ');

const _imgCache = new Map();   // product-image bytes, per URL, per process
async function fetchImage(url) {
    if (!url) return null;
    if (_imgCache.has(url)) return _imgCache.get(url);
    let buf = null;
    try {
        const r = await axios.get(url, { timeout: 5000, responseType: 'arraybuffer', validateStatus: () => true });
        if (r.status === 200 && r.data && r.data.byteLength > 100) buf = Buffer.from(r.data);
    } catch (_) {}
    _imgCache.set(url, buf);
    return buf;
}

// EasyEcom's value-in-words, quirks included: Indian scales pluralised ("twenty thousands"), paise
// spoken digit by digit ("point three eight Paise"). 20806.38 reproduces their sample exactly.
const _ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const _TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const _w2 = n => n < 20 ? _ONES[n] : (_TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + _ONES[n % 10] : ''));
const _w3 = n => { const h = Math.floor(n / 100), r = n % 100;
    return [h ? _ONES[h] + ' hundred' : '', r ? (h ? 'and ' : '') + _w2(r) : ''].filter(Boolean).join(' '); };
function inrWords(amount) {
    const rupees = Math.floor(amount), paise = Math.round((amount - rupees) * 100);
    let n = rupees; const parts = [];
    const crore = Math.floor(n / 1e7); n %= 1e7;
    const lakh = Math.floor(n / 1e5); n %= 1e5;
    const thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push(_w2(crore) + ' crores');
    if (lakh) parts.push(_w2(lakh) + ' lakhs');
    if (thousand) parts.push(_w2(thousand) + ' thousands');
    if (n) parts.push(_w3(n));
    let s = (parts.join(' ') || 'zero') + ' Rupees';
    if (paise) s += ' point ' + String(paise).padStart(2, '0').split('').map(d => d === '0' ? 'zero' : _ONES[+d]).join(' ') + ' Paise';
    return s;
}

router.get('/po-approvals/:id/pdf', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const row = await loadRequest(id);
        if (!row) return res.status(404).json({ success: false, error: `Request ${id} not found` });
        const b = row.payload || {};
        const items = Array.isArray(b.items) ? b.items : [];

        // Vendor detail (address / TIN / contact / state) and the product master (names, EAN,
        // images) — both degrade to blanks, never a failed document. ⚠️ Fetched IN PARALLEL, and the
        // images too: the first render awaited them one after another and a cold open took 6–8 s
        // (user-reported); warm caches (both 10-min) make later opens instant either way.
        let vend = null; const bySku = {};
        const [vendors, master] = await Promise.all([
            rawVendors().catch(() => []),
            fetchProductMaster().catch(() => []),
        ]);
        vend = vendors.find(v => v.vendor_c_id === parseInt(b.vendorId, 10) || v.vendor_name === row.vendor_name) || null;
        master.forEach(p => { const k = String(p.sku || '').trim(); if (k) bySku[k] = p; });
        const disp = (vend && vend.address && vend.address.dispatch) || {};
        const interstate = (disp.state_name || '') !== COMPANY.state;   // IGST across states, CGST/SGST within

        // Product images fetched up-front (pdfkit draws synchronously) — all at once, per-URL cached.
        const imgs = {};
        await Promise.all(items.map(async it => {
            const m = bySku[String(it.sku || '').trim()];
            if (m && m.product_image_url) imgs[it.sku] = await fetchImage(m.product_image_url);
        }));

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 26, size: 'A4' });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="PO-${row.ref_code || id}.pdf"`);
            res.setHeader('Content-Length', pdf.length);
            res.end(pdf);
        });

        const L = 26, R = 569, W = R - L;
        const B = '#8a8a8a';
        const hline = (y, x1 = L, x2 = R) => doc.moveTo(x1, y).lineTo(x2, y).strokeColor(B).lineWidth(0.7).stroke();
        const vline = (x, y1, y2) => doc.moveTo(x, y1).lineTo(x, y2).strokeColor(B).lineWidth(0.7).stroke();
        const n2 = n => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        // Header: GST left · company centre · PURCHASE ORDER + number right.
        const top = 30;
        doc.font('Helvetica').fontSize(8).fillColor('#000').text(`GST number : ${COMPANY.gst}`, L + 6, top + 12, { width: 150 });
        doc.font('Helvetica-Bold').fontSize(10).text(COMPANY.name, L + 160, top + 4, { width: W - 320, align: 'center' });
        doc.font('Helvetica').fontSize(8);
        let cy = top + 18;
        COMPANY.addr.concat(['Phone:']).forEach(t => { doc.text(t, L + 160, cy, { width: W - 320, align: 'center' }); cy += 10; });
        doc.font('Helvetica-Bold').fontSize(9).text('PURCHASE ORDER', R - 140, top + 6, { width: 134, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(10).text(String(row.ref_code || id), R - 140, top + 22, { width: 134, align: 'center' });
        // A draft is a draft — the one deliberate departure from EE's sheet, so this can never be
        // mistaken for a released PO.
        if (row.status !== 'created') { doc.font('Helvetica').fontSize(7).fillColor('#b45309')
            .text(row.status === 'pending' ? 'DRAFT — pending approval' : `status: ${row.status}`, R - 140, top + 38, { width: 134, align: 'center' }); doc.fillColor('#000'); }
        let y = Math.max(cy + 4, top + 62);
        hline(top); hline(y);

        // Vendor block left · PO meta right.
        const midX = L + W * 0.5;
        const kv = (label, value, x, yy, lw, vw, bold) => {
            doc.font('Helvetica').fontSize(8).text(label, x, yy, { width: lw });
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).text(value == null ? '' : String(value), x + lw, yy, { width: vw });
            return Math.max(doc.heightOfString(String(value || ' '), { width: vw }), 10);
        };
        let ly = y + 8, ry = y + 8;
        ly += kv('Vendor Code', (vend && vend.vendor_code) || b.vendorCode || '', L + 6, ly, 86, midX - L - 100, true) + 1;
        ly += kv('Vendor Name', (row.vendor_name || '').toUpperCase(), L + 6, ly, 86, midX - L - 100, true) + 1;
        const vendAddr = [String(disp.address || '').replace(/,\s*$/, ','), `${disp.city || ''} ,${disp.state_name || ''} - ${disp.zip || ''}`, disp.country || ''].filter(s => String(s).trim() && String(s).trim() !== ',').join('\n');
        if (vendAddr) { doc.font('Helvetica').fontSize(8).text(vendAddr, L + 92, ly, { width: midX - L - 100 });
            ly += doc.heightOfString(vendAddr, { width: midX - L - 100 }) + 3; }
        ly += kv('Contact Person', (vend ? `${vend.firstname || ''} ${vend.lastname || ''}`.trim() : ''), L + 6, ly, 86, midX - L - 100) + 1;
        ly += kv('Contact Number', (vend && vend.contact_number) || '', L + 6, ly, 86, midX - L - 100) + 1;
        ry += kv('PO Ref No', row.ref_code || '', midX + 6, ry, 120, R - midX - 130) + 1;
        ry += kv('PO Date', String(row.requested_at || '').slice(0, 10), midX + 6, ry, 120, R - midX - 130) + 1;
        ry += kv('Payment Term', (vend && vend.paymentTerm) || 'NA', midX + 6, ry, 120, R - midX - 130) + 1;
        ry += kv('Expected Delivery Date', b.expDeliveryDate || '', midX + 6, ry, 120, R - midX - 130) + 1;
        ry += kv('Vendor Invoice Number', '', midX + 6, ry, 120, R - midX - 130) + 1;
        ry += kv('Vendor Tax ID', (vend && vend.tax_identification_number) || '', midX + 6, ry, 120, R - midX - 130) + 1;
        ry += kv('Purchase Date', '', midX + 6, ry, 120, R - midX - 130) + 1;
        ry += kv('Payment Mode', '', midX + 6, ry, 120, R - midX - 130) + 1;
        y = Math.max(ly, ry) + 4;
        hline(y);

        // Billing / Shipping band.
        doc.font('Helvetica-Bold').fontSize(9)
           .text('Billing Address', L, y + 5, { width: W / 2, align: 'center' })
           .text('Shipping Address', midX, y + 5, { width: W / 2, align: 'center' });
        const bandBot = y + 20; hline(bandBot);
        const addrBlock = [COMPANY.name, '', ...COMPANY.addr, COMPANY.phone].join('\n');
        doc.font('Helvetica').fontSize(8)
           .text(addrBlock, L + 8, bandBot + 6, { width: W / 2 - 20 })
           .text(addrBlock, midX + 8, bandBot + 6, { width: W / 2 - 20 });
        const addrH = doc.heightOfString(addrBlock, { width: W / 2 - 20 });
        vline(midX, y, bandBot + addrH + 12);
        y = bandBot + addrH + 12;
        hline(y);

        // Item grid — EasyEcom's columns, product image included.
        // ⚠️ Widths MUST sum to exactly W (543) — the first render's summed 617 and pushed the
        // Unit Total column off the right edge of the sheet.
        const COLS = [
            ['SKU IMAGE', 42], ['Company SKU', 46], ['Product Name', 110], ['Vendor SKU', 44], ['EAN/UPC', 48],
            ['Product Tax Code', 36], ['Quantity', 32], ['Tax Rate', 26], ['Tax Type', 48], ['Base Price', 32],
            ['Tax per Item', 30], ['Unit Total', 49],
        ];
        if (RUPEE_FONT) doc.registerFont('MoneyB', RUPEE_FONT);
        const moneyFont = RUPEE_FONT ? 'MoneyB' : 'Helvetica-Bold';
        const colX = []; { let x = L; COLS.forEach(([, w]) => { colX.push(x); x += w; }); colX.push(R); }
        doc.font('Helvetica-Bold').fontSize(7);
        let hh = 0; COLS.forEach(([t, w]) => { hh = Math.max(hh, doc.heightOfString(t, { width: w - 4 })); });
        COLS.forEach(([t, w], k) => doc.text(t, colX[k] + 2, y + 4, { width: w - 4 }));
        let rowY = y + hh + 8; hline(rowY);
        const gridTop = y;
        doc.font('Helvetica').fontSize(7).fillColor('#000');
        let exTax = 0, taxTotal = 0, qtyTotal = 0;
        items.forEach(it => {
            const m = bySku[String(it.sku || '').trim()] || {};
            const qty = num(it.quantity), base = num(it.unitPrice), rate = num(it.taxRate);
            const taxPer = Math.round(base * rate) / 100;
            const unitTotal = Math.round(qty * (base + taxPer) * 100) / 100;
            exTax += qty * base; taxTotal += qty * taxPer; qtyTotal += qty;
            const name = m.product_name || it.sku;
            const taxType = rate ? (interstate ? `IGST-${rate}% CESS- 0%` : `CGST-${rate / 2}% SGST-${rate / 2}%`) : '';
            const cells = [null, it.sku, name, it.sku, m.EANUPC || '', '', String(qty), rate ? rate + '%' : '',
                taxType, n2(base), n2(taxPer), n2(unitTotal)];
            let rh = 34;   // image row height
            cells.forEach((c, k) => { if (c != null) rh = Math.max(rh, doc.heightOfString(String(c), { width: COLS[k][1] - 4 }) + 8); });
            if (rowY + rh > 720) { doc.addPage(); rowY = 40; }
            const img = imgs[it.sku];
            if (img) { try { doc.image(img, colX[0] + 6, rowY + 3, { fit: [34, rh - 8] }); } catch (_) {} }
            cells.forEach((c, k) => { if (c != null) doc.text(String(c), colX[k] + 2, rowY + 4, { width: COLS[k][1] - 4 }); });
            rowY += rh;
            hline(rowY);
        });
        const gridBot = rowY;                     // column verticals stop here; totals span full width
        const grand = Math.round((exTax + taxTotal) * 100) / 100;
        // Totals rows, EE-style: label in the Vendor-SKU column band, figures right.
        const totalsRow = (label, qty, value, big) => {
            doc.font('Helvetica-Bold').fontSize(big ? 11 : 8)
               .text(label, colX[3], rowY + 5, { width: 160 });
            if (qty != null) doc.font('Helvetica-Bold').fontSize(8).text(String(qty), colX[6] + 2, rowY + 5, { width: COLS[6][1] - 4 });
            doc.font(moneyFont).fontSize(big ? 11 : 8)
               .text(rupeeText(value), colX[9], rowY + 5, { width: R - colX[9] - 4, align: 'right' });
            rowY += big ? 24 : 17;
            hline(rowY);
        };
        // EE prints these UNGROUPED with no forced decimals ("₹19815.6*", "₹990.78*") — plain
        // number-to-string reproduces that exactly.
        const rawn = n => String(Math.round((Number(n) || 0) * 100) / 100);
        totalsRow('Item Total', qtyTotal, `₹${rawn(exTax)}*`);
        totalsRow('Total Tax Amount', null, `₹${rawn(taxTotal)}*`);
        totalsRow('Grand Total', null, `₹${rawn(grand)}*`, true);
        doc.font('Helvetica-Bold').fontSize(8).text(`Value In Words : ${inrWords(grand)}`, L + 6, rowY + 8, { width: W - 12 });
        rowY += 26;
        doc.font('Helvetica-Bold').fontSize(8).text(`FOR ${COMPANY.name}`, R - 240, rowY + 8, { width: 234, align: 'right', underline: true });
        doc.font('Helvetica').fontSize(8).text('Authorized Signatory', R - 240, rowY + 44, { width: 234, align: 'right' });
        rowY += 60;
        // Grid verticals over the item rows only; the outer frame wraps the whole sheet.
        colX.forEach(x => vline(x, gridTop, gridBot));
        vline(L, top, rowY); vline(R, top, rowY);
        hline(rowY);
        doc.end();
    } catch (e) {
        console.error('[PO approvals pdf]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
