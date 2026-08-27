// GRN — Goods Receiving (Inventory → GRN). The receiving side of the purchase cycle: what the
// warehouse has actually taken in against each purchase order, and what is still on its way.
//
// Source: GET {EASYECOM_BASE_URL}/Grn/V2/getGrnDetails
//   headers: x-api-key + Authorization: Bearer <JWT> (both api-key spellings sent, same as the PO
//   routes — different EasyEcom endpoints document different ones).
//
// ⚠️ THIS ENDPOINT HAS THE SAME SILENT-SLICE TRAP AS getPurchaseOrderDetails, verified live 2026-08-26:
// called bare it returned 6 GRNs (19–26 Aug) while `created_after=2024-01-01` returned 67 back to
// 18 Feb 2026 over 14 pages. No error, no truncation notice — just a short list that looks complete.
// `limit` is hard-capped at 10 ("Limit cannot be greater than 10"), and paging is cursor-based via
// `nextUrl` (a path, needs the base prefixed). So: always send created_after, always walk nextUrl.
//
// ⚠️ GRN STATUS IDS DO NOT MATCH EASYECOM'S OWN DOC. Their sample shows 1=CREATED / 3=QC Complete;
// live data carries 2="In Progress" and 5="Completed". The API sends the label in `grn_status`, so the
// label is used verbatim and the id is carried only as data — a hardcoded map here would lie.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const config = require('../../config');
const { getEasyecomToken } = require('./easyecom');
// The PO book is the other half of the receiving story ("awaiting receipt" = open POs). Reused from
// purchase_orders so open/dead/received semantics can never drift from what the PO page shows.
const { fetchAllPurchaseOrders, shapePo, fetchVendors, fetchProductMaster, poBookCached } = require('./purchase_orders');

// SKU → { mrp, name } from the live product master, for the Receive form's MRP auto-fill (probe
// 2026-08-26: the master carries `mrp` on 40/50 sampled rows). Master failure degrades to no
// prefill — the field stays hand-typed, never blocked.
async function skuInfoMap() {
    const info = {};
    try {
        (await fetchProductMaster()).forEach(p => {
            const sku = String(p.sku || '').trim();
            if (!sku || p.active !== 1) return;
            info[sku] = { mrp: (isFinite(p.mrp) && p.mrp > 0) ? Number(p.mrp) : null, name: p.product_name || null,
                colour: p.colour || null, size: p.size || null };   // colour/size feed the EE-format GRN document
        });
    } catch (e) { console.warn('[GRN] product master failed — MRP auto-fill unavailable:', e.message); }
    return info;
}

const PAGE_CAP = 300;                       // runaway guard, not an expected limit (67 GRNs ≈ 14 pages)
const DEFAULT_LOOKBACK_DAYS = 730;          // a GRN is history, but short receipts stay relevant for months
let _grnCache = null;
const GRN_TTL = 3 * 60 * 1000;              // EasyEcom is rate-limited; this book changes a few times a day

const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

async function fetchAllGrns(sinceISO) {
    const jwt = await getEasyecomToken();
    const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
    const headers = { 'x-api-key': config.EASYECOM_API_KEY, 'x_api_key': config.EASYECOM_API_KEY,
        'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' };
    let url = `${base}/Grn/V2/getGrnDetails?created_after=${encodeURIComponent(sinceISO)}`;
    const rows = [];
    let pages = 0, truncated = false;
    while (url) {
        if (pages >= PAGE_CAP) { truncated = true; break; }
        let r = await axios.get(url, { headers, timeout: 30000, validateStatus: () => true });
        // ⚠️ A 429 mid-walk retries THIS page with backoff, never the whole walk — the whole-walk
        // retry re-fetched every earlier page and doubled the very burst that tripped the limiter.
        for (let a = 0; r.status === 429 && a < 3; a++) {
            await new Promise(s => setTimeout(s, 2500 * (a + 1)));
            r = await axios.get(url, { headers, timeout: 30000, validateStatus: () => true });
        }
        if (r.status !== 200) throw new Error(`EasyEcom HTTP ${r.status}${typeof r.data === 'string' ? ' — ' + r.data.slice(0, 120) : ''}`);
        const body = r.data || {};
        if (body.code !== 200) throw new Error(body.message || `EasyEcom code ${body.code}`);
        const page = Array.isArray(body.data) ? body.data : [];
        rows.push(...page);
        pages++;
        if (!page.length || !body.nextUrl) break;
        url = String(body.nextUrl).startsWith('http') ? body.nextUrl : base + body.nextUrl;
        await new Promise(s => setTimeout(s, 150));   // pace the limiter
    }
    return { rows, pages, truncated };
}

