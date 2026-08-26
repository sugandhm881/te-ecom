// Purchase Orders — read-only view of EasyEcom's PO book (Inventory → Purchase Order).
//
// Source: GET {EASYECOM_BASE_URL}/wms/V2/getPurchaseOrderDetails
//   headers: x-api-key: <EASYECOM_API_KEY>   Authorization: Bearer <JWT>
// The JWT auto-refreshes through the existing getEasyecomToken() helper, so this inherits the same
// token handling as every other EasyEcom call — no second auth path to keep alive.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const config = require('../../config');
const { getEasyecomToken } = require('./easyecom');
const { supabase } = require('../supabase');   // product names for the SKU picker

// ⚠️ THE ENDPOINT IS CURSOR-PAGINATED AND THE PAGE IS TINY (`limit` is capped at 10 server-side — asking
// for more is a hard 400). The first response carries 5 POs plus a `nextUrl` cursor, so `nextUrl` is
// followed to exhaustion. PAGE_CAP is a runaway guard, not a limit we expect to reach; if it is ever hit
// the response says so rather than quietly truncating.
const PAGE_CAP = 300;

// ⚠️⚠️ **WITHOUT A DATE PARAM THE ENDPOINT RETURNS ONLY A RECENT SLICE — SILENTLY.**
// Called bare it returned **9 POs (06–12 Aug)** while the EasyEcom portal listed six "Waiting for
// Approval" POs going back to 28 Jul, four of which we never saw. There is no error, no flag, no
// truncation notice — just a short list that looks complete. Reported by the user, not by the code.
// `created_after=<date>` (equivalently `updated_after`) widens it: the same account returns **69 POs
// back to 18 Feb 2026** over 14 pages in ~2s. Note that `start_date` / `from_date` / `date_from` /
// `po_created_after` are all ACCEPTED AND SILENTLY IGNORED — they return the default 9 — so the
// parameter name had to be found by probing, and a wrong guess looks exactly like success.
// The lookback is deliberately generous: a purchase order is a live document and an open PO from
// months ago is precisely the one you must not lose.
const DEFAULT_LOOKBACK_DAYS = 730;
// A PO line still owed to us this long after it was raised has, in practice, been forgotten. It stays
// in the subtraction (EasyEcom still calls it open) but is flagged, because a stale remnant silently
// suppressing a re-order is the failure mode this number causes.
const PO_STALE_DAYS = 45;

// EasyEcom is rate-limited and this data changes a few times a day at most, so a short cache keeps the
// page snappy without hammering them. `?fresh=1` (the Refresh button) always recomputes.
let _poCache = null;
const PO_TTL = 3 * 60 * 1000;

// OFFICIAL EasyEcom status mapping (supplied 2026-08-13 with the updatePoStatus docs). Until then these
// were shown as raw ids because the meaning was unverified — and that caution paid: the natural guesses
// were WRONG. **4 is Rejected, not Cancelled** (Cancelled is 7), and **3 is Approved, not
// "partially received"**. Labelling 4 "Cancelled" would have told the buyer a live rejected PO was dead.
const PO_STATUS = {
    1: 'Open', 2: 'Waiting for approval', 3: 'Approved', 4: 'Rejected', 5: 'Completed',
    6: 'Pending on supplier', 7: 'Cancelled', 8: 'Payment pending', 9: 'Payment done',
    11: 'Shipped to FF', 12: 'Pending dispatch on FF', 13: 'Shipped', 14: 'Shipped by FF',
    15: 'Received by FF', 16: 'Invoice done by vendor',
};
const statusLabel = id => PO_STATUS[id] || `Status ${id}`;
// Terminal states — a PO here is finished and should not be counted as inbound stock, however its
// pending_quantity reads. A Rejected or Cancelled PO with 10,000 units "pending" is not 10,000 units
// on their way; that is exactly the number a buyer would act on wrongly.
// ⚠️ COMPLETED (5) IS TERMINAL TOO (added 2026-08-20). A short-closed PO — goods received by a GRN
// that was never linked to it, then the PO marked Completed — keeps its pending_quantity FROZEN
// forever. Two live POs (49: 2,441 × TE-BDR1; 50: 2,022 × TE-2SAS1 + 254 × TE-LB1) sat "Completed"
// with 4,717 phantom inbound units, so the reorder sheet under-ordered those SKUs indefinitely.
// Marking a PO Completed IS EasyEcom's way of closing it short; the subtraction must respect that.
const PO_DEAD = new Set([4, 5, 7]);

const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
// ⚠️ **`tax_rate` COMES BACK AS THE STRING "18%", NOT THE NUMBER 18.** `Number("18%")` is NaN, so a plain
// numeric parse silently reports every line as 0% — which made the net/gross split a no-op and left the
// re-taxing bug in place while looking like it had been fixed. Strip everything that is not a number.
const pct = v => {
    if (v == null) return 0;
    const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
    return isFinite(n) ? n : 0;
};
// Strip tax from a stored (gross) price. A line genuinely recorded at 0% has no tax in it and is
// returned as is — un-grossing that with a guessed rate would invent a discount never given.
const netOf = (gross, taxRate) => {
    const t = pct(taxRate);
    if (!t) return Math.round(gross * 10000) / 10000;
    return Math.round((gross / (1 + t / 100)) * 10000) / 10000;
};

async function fetchAllPurchaseOrders(sinceISO) {
    const jwt = await getEasyecomToken();
    const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
    const headers = {
        'x-api-key': config.EASYECOM_API_KEY,
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
    };
    let url = `${base}/wms/V2/getPurchaseOrderDetails?created_after=${encodeURIComponent(sinceISO)}`;
    const rows = [];
    let pages = 0, truncated = false;
    while (url) {
        if (pages >= PAGE_CAP) { truncated = true; break; }
        let r = await axios.get(url, { headers, timeout: 30000, validateStatus: () => true });
        // ⚠️ A 429 MID-WALK RETRIES THIS PAGE, NEVER THE WHOLE WALK (2026-08-26). The old recovery
        // re-fetched every earlier page too, DOUBLING the burst that tripped the limiter — which is
        // why "EasyEcom HTTP 429" kept coming back. Backoff grows per attempt; the cursor stays valid.
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
        // nextUrl comes back as a PATH ('/wms/V2/...?cursor=…'), so it needs the base prefixed.
        url = String(body.nextUrl).startsWith('http') ? body.nextUrl : base + body.nextUrl;
        await new Promise(s => setTimeout(s, 150));   // pace the limiter — 14 back-to-back pages is what trips it
    }
    return { rows, pages, truncated };
}

// The SHAPED PO book behind one short cache, shared with the GRN dashboard — without it the two
// pages walked the same 14 EasyEcom pages independently within seconds of each other, which is
// exactly the burst their limiter punishes. `fresh` (the Refresh button) always re-walks.
let _poBookCache = null;
const PO_BOOK_TTL = 3 * 60 * 1000;
async function poBookCached(sinceISO, fresh) {
    if (!fresh && _poBookCache && _poBookCache.key === sinceISO && Date.now() - _poBookCache.t < PO_BOOK_TTL) return _poBookCache.rows;
    const { rows } = await fetchAllPurchaseOrders(sinceISO);
    const shaped = rows.map(shapePo);
    _poBookCache = { t: Date.now(), key: sinceISO, rows: shaped };
    return shaped;
}

