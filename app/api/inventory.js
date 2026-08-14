// ─────────────────────────────────────────────────────────────────────────────
// Inventory Analytics — reads the daily `inventory_snapshots` table (built by the Supabase
// `snapshot-inventory` edge function @ 00:00 IST, which combines EasyEcom stock + b2c_order_easycom
// sales, pack→base expanded via sku_pack_mapping). This module ONLY READS the snapshot; it never calls
// EasyEcom on page load. It serves the dashboard and posts a daily summary to Microsoft Teams (not Slack).
// Mounted at /api → routes under /inventory/*, gated by the `inventory` perm key in server.js.
//
// DRR = units sold in period / period days;  DOI = stock / DRR (999 if DRR=0 & stock>0; 0 if no stock).
// Warehouses: docpharma→ix73493041216 (DP Bangalore), rapidshyp→wo66194027524 (Shifupro/Gurgaon).
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { supabase } = require('../supabase');
const { postTeams } = require('./teams');
// Units already on a live purchase order, so the reorder list never asks a buyer to re-order stock
// that is already on its way. Lives in purchase_orders.js so the "which PO statuses count as inbound"
// rule (Rejected/Cancelled keep a pending qty but are NOT coming) has exactly one definition.
const { openPoQtyBySku } = require('./purchase_orders');

const istDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD in IST

// Load EVERY row of the most-recent snapshot (paginate past Supabase's 1000-row cap).
async function loadLatestSnapshot() {
    const { data: latest } = await supabase.from('inventory_snapshots')
        .select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
    if (!latest) return { snapshot_date: null, rows: [] };
    const date = latest.snapshot_date;
    const rows = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('inventory_snapshots')
            .select('sku, product_name, warehouse, category, location_id, available_quantity, units_sold_7d, units_sold_14d, units_sold_30d')
            .eq('snapshot_date', date).order('sku', { ascending: true }).range(from, from + 999);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    // Drop phantom/unmapped locations (warehouse 'N/A') — their location_id is a bare warehouse name or an
    // Amazon FBA code the snapshot fn couldn't map to a real stock location, so they hold stray sales but
    // 0 stock and no product metadata (name=SKU, Uncategorized). Not real inventory — hide everywhere.
    // ALSO drop DP Bangalore (2026-08-04, user request): the dashboard and the daily report cover OUR OWN
    // warehouse only. DocPharma holds its stock on our behalf and is reconciled separately, so mixing it in
    // double-counted the catalogue (the same 17 SKUs appeared twice) and skewed every DOI/reorder number.
    const clean = rows.filter(r =>
        r.warehouse && String(r.warehouse).trim().toUpperCase() !== 'N/A' && r.location_id === SHIFUPRO_LOC);
    return { snapshot_date: date, rows: clean };
}

// ── Reorder model ────────────────────────────────────────────────────────────────────────────────
// Cover targets (days of inventory), set by the user 2026-08-04:
//   ≤ 20  → Place Order   ·  ≤ 30 → Warning  ·  30–45 → Healthy  ·  > 45 → Overstock
// Recommended order qty = DRR × TARGET_COVER − current stock, then rounded UP to whole shipping CASES
// (a supplier ships cases, not loose units). Case sizes live in `sku_case_size`, seeded from the
// warehouse INVENTORY COUNT sheet — they exist nowhere else in the DB.
const PLACE_ORDER_DOI = 20;
const WARNING_DOI = 30;
const TARGET_COVER_DAYS = 45;      // also the report's "low inventory" threshold
const DRR_WINDOW_DAYS = 7;         // 7-day average — tracks current demand; drives DRR, DOI and the order qty

async function fetchCaseSizes() {
    const { data } = await supabase.from('sku_case_size').select('sku, case_size');
    const map = {};
    (data || []).forEach(r => { if (r.case_size > 0) map[r.sku] = Number(r.case_size); });
    return map;
}