// Shape one GRN for the UI. Numbers are normalised here so the client never parses EasyEcom's
// stringified decimals; QC and stock-state counters ride on each line for the drawer.
function shapeGrn(g) {
    const items = (g.grn_items || []).map(i => ({
        detailId: i.grn_detail_id,
        poDetailId: i.purchase_order_detail_id,
        sku: i.sku || '',
        name: i.product_name || i.product_description || null,
        hsn: i.hsn || null, ean: i.ean || null, modelNo: i.model_no || null,
        // Per-line receiving arithmetic: original = the PO line quantity, received = taken in on this
        // GRN, pending = still owed AFTER it. pending > 0 is a short receipt worth seeing.
        ordered: num(i.original_quantity),
        received: num(i.received_quantity),
        pending: num(i.pending_quantity),
        // ⚠️⚠️ **`grn_detail_price` IS THE LINE TOTAL, NOT THE UNIT RATE — EASYECOM'S OWN DOC SHOWS THE
        // OPPOSITE.** Their sample (price 500 × qty 5 = total 2500) reads as a per-unit rate; on our
        // live book it is the line total on 62 of 62 non-zero GRNs and the unit rate on 0 (e.g.
        // TE-BDR1: 391 received, grn_detail_price 10752.50 = 391 × ₹27.50, header total 10752.50).
        // Multiplying by quantity — the natural reading of their doc — would inflate every line 391×.
        // The unit rate is derived, and only when a quantity exists to divide by.
        rate: num(i.received_quantity) > 0 ? Math.round(num(i.grn_detail_price) / num(i.received_quantity) * 100) / 100 : null,
        lineValue: num(i.grn_detail_price),
        batch: i.batch_code || null,
        expiry: i.expire_date || null,
        lineStatus: i.grn_details_status_name || null,
        qc: { pending: num(i.qc_pending), pass: num(i.qc_pass), fail: num(i.qc_fail) },
        damaged: num(i.damaged), lost: num(i.lost),
        available: num(i.available), reserved: num(i.reserved), sold: num(i.sold),
    }));
    const received = items.reduce((a, i) => a + i.received, 0);
    const pending = items.reduce((a, i) => a + i.pending, 0);
    const shortLines = items.filter(i => i.pending > 0).length;
    return {
        grnId: g.grn_id,
        invoiceNo: g.grn_invoice_number || null,
        // "AutoGrn" is EasyEcom's own stamp for receipts it generated (batch updates / auto POs), the
        // same way "Auto PO" marks its reorder documents. Matched loosely, same as poIsAuto.
        isAuto: /^auto\s*grn$/i.test(String(g.grn_invoice_number || '').trim()),
        value: num(g.total_grn_value),
        statusId: g.grn_status_id,
        status: g.grn_status || `Status ${g.grn_status_id}`,   // API's own label — see header note
        createdAt: g.grn_created_at || null,
        invoiceDate: g.grn_invoice_date || null,
        poId: g.po_id || null, poNumber: g.po_number || null, poRef: g.po_ref_num || null,
        poStatusId: g.po_status_id || null, poCreatedAt: g.po_created_date || null,
        warehouse: g.inwarded_warehouse || null,
        warehouseCid: g.inwarded_warehouse_c_id || null,   // completeGrn wants this as `c_id`
        vendor: g.vendor_name || null,
        received, pending,
        shortLines, isShort: shortLines > 0,
        qcFail: items.reduce((a, i) => a + i.qc.fail, 0),
        damaged: items.reduce((a, i) => a + i.damaged, 0),
        lineCount: items.length, items,
    };
}

