// DocPharma Inventory / SKU Match — goods SENT to DocPharma vs what shipped out, in BASE-SKU units.
// Sent      = Σ goods-invoice item qty (docpharma_goods_invoice_items)
// Movement  = per-SKU units from order line-items, packs/combos exploded (RPC docpharma_inventory_match)
// On-hand   = Sent − Delivered − Lost − In-transit           (RTO left then returned → nets out)
// Adds: velocity (run-rate), days-of-cover + reorder, RTO% per SKU, and ₹ value alongside units.
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const axios = require('axios');
const config = require('../../config');
const { getEasyecomToken } = require('./easyecom');

const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
const EE_BASE = 'https://api.easyecom.io';

// Pull DocPharma's actual on-hand from EasyEcom (they're a location under our account) → docpharma_easyecom_stock.
// V3 inventory is cursor-paginated, max 100/page; we keep only rows at the DP location (EASYECOM_WH2_KEY).
async function syncDocpharmaEasyecomStock() {
    const loc = config.EASYECOM_WH2_KEY || process.env.EASYECOM_WH2_KEY;
    if (!loc) throw new Error('EASYECOM_WH2_KEY (DocPharma location key) not set in .env');
    const jwt = await getEasyecomToken();
    const headers = { 'x-api-key': config.EASYECOM_API_KEY, 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' };
    let url = `${EE_BASE}/getInventoryDetailsV3?includeLocations=1&limit=100`;
    const bySku = {}; let pages = 0;
    while (url && pages < 80) {
        const r = await axios.get(url, { headers, timeout: 30000, validateStatus: () => true });
        if (r.status !== 200) throw new Error(`EasyEcom inventory ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
        const d = (r.data && r.data.data) || {};
        const rows = Array.isArray(d.inventoryData) ? d.inventoryData : [];
        rows.forEach(x => { if (x.location_key === loc) bySku[x.sku] = { sku: x.sku, product_name: x.productName || null, available: num(x.availableInventory), is_combo: x.is_combo != null ? Number(x.is_combo) : null, cost: x.cost != null ? num(x.cost) : null, mrp: x.mrp != null ? num(x.mrp) : null, location_key: loc, synced_at: new Date().toISOString() }; });
        const nu = d.nextUrl || d.next_url; pages++;
        if (!rows.length || !nu) break;
        url = String(nu).startsWith('/') ? EE_BASE + nu : nu;
    }
    const list = Object.values(bySku);
    for (let i = 0; i < list.length; i += 500) {
        const { error } = await supabase.from('docpharma_easyecom_stock').upsert(list.slice(i, i + 500), { onConflict: 'sku' });
        if (error) throw new Error(error.message);
    }
    return { skus: list.length, stocked: list.filter(x => x.available > 0).length, units: list.reduce((s, x) => s + x.available, 0), syncedAt: new Date().toISOString() };
}

// POST /api/docpharma-inventory/sync-easyecom  → refresh DocPharma's EasyEcom stock snapshot
router.post('/docpharma-inventory/sync-easyecom', async (req, res) => {
    try { const r = await syncDocpharmaEasyecomStock(); res.json({ success: true, ...r }); }
    catch (e) { console.error('[DP EE sync]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// Pull DocPharma's OWN inventory (their partner dashboard — authoritative, uses our partner_sku_code + expiry) → docpharma_dp_stock.
const dpNorm = s => String(s || '').trim().replace(/[xX]1$/, '');   // TE-BFW1x1 → TE-BFW1 (dedupe catalog aliases)
async function syncDocpharmaDpStock() {
    const { getPortalToken, PORTAL_BASE } = require('./docpharma_portal');
    const token = await getPortalToken();
    if (!token) throw new Error('DocPharma portal token unavailable (check DP_PORTAL_EMAIL / DP_PORTAL_PASSWORD)');
    const bySku = {}; let page = 1, totalPages = 1;
    do {
        const r = await axios.get(`${PORTAL_BASE}/inventory-management/products?page=${page}&search_value=&sort_by=product_id&order=ASC`,
            { headers: { Authorization: 'Bearer ' + token }, timeout: 20000, validateStatus: () => true });
        if (r.status !== 200 && r.status !== 304) throw new Error(`DocPharma inventory ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
        const d = r.data && r.data.data; if (!d) break;
        totalPages = d.total_pages || 1;
        (d.products_with_inventory || []).forEach(p => {
            if (!/^TE/i.test(p.partner_sku_code || '') && !/element/i.test(p.manufacturer || '')) return;   // The Element products only
            const sku = dpNorm(p.partner_sku_code); if (!sku) return;
            const row = { sku, product_name: p.product_name || null, inventory_count: num(p.inventory_count), mrp: p.mrp != null ? num(p.mrp) : null, expiry_date: p.expiry_date ? String(p.expiry_date).slice(0, 10) : null, pack_size: p.pack_size || null, dp_id: p.dp_id || null, sub_category: p.sub_category || null, synced_at: new Date().toISOString() };
            const ex = bySku[sku];                                                                            // dedupe aliases → keep the larger count / nearer expiry
            if (!ex || row.inventory_count > ex.inventory_count) bySku[sku] = row;
        });
        page++;
    } while (page <= totalPages && page < 30);
    const list = Object.values(bySku);
    for (let i = 0; i < list.length; i += 500) {
        const { error } = await supabase.from('docpharma_dp_stock').upsert(list.slice(i, i + 500), { onConflict: 'sku' });
        if (error) throw new Error(error.message);
    }
    return { skus: list.length, stocked: list.filter(x => x.inventory_count > 0).length, units: list.reduce((s, x) => s + Math.max(0, x.inventory_count), 0), syncedAt: new Date().toISOString() };
}

// POST /api/docpharma-inventory/sync-docpharma  → refresh DocPharma's own inventory snapshot
router.post('/docpharma-inventory/sync-docpharma', async (req, res) => {
    try { const r = await syncDocpharmaDpStock(); res.json({ success: true, ...r }); }
    catch (e) { console.error('[DP DP-stock sync]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/docpharma-inventory?lead=15&low=20   → per-SKU reconciliation + summary
router.get('/docpharma-inventory', async (req, res) => {
    try {
        const lead = req.query.lead != null ? Math.max(1, num(req.query.lead)) : 15;   // reorder lead time (days), configurable
        const lowThreshold = req.query.low != null ? num(req.query.low) : 20;

        const { data: mv, error: mvErr } = await supabase.rpc('docpharma_inventory_match');
        if (mvErr) throw new Error(mvErr.message);
        const { data: items, error: itErr } = await supabase.from('docpharma_goods_invoice_items').select('sku, name, qty, amount');
        if (itErr) throw new Error(itErr.message);
        // DocPharma's ACTUAL on-hand from EasyEcom (base SKUs; combos there are virtual so we match SKU-to-SKU, no explosion).
        const { data: eeRows } = await supabase.from('docpharma_easyecom_stock').select('sku, available, synced_at');
        const eeMap = {}; let eeSyncedAt = null;
        (eeRows || []).forEach(r => { eeMap[r.sku] = num(r.available); if (r.synced_at && (!eeSyncedAt || r.synced_at > eeSyncedAt)) eeSyncedAt = r.synced_at; });
        // DocPharma's own inventory (authoritative — their partner_sku_code + expiry)
        const { data: dpRows } = await supabase.from('docpharma_dp_stock').select('sku, inventory_count, expiry_date, synced_at');
        const dpMap = {}; let dpSyncedAt = null;
        (dpRows || []).forEach(r => { dpMap[r.sku] = { count: num(r.inventory_count), expiry: r.expiry_date }; if (r.synced_at && (!dpSyncedAt || r.synced_at > dpSyncedAt)) dpSyncedAt = r.synced_at; });

        const bySku = {};
        const get = sku => bySku[sku] || (bySku[sku] = { sku, name: null, sent: 0, sentValue: 0, delivered: 0, rto: 0, lost: 0, inTransit: 0, delivered30d: 0, invoiced: false });
        (mv || []).forEach(r => { const b = get(r.sku); b.name = r.name || b.name; b.delivered = num(r.delivered); b.rto = num(r.rto); b.lost = num(r.lost); b.inTransit = num(r.in_transit); b.delivered30d = num(r.delivered_30d); });
        (items || []).forEach(it => { if (!it.sku) return; const b = get(it.sku); b.sent += num(it.qty); b.sentValue += num(it.amount); b.name = it.name || b.name; b.invoiced = true; });

        const skus = Object.values(bySku).map(b => {
            const dispatched = b.delivered + b.rto + b.lost + b.inTransit;
            const onHand = Math.round(b.sent - b.delivered - b.lost - b.inTransit);   // RTO nets out
            const unitRate = b.sent > 0 ? b.sentValue / b.sent : null;                // ₹/base-unit (incl tax) from goods invoices
            const onHandValue = unitRate != null ? Math.round(onHand * unitRate) : null;
            const rtoValue = unitRate != null ? Math.round(b.rto * unitRate) : null;
            const rtoRate = (b.delivered + b.rto) > 0 ? b.rto / (b.delivered + b.rto) : 0;
            const runRate = b.delivered30d / 30;                                       // units/day (last 30d of delivery activity)
            const daysCover = runRate > 0 ? Math.round(onHand / runRate) : null;       // null = no recent velocity
            const reorder = b.invoiced && runRate > 0 && onHand >= 0 && daysCover != null && daysCover < lead;
            const suggestedQty = reorder ? Math.max(0, Math.ceil(lead * 2 * runRate - onHand)) : 0;   // top up to ~2× lead-time cover
            let status;
            if (!b.invoiced) status = 'no-invoice';
            else if (onHand < 0) status = 'short';
            else if (reorder) status = 'reorder';
            else if (onHand <= lowThreshold) status = 'low';
            else status = 'ok';
            // Three-source reconciliation. DocPharma's own count is authoritative; EasyEcom is a cross-check.
            const eeStock = eeMap[b.sku] != null ? eeMap[b.sku] : null;
            const dp = dpMap[b.sku] || null;
            const dpStock = dp ? dp.count : null;
            const dpExpiry = dp ? dp.expiry : null;
            const expiryDays = dpExpiry ? Math.round((new Date(dpExpiry) - Date.now()) / 86400000) : null;
            const actual = dpStock != null ? dpStock : eeStock;                        // best available "actual"
            const variance = (actual != null && b.invoiced) ? actual - onHand : null;   // actual − implied
            const sourcesDisagree = dpStock != null && eeStock != null && Math.abs(dpStock - eeStock) > Math.max(15, 0.2 * Math.max(Math.abs(dpStock), Math.abs(eeStock)));
            const discrepancy = (variance != null && Math.abs(variance) > Math.max(15, 0.15 * Math.abs(onHand))) || sourcesDisagree;
            const actualValue = (unitRate != null && actual != null) ? Math.round(Math.max(0, actual) * unitRate) : null;
            return { ...b, dispatched, onHand, unitRate: unitRate != null ? Math.round(unitRate) : null, onHandValue, rtoValue, rtoRate, runRate: Math.round(runRate * 10) / 10, daysCover, reorder, suggestedQty, status, eeStock, dpStock, dpExpiry, expiryDays, actual, actualValue, variance, sourcesDisagree, discrepancy };
        });
        const rank = s => ({ reorder: 0, short: 1, low: 2, ok: 3, 'no-invoice': 4 }[s.status] ?? 5);
        skus.sort((a, b) => rank(a) - rank(b) || (a.daysCover ?? 1e9) - (b.daysCover ?? 1e9) || b.delivered - a.delivered);

        const sum = k => skus.reduce((s, x) => s + (x[k] || 0), 0);
        const summary = {
            skuCount: skus.length,
            invoicedSkus: skus.filter(s => s.invoiced).length,
            missingInvoiceSkus: skus.filter(s => !s.invoiced).length,
            shortSkus: skus.filter(s => s.status === 'short').length,
            lowSkus: skus.filter(s => s.status === 'low').length,
            reorderSkus: skus.filter(s => s.status === 'reorder').length,
            reorderQty: skus.reduce((s, x) => s + (x.suggestedQty || 0), 0),
            sent: sum('sent'), sentValue: Math.round(sum('sentValue')),
            delivered: sum('delivered'), rto: sum('rto'), lost: sum('lost'), inTransit: sum('inTransit'),
            onHand: sum('onHand'), onHandValue: Math.round(sum('onHandValue')), rtoValue: Math.round(sum('rtoValue')),
            eeSyncedAt, dpSyncedAt,
            eeStock: skus.reduce((s, x) => s + (x.eeStock || 0), 0),
            dpStock: skus.reduce((s, x) => s + (x.dpStock > 0 ? x.dpStock : 0), 0),
            dpMatched: skus.filter(s => s.dpStock != null && s.invoiced).length,
            actualValue: Math.round(skus.reduce((s, x) => s + (x.actualValue || 0), 0)),
            discrepancySkus: skus.filter(s => s.discrepancy).length,
            netVariance: skus.reduce((s, x) => s + (x.variance || 0), 0),
            expiringSkus: skus.filter(s => s.expiryDays != null && s.expiryDays <= 120 && s.dpStock > 0).length,
        };
        res.json({ success: true, lead, lowThreshold, eeSyncedAt, dpSyncedAt, summary, skus });
    } catch (e) { console.error('[DP Inventory]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/docpharma-inventory/detail?sku=TE-XXX  → drill: goods invoices + monthly trend + pack/combo contributors
router.get('/docpharma-inventory/detail', async (req, res) => {
    try {
        const sku = String(req.query.sku || '').trim();
        if (!sku) return res.status(400).json({ success: false, error: 'sku required' });

        const { data: det, error } = await supabase.rpc('docpharma_inventory_sku_detail', { p_base: sku });
        if (error) throw new Error(error.message);
        const monthsMap = {}, contribMap = {};
        (det || []).forEach(r => {
            monthsMap[r.month] = (monthsMap[r.month] || 0) + num(r.delivered);
            const c = contribMap[r.contrib_sku] || (contribMap[r.contrib_sku] = { sku: r.contrib_sku, mult: r.mult, delivered: 0 });
            c.delivered += num(r.delivered);
        });
        const monthly = Object.keys(monthsMap).sort().map(m => ({ month: m, delivered: Math.round(monthsMap[m]) }));
        const contributors = Object.values(contribMap).sort((a, b) => b.delivered - a.delivered).map(c => ({ ...c, delivered: Math.round(c.delivered) }));

        const { data: gi } = await supabase.from('docpharma_goods_invoice_items').select('qty, amount, invoice_id').eq('sku', sku);
        const invIds = [...new Set((gi || []).map(x => x.invoice_id).filter(Boolean))];
        const invMap = {};
        if (invIds.length) { const { data: invs } = await supabase.from('docpharma_goods_invoices').select('id, invoice_no, invoice_date').in('id', invIds); (invs || []).forEach(i => invMap[i.id] = i); }
        const invoices = (gi || []).map(x => ({ invoice_no: (invMap[x.invoice_id] || {}).invoice_no || '—', invoice_date: (invMap[x.invoice_id] || {}).invoice_date || null, qty: num(x.qty), amount: Math.round(num(x.amount)) }))
            .sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')));

        res.json({ success: true, sku, monthly, contributors, invoices });
    } catch (e) { console.error('[DP Inventory detail]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