// One row per SKU with DRR, DOI, status and the recommended order quantity.
//
// `openPo` = { SKU: units } already on a live purchase order (see purchase_orders.openPoQtyBySku).
// Units already ordered are stock on its way, so they are SUBTRACTED from the recommendation —
// otherwise the report tells a buyer to re-order something a PO is already covering. Measured on live
// data the day this was added: 7 of the 9 recommended SKUs were already fully covered, TE-BDR1 by
// 27,441 units against a 16,837 recommendation. Optional and defaults to {} so every existing caller
// behaves exactly as before, which is also the safe degradation when EasyEcom is unreachable.
function buildReorder(rows, caseSizes, openPo = {}) {
    return rows.map(r => {
        const stock = Number(r.available_quantity) || 0;
        const sold = Number(r[`units_sold_${DRR_WINDOW_DAYS}d`]) || 0;
        const drr = Math.round((sold / DRR_WINDOW_DAYS) * 100) / 100;
        const doi = drr > 0 ? Math.round((stock / drr) * 10) / 10 : null;
        let status;
        if (stock <= 0) status = 'Out of Stock';
        else if (drr <= 0) status = 'No Sales';
        else if (doi <= PLACE_ORDER_DOI) status = 'Place Order';
        else if (doi <= WARNING_DOI) status = 'Warning';
        else if (doi <= TARGET_COVER_DAYS) status = 'Healthy';
        else status = 'Overstock';
        const rawQty = Math.max(0, Math.ceil(drr * TARGET_COVER_DAYS - stock));
        // Units already on a live PO, and what is STILL needed once those are counted.
        const poQty = Math.max(0, Number(openPo[r.sku]) || 0);
        const netQty = Math.max(0, rawQty - poQty);
        const caseSize = caseSizes[r.sku] || null;
        // Round UP to whole cases — off the NET need, since you only buy what the open POs don't cover.
        // Without a known case size we still surface the raw need rather than hiding the SKU — the UI
        // flags that it couldn't be cased.
        const orderQty = (caseSize && netQty > 0) ? Math.ceil(netQty / caseSize) * caseSize : netQty;
        return {
            sku: r.sku, product_name: r.product_name, category: r.category,
            warehouse: r.warehouse, location_id: r.location_id,
            stock, units_sold: sold, drr, doi, status,
            case_size: caseSize, raw_qty: rawQty, order_qty: orderQty,
            open_po: poQty, net_qty: netQty,
            // Fully covered by what is already on order — listed, but with nothing left to buy.
            poCovered: rawQty > 0 && netQty === 0,
            cases: caseSize && orderQty > 0 ? Math.round(orderQty / caseSize) : 0,
            // A SKU is still "needs order" if it was short at all — a covered one stays visible so the
            // buyer can see WHY it is not being ordered, rather than it silently vanishing.
            needsOrder: rawQty > 0,
        };
    });
}