// GET /api/grn?fresh=1&days=730
// One payload drives the whole page: the GRN book, the receiving pipeline, and the open-PO
// "awaiting receipt" list — fetched together so the two halves describe the same moment.
router.get('/grn', async (req, res) => {
    try {
        if (!config.EASYECOM_API_KEY) return res.status(500).json({ success: false, error: 'EASYECOM_API_KEY is not set in .env' });
        const days = Math.min(3650, Math.max(1, parseInt(req.query.days || DEFAULT_LOOKBACK_DAYS, 10) || DEFAULT_LOOKBACK_DAYS));
        const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        // canWrite is PER USER and must never ride the shared cache — everything else in the payload
        // is the same for everyone.
        if (!req.query.fresh && _grnCache && _grnCache.key === since && Date.now() - _grnCache.t < GRN_TTL) {
            return res.json({ ..._grnCache.v, cached: true, canWrite: canWriteGrn(req) });
        }
        // ⚠️ One retry after 3s — EasyEcom 429s under bursts (seen live the first time this route ran,
        // right after the PO page had walked its own 14 pages). Same ladder as openPoQtyBySku.
        const grnsWithRetry = () => fetchAllGrns(since).catch(async e1 => {
            console.warn('[GRN] fetch failed, retrying in 3s:', e1.message);
            await new Promise(r => setTimeout(r, 3000));
            return fetchAllGrns(since);
        });
        // The PO book comes from the SHARED cache (poBookCached) — the PO page and this one used to
        // walk the same 14 EasyEcom pages independently within seconds, which is the burst their
        // limiter punishes. One outer retry stays as the last-resort ladder.
        const poWithRetry = () => poBookCached(since, !!req.query.fresh).catch(async e1 => {
            console.warn('[GRN] PO book fetch failed, retrying in 3s:', e1.message);
            await new Promise(r => setTimeout(r, 3000));
            return poBookCached(since, false);
        });
        const [{ rows, pages, truncated }, poBook, vendorMaster, skuInfo] = await Promise.all([
            grnsWithRetry(),
            // The PO half is a nicety the GRN book must not die for — degrade to "awaiting unknown".
            poWithRetry()
                .catch(e => { console.warn('[GRN] PO book failed — awaiting-receipt panel degraded:', e.message); return null; }),
            // Suppliers for the Auto-GRN (no-PO) Receive form; a failure degrades that picker only.
            fetchVendors().catch(e => { console.warn('[GRN] vendor master failed:', e.message); return []; }),
            skuInfoMap(),
        ]);
        const grns = rows.map(shapeGrn).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

        // GRNs grouped by PO, so the awaiting list can show receipts already made against each PO.
        const grnsByPo = {};
        grns.forEach(g => { if (g.poId) (grnsByPo[g.poId] = grnsByPo[g.poId] || []).push(g.grnId); });

        // Awaiting receipt = open POs (pending units, not dead) — the PO page's own definition, reused.
        const awaiting = (poBook || []).filter(p => p.isOpen).map(p => {
            const ageDays = p.createdAt ? Math.round((Date.now() - new Date(p.createdAt).getTime()) / 86400000) : null;
            return {
                poId: p.poId, poNumber: p.poNumber, ref: p.ref, vendor: p.vendor, warehouse: p.warehouse,
                status: p.status, createdAt: p.createdAt, expectedAt: p.expectedAt, ageDays,
                ordered: p.qty, received: p.received, pending: p.pending,
                pendingValue: Math.round(p.items.reduce((a, i) => a + i.pending * i.price, 0) * 100) / 100,
                grnIds: grnsByPo[p.poId] || [],
                // Items still owed, for the expandable row and the Receive form — only lines with
                // something pending. `price` is the NET unit price (the PO's own figure), prefill for
                // the GRN line's cost; `mrp` rides in from the product master for the MRP box.
                pendingItems: p.items.filter(i => i.pending > 0).map(i => ({ sku: i.sku, ordered: i.qty, received: i.received, pending: i.pending, price: i.netPrice,
                    mrp: (skuInfo[String(i.sku || '').trim()] || {}).mrp || null })),
            };
        }).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));   // oldest first — longest-waiting on top

        const uniq = f => { const c = {}; grns.forEach(g => { const k = f(g); if (k) c[k] = (c[k] || 0) + 1; });
            return Object.entries(c).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count); };
        const sum = (arr, f) => Math.round(arr.reduce((a, x) => a + f(x), 0) * 100) / 100;
        const inProgress = grns.filter(g => !/complete/i.test(g.status));
        const payload = {
            success: true,
            fetchedAt: new Date().toISOString(),
            pages, truncated, since, lookbackDays: days,
            poBookAvailable: poBook !== null,
            summary: {
                total: grns.length,
                completed: grns.length - inProgress.length,
                inProgress: inProgress.length,
                unitsReceived: grns.reduce((a, g) => a + g.received, 0),
                valueReceived: sum(grns, g => g.value),
                shortGrns: grns.filter(g => g.isShort).length,
                qcFailUnits: grns.reduce((a, g) => a + g.qcFail, 0),
                damagedUnits: grns.reduce((a, g) => a + g.damaged, 0),
                awaitingPos: awaiting.length,
                awaitingUnits: awaiting.reduce((a, p) => a + p.pending, 0),
                awaitingValue: sum(awaiting, p => p.pendingValue),
            },
            vendors: uniq(g => g.vendor),
            warehouses: uniq(g => g.warehouse),
            statuses: uniq(g => g.status),
            vendorOptions: vendorMaster.map(v => ({ id: v.id, code: v.code, name: v.name })),
            skuInfo,                                    // SKU → { mrp, name } for the Auto-GRN lines
            awaiting,
            grns,
        };
        _grnCache = { t: Date.now(), key: since, v: payload };
        res.json({ ...payload, canWrite: canWriteGrn(req) });
    } catch (e) {
        console.error('[GRN]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── WRITES ───────────────────────────────────────────────────────────────────────────────────────
// Creating a GRN puts REAL STOCK into EasyEcom's inventory — sellable the moment QC passes. Gated on
// its own capability (`grn-write`), same construction as `purchase-orders-write`: reading the
// receiving book is a reporting need, receiving goods is a warehouse decision.
//
// ⚠️ ONE ENDPOINT SERVES BOTH FLOWS — `POST /wms/QueueGrnApi`. With `purchase_order_id` it is a GRN
// against that PO (consumes the PO's pending quantities); without it, an Auto GRN (free-standing
// inward). Both return `{ code: 200, queueId }` — the job is ASYNC, and `GET /wms/CheckGrnStatus
// ?queue_id=` reports when it lands ("Job Finished"). We poll briefly and report what we actually saw.
//
// ⚠️ THE PO-BASED PARAM TABLE SAYS `vendorId` ("Vendor Code") BUT BOTH OF EASYECOM'S OWN BODY SAMPLES
// SEND `vendor_id` WITH THE NUMERIC ID — the exact documented-vs-real split CreatePurchaseOrder had
// (`vendorId` resolves as a CODE, `vendor_id` as the numeric id). We send numeric `vendor_id`, and
// for a PO-based GRN the vendor is taken FROM THE PO, never from the client — a receipt booked
// against PO 68 cannot belong to anyone but PO 68's supplier.
//
// ⚠️ `cost` is the PER-UNIT rate — PROVEN LIVE 2026-08-26 on the first real GRN (2355800, PO 79):
// sent quantity 588 / cost 33.70, EasyEcom stored total_grn_value 19815.60 = 588 × 33.70. Note this
// is the OPPOSITE of what getGrnDetails returns (`grn_detail_price` = line total) — the two sides
// of this module deliberately use different readings because EasyEcom does.
//
// ⚠️ AN API-CREATED GRN IS STAMPED `grn_invoice_number = "AutoGrn"` BY EASYECOM — even a PO-based
// one (verified on 2355800). So dashboard-created receipts surface under the "Auto" side of the
// Manual/Auto toggle; the invoice number cannot distinguish our API GRNs from EasyEcom's own.
function canWriteGrn(req) {
    const u = req.user || {};
    if (u.role === undefined && u.permissions === undefined) return true;   // legacy bootstrap admin
    if (u.role === 'admin') return true;
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    return perms.includes('*') || perms.includes('grn-write');
}

const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());

// RAW vendor master rows (unmapped — fetchVendors strips the TIN and address the GRN document
// needs). 10-min in-process cache; vendors change rarely, documents print often.
let _rawVendCache = { at: 0, rows: [] };
async function rawVendors() {
    if (Date.now() - _rawVendCache.at < 10 * 60 * 1000) return _rawVendCache.rows;
    const jwt = await getEasyecomToken();
    const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
    const headers = { 'x-api-key': config.EASYECOM_API_KEY, 'x_api_key': config.EASYECOM_API_KEY,
        'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' };
    let url = `${base}/wms/V2/getVendors`;
    const rows = [];
    for (let p = 0; url && p < 20; p++) {
        const r = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
        if (r.status !== 200 || !r.data) break;
        rows.push(...(Array.isArray(r.data.data) ? r.data.data : []));
        if (!r.data.nextUrl) break;
        url = String(r.data.nextUrl).startsWith('http') ? r.data.nextUrl : base + r.data.nextUrl;
    }
    if (rows.length) _rawVendCache = { at: Date.now(), rows };
    return rows;
}

// Receiving-warehouse address block for the document header. The GRN API carries only the warehouse
// NAME; EasyEcom's own document prints the full address, so the known warehouse is mapped here.
// An unmapped warehouse prints its name alone — never a guessed address.
const WAREHOUSE_ADDR = {
    'Shifupro Technologies Pvt. Ltd.': ['Shifupro Technologies Pvt. Ltd.', 'Shop 19, AIPL Boulevard, Sector 70A', 'Gurgaon', 'Haryana,122101'],
};

// ⚠️ EasyEcom's QueueGrnApi reports validation failures as an ARRAY of objects —
// `{"code":400,"message":[{"SKU":"TE-AAD1","key":"","Error":"Manufacturing Date is mandatory…",
// "type":"ValidationError"}]}` (seen live on the first real attempt) — so `body.message` fed straight
// into an error string renders as "[object Object]". Flattened here into readable per-SKU sentences.
function eeMsgText(m) {
    if (Array.isArray(m)) return m.map(x => {
        if (x && typeof x === 'object') {
            const sku = x.SKU || x.sku || '';
            const err = x.Error || x.error || x.message || JSON.stringify(x);
            return (sku ? sku + ': ' : '') + err;
        }
        return String(x);
    }).join(' · ');
    if (m && typeof m === 'object') return JSON.stringify(m);
    return m ? String(m) : '';
}

// Poll CheckGrnStatus until the job reports finished, for a bounded few seconds. The message is
// returned VERBATIM — we report what EasyEcom said, not what we hoped.
async function waitForGrnJob(queueId, headers, base) {
    let last = null;
    for (let i = 0; i < 6; i++) {
        if (i) await new Promise(r => setTimeout(r, 2000));
        try {
            const r = await axios.get(`${base}/wms/CheckGrnStatus`, {
                params: { queue_id: queueId }, headers, timeout: 20000, validateStatus: () => true });
            last = (r.data && r.data.message) || `HTTP ${r.status}`;
            if (/finished|success|complete/i.test(String(last))) return { finished: true, message: last };
            if (/fail|error|reject/i.test(String(last))) return { finished: false, failed: true, message: last };
        } catch (e) { last = e.message; }
    }
    return { finished: false, message: last || 'no status yet' };
}

// POST /api/grn/create
// Body: { poId?, vendorId?, refNumber?, items: [{ sku, quantity, cost, shelf?, batch?, mrp?, ean?,
//         expiry?, mfg?, daysToExpire? }] }
// With poId: vendor comes from the PO, and every line is validated against that PO's PENDING
// quantities — a typo'd 6000 against a 600-unit line would otherwise create phantom stock.
router.post('/grn/create', async (req, res) => {
    if (!canWriteGrn(req)) return res.status(403).json({ success: false, error: 'You do not have permission to create GRNs.' });
    try {
        const b = req.body || {};
        const poId = b.poId ? parseInt(b.poId, 10) : null;
        let vendorId = b.vendorId ? parseInt(b.vendorId, 10) : null;
        const refNumber = String(b.refNumber || '').trim().slice(0, 200);
        const items = Array.isArray(b.items) ? b.items : [];
        // The form's mfg/expiry are MONTH pickers (product dating is month-level); a bare YYYY-MM is
        // expanded to the FIRST of the month — EasyEcom's own storage convention for month-level
        // expiry (GRN 2355800: July-2029 stored as 2029-07-01).
        items.forEach(it => { if (it && typeof it === 'object') for (const k of ['expiry', 'mfg'])
            if (/^\d{4}-\d{2}$/.test(String(it[k] || '').trim())) it[k] = String(it[k]).trim() + '-01'; });
        const errs = [];
        if (!items.length) errs.push('at least one line item is required');
        items.forEach((it, i) => {
            const n = `item ${i + 1}`;
            if (!String(it.sku || '').trim()) errs.push(`${n}: sku is required`);
            const q = Number(it.quantity);
            if (!Number.isInteger(q) || q <= 0) errs.push(`${n}: quantity must be a whole number greater than 0`);
            const c = Number(it.cost);
            if (it.cost === '' || it.cost == null || !isFinite(c) || c < 0) errs.push(`${n}: cost (per unit) is required — EasyEcom refuses a GRN line without it`);
            if (it.expiry && !isoDate(it.expiry)) errs.push(`${n}: expiry must be YYYY-MM-DD`);
            if (it.expiry && it.daysToExpire) errs.push(`${n}: send expiry date OR days-to-expire, not both`);
        });
        if (errs.length) return res.status(400).json({ success: false, error: errs.join(' · '), errors: errs });

        // PO-based: read the PO live and hold every line against what that PO is still owed.
        let po = null;
        if (poId) {
            const since = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
            // ⚠️ Retry once after 3s — the real flow is "load page → click Receive → submit", so this
            // read lands seconds after the page walked both books, exactly the burst EasyEcom 429s.
            const { rows } = await fetchAllPurchaseOrders(since).catch(async e1 => {
                console.warn('[GRN create] PO read failed, retrying in 3s:', e1.message);
                await new Promise(r => setTimeout(r, 3000));
                return fetchAllPurchaseOrders(since);
            });
            const raw = rows.find(r => r.po_id === poId);
            if (!raw) return res.status(404).json({ success: false, error: `PO ${poId} not found in EasyEcom` });
            po = shapePo(raw);
            if (po.isDead) return res.status(400).json({ success: false, error: `PO ${po.poNumber} is ${po.status} — a dead PO cannot receive goods` });
            const pendingBySku = {};
            po.items.forEach(i => { const k = String(i.sku || '').trim(); if (k) pendingBySku[k] = (pendingBySku[k] || 0) + i.pending; });
            const over = [];
            items.forEach(it => {
                const sku = String(it.sku).trim();
                const pending = pendingBySku[sku];
                if (pending == null) over.push(`${sku} is not on PO ${po.poNumber}`);
                else if (Number(it.quantity) > pending) over.push(`${sku}: receiving ${it.quantity} but PO ${po.poNumber} is only owed ${pending}`);
            });
            if (over.length) return res.status(400).json({ success: false, error: over.join(' · '), errors: over });
            vendorId = po.vendorId || vendorId;   // the PO's supplier wins — see header note
        }
        if (!vendorId) return res.status(400).json({ success: false, error: poId ? `PO ${poId} carries no vendor id` : 'a supplier (vendorId) is required for an Auto GRN' });

        const payload = {
            vendor_id: vendorId,                               // snake_case + numeric — see header note
            ...(poId ? { purchase_order_id: poId } : {}),
            ...(refNumber ? { grn_reference_number: refNumber } : {}),
            // Optional fields are OMITTED when blank, never sent as '' — the PO-create lesson: EasyEcom
            // turns empty strings into blank batches.
            items: items.map(it => {
                const line = { sku: String(it.sku).trim(), quantity: Number(it.quantity), cost: Number(it.cost) };
                if (String(it.shelf || '').trim()) line.shelf = String(it.shelf).trim();
                if (String(it.batch || '').trim()) line.batch_code = String(it.batch).trim();
                if (it.mrp !== '' && it.mrp != null && isFinite(Number(it.mrp))) line.mrp = Number(it.mrp);
                if (String(it.ean || '').trim()) line.ean = String(it.ean).trim();
                if (isoDate(it.expiry)) line.expiry_date = it.expiry;
                if (isoDate(it.mfg)) line.mfg_date = it.mfg;
                if (it.daysToExpire && isFinite(Number(it.daysToExpire))) line.days_to_expire = String(it.daysToExpire);
                return line;
            }),
        };

        const jwt = await getEasyecomToken();
        const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
        const headers = { 'x-api-key': config.EASYECOM_API_KEY, 'x_api_key': config.EASYECOM_API_KEY,
            'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' };
        const r = await axios.post(`${base}/wms/QueueGrnApi`, payload, { headers, timeout: 30000, validateStatus: () => true });
        const body = r.data || {};
        // ⚠️ DO NOT TRUST HTTP 200 ALONE — EasyEcom reports failures under `code` OR `status` in a 200
        // body (both traps seen live on the PO endpoints). A success MUST also carry the queueId.
        const failCode = (body && typeof body === 'object') ? (body.code != null ? body.code : body.status) : null;
        const bodyFailed = failCode != null && failCode !== 200 && failCode !== 201;
        const queueId = body.queueId || (body.data && body.data.queueId) || null;
        if (r.status < 200 || r.status >= 300 || bodyFailed || !queueId) {
            console.error('[GRN create] failed', r.status, JSON.stringify(body).slice(0, 300));
            return res.status(502).json({ success: false, error: eeMsgText(body.message) || `EasyEcom HTTP ${r.status}${queueId ? '' : ' (no queueId returned)'}`, easyecom: body });
        }
        console.log(`[GRN create] queued ${queueId} · ${poId ? `PO ${po.poNumber} (id ${poId})` : 'Auto GRN'} · vendor ${vendorId} · ${payload.items.length} line(s) · by ${(req.user || {}).sub || 'unknown'}`);

        // The job is async: poll briefly so the caller usually hears "finished", and always hears the
        // truth. The GRN book changed (or is about to) either way — never serve a stale list after.
        const job = await waitForGrnJob(queueId, headers, base);
        _grnCache = null;
        // Once the job lands, read the NEW GRN back so the confirmation can show the real document —
        // what EasyEcom recorded, not what we asked for. Matched by PO (or vendor for an Auto GRN)
        // among GRNs created in the last few minutes. A read failure degrades to the plain summary.
        let createdGrn = null;
        if (job.finished) {
            try {
                const recent = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
                const { rows: gRows } = await fetchAllGrns(recent);
                // ⚠️ grn_created_at is IST-NAIVE ("2026-08-26 20:08:00"), so the window is compared as
                // STRINGS against IST-now minus an hour — `new Date()` on that stamp shifts by the
                // server's timezone (IST locally, UTC on the VPS) and would mis-window on one of them.
                const istFloor = new Date(Date.now() + 5.5 * 3600 * 1000 - 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
                createdGrn = gRows.map(shapeGrn)
                    // PO-based: the GRN carries our PO id. Auto GRN: EasyEcom creates an auto-PO behind
                    // it (0 of 67 book GRNs lack po_id), so the newest in-window GRN is the match.
                    .filter(g => (!poId || g.poId === poId) && String(g.createdAt || '') >= istFloor)
                    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
            } catch (e) { console.warn('[GRN create] read-back failed (confirmation degrades):', e.message); }
        }
        res.json({ success: true, queueId,
            finished: !!job.finished, jobFailed: !!job.failed, jobMessage: job.message,
            poNumber: po ? po.poNumber : null,
            grn: createdGrn,
            message: job.finished ? 'GRN created — stock is being inwarded'
                : job.failed ? `The job reported: ${job.message}`
                : `GRN queued (job ${queueId}) — still processing; refresh in a moment` });
    } catch (e) {
        console.error('[GRN create]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── COMPLETE GRN ─────────────────────────────────────────────────────────────────────────────────
// POST /api/grn/complete { grnId } — the portal's "Complete GRN" button, from our module. An
// API-created GRN lands "In Progress" and stays there until completed (the user was clicking the
// portal button for it).
//
// ⚠️ THE ENDPOINT IS UNDOCUMENTED — FOUND BY PROBING (2026-08-26). `POST /wms/completeGrn` was the
// one candidate of 12 answering 405-on-GET (a route that exists and wants POST). Its payload is
// `{ grn_id, c_id }` where **`c_id` is the RECEIVING WAREHOUSE's company id** — the GRN's own
// `inwarded_warehouse_c_id`, never a hand-typed value. Proven live: `company_id`/`companyId` both
// answer "Company Id is missing"; with `c_id` the API answered "Cannot complete GRN as it is
// already in completed status" on a completed GRN — i.e. the call reached the completion logic.
// ⚠️ Failures come as HTTP 200 with `status: 400` in the body (the updatePoStatus trap again).
router.post('/grn/complete', async (req, res) => {
    if (!canWriteGrn(req)) return res.status(403).json({ success: false, error: 'You do not have permission to complete GRNs.' });
    try {
        const grnId = parseInt(req.body && req.body.grnId, 10);
        if (!grnId) return res.status(400).json({ success: false, error: 'grnId is required' });
        // The GRN supplies its own warehouse c_id; cache first, fresh walk (with retry) on a miss.
        let g = null;
        if (_grnCache && _grnCache.v) g = (_grnCache.v.grns || []).find(x => x.grnId === grnId) || null;
        if (!g) {
            const since = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
            const { rows } = await fetchAllGrns(since).catch(async e1 => {
                console.warn('[GRN complete] fetch failed, retrying in 3s:', e1.message);
                await new Promise(r => setTimeout(r, 3000));
                return fetchAllGrns(since);
            });
            const raw = rows.find(r => r.grn_id === grnId);
            if (!raw) return res.status(404).json({ success: false, error: `GRN ${grnId} not found` });
            g = shapeGrn(raw);
        }
        if (/complete/i.test(g.status)) return res.status(400).json({ success: false, error: `GRN ${grnId} is already ${g.status}` });
        if (!g.warehouseCid) return res.status(400).json({ success: false, error: `GRN ${grnId} carries no warehouse company id — cannot complete it via the API` });

        const jwt = await getEasyecomToken();
        const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
        const r = await axios.post(`${base}/wms/completeGrn`, { grn_id: grnId, c_id: g.warehouseCid },
            { headers: { 'x-api-key': config.EASYECOM_API_KEY, 'x_api_key': config.EASYECOM_API_KEY,
                'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
              timeout: 30000, validateStatus: () => true });
        const body = r.data || {};
        const failCode = (body && typeof body === 'object') ? (body.code != null ? body.code : body.status) : null;
        if (r.status < 200 || r.status >= 300 || (failCode != null && failCode !== 200 && failCode !== 201)) {
            console.error('[GRN complete] failed', r.status, JSON.stringify(body).slice(0, 250));
            return res.status(502).json({ success: false, error: eeMsgText(body.message) || `EasyEcom HTTP ${r.status}`, easyecom: body });
        }
        _grnCache = null;                       // the book changed — never serve a stale list after
        console.log(`[GRN complete] grn ${grnId} completed (warehouse c_id ${g.warehouseCid}) · by ${(req.user || {}).sub || 'unknown'}`);
        res.json({ success: true, grnId, message: eeMsgText(body.message) || 'GRN completed' });
    } catch (e) {
        console.error('[GRN complete]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── GRN DOCUMENT (PDF) ───────────────────────────────────────────────────────────────────────────
// GET /api/grn/:grnId/pdf — a goods-received note as a document.
// ⚠️ EASYECOM HAS NO GRN-DOCUMENT ENDPOINT (probed live 2026-08-26: downloadGrn / downloadGRN /
// downloadGrnDocument / Grn/downloadGrn / downloadGrnReport all 404 on api.easyecom.io — unlike POs,
// which have /downloadPurchaseOrder). The portal DOES have `app.easyecom.io/wms/printGRN?grn_id=` —
// probed on api.easyecom.io with our api-key + JWT and it answers `{"code":400,"message":"Not
// authorised"}`: the route exists there but is PORTAL-SESSION-ONLY, and app.easyecom.io itself is
// the cookie-auth host the VPS is WAF-blocked from (the warehouse-routing lesson). So unlike the PO
// route there is nothing official to prefer: this document is ALWAYS generated by us from the GRN
// book, and the footer says so.
router.get('/grn/:grnId/pdf', async (req, res) => {
    try {
        const grnId = parseInt(req.params.grnId, 10);
        if (!grnId) return res.status(400).json({ success: false, error: 'grnId is required' });
        // The cached book usually has it; a cache miss falls back to a fresh walk — WITH the retry
        // ladder: a create invalidates the cache and the user clicks Download seconds later, exactly
        // inside the 429 window the create burst just opened (seen live: "[GRN pdf] EasyEcom HTTP 429").
        let g = null;
        if (_grnCache && _grnCache.v) g = (_grnCache.v.grns || []).find(x => x.grnId === grnId) || null;
        if (!g) {
            const since = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
            const { rows } = await fetchAllGrns(since).catch(async e1 => {
                console.warn('[GRN pdf] fetch failed, retrying in 3s:', e1.message);
                await new Promise(r => setTimeout(r, 3000));
                return fetchAllGrns(since);
            });
            const raw = rows.find(r => r.grn_id === grnId);
            if (!raw) return res.status(404).json({ success: false, error: `GRN ${grnId} not found` });
            g = shapeGrn(raw);
        }

        // ── EASYECOM'S OWN GRN LAYOUT, reproduced (user request 2026-08-26, from a real portal
        // print of GRN 2355558): bordered company header → "GRN" band → vendor/PO info block →
        // 14-column bordered item grid → Grand Total row. Vendor address + TIN come from the RAW
        // vendor master (the GRN payload has neither; EE's doc prints both), MRP/colour/size from
        // the product master. Every lookup degrades to a blank cell, never a failed document.
        let vend = null, skuMeta = {};
        try { vend = (await rawVendors()).find(v => v.vendor_name === g.vendor) || null; } catch (_) {}
        try { skuMeta = await skuInfoMap(); } catch (_) {}
        const disp = (vend && vend.address && vend.address.dispatch) || {};
        const vendAddr = [disp.address, disp.city, disp.country].filter(Boolean).join(' ').replace(/,\s*$/, '')
            ? [String(disp.address || '').replace(/,\s*$/, ''), disp.city, disp.country].filter(Boolean).join(', ') : '';

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 28, size: 'A4' });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="GRN-${g.grnId}.pdf"`);
            res.setHeader('Content-Length', pdf.length);
            res.end(pdf);
        });

        const n2 = n => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const L = 28, R = 567, W = R - L;
        const BORDER = '#8a8a8a';
        const hline = (y, x1 = L, x2 = R) => doc.moveTo(x1, y).lineTo(x2, y).strokeColor(BORDER).lineWidth(0.7).stroke();
        const vline = (x, y1, y2) => doc.moveTo(x, y1).lineTo(x, y2).strokeColor(BORDER).lineWidth(0.7).stroke();

        // Company / warehouse header (their doc centres the receiving company's name + address).
        let y = 30;
        const headTop = y;
        const addrLines = WAREHOUSE_ADDR[g.warehouse] || [g.warehouse || '—'];
        doc.fillColor('#000').font('Helvetica-Bold').fontSize(10).text(g.warehouse || '—', L, y + 6, { width: W, align: 'center' });
        y += 20;
        doc.font('Helvetica').fontSize(8);
        addrLines.forEach(t => { doc.text(t, L, y, { width: W, align: 'center' }); y += 10; });
        y += 4;
        hline(headTop); hline(y);

        // "GRN" title band
        doc.font('Helvetica').fontSize(13).fillColor('#000').text('GRN', L, y + 5, { width: W, align: 'center' });
        const bandBot = y + 22; hline(bandBot);

        // Info block — two label columns with EasyEcom's ":-" convention.
        const midX = L + W * 0.52;
        const info = (label, value, x, yy, lw, vw) => {
            doc.font('Helvetica-Bold').fontSize(8).text(label, x, yy, { width: lw });
            doc.font('Helvetica').fontSize(8).text(value == null || value === '' ? '' : String(value), x + lw, yy, { width: vw });
            return Math.max(doc.heightOfString(String(value || ' '), { width: vw }), 10);
        };
        let ly = bandBot + 6, ry = bandBot + 6;
        ly += info('Vendor Name :-', g.vendor || '', L + 6, ly, 92, midX - L - 104) + 2;
        ly += info('Vendor Address :-', vendAddr, L + 6, ly, 92, midX - L - 104) + 2;
        ly += info('Vendor TinNo :-', (vend && vend.tax_identification_number) || '', L + 6, ly, 92, midX - L - 104) + 2;
        ry += info('PO No :-', g.poId || '', midX + 6, ry, 92, R - midX - 100) + 2;
        ry += info('PO Ref No :-', g.poRef || '', midX + 6, ry, 92, R - midX - 100) + 2;
        ry += info('GRN No :-', g.grnId, midX + 6, ry, 92, R - midX - 100) + 2;
        ry += info('Vendor Invoice No :-', g.invoiceNo || '', midX + 6, ry, 92, R - midX - 100) + 2;
        ry += info('PO Date :-', g.poCreatedAt ? String(g.poCreatedAt).slice(0, 10) : '', midX + 6, ry, 92, R - midX - 100) + 2;
        ry += info('GRN date :-', g.createdAt || '', midX + 6, ry, 92, R - midX - 100) + 2;
        y = Math.max(ly, ry) + 4;
        hline(y);
        // Outer frame around the header + info blocks, drawn NOW while this is still the current
        // page — a multi-page GRN would otherwise get these verticals painted onto its last page.
        vline(L, headTop, y); vline(R, headTop, y);

        // Item grid — EasyEcom's 14 columns, bordered. Exp Qty mirrors their sample (the quantity
        // expected on THIS receipt); Cost Price is the derived per-unit rate; Total the line value.
        const COLS = [
            ['S.No', 20, i => String(i._sno)],
            ['SKU Code', 40, i => i.sku || ''],
            ['Product Name', 100, i => i.name || ''],
            ['SKU Desc', 28, () => ''],
            ['Vendor SKU', 36, () => ''],
            ['Colour', 34, i => (skuMeta[i.sku] || {}).colour || ''],
            ['Size', 26, i => (skuMeta[i.sku] || {}).size || ''],
            ['GRN MRP', 32, i => { const m = (skuMeta[i.sku] || {}).mrp; return m != null ? String(m) : ''; }],
            ['Exp Qty', 30, i => String(i.received)],
            ['Recv Qty', 32, i => String(i.received)],
            ['Cost Price', 34, i => i.rate != null ? n2(i.rate) : ''],
            ['Batch Code', 38, i => i.batch || ''],
            ['Additional Cost', 40, () => ''],
            ['Total', 49, i => n2(i.lineValue)],
        ];
        const colX = []; { let x = L; COLS.forEach(([, w]) => { colX.push(x); x += w; }); colX.push(R); }
        const drawGridHeader = (yy) => {
            doc.font('Helvetica-Bold').fontSize(7).fillColor('#000');
            hline(yy);
            let hh = 0;
            COLS.forEach(([t, w]) => { hh = Math.max(hh, doc.heightOfString(t, { width: w - 4 })); });
            COLS.forEach(([t, w], k) => doc.text(t, colX[k] + 2, yy + 3, { width: w - 4 }));
            const bot = yy + hh + 6;
            hline(bot);
            return bot;
        };
        let segStart = y;   // vertical borders are drawn per page segment
        let rowY = drawGridHeader(y);
        doc.font('Helvetica').fontSize(7).fillColor('#000');
        g.items.forEach((i, idx) => {
            i._sno = idx + 1;
            const cellHs = COLS.map(([, w, f]) => doc.heightOfString(String(f(i) || ' '), { width: w - 4 }));
            const rh = Math.max(12, Math.max(...cellHs) + 6);
            if (rowY + rh > 780) {                       // page break: close this segment's verticals
                colX.forEach(x => vline(x, segStart, rowY));
                doc.addPage(); segStart = 30; rowY = drawGridHeader(30);
                doc.font('Helvetica').fontSize(7).fillColor('#000');
            }
            COLS.forEach(([, w, f], k) => doc.text(String(f(i) || ''), colX[k] + 2, rowY + 3, { width: w - 4 }));
            rowY += rh;
            hline(rowY);
        });
        // Grand-total band, their wording and placement.
        const gtH = 16;
        doc.font('Helvetica-Bold').fontSize(8)
           .text('Grand Total:', L + 4, rowY + 4, { width: 60 })
           .text(n2(g.value), L + 66, rowY + 4, { width: 90 });
        doc.font('Helvetica-Bold').fontSize(8)
           .text('Total Quantity:', midX + 6, rowY + 4, { width: 70 })
           .text(String(g.received), midX + 80, rowY + 4, { width: 60 });
        rowY += gtH;
        hline(rowY);
        colX.forEach(x => vline(x, segStart, rowY - gtH));   // grid verticals stop above the total band
        vline(L, segStart, rowY); vline(R, segStart, rowY);  // outer frame includes the total band

        doc.font('Helvetica').fontSize(6.5).fillColor('#9a9a9a')
           .text(`Generated from EasyEcom GRN data by Pravidhi · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
                 L, rowY + 8, { width: W });
        doc.end();
    } catch (e) {
        console.error('[GRN pdf]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
module.exports.rawVendors = rawVendors;   // po_approvals' draft-PO PDF needs address/TIN/state