// The vendor master. Derived from PO history at first, which only ever knew suppliers we had already
// ordered from — this lists every active vendor, and carries the `vendor_code` needed as a fallback id.
async function fetchVendors() {
    const jwt = await getEasyecomToken();
    const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
    const headers = { 'x-api-key': config.EASYECOM_API_KEY, 'x_api_key': config.EASYECOM_API_KEY,
        'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' };
    let url = `${base}/wms/V2/getVendors`;
    const rows = [];
    for (let pages = 0; url && pages < 40; pages++) {
        const r = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
        if (r.status !== 200 || !r.data) break;
        const page = Array.isArray(r.data.data) ? r.data.data : [];
        rows.push(...page);
        if (!page.length || !r.data.nextUrl) break;
        url = String(r.data.nextUrl).startsWith('http') ? r.data.nextUrl : base + r.data.nextUrl;
    }
    return rows
        .filter(v => v && v.vendor_name && String(v.active) !== '0')   // don't offer a disabled supplier
        .map(v => ({
            id: v.vendor_c_id || null,
            code: v.vendor_code || null,
            name: v.vendor_name,
            email: v.email || null,
            paymentTerm: v.paymentTerm || null,
            deliveryTerm: v.deliveryTerm || null,
            // The vendor's dispatch city, offered as the delivery-address default on the create form.
            city: (v.address && v.address.dispatch && v.address.dispatch.city) || null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// Build the SKU picker list: every SKU we have ordered before, with the most recent price / tax /
// supplier, plus a human product name joined from our own inventory tables (EasyEcom's PO lines carry
// no description). Picking a SKU can then pre-fill the price the buyer last paid, which is both faster
// and a check — a price that jumps against last time is visible before the PO is raised.
// ⚠️ **GST CANNOT COME FROM PO HISTORY — EasyEcom returns `tax_rate: 0` on ALL 114 live line items.**
// Pre-filling from history would therefore have quietly put 0% GST on every new PO, which is worse than
// leaving it blank: a zero looks deliberate. HSN is present though (33049990 ×73, 30049011 ×22, 3304 ×2),
// and in India the HSN chapter is what sets the rate, so the suggestion is derived from that instead.
// These are the standard rates for those chapters — **treated as a SUGGESTION the buyer can overwrite,
// shown next to the HSN it came from**, never as an assertion. Rates change and misclassification is a
// compliance problem, so this must stay visible and editable rather than silent.
const HSN_GST = {
    '3304': 18, '33049990': 18, '33049910': 18, '33051090': 18,   // cosmetics / beauty preparations
    '30049011': 12, '30049099': 12, '3004': 12,                    // ayurvedic & other medicaments
    '34011190': 18, '96032100': 18,
};
function gstFromHsn(hsn) {
    const h = String(hsn || '').trim();
    if (!h) return null;
    if (HSN_GST[h] != null) return HSN_GST[h];
    // Fall back to the 4-digit chapter heading — 33049990 and 33041000 are both chapter 3304.
    const head = h.slice(0, 4);
    return HSN_GST[head] != null ? HSN_GST[head] : null;
}

// ── EasyEcom product master — the SKU universe, live ─────────────────────────────────────────────
// Why this exists: the picker was built ONLY from PO history, so a SKU that had never been on a PO
// could never be put on one — a chicken-and-egg that blocked exactly the first order of every new
// product (reported 2026-08-19 on TE-ABD1, created in EasyEcom at 12:52 the same day; no snapshot,
// count or case-size table had it either, and none would until the nightly snapshot). The master is
// the only source that knows a SKU the moment it is created. ~126 products, one or two pages.
// ⚠️ Auth needs BOTH headers — `x-api-key` AND the Bearer token. With only the Bearer this endpoint
// returns 403 Forbidden (verified live), even though PO endpoints accept the same token happily.
// Cached in-process for 10 min: the dashboard reloads the picker often, new SKUs appear rarely.
let _pmCache = { at: 0, rows: [] };
async function fetchProductMaster() {
    if (Date.now() - _pmCache.at < 10 * 60 * 1000) return _pmCache.rows;
    const jwt = await getEasyecomToken();
    const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
    const headers = { 'x-api-key': config.EASYECOM_API_KEY, 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' };
    let url = `${base}/Products/GetProductMaster?limit=200&offset=0`;
    const rows = [];
    for (let pages = 0; url && pages < 20; pages++) {
        const r = await axios.get(url, { headers, timeout: 30000, validateStatus: () => true });
        if (r.status !== 200 || !r.data) throw new Error(`GetProductMaster HTTP ${r.status}`);
        rows.push(...(Array.isArray(r.data.data) ? r.data.data : []));
        url = r.data.nextUrl ? (String(r.data.nextUrl).startsWith('http') ? r.data.nextUrl : base + r.data.nextUrl) : null;
    }
    _pmCache = { at: Date.now(), rows };
    return rows;
}
// Master `tax_rate` is a FRACTION (0.18 = 18%, 0.05 = 5% — verified on live products); a null stays null.
const pctFromFraction = v => (v != null && isFinite(v) && v > 0 && v < 1) ? Math.round(v * 10000) / 100 : null;

async function skuCatalogue(pos) {
    const latest = {};
    const history = {};
    pos.forEach(p => (p.items || []).forEach(i => {
        const sku = String(i.sku || '').trim(); if (!sku) return;
        // Price history, newest first — cost is NOT stable here (TE-BDR1 has been ordered at 27.3, 27.5,
        // 28.875 and 30.135), so the buyer needs to SEE the movement, not just inherit the last number.
        (history[sku] = history[sku] || []).push({ price: i.netPrice, gross: i.grossPrice, tax: i.taxRate, at: p.createdAt, vendor: p.vendor });
        const cur = latest[sku];
        if (!cur || String(p.createdAt || '') > String(cur.at || '')) {
            latest[sku] = { at: p.createdAt, price: i.netPrice, gross: i.grossPrice, taxRate: i.taxRate, hsn: i.hsn, vendor: p.vendor, vendorId: p.vendorId };
        }
    }));
    const skus = Object.keys(latest).sort();
    // The live product master joins the party for two jobs: NAMES for history SKUs our tables don't
    // know, and — the important one — SKUs never ordered before, which PO history is blind to by
    // definition. A master failure degrades to the old history-only picker, never blocks it.
    let masterBySku = {};
    try {
        (await fetchProductMaster()).forEach(p => { const k = String(p.sku || '').trim(); if (k) masterBySku[k] = p; });
    } catch (e) { console.warn('[PO skuCatalogue] product master failed — picker limited to PO history:', e.message); }
    const names = {};
    try {
        // Two sources, newest wins. Neither is a product master, but between them they cover the range.
        if (skus.length) for (const t of ['inventory_snapshots', 'inventory_counts_ecom']) {
            const { data } = await supabase.from(t).select('sku, product_name').in('sku', skus).not('product_name', 'is', null);
            (data || []).forEach(r => { const k = String(r.sku || '').trim(); if (k && !names[k]) names[k] = r.product_name; });
        }
    } catch (e) { console.warn('[PO skuCatalogue] name lookup failed:', e.message); }   // names are a nicety, never a blocker
    // Active master products with no PO history — the "first order" rows. Price/tax context comes from
    // the master itself: `cost` (labelled as such in the UI, it is EasyEcom's cost field, not a price we
    // ever paid) and `tax_rate` (a FRACTION; product-specific, set at product creation) with the HSN
    // chapter as fallback. Inactive products stay out — a discontinued SKU on the picker is a trap.
    // Combos are excluded: a combo_product is a bundle EasyEcom assembles from child SKUs, not a thing
    // a supplier sells — 53 of the 124 active products, none of which has ever been on a PO. Children
    // and normal products stay, including oddly-named marketplace imports (brand "Unknown"): hiding by
    // name/brand guesswork could bury a legitimate SKU, and the tail only surfaces when searched.
    const fresh = Object.values(masterBySku)
        .filter(p => p.active === 1 && p.product_type !== 'combo_product' && !latest[String(p.sku).trim()])
        .map(p => {
            const sku = String(p.sku).trim();
            const hsn = p.hsn_code || null;
            const masterTax = pctFromFraction(p.tax_rate);
            const suggestedTax = masterTax != null ? masterTax : gstFromHsn(hsn);
            return {
                sku, name: p.product_name || null, neverOrdered: true,
                lastPrice: null, lastGrossPrice: null, lastLineTaxRate: null,
                lastVendor: null, lastVendorId: null, lastOrderedAt: null,
                orderCount: 0, prevPrice: null, prevPriceAt: null, priceChanged: false,
                masterCost: (isFinite(p.cost) && p.cost > 0) ? Number(p.cost) : null,
                hsn, suggestedTax,
                taxSource: masterTax != null ? 'product master' : (suggestedTax != null ? `HSN ${hsn}` : null),
            };
        })
        .sort((a, b) => a.sku.localeCompare(b.sku));
    // History rows FIRST — buyers mostly reorder, so the familiar SKUs stay on top and the
    // never-ordered tail sits below them; the search box reaches both equally.
    return skus.map(sku => {
        const h = (history[sku] || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
        const prices = [...new Set(h.map(x => x.price))];
        const prev = h.find(x => x.price !== latest[sku].price);   // the last DIFFERENT price, if any
        // ⚠️ GST FOR HISTORY ROWS COMES FROM THE PRODUCT MASTER FIRST (fixed 2026-08-27, user-reported
        // on TE-AAD1: "no HSN on record" though EasyEcom held everything). Two failures stacked up:
        // PO lines carry no HSN for newer SKUs, so the HSN-chapter guess had nothing to read — and
        // even WITH an HSN the chapter guess is a genus, not the product: 30049011 suggests 12% while
        // TE-AAD1's configured rate is 5% (EasyEcom's own PO prints IGST-5%). The master's per-product
        // `tax_rate` (a FRACTION) is the configured truth; the HSN chapter stays as the fallback.
        const m = masterBySku[sku];
        const hsn = latest[sku].hsn || (m && m.hsn_code) || null;
        const masterTax = m ? pctFromFraction(m.tax_rate) : null;
        const suggestedTax = masterTax != null ? masterTax : gstFromHsn(hsn);
        return {
            sku, name: names[sku] || (masterBySku[sku] && masterBySku[sku].product_name) || null,
            // ⚠️ lastPrice is the NET (tax-exclusive) figure — the one CreatePurchaseOrder expects. The
            // gross is carried alongside so the UI can show what was actually invoiced, but the two are
            // never merged: mixing them is what would re-tax a SKU on every re-order.
            lastPrice: latest[sku].price,
            lastGrossPrice: latest[sku].gross,
            lastLineTaxRate: latest[sku].taxRate,
            lastVendor: latest[sku].vendor, lastVendorId: latest[sku].vendorId,
            lastOrderedAt: latest[sku].at ? String(latest[sku].at).slice(0, 10) : null,
            orderCount: h.length,
            // Cost context: the previous different price and when, so a rise is visible at the moment of
            // ordering rather than when the invoice arrives.
            prevPrice: prev ? prev.price : null,
            prevPriceAt: prev && prev.at ? String(prev.at).slice(0, 10) : null,
            priceChanged: prices.length > 1,
            hsn,
            // `taxSource` tells the UI (and the buyer) where the number came from, so an inherited
            // rate is never mistaken for a confirmed one.
            suggestedTax,
            taxSource: masterTax != null ? 'product master' : (suggestedTax != null ? `HSN ${hsn}` : null),
        };
    }).concat(fresh);
}

// Shape one PO for the UI. Quantities and money are normalised to numbers here so the client never has
// to parse EasyEcom's stringified decimals ("798.0000") — doing that per-render is where rounding drift
// creeps in.
function shapePo(p) {
    const items = (p.po_items || []).map(i => ({
        detailId: i.purchase_order_detail_id, productId: i.product_id, sku: i.sku || '',
        ean: i.ean || null, hsn: i.hsn || null, modelNo: i.model_no || null,
        description: i.product_description || null,
        qty: num(i.original_quantity), pending: num(i.pending_quantity),
        received: num(i.original_quantity) - num(i.pending_quantity),
        // ⚠️⚠️ **`item_price` IS TAX-INCLUSIVE (GROSS); CreatePurchaseOrder's `unitPrice` IS NET.**
        // Proven on our own POs: we sent unitPrice 15 with taxRate 18 and EasyEcom stored 17.70
        // (= 15 × 1.18); we sent 70 and it stored 82.60. Feeding the stored figure back into the
        // create form therefore RE-TAXES IT EVERY TIME — 15 → 17.70 → 20.89 → 24.65 over three
        // re-orders. Both are now carried explicitly so the two can never be confused again.
        // Historic lines carry tax_rate 0 (tax was not recorded then), so for those net == gross —
        // faithful to what EasyEcom actually stores rather than a guess at what was meant.
        grossPrice: num(i.item_price),
        netPrice: netOf(num(i.item_price), i.tax_rate),
        price: num(i.item_price),                       // kept: existing readers expect the stored value
        lineValue: num(i.item_price) * num(i.original_quantity),
        taxRate: i.tax_rate != null ? pct(i.tax_rate) : null, taxType: i.tax_type || null,
    }));
    const qty = items.reduce((a, i) => a + i.qty, 0);
    const pending = items.reduce((a, i) => a + i.pending, 0);
    const itemsValue = items.reduce((a, i) => a + i.lineValue, 0);
    const total = num(p.total_po_value);
    return {
        poId: p.po_id, poNumber: p.po_number, ref: p.po_ref_num || null,
        statusId: p.po_status_id, status: statusLabel(p.po_status_id),
        createdAt: p.po_created_date || null, updatedAt: p.po_updated_date || null,
        expectedAt: p.expected_delivery_date || null, expiresAt: p.po_expiry_date || null,
        warehouse: p.po_created_warehouse || null,
        vendor: p.vendor_name || null, vendorCode: p.vendor_code || null,
        // vendor_c_id is what CreatePurchaseOrder wants as `vendorId`, so the create form can offer
        // suppliers we have actually ordered from instead of asking for a raw id.
        vendorId: p.vendor_c_id || null,
        totalValue: total, itemsValue: Math.round(itemsValue * 100) / 100,
        // Verified 9/9 agreement on live data, but surfaced rather than assumed — if EasyEcom's header
        // total ever drifts from the line items, that is worth SEEING, not silently preferring one.
        valueMismatch: Math.abs(itemsValue - total) > 1,
        qty, pending, received: qty - pending,
        // ⚠️ "Open" = units still owed to us AND the PO is not dead. Pending quantity alone is not enough:
        // a Rejected (4) or Cancelled (7) PO keeps its pending_quantity, so counting it would report
        // stock as inbound that nobody is ever going to ship. On live data 3 of the 13 pending POs are
        // in a dead state. `isDead` is kept on the row so the UI can grey them rather than hide them.
        isDead: PO_DEAD.has(p.po_status_id),
        isOpen: pending > 0 && !PO_DEAD.has(p.po_status_id),
        // Status 2 = EasyEcom's "Waiting for Approval" (confirmed against the portal, 6/6). Kept as its
        // own flag so the dashboard can show the SAME number the portal does, without conflating it with
        // "has units outstanding" — a partially-received PO also has pending units but is already approved.
        awaitingApproval: p.po_status_id === 2,
        lineCount: items.length, items,
    };
}

// GET /api/purchase-orders?fresh=1
router.get('/purchase-orders', async (req, res) => {
    try {
        if (!config.EASYECOM_API_KEY) return res.status(500).json({ success: false, error: 'EASYECOM_API_KEY is not set in .env' });
        const days = Math.min(3650, Math.max(1, parseInt(req.query.days || DEFAULT_LOOKBACK_DAYS, 10) || DEFAULT_LOOKBACK_DAYS));
        const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const cacheKey = since;
        if (!req.query.fresh && _poCache && _poCache.key === cacheKey && Date.now() - _poCache.t < PO_TTL) {
            return res.json({ ..._poCache.v, cached: true });
        }
        // Vendors come from the master, POs from the book — fetched together.
        const [{ rows, pages, truncated }, vendorMaster] = await Promise.all([
            fetchAllPurchaseOrders(since),
            fetchVendors().catch(e => { console.warn('[PO] vendor master failed:', e.message); return []; }),
        ]);
        const pos = rows.map(shapePo).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

        // ⚠️ PO LINES ARRIVE WITH NO PRODUCT NAME, AND FOR NEWER SKUS NO EAN/HSN EITHER (user-reported
        // 2026-08-27: TE-ABD1 showed — / — / — on the page while the product master holds all three;
        // TE-BFW1 had HSN only). EasyEcom simply doesn't copy master fields onto PO lines. Enriched
        // from the master here — EasyEcom's own value wins whenever it IS present, and a master
        // failure just leaves the dashes (never blocks the book).
        try {
            const bySku = {};
            (await fetchProductMaster()).forEach(p => { const k = String(p.sku || '').trim(); if (k) bySku[k] = p; });
            pos.forEach(p => p.items.forEach(i => {
                const m = bySku[String(i.sku || '').trim()];
                if (!m) return;
                if (!i.description) i.description = m.product_name || null;
                if (!i.ean) i.ean = m.EANUPC || null;
                if (!i.hsn) i.hsn = m.hsn_code || null;
            }));
        } catch (e) { console.warn('[PO] master enrichment failed — line names/EAN/HSN may show dashes:', e.message); }

        const open = pos.filter(p => p.isOpen);
        const uniq = (f) => { const c = {}; pos.forEach(p => { const k = f(p); if (k) c[k] = (c[k] || 0) + 1; });
            return Object.entries(c).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count); };
        const sum = (arr, f) => Math.round(arr.reduce((a, x) => a + f(x), 0) * 100) / 100;

        // Value still to arrive = the pending units at their line price, NOT the whole PO value — a PO
        // that is 90% received does not have 100% of its money outstanding.
        const pendingValue = sum(open, p => p.items.reduce((a, i) => a + i.pending * i.price, 0));

        const payload = {
            success: true,
            fetchedAt: new Date().toISOString(),
            pages, truncated, since, lookbackDays: days,
            summary: {
                total: pos.length,
                open: open.length,
                awaitingApproval: pos.filter(p => p.awaitingApproval).length,
                closed: pos.length - open.length,
                totalValue: sum(pos, p => p.totalValue),
                openValue: sum(open, p => p.totalValue),
                pendingValue,
                pendingUnits: open.reduce((a, p) => a + p.pending, 0),
                totalUnits: pos.reduce((a, p) => a + p.qty, 0),
                vendors: uniq(p => p.vendor).length,
                lineItems: pos.reduce((a, p) => a + p.lineCount, 0),
                mismatches: pos.filter(p => p.valueMismatch).length,
            },
            vendors: uniq(p => p.vendor),
            // Every ACTIVE vendor, not just ones we have ordered from before, each with the code that
            // serves as a fallback id. Order count is joined on so the picker can show familiarity.
            vendorOptions: vendorMaster.map(v => ({ ...v,
                orders: pos.filter(p => p.vendorId === v.id || p.vendor === v.name).length })),
            // SKUs previously ordered, each carrying what we LAST paid and to whom. EasyEcom sends no
            // product_description on PO lines (0 of 114 live), so the readable name is joined in from our
            // own inventory data below — a picker showing only "TE-BDR1" makes the buyer look it up
            // elsewhere, which is where wrong-SKU orders come from.
            skuOptions: await skuCatalogue(pos),
            warehouses: uniq(p => p.warehouse),
            statuses: uniq(p => p.status),
            purchaseOrders: pos,
        };
        _poCache = { t: Date.now(), key: cacheKey, v: payload };
        res.json(payload);
    } catch (e) {
        console.error('[PurchaseOrders]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── WRITES ───────────────────────────────────────────────────────────────────────────────────────
// Creating a PO commits the company to a purchase; changing a status can approve, reject or cancel a
// live order. Both are gated on their OWN capability (`purchase-orders-write`) rather than on view
// access — reading the PO book is a reporting need, raising one is a buying decision.
//
// ⚠️ NEITHER WAS EVER FIRED AGAINST EASYECOM DURING DEVELOPMENT. Validation and permission paths were
// exercised; the outbound call was not, because the only way to "test" it is to create a real purchase
// order or move a real one's status. Same rule as the RapidShyp NDR action. **The first live run should
// be one small PO you are willing to see in EasyEcom.**
function canWritePo(req) {
    const u = req.user || {};
    if (u.role === undefined && u.permissions === undefined) return true;   // legacy bootstrap admin
    if (u.role === 'admin') return true;
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    return perms.includes('*') || perms.includes('purchase-orders-write');
}
const denyWrite = res => res.status(403).json({ success: false, error: 'You do not have permission to create or change purchase orders.' });

// Statuses a user may set from here. Deliberately a SUBSET of EasyEcom's 16: the fulfilment-centre
// codes (11–16) describe things FF tells us, not decisions we make, and setting them by hand would
// invent a state nothing else agrees with.
const PO_SETTABLE = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());

// Read one PO's current status straight from EasyEcom. Used after a create so the response reports what
// ACTUALLY happened rather than what we asked for — the difference between those two is the whole bug
// this exists to catch.
async function readPoStatus(poId) {
    try {
        const jwt = await getEasyecomToken();
        const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
        const headers = { 'x-api-key': config.EASYECOM_API_KEY, 'x_api_key': config.EASYECOM_API_KEY,
            'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' };
        // A brand-new PO is in the last day or two, so a short window finds it in one or two pages.
        const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
        let url = `${base}/wms/V2/getPurchaseOrderDetails?created_after=${since}`;
        for (let p = 0; url && p < 20; p++) {
            const r = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
            if (r.status !== 200 || !r.data) return null;
            const hit = (r.data.data || []).find(x => x.po_id === poId);
            if (hit) return hit.po_status_id;
            if (!r.data.nextUrl) return null;
            url = String(r.data.nextUrl).startsWith('http') ? r.data.nextUrl : base + r.data.nextUrl;
        }
    } catch (e) { console.warn('[PO create] status read-back failed:', e.message); }
    return null;
}

// Shared status writer — used by the status route AND by create (which has to correct EasyEcom's
// auto-approve). One implementation so the two can never drift on how success is judged.
async function setPoStatus(poId, status, markComplete) {
    try {
        const jwt = await getEasyecomToken();
        const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
        const r = await axios.post(`${base}/wms/updatePoStatus`,
            { po_id: poId, po_status: status, markPoComplete: markComplete ? 1 : 0 },
            { headers: { 'x-api-key': config.EASYECOM_API_KEY, 'x_api_key': config.EASYECOM_API_KEY,
                'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
              timeout: 30000, validateStatus: () => true });
        const body = r.data || {};
        // ⚠️⚠️ **THIS ENDPOINT REPORTS FAILURE UNDER `status`, NOT `code`.** A rejected update returns
        // `HTTP 200 {"status":400,"message":"PO cannot be moved to Waiting for Approval status"}`.
        // The original check only looked at `body.code`, so that came back as SUCCESS — the create flow
        // then reported "Waiting for approval" while the PO sat on Approved. A false success is worse
        // than an error, because nobody re-checks it. BOTH keys are now inspected.
        const failCode = (body && typeof body === 'object') ? (body.code != null ? body.code : body.status) : null;
        const bodyFailed = failCode != null && failCode !== 200 && failCode !== 201;
        if (r.status < 200 || r.status >= 300 || bodyFailed) {
            return { ok: false, error: (body && body.message) || `EasyEcom HTTP ${r.status}`, easyecom: body };
        }
        return { ok: true, easyecom: body };
    } catch (e) { return { ok: false, error: e.message }; }
}

// The ACTUAL EasyEcom write, shared by the direct route below and the PO-APPROVAL flow
// (po_approvals.js) — one implementation so the two can never drift on validation, the vendor_id
// trap, the status read-back, or how success is judged. Returns { http, body } for res.status().json().
async function performPoCreate(b, actorSub) {
    try {
        const vendorId = parseInt(b.vendorId, 10);
        const items = Array.isArray(b.items) ? b.items : [];
        const errs = [];
        if (!vendorId && !String(b.vendorCode || '').trim()) errs.push('a supplier is required');
        // ⚠️ referenceCode IS MANDATORY — undocumented, discovered on the first live attempt. EasyEcom
        // rejects with **HTTP 200 and code 400** in the body ("referenceCode field is mandatory/cannot be
        // left blank"), which is precisely why the create path never trusts the HTTP status alone.
        // Validated here so a blank one fails instantly instead of costing a round trip.
        if (!String(b.referenceCode || '').trim()) errs.push('referenceCode is required (EasyEcom rejects a blank one)');
        if (!isoDate(b.expDeliveryDate)) errs.push('expDeliveryDate must be YYYY-MM-DD');
        if (!items.length) errs.push('at least one line item is required');
        items.forEach((it, i) => {
            const n = `item ${i + 1}`;
            if (!String(it.sku || '').trim()) errs.push(`${n}: sku is required`);
            const q = Number(it.quantity);
            if (!isFinite(q) || q <= 0) errs.push(`${n}: quantity must be greater than 0`);
            const p = Number(it.unitPrice);
            if (!isFinite(p) || p < 0) errs.push(`${n}: unitPrice must be 0 or more`);
        });
        if (errs.length) return { http: 400, body: { success: false, error: errs.join(' · '), errors: errs } };

        // ⚠️⚠️ **THE FIELD IS `vendor_id` (snake_case), NOT `vendorId` AS DOCUMENTED.**
        // EasyEcom's own CreatePurchaseOrder sample shows `"vendorId": 100176`, but sending our numeric
        // vendor id that way is rejected: *"Vendor cannot be found with vendorId 260128 or vendor_id"*.
        // That message is the clue — it looks `vendorId` up as a vendor CODE and `vendor_id` as the
        // numeric id. Proven by probing with a deliberately invalid SKU (so nothing could be created):
        //     vendorId: 260128   → "Vendor cannot be found"      ✗
        //     vendor_id: 260128  → "Unable to find the sku…"     ✓ vendor resolved
        //     vendorId: "VCPL"   → "Unable to find the sku…"     ✓ (the CODE works under vendorId)
        // We send the numeric `vendor_id`, and only fall back to the code when a numeric id is missing —
        // sending both invites them to disagree.
        const vendorCode = String(b.vendorCode || '').trim();
        const payload = {
            ...(vendorId ? { vendor_id: vendorId } : { vendorId: vendorCode }),
            referenceCode: String(b.referenceCode || '').trim() || undefined,
            address: String(b.address || '').trim() || undefined,
            expDeliveryDate: b.expDeliveryDate,
            shippingCost: Number(b.shippingCost) || 0,
            createOrUpdate: 'I',           // 'I' = insert. Update/cancel are NOT exposed from this route.
            isCancel: 0,
            // Ask for "Waiting for approval" at creation. ⚠️ UNPROVEN: EasyEcom silently ignores unknown
            // fields — probing showed a bare control request and every candidate status field behaving
            // identically — so these may do nothing. They are sent because they cost nothing if ignored
            // and are the only lever the API might offer; whether they work is decided by looking at the
            // status of the PO that comes back, which is exactly what the response now reports.
            po_status: 2, poStatus: 2,
            docNumber: String(b.docNumber || '').trim() || undefined,
            updateTaxRate: b.updateTaxRate ? 1 : 0,
            items: items.map((it, i) => {
                const line = {
                    lineItemNumber: String(it.lineItemNumber || (i + 1)),
                    sku: String(it.sku).trim(),
                    quantity: String(Number(it.quantity)),
                    unitPrice: Number(it.unitPrice),
                };
                if (it.taxRate !== '' && it.taxRate != null) line.taxRate = String(it.taxRate);
                if (it.taxValue !== '' && it.taxValue != null) line.taxValue = Number(it.taxValue);
                if (it.taxType !== '' && it.taxType != null) line.taxType = Number(it.taxType);
                // Batch / serial fields are optional and only sent when actually filled — sending empty
                // strings makes EasyEcom create blank batches.
                if (String(it.batch_code || '').trim()) line.batch_code = String(it.batch_code).trim();
                if (String(it.batch_mrp || '').trim()) line.batch_mrp = String(it.batch_mrp).trim();
                if (isoDate(it.expiry_date)) line.expiry_date = it.expiry_date;
                if (Array.isArray(it.serials) && it.serials.length) line.serials = it.serials.map(String);
                return line;
            }),
        };

        const jwt = await getEasyecomToken();
        const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
        const r = await axios.post(`${base}/WMS/Cart/CreatePurchaseOrder`, payload, {
            // Both spellings sent: getPurchaseOrderDetails documents `x-api-key`, updatePoStatus
            // documents `x_api_key`. Sending both costs nothing and removes a whole class of 401.
            headers: { 'x-api-key': config.EASYECOM_API_KEY, 'x_api_key': config.EASYECOM_API_KEY,
                'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
            timeout: 30000, validateStatus: () => true,
        });
        const body = r.data || {};
        // ⚠️ DO NOT TRUST HTTP 200 ALONE — EasyEcom returns 200 with a failure code in the body on some
        // errors (the same trap that made the warehouse-router extension report false successes).
        const okCode = body.code === 200 || body.code === 201;
        if (r.status < 200 || r.status >= 300 || !okCode) {
            console.error('[PO create] failed', r.status, JSON.stringify(body).slice(0, 300));
            return { http: 502, body: { success: false, error: body.message || `EasyEcom HTTP ${r.status}`, easyecom: body } };
        }
        _poCache = null;                         // the book changed — never serve a stale list after a write
        const poId = body.data && body.data.poId;
        console.log(`[PO create] poId ${poId} · vendor ${vendorId} · ${payload.items.length} line(s) · by ${actorSub || 'unknown'}`);

        // ⚠️ **CreatePurchaseOrder LANDS THE PO ON "Approved" (status 3), NOT "Waiting for approval".**
        // Verified on PO 70 (id 2144985): created straight into status 3, so it would skip the approval
        // step entirely — a PO could reach a supplier without anyone signing it off. There is no
        // documented status parameter on create, so we immediately move it to 2.
        // ⚠️ If that second call fails the PO still EXISTS, and approved. That is reported loudly rather
        // than swallowed: a half-completed write silently reported as success is the worst outcome here.
        // ⚠️⚠️ **APPROVED → WAITING FOR APPROVAL IS REFUSED BY EASYECOM.** Verified against a live PO:
        // `updatePoStatus` answers *"PO cannot be moved to Waiting for Approval status"*. So a PO that
        // lands on Approved CANNOT be corrected afterwards — it has to be created in the right state,
        // which is why the status hints go in the create payload above rather than as a follow-up call.
        // Rather than assert the status, we READ IT BACK and report what actually happened.
        let landedStatus = null, statusWarning = null;
        if (poId) {
            const check = await readPoStatus(poId);
            landedStatus = check;
            if (check === 3) {
                statusWarning = 'EasyEcom created this PO as APPROVED, not "Waiting for approval" — and it will not allow an approved PO to be moved back. If your process needs approval, the PO approval workflow has to be enabled on the EasyEcom side.';
                console.warn(`[PO create] poId ${poId} landed on Approved (3) — EasyEcom did not honour the requested status`);
            }
        }
        return { http: 200, body: { success: true, poId,
            status: landedStatus, statusLabel: landedStatus ? statusLabel(landedStatus) : null,
            warning: statusWarning, message: body.message || 'Purchase order created', easyecom: body } };
    } catch (e) {
        console.error('[PO create]', e.message);
        return { http: 500, body: { success: false, error: e.message } };
    }
}

// POST /api/purchase-orders/create — the DIRECT write. ⚠️ Since the PO-APPROVAL flow went in
// (2026-08-27), every PO is meant to travel submit → approve → create; this route stays only as an
// ADMIN escape hatch (a broken approval flow must never mean nobody can buy stock). Non-admins are
// pointed at the approval flow — holding purchase-orders-write now means "may SUBMIT for approval".
router.post('/purchase-orders/create', async (req, res) => {
    if (!canWritePo(req)) return denyWrite(res);
    const u = req.user || {};
    const isAdmin = (u.role === undefined && u.permissions === undefined) || u.role === 'admin'
        || (Array.isArray(u.permissions) && u.permissions.includes('*'));
    if (!isAdmin) return res.status(400).json({ success: false,
        error: 'Purchase orders now go through approval — submit it from the New PO form and an approver will release it to EasyEcom.' });
    const out = await performPoCreate(req.body || {}, u.sub);
    res.status(out.http).json(out.body);
});

// POST /api/purchase-orders/status   { poId, status, markComplete }
router.post('/purchase-orders/status', async (req, res) => {
    if (!canWritePo(req)) return denyWrite(res);
    try {
        const poId = parseInt(req.body && req.body.poId, 10);
        const status = parseInt(req.body && req.body.status, 10);
        const markComplete = req.body && req.body.markComplete ? 1 : 0;
        if (!poId) return res.status(400).json({ success: false, error: 'poId is required' });
        if (!PO_SETTABLE.includes(status)) {
            return res.status(400).json({ success: false,
                error: `status must be one of ${PO_SETTABLE.join(', ')} (${PO_SETTABLE.map(statusLabel).join(' / ')})` });
        }
        const out = await setPoStatus(poId, status, markComplete);
        if (!out.ok) {
            console.error('[PO status] failed', out.error);
            return res.status(502).json({ success: false, error: out.error, easyecom: out.easyecom });
        }
        _poCache = null;
        console.log(`[PO status] po ${poId} → ${status} (${statusLabel(status)})${markComplete ? ' +markComplete' : ''} · by ${(req.user || {}).sub || 'unknown'}`);
        res.json({ success: true, poId, status, statusLabel: statusLabel(status) });
    } catch (e) {
        console.error('[PO status]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── PO DOCUMENT (PDF) ────────────────────────────────────────────────────────────────────────────
// GET /api/purchase-orders/:poId/pdf
//
// EasyEcom's OWN purchase-order PDF is served first — it is the canonical document, in the format a
// supplier expects. The route is `GET /downloadPurchaseOrder?po_id=…`, which returns JSON carrying an
// S3 `file_url`; we fetch that and stream the bytes back.
//
// ⚠️ THE ENDPOINT LIVES ON BOTH HOSTS AND ONLY ONE IS USABLE. The browser calls it on
// **app.easyecom.io**, authenticated by PORTAL SESSION COOKIES (PHPSESSID / laravel_session) — server-side
// that returns `401 Unauthenticated`, and app.easyecom.io is also the host the VPS is WAF-blocked from
// (the reason warehouse routing had to become a browser extension). The SAME path on **api.easyecom.io**
// accepts our ordinary api-key + JWT and returns the file_url. Verified: 401 on app.*, 200 + a 34 KB PDF
// on api.*. **If a portal call ever needs porting, try api.easyecom.io before assuming it needs a session.**
//
// A locally generated PDF remains as a fallback for any PO their generator will not render.
// ⚠️ **EASYECOM GENERATES THE PDF ASYNCHRONOUSLY.** For a PO whose document does not exist yet the first
// call does not fail — it QUEUES a job and replies *"Purchase Order document creation job queued, please
// wait for some time"* with no file_url. Measured across a spread of POs: 4 of 5 returned the document
// immediately, one was queued. Falling straight through to the local generator on that message would mean
// a supplier occasionally receives a differently-formatted document for no visible reason, so the queue
// case is RETRIED briefly first — the job usually completes in seconds.
const PDF_QUEUED = /queued|please wait|in progress|being generated/i;
async function easyecomPoPdf(poId, attempts = 3) {
    const jwt = await getEasyecomToken();
    const base = String(config.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/+$/, '');
    let last = 'unknown error';
    let fileUrl = null, r = null;
    for (let i = 0; i < attempts && !fileUrl; i++) {
        if (i) await new Promise(s => setTimeout(s, 1800));   // give the queued job a moment
        r = await axios.get(`${base}/downloadPurchaseOrder`, {
            params: { po_id: poId },
            headers: { 'x-api-key': config.EASYECOM_API_KEY, 'x_api_key': config.EASYECOM_API_KEY,
                'Authorization': `Bearer ${jwt}`, 'X-Requested-With': 'XMLHttpRequest' },
            timeout: 25000, validateStatus: () => true,
        });
        fileUrl = r.data && r.data.data && r.data.data.file_url;
        last = (r.data && r.data.message) || `EasyEcom HTTP ${r.status}`;
        // Only a QUEUED response is worth retrying; a real error will not fix itself.
        if (!fileUrl && !PDF_QUEUED.test(String(last))) break;
    }
    if (!fileUrl) throw new Error(last);
    // The S3 link is pre-authorised — fetched without our headers, which S3 would reject.
    const f = await axios.get(fileUrl, { timeout: 30000, responseType: 'arraybuffer', validateStatus: () => true });
    const buf = Buffer.from(f.data || []);
    if (f.status !== 200 || buf.slice(0, 4).toString() !== '%PDF') throw new Error(`file_url fetch failed (HTTP ${f.status})`);
    return buf;
}

router.get('/purchase-orders/:poId/pdf', async (req, res) => {
    try {
        const poId = parseInt(req.params.poId, 10);
        if (!poId) return res.status(400).json({ success: false, error: 'poId is required' });

        // EasyEcom's own document first; `?local=1` forces ours (useful if theirs is ever wrong).
        if (req.query.local !== '1') {
            try {
                const buf = await easyecomPoPdf(poId);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('X-PO-Pdf-Source', 'easyecom');
                res.setHeader('Content-Disposition', `attachment; filename="PO-${poId}.pdf"`);
                res.setHeader('Content-Length', buf.length);
                return res.end(buf);
            } catch (e) {
                console.warn(`[PO pdf] EasyEcom document unavailable for ${poId} (${e.message}) — falling back to the generated one`);
                // Passed to the client so the UI can SAY the document is our copy, not EasyEcom's. A
                // supplier-facing document quietly changing format is exactly the kind of thing nobody
                // notices until the supplier asks why the PO looks different.
                res.setHeader('X-PO-Pdf-Reason', String(e.message).slice(0, 140));
            }
        }
        // ⚠️ REUSE THE CACHED BOOK. Refetching all 14 pages to print ONE PO is both slow and a good way
        // to get rate-limited — printing two POs in a row returned EasyEcom HTTP 429 during testing.
        // The cache already holds the shaped POs and the vendor master, so a print normally costs nothing.
        let po = null, vendor = {};
        if (_poCache && _poCache.v) {
            po = (_poCache.v.purchaseOrders || []).find(p => p.poId === poId) || null;
            vendor = (_poCache.v.vendorOptions || []).find(v => v.id === (po && po.vendorId) || v.name === (po && po.vendor)) || {};
        }
        if (!po) {
            const since = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
            const [{ rows }, vendors] = await Promise.all([
                fetchAllPurchaseOrders(since),
                fetchVendors().catch(() => []),
            ]);
            const raw = rows.find(r => r.po_id === poId);
            if (!raw) return res.status(404).json({ success: false, error: `PO ${poId} not found` });
            po = shapePo(raw);
            vendor = vendors.find(v => v.id === po.vendorId || v.name === po.vendor) || {};
        }

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('X-PO-Pdf-Source', 'generated');   // so a fallback is visible, not silent
            res.setHeader('Content-Disposition', `attachment; filename="PO-${po.poNumber}-${String(po.vendor || '').replace(/[^\w]+/g, '-').slice(0, 24)}.pdf"`);
            res.setHeader('Content-Length', pdf.length);
            res.end(pdf);
        });

        const INR = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-IN');
        const dmy = s => s ? String(s).slice(0, 10).split('-').reverse().join('-') : '—';
        const L = 40, R = 555, W = R - L;
        const line = y => doc.moveTo(L, y).lineTo(R, y).strokeColor('#e2e8f0').lineWidth(1).stroke();

        doc.fillColor('#1e293b').fontSize(20).font('Helvetica-Bold').text('PURCHASE ORDER', L, 44);
        doc.fontSize(9).font('Helvetica').fillColor('#64748b')
           .text(`PO ${po.poNumber}`, L, 70).text(`Ref ${po.ref || '—'}`, L, 82);
        doc.fontSize(9).fillColor('#64748b')
           .text(`Raised   ${dmy(po.createdAt)}`, R - 180, 70, { width: 180, align: 'right' })
           .text(`Expected ${dmy(po.expectedAt)}`, R - 180, 82, { width: 180, align: 'right' })
           .text(`Status   ${po.status}`, R - 180, 94, { width: 180, align: 'right' });
        line(112);

        // Buyer / supplier blocks
        doc.fontSize(8).fillColor('#94a3b8').font('Helvetica-Bold').text('SUPPLIER', L, 124);
        doc.fontSize(10).fillColor('#1e293b').font('Helvetica-Bold').text(po.vendor || '—', L, 137, { width: W / 2 - 20 });
        doc.fontSize(9).font('Helvetica').fillColor('#475569');
        let vy = 152;
        [vendor.code ? `Code ${vendor.code}` : null, vendor.email, vendor.city,
         vendor.paymentTerm ? `Payment: ${vendor.paymentTerm}` : null,
         vendor.deliveryTerm ? `Delivery: ${vendor.deliveryTerm}` : null]
            .filter(Boolean).forEach(t => { doc.text(t, L, vy, { width: W / 2 - 20 }); vy += 12; });

        doc.fontSize(8).fillColor('#94a3b8').font('Helvetica-Bold').text('DELIVER TO', L + W / 2, 124);
        doc.fontSize(10).fillColor('#1e293b').font('Helvetica-Bold').text(po.warehouse || '—', L + W / 2, 137, { width: W / 2 });
        doc.fontSize(9).font('Helvetica').fillColor('#475569').text(po.address || '', L + W / 2, 152, { width: W / 2 });

        // Line items
        const top = Math.max(vy, 200) + 8;
        doc.rect(L, top, W, 20).fillColor('#f1f5f9').fill();
        doc.fillColor('#475569').fontSize(8).font('Helvetica-Bold');
        const col = { sku: L + 6, name: L + 92, qty: L + 300, price: L + 355, tax: L + 415, total: R - 6 };
        doc.text('SKU', col.sku, top + 6).text('PRODUCT', col.name, top + 6)
           .text('QTY', col.qty, top + 6, { width: 45, align: 'right' })
           .text('RATE', col.price, top + 6, { width: 52, align: 'right' })
           .text('TAX', col.tax, top + 6, { width: 40, align: 'right' })
           .text('AMOUNT', col.total - 74, top + 6, { width: 74, align: 'right' });
        let y = top + 24;
        doc.font('Helvetica').fontSize(9).fillColor('#1e293b');
        po.items.forEach(i => {
            if (y > 720) { doc.addPage(); y = 60; }
            doc.fillColor('#1e293b').text(i.sku || '—', col.sku, y, { width: 84, ellipsis: true });
            doc.fillColor('#475569').text(i.description || '', col.name, y, { width: 200, ellipsis: true });
            doc.fillColor('#1e293b')
               .text(String(i.qty), col.qty, y, { width: 45, align: 'right' })
               .text(String(i.price), col.price, y, { width: 52, align: 'right' })
               .text(i.taxRate != null ? `${i.taxRate}%` : '—', col.tax, y, { width: 40, align: 'right' })
               .text(INR(i.lineValue), col.total - 74, y, { width: 74, align: 'right' });
            y += 16;
        });
        line(y + 4);

        // Totals
        y += 14;
        const totalRow = (label, value, bold) => {
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
               .fillColor(bold ? '#1e293b' : '#64748b')
               .text(label, R - 250, y, { width: 150, align: 'right' })
               .text(value, R - 96, y, { width: 96, align: 'right' });
            y += bold ? 18 : 14;
        };
        totalRow('Units', po.qty.toLocaleString('en-IN'));
        totalRow('Goods value', INR(po.itemsValue));
        totalRow('PO TOTAL', INR(po.totalValue), true);

        doc.fontSize(8).fillColor('#94a3b8').font('Helvetica')
           .text('Tax is applied per line as shown. This document is generated from EasyEcom PO data.',
                 L, Math.max(y + 16, 760), { width: W });
        doc.text(`EasyEcom PO id ${po.poId} · generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
                 L, Math.max(y + 28, 772), { width: W });
        doc.end();
    } catch (e) {
        console.error('[PO pdf]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// The settable statuses + labels, so the UI never hardcodes a second copy of the mapping.
router.get('/purchase-orders/meta', (req, res) => {
    res.json({ success: true, canWrite: canWritePo(req),
        statuses: PO_SETTABLE.map(id => ({ id, label: statusLabel(id) })),
        allStatuses: Object.entries(PO_STATUS).map(([id, label]) => ({ id: Number(id), label })) });
});

// ── Open PO units per SKU — units already ordered and still owed to us ───────────────────────────
// Used by the daily Inventory & Reorder report to subtract stock that is already on its way, so a
// buyer never re-orders something a live PO is already covering.
//
// ⚠️ "Open" is `pending > 0 AND the PO is not dead`. Pending quantity ALONE is wrong: a Rejected (4) or
// Cancelled (7) PO keeps its pending_quantity, so counting it would report units as inbound that
// nobody will ever ship — and on live data a meaningful share of pending POs sit in a dead state.
// Reuses PO_DEAD/shapePo so this can never drift from what the Purchase Order page shows.
//
// Returns { bySku: { SKU: units }, poCount, skuCount, fetchedAt } and NEVER throws — the report must
// still go out if EasyEcom is unreachable; the caller degrades to not subtracting.
let _openPoCache = null;
const OPEN_PO_TTL = 5 * 60 * 1000;

// ⚠️ HARDENED 2026-08-20 after the 06:30 inventory report warned "Open POs could not be read". The
// lookup worked seconds later when reproduced — EasyEcom flakes transiently in that busy sync window,
// and ONE bad response among the ~14 pages threw the whole lookup with no retry and no fallback, so
// the report silently over-stated every reorder quantity. Ladder: one retry after 3s (same recipe as
// the RS-sync hardening), then the LAST GOOD copy however old — labelled stale with its timestamp —
// and only with no history at all does it throw and the report show the old warning.
let _lastGoodOpenPo = null;   // survives past OPEN_PO_TTL, exactly for the fallback
async function openPoQtyBySku({ days = DEFAULT_LOOKBACK_DAYS, fresh = false } = {}) {
    if (!fresh && _openPoCache && Date.now() - _openPoCache.t < OPEN_PO_TTL) return _openPoCache.v;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    let rows;
    try {
        ({ rows } = await fetchAllPurchaseOrders(since));
    } catch (e1) {
        console.warn('[OpenPO] fetch failed, retrying in 3s:', e1.message);
        await new Promise(r => setTimeout(r, 3000));
        try { ({ rows } = await fetchAllPurchaseOrders(since)); }
        catch (e2) {
            if (_lastGoodOpenPo) {
                console.warn(`[OpenPO] retry failed too (${e2.message}) — serving the last good copy from ${_lastGoodOpenPo.fetchedAt}`);
                return { ..._lastGoodOpenPo, stale: true };
            }
            throw e2;   // no history at all — the caller's warning is the honest outcome
        }
    }
    // ⚠️ THE TOTAL ALONE IS UNREADABLE, AND THAT IS HOW A DEAD PO HIDES. "Raised PO 549" for TE-BB1
    // looks wrong to anyone who raised a PO for 500 — it is 500 from PO 69 plus a 49-unit remnant of
    // PO 38, raised 5 June, 1 of 50 units ever received and still sitting Open 77 days later. The
    // remnant is real as far as EasyEcom is concerned, so it is still subtracted; what was missing was
    // any way to SEE it. Every contributing PO now rides along with the number, and a line still
    // pending past PO_STALE_DAYS is flagged so a forgotten PO can be closed rather than quietly
    // suppressing the buy for a SKU nobody is actually shipping.
    const bySku = {};
    const detailBySku = {};
    const pos = rows.map(shapePo).filter(p => p.isOpen);
    pos.forEach(p => p.items.forEach(i => {
        const sku = String(i.sku || '').trim();
        if (!sku || !(i.pending > 0)) return;
        bySku[sku] = (bySku[sku] || 0) + i.pending;
        const ageDays = p.createdAt ? Math.round((Date.now() - new Date(p.createdAt).getTime()) / 86400000) : null;
        (detailBySku[sku] = detailBySku[sku] || []).push({
            po: p.poNumber, poId: p.poId, status: p.status, vendor: p.vendor,
            ordered: i.qty, received: i.received, pending: i.pending,
            createdAt: p.createdAt, ageDays, stale: ageDays != null && ageDays > PO_STALE_DAYS,
        });
    }));
    Object.values(detailBySku).forEach(l => l.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
    const staleBySku = {};
    Object.keys(detailBySku).forEach(sku => {
        const u = detailBySku[sku].filter(x => x.stale).reduce((a, x) => a + x.pending, 0);
        if (u > 0) staleBySku[sku] = u;
    });
    const v = { bySku, detailBySku, staleBySku, poCount: pos.length, skuCount: Object.keys(bySku).length, fetchedAt: new Date().toISOString() };
    _openPoCache = { t: Date.now(), v };
    _lastGoodOpenPo = v;
    return v;
}

module.exports = router;
module.exports.openPoQtyBySku = openPoQtyBySku;
// Reused by the GRN dashboard so "awaiting receipt" can never disagree with this page's own
// open/dead/received semantics.
module.exports.fetchAllPurchaseOrders = fetchAllPurchaseOrders;
module.exports.shapePo = shapePo;
module.exports.poBookCached = poBookCached;   // shared with the GRN page — one walk serves both
module.exports.performPoCreate = performPoCreate;   // the PO-approval flow fires this on Approve
module.exports.canWritePo = canWritePo;
module.exports.fetchVendors = fetchVendors;   // the GRN Receive form's supplier picker (Auto-GRN mode)
module.exports.fetchProductMaster = fetchProductMaster;   // GRN form's MRP/name auto-fill (10-min in-process cache)