// ── GET /inventory/reorder — the Recommended Order list (Shifupro only). ──
router.get('/inventory/reorder', async (req, res) => {
    try {
        const [{ snapshot_date, rows }, caseSizes] = await Promise.all([loadLatestSnapshot(), fetchCaseSizes()]);
        // Same PO subtraction the Teams report uses, so the page and the report can never disagree.
        // A failure here degrades to "no subtraction" rather than failing the page; `poSubtracted`
        // tells the client which of the two it is looking at.
        let openPo = {}, poSubtracted = true;
        try { openPo = (await openPoQtyBySku()).bySku || {}; }
        catch (e) { poSubtracted = false; console.warn('[Inventory] open PO lookup failed:', e.message); }
        const all = buildReorder(rows, caseSizes, openPo)
            .sort((a, b) => (a.doi == null ? 1e9 : a.doi) - (b.doi == null ? 1e9 : b.doi));
        const order = all.filter(r => r.needsOrder);
        res.json({
            success: true, snapshot_date, today: istDate(),
            stale: !!(snapshot_date && snapshot_date < istDate()),
            thresholds: { placeOrder: PLACE_ORDER_DOI, warning: WARNING_DOI, target: TARGET_COVER_DAYS, drrWindow: DRR_WINDOW_DAYS },
            counts: {
                skus: all.length,
                outOfStock: all.filter(r => r.status === 'Out of Stock').length,
                placeOrder: all.filter(r => r.status === 'Place Order').length,
                warning: all.filter(r => r.status === 'Warning').length,
                healthy: all.filter(r => r.status === 'Healthy').length,
                overstock: all.filter(r => r.status === 'Overstock').length,
                noCaseSize: all.filter(r => r.needsOrder && !r.case_size && r.net_qty > 0).length,
                poCovered: all.filter(r => r.poCovered).length,
            },
            poSubtracted,
            openPoUnits: order.reduce((s, r) => s + (r.open_po || 0), 0),
            totalUnits: order.reduce((s, r) => s + r.order_qty, 0),
            order, rows: all,
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /inventory/snapshot — latest snapshot rows + facets. Frontend computes DRR/DOI per DRR-period. ──
router.get('/inventory/snapshot', async (req, res) => {
    try {
        const { snapshot_date, rows } = await loadLatestSnapshot();
        res.json({
            success: true, snapshot_date, today: istDate(),
            stale: !!(snapshot_date && snapshot_date < istDate()),
            warehouses: [...new Set(rows.map(r => r.warehouse).filter(Boolean))].sort(),
            categories: [...new Set(rows.map(r => r.category).filter(Boolean))].sort(),
            rows,
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Force a fresh snapshot NOW — invoke the snapshot-inventory edge fn (fetch EasyEcom stock + sales, rebuild). ~1-2 min.
async function refreshSnapshot() {
    const r = await axios.post(`${config.SUPABASE_URL}/functions/v1/snapshot-inventory`, {}, {
        headers: { Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
        timeout: 150000, validateStatus: () => true });
    if (r.status >= 400) throw new Error((r.data && r.data.error) || `snapshot-inventory returned ${r.status}`);
    return r.data;
}

// ── POST /inventory/refresh-snapshot — force a fresh snapshot NOW (invokes the edge fn, ~1-2 min). ──
router.post('/inventory/refresh-snapshot', async (req, res) => {
    try { res.json({ success: true, result: await refreshSnapshot() }); }
    catch (e) { res.status(502).json({ success: false, error: e.message }); }
});

// Build + post the daily inventory report to Teams as an IMAGE — the SAME dark "Low Inventory (DOI < 30d)"
// PNG the Slack #inventory-planning report uses. The `inventory-doi-image-teams` edge fn renders it
// (Satori→PNG), uploads to the public `reports` Storage bucket, and returns its URL + summary stats; we embed
// that image in a Teams card (Adaptive-Card Image element + an HTML <img> twin for reply-into-thread flows).
async function sendInventoryTeamsReport() {
    const url = config.TEAMS_WEBHOOK_INVENTORY || config.TEAMS_WEBHOOK_WAREHOUSE || process.env.TEAMS_WEBHOOK_WAREHOUSE;
    if (!url) { console.log('[Inventory] no Teams webhook (TEAMS_WEBHOOK_INVENTORY/_WAREHOUSE) — skipping report'); return false; }
    let img;
    try {
        const r = await axios.post(`${config.SUPABASE_URL}/functions/v1/inventory-doi-image-teams`, {}, {
            headers: { Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
            timeout: 120000, validateStatus: () => true });
        if (r.status >= 400 || !r.data || !r.data.ok) throw new Error((r.data && r.data.error) || `inventory-doi-image-teams returned ${r.status}`);
        img = r.data;
    } catch (e) { console.error('[Inventory] DOI image render failed:', e.message); return false; }
    const { image_url, label, rows: nRows, critical, watch, stockouts, warehouses = [] } = img;
    const whLine = warehouses.map(w => `${w.warehouse}: ${w.count}${w.oos ? ` (${w.oos} OOS)` : ''}`).join('  ·  ');

    // ── Recommended Order list — sits directly ABOVE the "Ecom Central · Inventory Analytics" footer.
    //    Recommend Qty = DRR(30d) × 45 − stock (units still needed)
    //    Case Qty      = Recommend Qty ÷ case size, rounded UP  →  how many CASES to actually order
    //    Order Units   = Case Qty × case size (what lands in the warehouse)
    //    Only SKUs that actually need ordering. Rendered as a `table` block: a code fence renders as
    //    literal backticks in Teams and collapses the padding, so alignment has to come from the card.
    let orderBlocks = [];
    try {
        // Open PO units are fetched alongside the snapshot. If EasyEcom is unreachable we fall back to
        // an empty map rather than dropping the whole report — the table then reads exactly as it did
        // before this feature, and the caption says the subtraction was skipped.
        let openPo = {}, poFailed = false;
        const [{ rows: snapRows }, caseSizes] = await Promise.all([loadLatestSnapshot(), fetchCaseSizes()]);
        try { openPo = (await openPoQtyBySku()).bySku || {}; }
        catch (e) { poFailed = true; console.warn('[Inventory] open PO lookup failed — reorder shown WITHOUT PO subtraction:', e.message); }

        const need = buildReorder(snapRows, caseSizes, openPo)
            .filter(r => r.needsOrder)
            .sort((a, b) => (a.doi == null ? 1e9 : a.doi) - (b.doi == null ? 1e9 : b.doi));
        if (need.length) {
            const n = v => Number(v || 0).toLocaleString('en-IN');
            const units = need.reduce((s, r) => s + r.order_qty, 0);
            const cases = need.reduce((s, r) => s + r.cases, 0);
            const noCase = need.filter(r => !r.case_size && r.net_qty > 0).length;
            const covered = need.filter(r => r.poCovered);
            const toOrder = need.filter(r => !r.poCovered);
            // ⚠️ COLUMN COUNT IS THE CONSTRAINT, NOT THE DATA. A Teams card is far narrower than the
            // composer suggests: at ten columns every cell truncated to "16,8…" / "TE-BD…". Rather
            // than drop fields, related ones are GROUPED into a single cell — same ten numbers, seven
            // columns, which is the width that rendered cleanly before this feature was added.
            //   DRR · DOI          → one cell ("409.29 · 3.9d")
            //   Case Qty × Size    → one cell ("1 × 116 = 351"), which also carries Order Units
            // Every SKU that was short stays listed, including ones fully covered by a PO — a
            // critical-looking SKU vanishing from the sheet is exactly the confusion to avoid.
            const table = {
                type: 'table',
                columns: [
                    { title: 'SKU', width: 3 },
                    { title: `DRR/${DRR_WINDOW_DAYS}d`, width: 2 },
                    { title: 'DOI', width: 2 },
                    { title: 'Stock', width: 2 },
                    { title: 'Recommend Qty', width: 3 },
                    { title: 'Raised PO', width: 2 },
                    { title: 'Final Qty', width: 2 },
                    { title: 'Case Size', width: 2 },
                    { title: 'Case Qty', width: 2 },
                    { title: 'Order Units', width: 2 },
                ],
                rows: need.map(r => [
                    r.sku,
                    r.drr.toFixed(2),
                    r.doi == null ? '—' : r.doi.toFixed(1) + 'd',
                    n(r.stock),
                    n(r.raw_qty),
                    r.open_po ? n(r.open_po) : '—',
                    // Fully covered by an open PO — say so rather than showing a bare 0.
                    r.poCovered ? '✓ on PO' : n(r.net_qty),
                    r.case_size ? n(r.case_size) : '—',
                    r.poCovered ? '—' : (r.case_size ? n(r.cases) : '—'),
                    r.poCovered ? '—' : (r.case_size ? n(r.order_qty) : n(r.net_qty) + '*'),
                ]),
                total: ['TOTAL', '', '', '', '', '', '', '', n(cases), n(units)],
            };
            const title = `🧾 *Recommended Order* — ${toOrder.length} SKU${toOrder.length === 1 ? '' : 's'} to order  ·  ${n(cases)} cases  ·  ${n(units)} units`;
            const notes = [];
            // Name the covered SKUs. "7 SKUs are covered" makes a buyer go hunting; the list answers
            // "why isn't TE-BDR1 on the sheet when it shows 3.9 days of stock?" without them asking.
            if (covered.length) notes.push(`_✅ Already on order — nothing to buy: *${covered.map(r => r.sku).join('*, *')}* (${n(covered.reduce((s, r) => s + r.open_po, 0))} units across ${covered.length} SKU${covered.length > 1 ? 's' : ''})._`);
            if (noCase) notes.push(`_* ${noCase} SKU${noCase > 1 ? 's have' : ' has'} no case size on file — raw quantity shown._`);
            if (poFailed) notes.push(`_⚠️ Open POs could not be read from EasyEcom — **Raised PO not subtracted**, quantities may be over-stated._`);
            orderBlocks = [
                { type: 'divider' },
                { type: 'section', text: { type: 'mrkdwn', text: title } },
                table,
                ...(notes.length ? [{ type: 'context', elements: notes.map(text => ({ type: 'mrkdwn', text })) }] : []),
            ];
        }
    } catch (e) { console.error('[Inventory] reorder list failed (report still sent):', e.message); }

    const payload = { blocks: [
        { type: 'header', text: { type: 'plain_text', text: `📦 Inventory & Reorder — Shifupro — ${label}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${nRows}* SKUs  ·  *${critical}* place order (≤${PLACE_ORDER_DOI}d)  ·  *${watch}* warning (≤${WARNING_DOI}d)  ·  *${stockouts}* out of stock` } },
        ...(whLine ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: whLine }] }] : []),
        { type: 'image', image_url, alt_text: `Inventory & Reorder — Shifupro — ${label}` },
        ...orderBlocks,
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Ecom Central · Inventory Analytics · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` }] },
    ] };
    // text:true sends the HTML twin alongside the card, so this works whether the Inventory webhook is a
    // channel-post Workflow (reads `card`) OR a reply-into-thread Workflow (reads `text`/`attachments`).
    const opts = { text: true };
    if (config.DASHBOARD_URL) { opts.actionUrl = String(config.DASHBOARD_URL).replace(/\/$/, '') + '/#inventory'; opts.actionTitle = 'Open Inventory Dashboard'; }
    const ok = await postTeams(url, payload, opts);
    console.log(`[Inventory] Teams image report ${ok ? 'sent ✓' : 'FAILED'} (${label}: ${nRows} rows, ${critical} critical, ${stockouts} OOS)`);
    return ok;
}

// ── POST /inventory/teams-report — send the daily Teams report immediately (admin / test). ──
router.post('/inventory/teams-report', async (req, res) => {
    try { const ok = await sendInventoryTeamsReport(); res.json({ success: ok }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Stock Count — physical inventory reconciliation vs EasyEcom. WH team member enters a BLIND physical count
// for a single-product SKU at Shifupro (our own warehouse); on submit we read the LIVE EasyEcom available qty
// for that SKU at that instant and log both + the difference (physical − system) to `inventory_counts_ecom`.
// This is the audit trail for hunting down system↔physical mismatches. Gated by the `inventory-count` perm.
// ─────────────────────────────────────────────────────────────────────────────
const SHIFUPRO_LOC = 'wo66194027524';                    // EasyEcom location code that we physically count
const SHIFUPRO_NAME = 'Shifupro Technologies Pvt. Ltd.';

let _eeInvCache = { at: 0, rows: null };
// EasyEcom inventory (all locations). Cached ~60s for the SKU picker; pass fresh=true on submit so the logged
// system qty is the value at the exact moment of the count (the whole point of this dashboard).
async function easyEcomInventory(fresh = false) {
    if (!fresh && _eeInvCache.rows && (Date.now() - _eeInvCache.at) < 60000) return _eeInvCache.rows;
    const r = await axios.post(`${config.SUPABASE_URL}/functions/v1/easyecom-proxy`, { action: 'getInventory' }, {
        headers: { Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`, apikey: config.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
        timeout: 120000, validateStatus: () => true });
    if (r.status >= 400 || !r.data) throw new Error(`easyecom-proxy returned ${r.status}`);
    if (r.data.rateLimited) throw new Error('EasyEcom is rate-limited — try again in a minute.');
    const rows = (r.data.data || []).map(it => ({
        sku: it.sku || it.SKU || it.product_sku || '',
        name: it.productName || it.product_name || it.name || '',
        loc: it.location_key || it.locationKey || it.location_id || '',
        qty: Number(it.availableInventory ?? it.available_quantity ?? it.inventory ?? it.stock ?? 0) || 0,
        cost: Number(it.cost) || null,
        combo: it.is_combo === true,
    })).filter(x => x.sku);
    _eeInvCache = { at: Date.now(), rows };
    return rows;
}

// The authoritative "real single products" list = registered base_skus in sku_pack_mapping (the same set the
// snapshot tracks). EasyEcom's `is_combo` flag is unreliable (combos/kits/drafts/variant-IDs leak through), so
// we DON'T trust it — we intersect this curated set with live EasyEcom rows. Register a new product in
// sku_pack_mapping (self-map) to make it countable, exactly like the dashboard.
async function singleProductSkus() {
    const { data, error } = await supabase.from('sku_pack_mapping').select('base_sku');
    if (error) throw new Error(error.message);
    return new Set((data || []).map(r => r.base_sku).filter(Boolean));
}

// Reserved (allocated-but-unshipped) units per base SKU at Shifupro + the underlying order lines, from the
// `inventory_reserved_lines_shifupro()` RPC (Confirmed/Assigned/On Hold/Printed orders, pack→base expanded).
// EasyEcom deducts these from availableInventory, but they're still physically on the shelf — so the true
// on-hand a physical count sees ≈ available + reserved.
async function reservedData(from, to) {
    const { data, error } = await supabase.rpc('inventory_reserved_lines_shifupro', { p_from: from || null, p_to: to || null });
    if (error) throw new Error(error.message);
    const map = new Map(), lines = [];
    for (const r of (data || [])) {
        const units = Number(r.units) || 0;
        map.set(r.base_sku, (map.get(r.base_sku) || 0) + units);
        lines.push({ sku: r.base_sku, order_date: r.order_date, order_ref: r.order_ref, order_status: r.order_status, qty: Number(r.qty) || 0, units });
    }
    return { map, lines };
}

// Current per-SKU BLOCKED (non-Available status: Damaged/QC-Fail/Expired/Lot-Locked) and AWAITING-PUTAWAY
// (returns received − put away) balances, derived from the `inventory_movements_ecom` webhook ledger. These are
// running balances from ledger start — they FIRM UP as events accumulate, and the status/putaway classification
// gets verified against real EasyEcom values. Physical = Available + Reserved + Blocked + Awaiting-putaway.
async function bucketBalances() {
    const blocked = new Map(), awaiting = new Map();
    // Paginate the ledger — the server caps every response at 1000 rows (the old .limit(50000) was
    // returning an arbitrary 1000-row slice, corrupting the running balances logged into every count).
    const data = [];
    for (let from = 0; ; from += 1000) {
        const { data: page, error } = await supabase.from('inventory_movements_ecom')
            .select('event_type, sku, qty, adjustment_type, old_status, new_status')
            .order('id', { ascending: true }).range(from, from + 999);
        if (error) throw new Error(error.message);
        data.push(...(page || []));
        if (!page || page.length < 1000) break;
    }
    const isBlocked = s => !!s && !/^\s*available\s*$/i.test(String(s));
    for (const r of (data || [])) {
        const q = Number(r.qty) || 0, sku = r.sku;
        if (r.event_type === 'adjustment') {
            let d = 0;
            if (isBlocked(r.new_status)) d += q;               // moved INTO a blocked status
            if (isBlocked(r.old_status)) d -= q;               // moved OUT of a blocked status
            if (d) blocked.set(sku, (blocked.get(sku) || 0) + d);
            if (/putaway/i.test(r.adjustment_type || '')) awaiting.set(sku, (awaiting.get(sku) || 0) - q);   // put away clears limbo
        } else if (r.event_type === 'return') {
            awaiting.set(sku, (awaiting.get(sku) || 0) + q);   // received return enters limbo
        }
    }
    // A negative just means the ledger is missing opening entries — clamp to 0 until history is complete.
    for (const m of [blocked, awaiting]) for (const [k, v] of m) if (v < 0) m.set(k, 0);
    return { blocked, awaiting };
}

// ── GET /inventory/count/skus — single-product SKUs at Shifupro for the count picker (blind: NO qty). ──
router.get('/inventory/count/skus', async (req, res) => {
    try {
        const base = await singleProductSkus();
        const rows = await easyEcomInventory(false);
        const atShifupro = new Map(rows.filter(x => x.loc === SHIFUPRO_LOC).map(x => [x.sku, x]));
        const skus = [...base].filter(sku => atShifupro.has(sku))
            .map(sku => ({ sku, name: atShifupro.get(sku).name || sku }))
            .sort((a, b) => a.sku.localeCompare(b.sku));
        res.json({ success: true, warehouse: SHIFUPRO_NAME, skus });
    } catch (e) { res.status(502).json({ success: false, error: e.message }); }
});

// ── POST /inventory/count — log a physical count; captures the LIVE EasyEcom system qty at submit time. ──
router.post('/inventory/count', async (req, res) => {
    try {
        const b = req.body || {};
        const sku = String(b.sku || '').trim();
        const physical = Number(b.physical_qty);
        if (!sku) return res.status(400).json({ success: false, error: 'SKU required' });
        if (!Number.isFinite(physical) || physical < 0) return res.status(400).json({ success: false, error: 'Physical qty must be a number ≥ 0' });
        const base = await singleProductSkus();
        if (!base.has(sku)) return res.status(400).json({ success: false, error: `${sku} isn't a tracked single product (combos aren't counted here). Register it in sku_pack_mapping first.` });
        const rows = await easyEcomInventory(true);   // LIVE read at this instant — no cache
        const hit = rows.find(x => x.sku === sku && x.loc === SHIFUPRO_LOC);
        if (!hit) return res.status(404).json({ success: false, error: `SKU ${sku} not found at ${SHIFUPRO_NAME} in EasyEcom` });
        let reserved = 0, blocked = 0, awaiting = 0;
        try { const { map } = await reservedData(); reserved = map.get(sku) || 0; } catch (e) { console.error('[Inventory] reserved capture failed:', e.message); }
        try { const bb = await bucketBalances(); blocked = bb.blocked.get(sku) || 0; awaiting = bb.awaiting.get(sku) || 0; } catch (e) { console.error('[Inventory] bucket capture failed:', e.message); }
        const row = {
            counted_by: (req.user && req.user.sub) || 'unknown',
            location_id: SHIFUPRO_LOC, warehouse: SHIFUPRO_NAME,
            sku, product_name: hit.name || sku,
            system_qty: hit.qty, physical_qty: physical, reserved_qty: reserved,
            blocked_qty: blocked, awaiting_putaway_qty: awaiting, cost: hit.cost,
            notes: b.notes ? String(b.notes).slice(0, 500) : null,
        };
        const { data, error } = await supabase.from('inventory_counts_ecom').insert(row).select().single();
        if (error) throw new Error(error.message);
        res.json({ success: true, entry: data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /inventory/count/log — count history + summary. Filters: sku, from, to, mismatch=1, limit. ──
router.get('/inventory/count/log', async (req, res) => {
    try {
        // Paginate to the requested limit — the server caps each response at 1000, so a limit above
        // 1000 (up to the 2000 max) silently truncated.
        const wanted = Math.min(Number(req.query.limit) || 500, 2000);
        const all = [];
        for (let from = 0; from < wanted; from += 1000) {
            let q = supabase.from('inventory_counts_ecom')
                .select('id, counted_at, counted_by, sku, product_name, warehouse, system_qty, physical_qty, difference, cost')
                .eq('location_id', SHIFUPRO_LOC)
                .order('counted_at', { ascending: false }).order('id', { ascending: true })
                .range(from, Math.min(from + 999, wanted - 1));
            if (req.query.sku) q = q.ilike('sku', `%${String(req.query.sku).trim()}%`);
            if (req.query.from) q = q.gte('counted_at', new Date(req.query.from).toISOString());
            if (req.query.to) q = q.lte('counted_at', new Date(new Date(req.query.to).getTime() + 86399999).toISOString());
            const { data, error } = await q;
            if (error) throw new Error(error.message);
            all.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        const mism = all.filter(r => Number(r.difference) !== 0);
        const netUnits = all.reduce((s, r) => s + Number(r.difference || 0), 0);
        const valueVar = all.reduce((s, r) => s + Number(r.difference || 0) * (Number(r.cost) || 0), 0);
        const rows = req.query.mismatch === '1' ? mism : all;
        res.json({ success: true, warehouse: SHIFUPRO_NAME, rows,
            summary: { total: all.length, mismatches: mism.length, netUnits, valueVar: Math.round(valueVar) } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /inventory/count/analysis — deep System-vs-Physical reconciliation analytics (manager-level). ──
// Rolls the raw count log into per-SKU current state (latest count) + full history, aggregate accuracy/variance,
// shortage-vs-excess split, ₹ impact at cost, coverage vs tracked SKUs, day-by-day trend, and per-counter stats.
router.get('/inventory/count/analysis', async (req, res) => {
    try {
        // Paginate — the server caps each response at 1000 rows; the old .limit(20000) silently
        // truncated the analysis to the oldest 1000 counts.
        const data = [];
        for (let from = 0; ; from += 1000) {
            let q = supabase.from('inventory_counts_ecom')
                .select('counted_at, counted_by, sku, product_name, system_qty, physical_qty, difference, reserved_qty, blocked_qty, awaiting_putaway_qty, cost')
                .eq('location_id', SHIFUPRO_LOC)
                .order('counted_at', { ascending: true }).order('id', { ascending: true })
                .range(from, from + 999);
            if (req.query.from) q = q.gte('counted_at', new Date(req.query.from).toISOString());
            if (req.query.to) q = q.lte('counted_at', new Date(new Date(req.query.to).getTime() + 86399999).toISOString());
            const { data: page, error } = await q;
            if (error) throw new Error(error.message);
            data.push(...(page || []));
            if (!page || page.length < 1000) break;
        }
        const rows = (data || []).map(r => ({ at: r.counted_at, by: r.counted_by || '—', sku: r.sku, product_name: r.product_name,
            system: Number(r.system_qty) || 0, physical: Number(r.physical_qty) || 0, diff: Number(r.difference) || 0,
            reserved: r.reserved_qty == null ? null : Number(r.reserved_qty),
            blocked: r.blocked_qty == null ? null : Number(r.blocked_qty),
            awaiting: r.awaiting_putaway_qty == null ? null : Number(r.awaiting_putaway_qty), cost: Number(r.cost) || 0 }));

        // Reserved (respects from/to date filter) + Blocked & Awaiting-putaway (current running balances from the ledger).
        let rmap = new Map(), rlines = [], bBlocked = new Map(), bAwaiting = new Map();
        try { const rd = await reservedData(req.query.from, req.query.to); rmap = rd.map; rlines = rd.lines; } catch (e) { console.error('[Inventory] reserved fetch failed:', e.message); }
        try { const bb = await bucketBalances(); bBlocked = bb.blocked; bAwaiting = bb.awaiting; } catch (e) { console.error('[Inventory] bucket fetch failed:', e.message); }

        const bySku = new Map();
        for (const r of rows) { if (!bySku.has(r.sku)) bySku.set(r.sku, { sku: r.sku, product_name: r.product_name, history: [] });
            const g = bySku.get(r.sku); g.product_name = r.product_name || g.product_name;
            g.history.push({ at: r.at, system: r.system, physical: r.physical, diff: r.diff, reserved: r.reserved, blocked: r.blocked, awaiting: r.awaiting, by: r.by, cost: r.cost }); }
        const perSku = [...bySku.values()].map(g => {
            const latest = g.history[g.history.length - 1];
            // adjSystem = Available + Reserved + Blocked + Awaiting-putaway. Current buckets (per-count frozen values in history).
            const reserved = rmap.get(g.sku) || 0, blocked = bBlocked.get(g.sku) || 0, awaiting = bAwaiting.get(g.sku) || 0;
            const adjSystem = latest.system + reserved + blocked + awaiting, trueDiff = latest.physical - adjSystem;
            const abs = g.history.map(h => Math.abs(h.diff));
            return { sku: g.sku, product_name: g.product_name, counts: g.history.length,
                system: latest.system, reserved, blocked, awaiting, adjSystem, physical: latest.physical, diff: latest.diff, trueDiff,
                diffPct: latest.system ? Math.round(latest.diff / latest.system * 1000) / 10 : (latest.diff ? 100 : 0),
                truePct: adjSystem ? Math.round(trueDiff / adjSystem * 1000) / 10 : (trueDiff ? 100 : 0),
                cost: latest.cost, valueVar: Math.round(latest.diff * latest.cost), trueValueVar: Math.round(trueDiff * latest.cost),
                by: latest.by, at: latest.at, avgAbsVar: Math.round(abs.reduce((a, b) => a + b, 0) / abs.length * 10) / 10, history: g.history };
        });

        const counted = perSku.length, matched = perSku.filter(s => s.diff === 0).length, trueMatched = perSku.filter(s => s.trueDiff === 0).length;
        const shortages = perSku.filter(s => s.trueDiff < 0), excesses = perSku.filter(s => s.trueDiff > 0);   // TRUE (net of reserved)
        const sum = (arr, f) => arr.reduce((a, s) => a + f(s), 0);

        let uncounted = [], nameMap = new Map(), baseSet = new Set();
        try { baseSet = await singleProductSkus(); const inv = await easyEcomInventory(false);
            nameMap = new Map(inv.filter(x => x.loc === SHIFUPRO_LOC).map(x => [x.sku, x]));
            const cs = new Set(perSku.map(s => s.sku));
            uncounted = [...baseSet].filter(sku => nameMap.has(sku) && !cs.has(sku)).map(sku => ({ sku, product_name: nameMap.get(sku).name })); } catch { /* EasyEcom optional */ }
        const trackedTotal = counted + uncounted.length;

        // Reserved rollup + order-line detail, restricted to tracked base SKUs.
        const rlTracked = rlines.filter(l => baseSet.has(l.sku));
        const rollup = new Map();
        for (const l of rlTracked) { const g = rollup.get(l.sku) || { sku: l.sku, reserved: 0, orders: new Set(), oldest: l.order_date, newest: l.order_date };
            g.reserved += l.units; g.orders.add(l.order_ref); if (l.order_date < g.oldest) g.oldest = l.order_date; if (l.order_date > g.newest) g.newest = l.order_date; rollup.set(l.sku, g); }
        const reservedRollup = [...rollup.values()].map(g => ({ sku: g.sku, product_name: (nameMap.get(g.sku) || {}).name || '',
            reserved: Math.round(g.reserved), orders: g.orders.size, oldest: g.oldest, newest: g.newest })).sort((a, b) => b.reserved - a.reserved);

        const dayKey = t => new Date(new Date(t).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
        const byDay = new Map();
        for (const r of rows) { const k = dayKey(r.at); const d = byDay.get(k) || { day: k, counts: 0, net: 0, gross: 0 };
            d.counts++; d.net += r.diff; d.gross += Math.abs(r.diff); byDay.set(k, d); }
        const byCounter = new Map();
        for (const r of rows) { const c = byCounter.get(r.by) || { by: r.by, counts: 0, mism: 0 }; c.counts++; if (r.diff !== 0) c.mism++; byCounter.set(r.by, c); }

        res.json({ success: true, warehouse: SHIFUPRO_NAME,
            summary: { counted, trackedTotal, coverage: trackedTotal ? Math.round(counted / trackedTotal * 1000) / 10 : 0, totalCounts: rows.length,
                matched, mismatched: counted - matched, accuracy: counted ? Math.round(matched / counted * 1000) / 10 : 0,
                trueMatched, trueMismatched: counted - trueMatched, trueAccuracy: counted ? Math.round(trueMatched / counted * 1000) / 10 : 0,
                netValue: sum(perSku, s => s.valueVar), grossValue: sum(perSku, s => Math.abs(s.valueVar)),
                trueNetValue: sum(perSku, s => s.trueValueVar), trueGrossValue: sum(perSku, s => Math.abs(s.trueValueVar)),
                reservedTrackedUnits: sum(reservedRollup, r => r.reserved),
                blockedUnits: sum(perSku, s => s.blocked), awaitingUnits: sum(perSku, s => s.awaiting),
                shortageSkus: shortages.length, shortageValue: sum(shortages, s => s.trueValueVar),
                excessSkus: excesses.length, excessValue: sum(excesses, s => s.trueValueVar) },
            perSku: perSku.sort((a, b) => Math.abs(b.trueValueVar) - Math.abs(a.trueValueVar)),
            reservedRollup, reservedLines: rlTracked,
            uncounted, trend: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
            counters: [...byCounter.values()].sort((a, b) => b.counts - a.counts) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, sendInventoryTeamsReport, refreshSnapshot };
