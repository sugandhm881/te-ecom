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
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
const EE_BASE = 'https://api.easyecom.io';

// Period movement per base SKU for [fromStr,toStr] (YYYY-MM-DD): Sent (goods invoiced), Delivered/RTO/Lost (status hit in period), with ₹ value.
async function periodMovement(fromStr, toStr) {
    const fromISO = `${fromStr}T00:00:00.000+05:30`, toISO = `${toStr}T23:59:59.999+05:30`;
    const { data: mv, error } = await supabase.rpc('docpharma_inventory_movement', { p_from: fromISO, p_to: toISO });
    if (error) throw new Error(error.message);
    const { data: items } = await supabase.from('docpharma_goods_invoice_items').select('sku, name, qty, amount, invoice_id');
    const { data: invs } = await supabase.from('docpharma_goods_invoices').select('id, invoice_date');
    const invDate = {}; (invs || []).forEach(i => invDate[i.id] = i.invoice_date ? String(i.invoice_date).slice(0, 10) : null);
    const cum = {}, nameMap = {}, periodSent = {};
    (items || []).forEach(it => {
        if (!it.sku) return;
        const c = cum[it.sku] || (cum[it.sku] = { qty: 0, amount: 0 }); c.qty += num(it.qty); c.amount += num(it.amount); nameMap[it.sku] = nameMap[it.sku] || it.name;
        const dt = invDate[it.invoice_id];
        if (dt && dt >= fromStr && dt <= toStr) { const p = periodSent[it.sku] || (periodSent[it.sku] = { qty: 0, value: 0 }); p.qty += num(it.qty); p.value += num(it.amount); }
    });
    const rate = {}; Object.keys(cum).forEach(s => rate[s] = cum[s].qty > 0 ? cum[s].amount / cum[s].qty : null);
    const bySku = {};
    (mv || []).forEach(r => { const b = bySku[r.sku] || (bySku[r.sku] = { sku: r.sku }); b.delivered = num(r.delivered); b.rto = num(r.rto); b.lost = num(r.lost); });
    Object.keys(periodSent).forEach(s => { const b = bySku[s] || (bySku[s] = { sku: s }); b.sent = periodSent[s].qty; b.sentValue = Math.round(periodSent[s].value); });
    const rows = Object.values(bySku).map(b => {
        const ur = rate[b.sku];
        const delivered = b.delivered || 0, rto = b.rto || 0, lost = b.lost || 0, sent = b.sent || 0;
        return { sku: b.sku, name: nameMap[b.sku] || null, sent, sentValue: b.sentValue || 0, delivered, rto, lost,
            deliveredValue: ur != null ? Math.round(delivered * ur) : null, rtoValue: ur != null ? Math.round(rto * ur) : null, lostValue: ur != null ? Math.round(lost * ur) : null,
            net: sent - delivered - lost };
    }).filter(x => x.sent || x.delivered || x.rto || x.lost).sort((a, b) => b.delivered - a.delivered);
    const totals = rows.reduce((t, x) => { ['sent', 'sentValue', 'delivered', 'deliveredValue', 'rto', 'rtoValue', 'lost', 'lostValue', 'net'].forEach(k => t[k] = (t[k] || 0) + (x[k] || 0)); return t; }, {});
    return { from: fromStr, to: toStr, rows, totals };
}

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

// Core reconciliation + optional period movement — shared by the JSON endpoint and the report endpoints.
async function computeInventory(lead, lowThreshold, fromStr, toStr) {
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
            const actual = dpStock != null ? dpStock : eeStock;                        // best available "actual" (for value)
            const variance = (eeStock != null && b.invoiced) ? eeStock - onHand : null;   // EasyEcom − Implied
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
        let period = null;
        if (fromStr && toStr) {
            const pm = await periodMovement(fromStr, toStr);
            const pmap = {}; pm.rows.forEach(r => pmap[r.sku] = r);
            skus.forEach(x => { x.period = pmap[x.sku] || { sent: 0, sentValue: 0, delivered: 0, deliveredValue: 0, rto: 0, rtoValue: 0, lost: 0, lostValue: 0, net: 0 }; });
            period = { from: fromStr, to: toStr, totals: pm.totals };
        }
        return { lead, lowThreshold, from: fromStr || null, to: toStr || null, eeSyncedAt, dpSyncedAt, summary, period, skus };
}

// GET /api/docpharma-inventory?lead=15&low=20&from=&to=   → per-SKU reconciliation + summary
router.get('/docpharma-inventory', async (req, res) => {
    try {
        const lead = req.query.lead != null ? Math.max(1, num(req.query.lead)) : 15;
        const lowThreshold = req.query.low != null ? num(req.query.low) : 20;
        const out = await computeInventory(lead, lowThreshold, req.query.from || '', req.query.to || '');
        res.json({ success: true, ...out });
    } catch (e) { console.error('[DP Inventory]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// All goods invoices grouped by SKU (for per-SKU detail in the report).
async function goodsInvoicesBySku() {
    const { data: gi } = await supabase.from('docpharma_goods_invoice_items').select('sku, qty, amount, invoice_id');
    const invIds = [...new Set((gi || []).map(x => x.invoice_id).filter(Boolean))];
    const invMap = {};
    if (invIds.length) { const { data: invs } = await supabase.from('docpharma_goods_invoices').select('id, invoice_no, invoice_date').in('id', invIds); (invs || []).forEach(i => invMap[i.id] = i); }
    const bySku = {};
    (gi || []).forEach(x => { if (!x.sku) return; (bySku[x.sku] || (bySku[x.sku] = [])).push({ invoice_no: (invMap[x.invoice_id] || {}).invoice_no || '-', invoice_date: (invMap[x.invoice_id] || {}).invoice_date || null, qty: num(x.qty), amount: Math.round(num(x.amount)) }); });
    return bySku;
}

// GET /api/docpharma-inventory/report.pdf?from=&to=&lead=  → full insight report (KPIs, reorder, discrepancies, RTO, expiry, per-SKU detail + bookmarks)
router.get('/docpharma-inventory/report.pdf', async (req, res) => {
    try {
        const fromStr = req.query.from || '', toStr = req.query.to || '';
        const lead = req.query.lead != null ? Math.max(1, num(req.query.lead)) : 15;
        const inv = await computeInventory(lead, 20, fromStr, toStr);
        const giBySku = await goodsInvoicesBySku();
        const skus = inv.skus, S = inv.summary, per = inv.period;
        const dmy = s => s ? String(s).slice(0, 10).split('-').reverse().join('-') : '-';
        const n = v => Math.round(Number(v) || 0).toLocaleString('en-IN'), rs = v => 'Rs ' + n(v);
        const clip = (s, k) => { s = String(s || ''); return s.length > k ? s.slice(0, k - 1) + '…' : s; };
        const stLabel = { ok: 'In stock', low: 'Low', reorder: 'Reorder', short: 'Short', 'no-invoice': 'No invoice' };
        // Real SKUs only — drop draft/placeholder codes with no invoice, stock, or movement (keeps the report clean).
        const realSkus = skus.filter(x => x.invoiced || x.dpStock > 0 || x.eeStock > 0);
        // Accurate discrepancy note: pinpoint which source is the odd one out, consistent with the numbers shown.
        const dTol = (a, b) => Math.abs(a - b) <= Math.max(10, 0.20 * Math.max(Math.abs(a), Math.abs(b)));
        const discNote = (I, D, E) => {
            if (D == null) return 'EasyEcom differs from our books';
            if (E == null) return 'DocPharma differs from our books';
            const gID = Math.abs(I - D), gIE = Math.abs(I - E), gDE = Math.abs(D - E), m = Math.min(gID, gIE, gDE);
            if (m === gDE && dTol(D, E)) return 'Our books differ; DocPharma & EasyEcom agree';
            if (m === gIE && dTol(I, E)) return 'DocPharma differs; our books & EasyEcom agree';
            if (m === gID && dTol(I, D)) return 'EasyEcom differs; our books & DocPharma agree';
            return 'All three sources differ';
        };
        const M = 28, R = 567;
        const doc = new PDFDocument({ margin: M, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=inventory-report${per ? `_${fromStr}_to_${toStr}` : ''}.pdf`);
        doc.pipe(res);
        const drawHeader = () => {
            const logo = ['../static/assets/te-logo.png', '../static/assets/ecom-logo.png'].map(p => path.join(__dirname, p)).find(fs.existsSync);
            if (logo) doc.image(logo, M, 22, { width: 54 });
            doc.font('Helvetica-Bold').fontSize(15).fillColor([34, 44, 67]).text('Inventory Report — DocPharma', logo ? 90 : M, 26);
            doc.font('Helvetica').fontSize(9).fillColor([120, 120, 120]).text('The Element  ·  Shifupro Technologies Pvt Ltd', logo ? 90 : M, 45);
            doc.text(per ? `${dmy(fromStr)}  to  ${dmy(toStr)}` : 'Current snapshot', M, 26, { align: 'right', width: R - M });
            doc.text(`Generated ${moment().tz('Asia/Kolkata').format('DD MMM YYYY, hh:mm A')}`, M, 39, { align: 'right', width: R - M });
            doc.save().moveTo(M, 64).lineTo(R, 64).strokeColor([224, 224, 224]).stroke().restore();
        };
        drawHeader(); doc.y = 74;
        // KPI band
        const kpis = [['On-hand value', rs(S.onHandValue)], ['DocPharma stock', rs(S.actualValue)], ['EasyEcom stock', n(S.eeStock)], ['Reorder', S.reorderSkus + ' SKU'], ['Mismatches', String(S.discrepancySkus)], ['Expiring 120d', String(S.expiringSkus)]];
        const kw = (R - M) / kpis.length, ky = doc.y; doc.roundedRect(M, ky, R - M, 40, 5).fill([247, 248, 251]);
        kpis.forEach((k, i) => { const x = M + kw * i; if (i) doc.save().moveTo(x, ky + 8).lineTo(x, ky + 32).strokeColor([224, 226, 232]).lineWidth(.5).stroke().restore(); doc.font('Helvetica').fontSize(6.5).fillColor([120, 120, 128]).text(k[0].toUpperCase(), x + 7, ky + 8, { width: kw - 12 }); doc.font('Helvetica-Bold').fontSize(10.5).fillColor([30, 30, 40]).text(k[1], x + 7, ky + 20, { width: kw - 12 }); });
        doc.y = ky + 50;
        if (per) { const t = per.totals; doc.font('Helvetica').fontSize(9.5).fillColor([60, 60, 60]).text(`Movement ${dmy(fromStr)}–${dmy(toStr)}: Sent ${n(t.sent)} (${rs(t.sentValue)}) · Delivered ${n(t.delivered)} (${rs(t.deliveredValue)}) · RTO ${n(t.rto)} (${rs(t.rtoValue)}) · Lost ${n(t.lost)}.`, M, doc.y, { width: R - M }); doc.moveDown(0.6); }
        // reusable section table
        const table = (title, cols, rows, color) => {
            if (!rows.length) return;
            if (doc.y + 46 > doc.page.height - 36) { doc.addPage(); drawHeader(); doc.y = 74; }
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor(color || [34, 44, 67]).text(title, M, doc.y); doc.moveDown(0.25);
            const rowH = 15, hy = doc.y; doc.rect(M, hy, R - M, rowH).fill([241, 242, 248]); doc.font('Helvetica-Bold').fontSize(6.5).fillColor([90, 90, 110]);
            let x = M; cols.forEach(c => { doc.text(c[0].toUpperCase(), x + 3, hy + 4.5, { width: c[1] - 6, align: c[2], lineBreak: false }); x += c[1]; }); doc.y = hy + rowH;
            rows.forEach((r, i) => { if (doc.y + rowH > doc.page.height - 36) { doc.addPage(); drawHeader(); doc.y = 74; } const y = doc.y; if (i % 2) doc.rect(M, y, R - M, rowH).fill([248, 249, 252]); doc.font('Helvetica').fontSize(7).fillColor([50, 50, 50]); let x2 = M; cols.forEach((c, j) => { doc.text(r[j] != null ? String(r[j]) : '', x2 + 3, y + 4.5, { width: c[1] - 6, align: c[2], lineBreak: false }); x2 += c[1]; }); doc.save().moveTo(M, y + rowH).lineTo(R, y + rowH).strokeColor([236, 238, 242]).lineWidth(.4).stroke().restore(); doc.y = y + rowH; });
            doc.moveDown(0.8);
        };
        table('Reorder now', [['SKU', 70, 'left'], ['On-hand', 60, 'right'], ['Days cover', 60, 'right'], ['Run/day', 50, 'right'], ['Suggested order', 90, 'right']], skus.filter(x => x.status === 'reorder').map(x => [x.sku, n(x.onHand), x.daysCover == null ? '-' : x.daysCover + 'd', String(x.runRate), n(x.suggestedQty)]), [190, 40, 40]);
        table('Discrepancies (sources disagree)', [['SKU', 62, 'left'], ['Implied', 48, 'right'], ['DocPharma', 56, 'right'], ['EasyEcom', 54, 'right'], ['Var (EE)', 48, 'right'], ['Note', 260, 'left']], skus.filter(x => x.discrepancy).map(x => [x.sku, n(x.onHand), x.dpStock == null ? '-' : n(x.dpStock), x.eeStock == null ? '-' : n(x.eeStock), (x.variance > 0 ? '+' : '') + n(x.variance), discNote(x.onHand, x.dpStock, x.eeStock)]), [180, 120, 0]);
        table('Expiring soon', [['SKU', 70, 'left'], ['Expiry', 60, 'right'], ['Days', 40, 'right'], ['DP stock', 60, 'right'], ['Value', 70, 'right']], skus.filter(x => x.expiryDays != null && x.dpStock > 0 && x.expiryDays <= 365).sort((a, b) => a.expiryDays - b.expiryDays).slice(0, 10).map(x => [x.sku, dmy(x.dpExpiry), String(x.expiryDays), n(x.dpStock), rs(x.actualValue)]), [180, 40, 40]);
        // full reconciliation — flows on from the insight sections (fills the page) unless too near the bottom
        if (doc.y + 64 > doc.page.height - 40) { doc.addPage(); drawHeader(); doc.y = 74; } else doc.moveDown(0.3);
        table(per ? 'Full reconciliation (Sent/Deliv = period movement)' : 'Full reconciliation (current)', [['SKU', 60, 'left'], ['Sent', 34, 'right'], ['Deliv', 38, 'right'], ['Impl', 38, 'right'], ['DP', 38, 'right'], ['EE', 38, 'right'], ['Var', 38, 'right'], ['Value', 54, 'right'], ['Cover', 42, 'right'], ['Status', 52, 'left']], realSkus.map(x => { const p = per && x.period; return [x.sku, n(p ? x.period.sent : x.sent), n(p ? x.period.delivered : x.delivered), n(x.onHand), x.dpStock == null ? '-' : n(x.dpStock), x.eeStock == null ? '-' : n(x.eeStock), x.variance == null ? '-' : (x.variance > 0 ? '+' : '') + n(x.variance), x.actualValue != null ? rs(x.actualValue) : '-', x.daysCover == null ? '-' : x.daysCover + 'd', stLabel[x.status] || x.status]; }));
        // per-SKU detail — one clean card per SKU
        doc.addPage(); drawHeader(); doc.y = 74;
        doc.font('Helvetica-Bold').fontSize(12).fillColor([34, 44, 67]).text('Per-SKU detail', M, doc.y); doc.moveDown(0.15);
        doc.font('Helvetica').fontSize(8).fillColor([130, 130, 130]).text('Net to DocPharma = Sent minus Delivered minus Lost. RTO units return to DocPharma stock, so they are not subtracted.', M, doc.y, { width: R - M }); doc.moveDown(0.5);
        const outlineTop = doc.outline.addItem('Per-SKU detail');
        const pad = 9, innerW = R - M - 2 * pad;
        const stat = (label, val, cx, cw, cy) => { doc.font('Helvetica').fontSize(6).fillColor([150, 152, 162]).text(String(label).toUpperCase(), cx, cy, { width: cw, lineBreak: false }); doc.font('Helvetica-Bold').fontSize(9).fillColor([34, 40, 55]).text(val, cx, cy + 9, { width: cw, lineBreak: false }); };
        realSkus.forEach(x => {
            const gi = (giBySku[x.sku] || []).slice().sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')));
            const giStr = gi.length ? gi.slice(0, 3).map(i => `${i.invoice_no} · ${dmy(i.invoice_date)} · ${n(i.qty)}`).join('      ') + (gi.length > 3 ? `      +${gi.length - 3} more` : '') : '';
            const metaBits = [];
            if (x.dpExpiry) metaBits.push(`Expiry ${dmy(x.dpExpiry)} (${x.expiryDays}d)`);
            if (x.reorder) metaBits.push(`Reorder ${n(x.suggestedQty)}`);
            const metaStr = metaBits.join('      ·      ');
            const pd = x.period;
            const periodStr = (per && pd) ? `This period   ·   Sent ${n(pd.sent)}   ·   Delivered ${n(pd.delivered)} (${rs(pd.deliveredValue)})   ·   RTO ${n(pd.rto)}   ·   Lost ${n(pd.lost)}   ·   Net to DocPharma ${(pd.net > 0 ? '+' : '') + n(pd.net)}  =  Sent ${n(pd.sent)} - Delivered ${n(pd.delivered)} - Lost ${n(pd.lost)}` : '';
            doc.font('Helvetica').fontSize(7.5);
            const metaH = metaStr ? doc.heightOfString(metaStr, { width: innerW }) : 0;
            const periodH = periodStr ? doc.heightOfString(periodStr, { width: innerW }) : 0;
            const giH = giStr ? doc.heightOfString('Goods invoices    ' + giStr, { width: innerW }) : 0;
            const cardH = pad + 17 + 24 + (metaH ? metaH + 3 : 0) + (periodH ? periodH + 3 : 0) + (giH ? giH + 3 : 0) + pad;
            if (doc.y + cardH + 7 > doc.page.height - 34) { doc.addPage(); drawHeader(); doc.y = 74; }
            outlineTop.addItem(x.sku);
            const top = doc.y;
            doc.lineWidth(0.6).roundedRect(M, top, R - M, cardH, 5).fillAndStroke([250, 250, 252], [231, 233, 242]);
            let yy = top + pad;
            doc.font('Helvetica-Bold').fontSize(10).fillColor([67, 56, 202]).text(x.sku + '    ', M + pad, yy, { continued: true }).font('Helvetica').fontSize(8).fillColor([140, 140, 140]).text(clip(x.name, 66));
            yy += 17;
            const cells = [['Implied', n(x.onHand)], ['DocPharma', x.dpStock == null ? '-' : n(x.dpStock)], ['EasyEcom', x.eeStock == null ? '-' : n(x.eeStock)], ['Var (EE)', x.variance == null ? '-' : (x.variance > 0 ? '+' : '') + n(x.variance)], ['RTO', (x.rtoRate * 100).toFixed(0) + '%'], ['Days cover', x.daysCover == null ? '-' : x.daysCover + 'd']];
            const cw = innerW / cells.length;
            cells.forEach((c, i) => stat(c[0], c[1], M + pad + cw * i, cw - 4, yy));
            yy += 24;
            if (metaStr) { doc.font('Helvetica').fontSize(7.5).fillColor([90, 92, 104]).text(metaStr, M + pad, yy, { width: innerW }); yy += metaH + 3; }
            if (periodStr) { doc.font('Helvetica').fontSize(7.5).fillColor([90, 92, 104]).text(periodStr, M + pad, yy, { width: innerW }); yy += periodH + 3; }
            if (giStr) { doc.font('Helvetica').fontSize(7.5).fillColor([155, 157, 168]).text('Goods invoices    ' + giStr, M + pad, yy, { width: innerW }); }
            doc.y = top + cardH + 7;
        });
        const range = doc.bufferedPageRange();
        for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); doc.page.margins.bottom = 0; doc.font('Helvetica').fontSize(7.5).fillColor([160, 160, 160]).text('The Element · DocPharma inventory report', M, doc.page.height - 24, { width: (R - M) / 2, align: 'left', lineBreak: false }).text(`Page ${i + 1} of ${range.count}`, M + (R - M) / 2, doc.page.height - 24, { width: (R - M) / 2, align: 'right', lineBreak: false }); }
        doc.end();
    } catch (e) { console.error('[DP Inv report pdf]', e); if (!res.headersSent) res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/docpharma-inventory/report.xlsx?from=&to=&lead=  → multi-sheet Excel (Summary · Reconciliation · Movement · Reorder · Discrepancies)
router.get('/docpharma-inventory/report.xlsx', async (req, res) => {
    try {
        const fromStr = req.query.from || '', toStr = req.query.to || '';
        const lead = req.query.lead != null ? Math.max(1, num(req.query.lead)) : 15;
        const inv = await computeInventory(lead, 20, fromStr, toStr);
        const skus = inv.skus, S = inv.summary, per = inv.period;
        const wb = new ExcelJS.Workbook(); wb.creator = 'The Element';
        const style = ws => { ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };
        // Summary
        const s1 = wb.addWorksheet('Summary');
        s1.addRow(['DocPharma Inventory Report']).font = { bold: true, size: 14 };
        s1.addRow([per ? `Period: ${fromStr} to ${toStr}` : 'Current snapshot']); s1.addRow([]);
        [['SKUs tracked', S.skuCount], ['Invoiced SKUs', S.invoicedSkus], ['Implied on-hand (u)', S.onHand], ['Implied value (Rs)', S.onHandValue], ['DocPharma stock (u)', S.dpStock], ['DocPharma value (Rs)', S.actualValue], ['EasyEcom stock (u)', S.eeStock], ['Reorder SKUs', S.reorderSkus], ['Reorder qty (u)', S.reorderQty], ['Mismatches', S.discrepancySkus], ['Expiring <=120d', S.expiringSkus]].forEach(r => s1.addRow(r));
        if (per) { const t = per.totals; s1.addRow([]); s1.addRow(['Period movement']).font = { bold: true }; [['Sent (u)', t.sent], ['Sent (Rs)', t.sentValue], ['Delivered (u)', t.delivered], ['Delivered (Rs)', t.deliveredValue], ['RTO (u)', t.rto], ['RTO (Rs)', t.rtoValue], ['Lost (u)', t.lost]].forEach(r => s1.addRow(r)); }
        s1.getColumn(1).width = 24; s1.getColumn(2).width = 16;
        // Reconciliation
        const s2 = wb.addWorksheet('Reconciliation');
        s2.columns = [{ header: 'SKU', key: 'sku', width: 14 }, { header: 'Product', key: 'name', width: 38 }, { header: 'Sent', key: 'sent', width: 9 }, { header: 'Delivered', key: 'delivered', width: 10 }, { header: 'RTO', key: 'rto', width: 8 }, { header: 'RTO %', key: 'rtoPct', width: 8 }, { header: 'Implied', key: 'onHand', width: 9 }, { header: 'DocPharma', key: 'dpStock', width: 11 }, { header: 'EasyEcom', key: 'eeStock', width: 10 }, { header: 'Var(EE)', key: 'variance', width: 9 }, { header: 'Value Rs', key: 'actualValue', width: 11 }, { header: 'Days cover', key: 'daysCover', width: 10 }, { header: 'Status', key: 'status', width: 11 }, { header: 'Expiry', key: 'dpExpiry', width: 12 }];
        skus.forEach(x => s2.addRow({ ...x, rtoPct: Math.round(x.rtoRate * 100) + '%' })); style(s2);
        // Movement (period)
        if (per) { const s3 = wb.addWorksheet('Movement'); s3.columns = [{ header: 'SKU', key: 'sku', width: 14 }, { header: 'Sent', key: 'sent', width: 9 }, { header: 'Sent Rs', key: 'sentValue', width: 11 }, { header: 'Delivered', key: 'delivered', width: 10 }, { header: 'Delivered Rs', key: 'deliveredValue', width: 12 }, { header: 'RTO', key: 'rto', width: 8 }, { header: 'RTO Rs', key: 'rtoValue', width: 11 }, { header: 'Lost', key: 'lost', width: 7 }, { header: 'Net', key: 'net', width: 9 }]; skus.forEach(x => { if (x.period && (x.period.sent || x.period.delivered || x.period.rto)) s3.addRow({ sku: x.sku, ...x.period }); }); style(s3); }
        // Reorder
        const s4 = wb.addWorksheet('Reorder'); s4.columns = [{ header: 'SKU', key: 'sku', width: 14 }, { header: 'On-hand', key: 'onHand', width: 9 }, { header: 'Days cover', key: 'daysCover', width: 10 }, { header: 'Run/day', key: 'runRate', width: 9 }, { header: 'Suggested qty', key: 'suggestedQty', width: 13 }]; skus.filter(x => x.status === 'reorder').forEach(x => s4.addRow(x)); style(s4);
        // Discrepancies
        const s5 = wb.addWorksheet('Discrepancies'); s5.columns = [{ header: 'SKU', key: 'sku', width: 14 }, { header: 'Implied', key: 'onHand', width: 9 }, { header: 'DocPharma', key: 'dpStock', width: 11 }, { header: 'EasyEcom', key: 'eeStock', width: 10 }, { header: 'Var(EE)', key: 'variance', width: 9 }]; skus.filter(x => x.discrepancy).forEach(x => s5.addRow(x)); style(s5);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=inventory-report${per ? `_${fromStr}_to_${toStr}` : ''}.xlsx`);
        await wb.xlsx.write(res); res.end();
    } catch (e) { console.error('[DP Inv report xlsx]', e); if (!res.headersSent) res.status(500).json({ success: false, error: e.message }); }
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
