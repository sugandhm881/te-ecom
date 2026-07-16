// Amazon FBA — dashboard, live inventory, and forecast-driven restock plan.
// Three read endpoints:
//   GET /api/fba/insights?days=30        — demand insights from synced AFN orders (DB, cached 5m)
//   GET /api/fba/inventory?fresh=1        — live FBA stock from SP-API (cached 20m in-memory)
//   GET /api/fba/forecast?coverDays=45&leadDays=14  — velocity x live stock -> restock plan
//
// FBA orders are amazon_orders.fulfillment_channel = 'AFN'. Revenue comes from order_total_amount
// (item_price is only ~9% populated); units come from item quantity_ordered (reliable).
// Inventory <-> velocity are merged on ASIN, never seller_sku (the FBA MSKU differs from the order feed).
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const { makeSignedApiRequest } = require('./helpers');
const { runReport } = require('./amazon_reports');
const inbound = require('./amazon_inbound');
const config = require('../../config');
const cron = require('node-cron');

const MKT = config.MARKETPLACE_ID || 'A21TJRUUN4KGV';
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const round1 = n => Math.round(n * 10) / 10;
const round2 = n => Math.round(n * 100) / 100;

// ── Response cache (matches ops_control) — GET analytics cached briefly; ?fresh=1 recomputes ──
const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
router.use((req, res, next) => {
    // Scope STRICTLY to /fba paths — this router is mounted at /api, so an unscoped use() would cache
    // every GET of routers mounted after it (same bug as ops_control's cache). Never widen this guard.
    if (!req.path.startsWith('/fba')) return next();
    if (req.method !== 'GET') return next();
    if (/^\/fba\/(locations|inbound)/.test(req.path)) return next(); // live table + action state
    const key = req.originalUrl.replace(/([?&])fresh=1(&|$)/, '$1').replace(/[?&]$/, '');
    if (!req.query.fresh) {
        const hit = _cache.get(key);
        if (hit && Date.now() - hit.t < CACHE_TTL) { res.set('X-Fba-Cache', 'hit'); return res.json(hit.v); }
    }
    const orig = res.json.bind(res);
    res.json = (body) => { if (body && body.success) _cache.set(key, { t: Date.now(), v: body }); return orig(body); };
    next();
});

// ── Live FBA inventory (SP-API getInventorySummaries) with a 20-min in-memory cache ──
let _invCache = { t: 0, data: null };
const INV_TTL = 20 * 60 * 1000;

async function fetchFbaInventory(fresh) {
    if (!fresh && _invCache.data && Date.now() - _invCache.t < INV_TTL) {
        return { rows: _invCache.data, at: _invCache.t, stale: false };
    }
    try {
        const all = [];
        let nextToken = null, guard = 0;
        do {
            const queryParams = { granularityType: 'Marketplace', granularityId: MKT, marketplaceIds: MKT, details: true };
            if (nextToken) queryParams.nextToken = nextToken;
            const r = await makeSignedApiRequest({ method: 'GET', path: '/fba/inventory/v1/summaries', queryParams });
            const payload = (r && r.payload) || {};
            all.push(...(payload.inventorySummaries || []));
            nextToken = (r && r.pagination && r.pagination.nextToken) || payload.nextToken || null;
        } while (nextToken && ++guard < 20);
        _invCache = { t: Date.now(), data: all };
        return { rows: all, at: _invCache.t, stale: false };
    } catch (e) {
        // Serve last good snapshot if the API hiccups, so the dashboard degrades gracefully.
        if (_invCache.data) return { rows: _invCache.data, at: _invCache.t, stale: true, error: e.message };
        throw e;
    }
}

// Flatten one SP-API inventory summary to the numbers we care about.
function normInv(s) {
    const d = s.inventoryDetails || {};
    const inboundWorking = num(d.inboundWorkingQuantity);
    const inboundShipped = num(d.inboundShippedQuantity);
    const inboundReceiving = num(d.inboundReceivingQuantity);
    return {
        sku: s.sellerSku, asin: s.asin, fnSku: s.fnSku, name: s.productName || null,
        fulfillable: num(d.fulfillableQuantity),
        inboundWorking, inboundShipped, inboundReceiving,
        inbound: inboundWorking + inboundShipped + inboundReceiving,
        reserved: num(d.reservedQuantity && d.reservedQuantity.totalReservedQuantity),
        unfulfillable: num(d.unfulfillableQuantity && d.unfulfillableQuantity.totalUnfulfillableQuantity),
        researching: num(d.researchingQuantity && d.researchingQuantity.totalResearchingQuantity),
        total: num(s.totalQuantity)
    };
}

// Roll SKU-level inventory up to ASIN (a relisted product can have >1 MSKU under one ASIN).
function aggByAsin(rows) {
    const m = {};
    rows.forEach(r => {
        const k = r.asin || r.sku;
        if (!m[k]) m[k] = { asin: r.asin, skus: [], fulfillable: 0, inbound: 0, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0, reserved: 0, unfulfillable: 0, researching: 0, total: 0, name: r.name };
        const a = m[k];
        if (r.sku) a.skus.push(r.sku);
        a.fulfillable += r.fulfillable; a.inbound += r.inbound;
        a.inboundWorking += r.inboundWorking; a.inboundShipped += r.inboundShipped; a.inboundReceiving += r.inboundReceiving;
        a.reserved += r.reserved; a.unfulfillable += r.unfulfillable; a.researching += r.researching; a.total += r.total;
        if (!a.name && r.name) a.name = r.name;
    });
    return m;
}

async function getVelocity() {
    const { data, error } = await supabase.rpc('fba_sku_velocity');
    if (error) throw new Error(error.message);
    const map = {};
    (data || []).forEach(v => { map[v.asin] = v; });
    return { list: data || [], map };
}

// asin -> { masterSku, masterName } — the internal master SKU behind each Amazon ASIN.
async function getAsinMaster() {
    const { data, error } = await supabase.rpc('fba_asin_master');
    if (error) throw new Error(error.message);
    const map = {};
    (data || []).forEach(r => { map[r.asin] = { masterSku: r.master_sku, masterName: r.master_name }; });
    return map;
}

// ─────────────────────────── INSIGHTS (demand) ───────────────────────────
router.get('/fba/insights', async (req, res) => {
    try {
        const days = Math.min(365, Math.max(7, parseInt(req.query.days || '30', 10) || 30));
        const [sumRes, dailyRes, vel, master] = await Promise.all([
            supabase.rpc('fba_summary', { days_back: days }),
            supabase.rpc('fba_daily', { days_back: days }),
            getVelocity(),
            getAsinMaster()
        ]);
        if (sumRes.error) throw new Error(sumRes.error.message);
        if (dailyRes.error) throw new Error(dailyRes.error.message);

        const s = (sumRes.data && sumRes.data[0]) || {};
        const orders = num(s.orders), units = num(s.units), revenue = num(s.revenue), canceled = num(s.canceled);
        const summary = {
            orders, units, revenue: round2(revenue),
            aov: orders ? Math.round(revenue / orders) : 0,
            unitsPerOrder: orders ? round2(units / orders) : 0,
            canceled, cancelRate: (orders + canceled) ? round1((canceled / (orders + canceled)) * 100) : 0,
            primePct: orders ? round1((num(s.prime) / orders) * 100) : 0,
            businessOrders: num(s.business),
            activeSkus: num(s.active_skus)
        };

        const totalUnits30 = vel.list.reduce((a, v) => a + num(v.u30), 0) || 1;
        const topAsins = vel.list
            .map(v => {
                const u30 = num(v.u30), u7 = num(v.u7), up = num(v.unit_price);
                const vel30 = round2(u30 / 30), vel7 = round2(u7 / 7);
                const mm = master[v.asin] || {};
                return {
                    asin: v.asin, sku: v.seller_sku, masterSku: mm.masterSku || null,
                    title: v.title || v.seller_sku || v.asin,
                    u7, u30, u60: num(v.u60), u90: num(v.u90),
                    vel30, vel7, unitPrice: up,
                    estRevenue: Math.round(u30 * up),
                    sharePct: round1((u30 / totalUnits30) * 100),
                    trendPct: vel30 > 0 ? Math.round(((vel7 - vel30) / vel30) * 100) : (vel7 > 0 ? 999 : 0),
                    lastSale: v.last_sale
                };
            })
            .sort((a, b) => b.u30 - a.u30);

        res.json({ success: true, days, summary, daily: dailyRes.data || [], topAsins });
    } catch (e) {
        console.error('[fba/insights]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─────────────────────────── LIVE INVENTORY ───────────────────────────
router.get('/fba/inventory', async (req, res) => {
    try {
        const [inv, vel, master] = await Promise.all([fetchFbaInventory(!!req.query.fresh), getVelocity(), getAsinMaster()]);
        const rows = inv.rows.map(normInv).map(r => {
            const v = vel.map[r.asin]; const mm = master[r.asin] || {};
            return { ...r, masterSku: mm.masterSku || null, title: (v && v.title) || mm.masterName || r.name || r.sku, vel30: v ? round2(num(v.u30) / 30) : 0, u30: v ? num(v.u30) : 0 };
        });
        // Active (has stock, inbound, or recent sales) first; then by fulfillable desc.
        rows.sort((a, b) => (b.fulfillable + b.inbound + b.u30) - (a.fulfillable + a.inbound + a.u30));
        const totals = rows.reduce((t, r) => {
            t.fulfillable += r.fulfillable; t.inbound += r.inbound; t.reserved += r.reserved;
            t.unfulfillable += r.unfulfillable; t.researching += r.researching; return t;
        }, { fulfillable: 0, inbound: 0, reserved: 0, unfulfillable: 0, researching: 0 });
        totals.skus = rows.length;
        totals.outOfStock = rows.filter(r => r.fulfillable === 0 && r.u30 > 0).length;
        res.json({ success: true, updatedAt: inv.at, stale: !!inv.stale, totals, rows });
    } catch (e) {
        console.error('[fba/inventory]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─────────────────────────── RESTOCK FORECAST ───────────────────────────
router.get('/fba/forecast', async (req, res) => {
    try {
        const coverDays = Math.min(180, Math.max(7, parseInt(req.query.coverDays || '45', 10) || 45));
        const leadDays = Math.min(90, Math.max(1, parseInt(req.query.leadDays || '14', 10) || 14));
        const [inv, vel, master] = await Promise.all([fetchFbaInventory(!!req.query.fresh), getVelocity(), getAsinMaster()]);

        const invByAsin = aggByAsin(inv.rows.map(normInv));
        // Every ASIN that either has FBA stock/pipeline or has sold in 90d.
        const asins = new Set([...Object.keys(invByAsin), ...vel.list.map(v => v.asin)]);
        const DAY = 86400000, today = Date.now();
        const fmtDate = ms => new Date(ms).toISOString().slice(0, 10);

        const rows = [];
        asins.forEach(asin => {
            const iv = invByAsin[asin] || { fulfillable: 0, inbound: 0, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0, reserved: 0, unfulfillable: 0, skus: [] };
            const v = vel.map[asin] || {};
            const u30 = num(v.u30), u7 = num(v.u7);
            const vel30 = round2(u30 / 30), vel7 = round2(u7 / 7);
            const unitPrice = num(v.unit_price);
            const avail = iv.fulfillable, inbound = iv.inbound;

            // On-hand cover = real sellable runway (inbound isn't sellable yet → drives stockout risk).
            // Effective cover = on-hand + inbound pipeline → drives the overstock test and next-PO timing.
            const onHandCover = vel30 > 0 ? avail / vel30 : (avail > 0 ? Infinity : 0);
            const effCover = vel30 > 0 ? (avail + inbound) / vel30 : (avail + inbound > 0 ? Infinity : 0);
            const targetStock = Math.ceil(vel30 * (coverDays + leadDays));
            const reorderPoint = Math.ceil(vel30 * leadDays);
            const suggestQty = Math.max(0, targetStock - avail - inbound);
            const stockoutDate = (vel30 > 0 && isFinite(onHandCover)) ? fmtDate(today + onHandCover * DAY) : null;
            const reorderByDate = (vel30 > 0 && isFinite(effCover)) ? fmtDate(today + Math.max(0, effCover - leadDays) * DAY) : null;
            const ohc = Math.round(onHandCover);

            let band, action;
            if (vel30 === 0 && avail === 0 && inbound === 0) { band = 'inactive'; action = 'No FBA sales, no stock — inactive listing'; }
            else if (vel30 === 0) { band = 'ok'; action = `In stock (${avail}), no sales in 90d — monitor`; }
            else if (avail === 0) {
                band = 'stockout';
                action = inbound > 0
                    ? `OUT OF STOCK — ${inbound} inbound; expedite it, then send ${suggestQty}`
                    : `OUT OF STOCK, nothing inbound — send ${suggestQty} now`;
            }
            else if (onHandCover <= leadDays) {
                band = 'critical';
                action = inbound >= reorderPoint
                    ? `Only ${ohc}d on hand — ${inbound} inbound covers it; top up ${suggestQty}`
                    : `Only ${ohc}d on hand${inbound ? `, just ${inbound} inbound` : ', nothing inbound'} — send ${suggestQty} now`;
            }
            else if (onHandCover <= coverDays) {
                band = 'reorder';
                action = `${ohc}d on hand (below ${coverDays}d target)${inbound ? `, ${inbound} inbound` : ''} — plan ${suggestQty}${reorderByDate ? ` by ${reorderByDate}` : ''}`;
            }
            else if (isFinite(effCover) && effCover > (coverDays + leadDays) * 2) {
                band = 'overstock';
                action = `~${Math.round(effCover)}d of cover${inbound ? ` incl. ${inbound} inbound` : ''} — hold replenishment`;
            }
            else { band = 'ok'; action = `Healthy — ~${ohc}d on hand${inbound ? `, ${inbound} inbound` : ''}`; }

            const mm = master[asin] || {};
            rows.push({
                asin, title: v.title || mm.masterName || iv.name || (iv.skus[0]) || asin,
                sku: v.seller_sku || iv.skus[0] || null, masterSku: mm.masterSku || null, fbaSkus: iv.skus,
                fulfillable: avail, inbound, inboundWorking: iv.inboundWorking, inboundShipped: iv.inboundShipped,
                inboundReceiving: iv.inboundReceiving, reserved: iv.reserved, unfulfillable: iv.unfulfillable,
                vel30, vel7, u30, u7,
                trendPct: vel30 > 0 ? Math.round(((vel7 - vel30) / vel30) * 100) : (vel7 > 0 ? 999 : 0),
                daysCover: isFinite(onHandCover) ? Math.round(onHandCover) : null,
                daysCoverInbound: isFinite(effCover) ? Math.round(effCover) : null,
                stockoutDate, reorderByDate,
                reorderPoint, targetStock, suggestQty,
                unitPrice, suggestValue: Math.round(suggestQty * unitPrice),
                band, action
            });
        });

        // Order by urgency, then by how fast it sells.
        const rank = { stockout: 0, critical: 1, reorder: 2, ok: 3, overstock: 4, inactive: 5 };
        rows.sort((a, b) => (rank[a.band] - rank[b.band]) || (b.vel30 - a.vel30));

        const summary = {
            skus: rows.length,
            stockout: rows.filter(r => r.band === 'stockout').length,
            critical: rows.filter(r => r.band === 'critical').length,
            reorder: rows.filter(r => r.band === 'reorder').length,
            ok: rows.filter(r => r.band === 'ok').length,
            overstock: rows.filter(r => r.band === 'overstock').length,
            suggestUnits: rows.reduce((a, r) => a + r.suggestQty, 0),
            suggestValue: rows.reduce((a, r) => a + r.suggestValue, 0),
            actionUnits: rows.filter(r => ['stockout', 'critical', 'reorder'].includes(r.band)).reduce((a, r) => a + r.suggestQty, 0)
        };

        res.json({ success: true, updatedAt: inv.at, stale: !!inv.stale, params: { coverDays, leadDays }, summary, rows });
    } catch (e) {
        console.error('[fba/forecast]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─────────────────────────── BY LOCATION (per-FC inventory + demand) ───────────────────────────
// Source: GET_LEDGER_SUMMARY_VIEW_DATA aggregated by FC (DAILY). Async + rate-limited, so we snapshot
// it into fba_fc_snapshot_ecom on a schedule and the endpoint reads the table.
let _locSync = { running: false, lastAt: 0, lastError: null };

async function syncFbaLocations(windowDays = 30) {
    if (_locSync.running) return { skipped: 'already running' };
    _locSync.running = true;
    try {
        const dataStartTime = new Date(Date.now() - windowDays * 86400000).toISOString();
        const [rows, master] = await Promise.all([
            runReport('GET_LEDGER_SUMMARY_VIEW_DATA', { dataStartTime, reportOptions: { aggregateByLocation: 'FC', aggregatedByTimePeriod: 'DAILY' } }),
            getAsinMaster()
        ]);
        // Aggregate per (FC, MSKU, disposition): latest-date ending balance = on-hand; sum |Customer Shipments| = demand.
        const agg = {};
        (rows || []).forEach(r => {
            const fc = r['Location']; if (!fc) return;
            const msku = r['MSKU'] || ''; const disp = r['Disposition'] || 'SELLABLE';
            const date = r['Date'] || '';
            const endBal = parseInt(r['Ending Warehouse Balance'] || '0', 10) || 0;
            const shipped = parseInt(r['Customer Shipments'] || '0', 10) || 0; // negative = outbound
            const key = fc + '|' + msku + '|' + disp;
            if (!agg[key]) agg[key] = { fc, msku, disp, asin: r['ASIN'] || null, title: r['Title'] || null, date, on_hand: endBal, shipped: 0 };
            const a = agg[key];
            a.shipped += Math.abs(shipped);
            if (date >= a.date) { a.date = date; a.on_hand = endBal; a.asin = r['ASIN'] || a.asin; a.title = r['Title'] || a.title; }
        });
        const batch = new Date().toISOString();
        const insertRows = Object.values(agg).map(a => ({
            synced_at: batch, fc: a.fc, msku: a.msku, asin: a.asin,
            master_sku: (master[a.asin] && master[a.asin].masterSku) || null,
            title: a.title, disposition: a.disp, on_hand: a.on_hand, shipped_units: a.shipped, window_days: windowDays
        }));
        if (insertRows.length) {
            const { error } = await supabase.from('fba_fc_snapshot_ecom').insert(insertRows);
            if (error) throw new Error(error.message);
            await supabase.from('fba_fc_snapshot_ecom').delete().lt('synced_at', batch); // keep only newest batch
        }
        _locSync.lastAt = Date.now(); _locSync.lastError = null;
        console.log(`[fba/locations] synced ${insertRows.length} rows across ${[...new Set(insertRows.map(r => r.fc))].join(', ')}`);
        return { rows: insertRows.length, fcs: [...new Set(insertRows.map(r => r.fc))], syncedAt: batch };
    } catch (e) {
        _locSync.lastError = e.message;
        console.error('[fba/locations] sync failed:', e.message);
        throw e;
    } finally {
        _locSync.running = false;
    }
}

// Build the per-FC summaries + product×FC matrix from a snapshot batch (SELLABLE only).
function buildLocationView(rows, windowDays) {
    const sellable = rows.filter(r => (r.disposition || 'SELLABLE') === 'SELLABLE');
    const fcs = [...new Set(sellable.map(r => r.fc))].sort();
    const cover = (onHand, shipped) => shipped > 0 ? Math.round(onHand / (shipped / windowDays)) : null;

    const fcSummary = fcs.map(fc => {
        const rs = sellable.filter(r => r.fc === fc);
        const onHand = rs.reduce((a, r) => a + (r.on_hand || 0), 0);
        const shipped = rs.reduce((a, r) => a + (r.shipped_units || 0), 0);
        return { fc, onHand, shipped, skus: rs.filter(r => r.on_hand > 0 || r.shipped_units > 0).length, coverDays: cover(onHand, shipped) };
    });

    // Group by product (master_sku, else msku).
    const byProd = {};
    sellable.forEach(r => {
        const pk = r.master_sku || r.msku || r.asin;
        if (!byProd[pk]) byProd[pk] = { masterSku: r.master_sku || null, msku: r.msku, asin: r.asin, title: r.title, cells: {}, total: { onHand: 0, shipped: 0 } };
        const p = byProd[pk];
        if (!p.masterSku && r.master_sku) p.masterSku = r.master_sku;
        p.cells[r.fc] = { onHand: (p.cells[r.fc]?.onHand || 0) + (r.on_hand || 0), shipped: (p.cells[r.fc]?.shipped || 0) + (r.shipped_units || 0) };
        p.total.onHand += r.on_hand || 0; p.total.shipped += r.shipped_units || 0;
    });

    const products = Object.values(byProd).map(p => {
        let rebalance = null, tight = Infinity;
        fcs.forEach(fc => {
            const c = p.cells[fc]; if (!c) return;
            c.coverDays = cover(c.onHand, c.shipped);
            // A cell is "tight" if it sells and has < 14d cover while another FC holds surplus of the same product.
            if (c.shipped > 0 && c.coverDays != null && c.coverDays < 14 && c.coverDays < tight) { tight = c.coverDays; rebalance = fc; }
        });
        p.total.coverDays = cover(p.total.onHand, p.total.shipped);
        // Only flag a rebalance when some OTHER FC has materially more cover (there's surplus to move).
        if (rebalance) {
            const surplus = fcs.some(fc => fc !== rebalance && p.cells[fc] && (p.cells[fc].coverDays == null || p.cells[fc].coverDays > (tight + 21)));
            if (!surplus) rebalance = null;
        }
        return { ...p, rebalance };
    }).sort((a, b) => b.total.shipped - a.total.shipped);

    return { fcs, fcSummary, products };
}

// GET /api/fba/locations?window=30 — reads the latest snapshot; triggers a first sync if none exists.
router.get('/fba/locations', async (req, res) => {
    try {
        const windowDays = Math.min(90, Math.max(7, parseInt(req.query.window || '30', 10) || 30));
        const { data: latest, error: e1 } = await supabase.from('fba_fc_snapshot_ecom').select('synced_at').order('synced_at', { ascending: false }).limit(1);
        if (e1) throw new Error(e1.message);
        if (!latest || !latest.length) {
            if (!_locSync.running) syncFbaLocations(windowDays).catch(() => {});
            return res.json({ success: true, pending: true, running: _locSync.running, error: _locSync.lastError, syncedAt: null, fcs: [], fcSummary: [], products: [] });
        }
        const syncedAt = latest[0].synced_at;
        const { data: rows, error: e2 } = await supabase.from('fba_fc_snapshot_ecom').select('*').eq('synced_at', syncedAt);
        if (e2) throw new Error(e2.message);
        const win = (rows && rows[0] && rows[0].window_days) || windowDays;
        const view = buildLocationView(rows || [], win);
        res.json({ success: true, pending: false, running: _locSync.running, syncedAt, windowDays: win, ...view });
    } catch (e) {
        console.error('[fba/locations]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/fba/locations/sync?window=30 — trigger a background refresh (2-min cooldown).
router.post('/fba/locations/sync', async (req, res) => {
    const windowDays = Math.min(90, Math.max(7, parseInt(req.query.window || '30', 10) || 30));
    if (_locSync.running) return res.json({ success: true, started: false, running: true });
    if (Date.now() - _locSync.lastAt < 120000) return res.json({ success: true, started: false, cooldown: true, syncedAt: new Date(_locSync.lastAt).toISOString() });
    syncFbaLocations(windowDays).catch(() => {});
    res.json({ success: true, started: true, running: true });
});

// Daily refresh at 06:30 IST; plus a startup sync if the snapshot is stale (>20h) or missing.
function initFbaLocationCron() {
    cron.schedule('30 6 * * *', () => { syncFbaLocations(30).catch(() => {}); }, { timezone: 'Asia/Kolkata' });
    setTimeout(async () => {
        try {
            const { data } = await supabase.from('fba_fc_snapshot_ecom').select('synced_at').order('synced_at', { ascending: false }).limit(1);
            const last = data && data[0] ? new Date(data[0].synced_at).getTime() : 0;
            if (Date.now() - last > 20 * 3600000) { console.log('[fba/locations] startup sync (snapshot stale/missing)'); syncFbaLocations(30).catch(() => {}); }
            else console.log('[fba/locations] snapshot fresh — skipping startup sync');
        } catch (_) {}
    }, 15000);
}

// ─────────────────────────── FBA INBOUND WIZARD (create shipment → labels) ───────────────────────────
// India-adapted Fulfillment Inbound flow. Every Amazon-committing step is its own endpoint the UI gates
// behind an explicit confirm. State persists in fba_inbound_ecom.
const inbUpdate = (planId, patch) => supabase.from('fba_inbound_ecom').update({ ...patch, updated_at: new Date().toISOString() }).eq('inbound_plan_id', planId);

// List inbound orders — merges our tracked rows (rich detail) with live Amazon plans (all + live status).
router.get('/fba/inbound', async (req, res) => {
    try {
        const { data: rows } = await supabase.from('fba_inbound_ecom').select('*').order('created_at', { ascending: false }).limit(200);
        const byId = {}; (rows || []).forEach(r => { byId[r.inbound_plan_id] = r; });
        let plans = [];
        try {
            let token = null, guard = 0;
            do {
                const q = { pageSize: 30 }; if (token) q.paginationToken = token;
                const r = await inbound.inbReq('/inbound/fba/2024-03-20/inboundPlans', 'GET', undefined, q);
                plans.push(...(r.inboundPlans || []));
                token = (r.pagination && r.pagination.paginationToken) || null;
            } while (token && ++guard < 12);
        } catch (e) { /* fall back to table-only if the live call fails */ }

        const sum = items => ({ skus: (items || []).length, units: (items || []).reduce((a, i) => a + (i.quantity || 0), 0) });
        const fcsOf = items => [...new Set((items || []).map(i => i.warehouseId).filter(Boolean))];
        const seen = new Set();
        const mk = (planId, p, row) => {
            const s = sum(row.items);
            return {
                planId, name: (p && p.name) || row.name || null,
                amzStatus: p ? p.status : null, ourStatus: row.status || null, stage: row.stage || null,
                createdAt: (p && p.createdAt) || row.created_at || null,
                ship: (p && p.sourceAddress && p.sourceAddress.city) || (row.source_address && row.source_address.city) || null,
                skus: s.skus, units: s.units, items: row.items || [],
                shipments: row.shipments || [], labels: row.labels || null, placementFee: row.placement_fee || 0,
                fcs: fcsOf(row.items), tracked: !!row.inbound_plan_id
            };
        };
        const orders = plans.map(p => { seen.add(p.inboundPlanId); return mk(p.inboundPlanId, p, byId[p.inboundPlanId] || {}); });
        (rows || []).forEach(r => { if (!seen.has(r.inbound_plan_id)) orders.push(mk(r.inbound_plan_id, null, r)); });
        orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        const isCancelled = o => o.ourStatus === 'CANCELLED' || o.amzStatus === 'VOIDED' || o.amzStatus === 'CANCELLED';
        const isConfirmed = o => (o.shipments || []).length > 0 || ['PLACEMENT_CONFIRMED', 'TRANSPORT_CONFIRMED', 'LABELS_READY'].includes(o.ourStatus);
        const summary = {
            total: orders.length,
            drafts: orders.filter(o => !isCancelled(o) && !isConfirmed(o)).length,
            confirmed: orders.filter(o => !isCancelled(o) && isConfirmed(o)).length,
            labelsReady: orders.filter(o => o.ourStatus === 'LABELS_READY' || (o.labels && o.labels.length)).length,
            units: orders.filter(o => !isCancelled(o)).reduce((a, o) => a + o.units, 0)
        };
        res.json({ success: true, orders, summary });
    } catch (e) { console.error('[fba/inbound list]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// Bulk-cancel all DRAFT (unconfirmed ACTIVE) inbound plans — clean up leftover drafts. Keeps confirmed shipments.
router.post('/fba/inbound/cancel-drafts', async (req, res) => {
    try {
        const { data: rows } = await supabase.from('fba_inbound_ecom').select('inbound_plan_id, status');
        const confirmed = new Set((rows || []).filter(r => ['PLACEMENT_CONFIRMED', 'TRANSPORT_CONFIRMED', 'LABELS_READY'].includes(r.status)).map(r => r.inbound_plan_id));
        const done = new Set((rows || []).filter(r => r.status === 'CANCELLED').map(r => r.inbound_plan_id));
        let plans = [];
        try {
            let token = null, g = 0;
            do { const q = { pageSize: 30 }; if (token) q.paginationToken = token; const r = await inbound.inbReq('/inbound/fba/2024-03-20/inboundPlans', 'GET', undefined, q); plans.push(...(r.inboundPlans || [])); token = (r.pagination && r.pagination.paginationToken) || null; } while (token && ++g < 12);
        } catch (_) {}
        const targets = plans.filter(p => p.status === 'ACTIVE' && !confirmed.has(p.inboundPlanId) && !done.has(p.inboundPlanId)).map(p => p.inboundPlanId);
        let ok = 0, fail = 0;
        for (const id of targets) { try { await inbound.cancelInboundPlan(id); await inbUpdate(id, { status: 'CANCELLED', stage: 'cancelled' }); ok++; } catch (_) { fail++; } }
        res.json({ success: true, cancelled: ok, failed: fail, total: targets.length });
    } catch (e) { console.error('[fba/inbound cancel-drafts]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// Create a plan (DRAFT). items: [{msku, quantity, warehouseId, prepOwner?, labelOwner?, title?, masterSku?}]
router.post('/fba/inbound/plan', async (req, res) => {
    try {
        const { items, name, sourceAddress } = req.body || {};
        if (!Array.isArray(items) || !items.length) return res.status(400).json({ success: false, error: 'items required' });
        const planId = await inbound.createInboundPlan({ items, name, sourceAddress });
        const row = { inbound_plan_id: planId, name: name || null, status: 'DRAFT', stage: 'placement', items, source_address: sourceAddress || inbound.DEFAULT_SOURCE };
        const { data, error } = await supabase.from('fba_inbound_ecom').upsert(row, { onConflict: 'inbound_plan_id' }).select().single();
        if (error) throw new Error(error.message);
        res.json({ success: true, inboundPlanId: planId, row: data });
    } catch (e) { console.error('[inbound/plan]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

router.get('/fba/inbound/:planId', async (req, res) => {
    try {
        const { data: row } = await supabase.from('fba_inbound_ecom').select('*').eq('inbound_plan_id', req.params.planId).single();
        let plan = null; try { plan = await inbound.getInboundPlan(req.params.planId); } catch (_) {}
        res.json({ success: true, row, plan });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Generate placement options (self-selected FC via customPlacement). Non-committing.
router.post('/fba/inbound/:planId/placement', async (req, res) => {
    try {
        const planId = req.params.planId;
        const { data: row } = await supabase.from('fba_inbound_ecom').select('items').eq('inbound_plan_id', planId).single();
        const items = (row && row.items) || (req.body && req.body.items) || [];
        const groups = {};
        items.forEach(i => { const w = i.warehouseId || 'DEL4'; (groups[w] = groups[w] || { warehouseId: w, items: [] }).items.push({ msku: i.msku, quantity: i.quantity, prepOwner: i.prepOwner, labelOwner: i.labelOwner }); });
        const options = await inbound.generatePlacement(planId, Object.values(groups));
        const opt = options[0] || {};
        await inbUpdate(planId, { stage: 'packing', placement_option_id: opt.placementOptionId, placement_fee: (opt.fees || []).reduce((a, f) => a + ((f.value && f.value.amount) || 0), 0), shipment_ids: opt.shipmentIds || [] });
        res.json({ success: true, placementOptions: options });
    } catch (e) { console.error('[inbound/placement]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// Set box/packing details (India requires this BEFORE confirming placement). Builds one box per
// shipment containing that FC's items. Non-committing.
router.post('/fba/inbound/:planId/packing', async (req, res) => {
    try {
        const planId = req.params.planId;
        const { data: row } = await supabase.from('fba_inbound_ecom').select('*').eq('inbound_plan_id', planId).single();
        const box = (req.body && req.body.box) || {};
        const w = +box.weightKg || 3, L = +box.length || 30, W = +box.width || 30, H = +box.height || 30;
        const shipmentIds = (row && row.shipment_ids) || [];
        const items = (row && row.items) || [];
        const groupings = [];
        for (const sid of shipmentIds) {
            let fc = null;
            try { const sh = await inbound.getShipment(planId, sid); fc = sh && sh.destination && sh.destination.warehouseId; } catch (_) {}
            let shipItems = (shipmentIds.length === 1 || !fc) ? items : items.filter(i => (i.warehouseId || 'DEL4') === fc);
            if (!shipItems.length) shipItems = items;
            groupings.push({
                shipmentId: sid,
                boxes: [{ contentInformationSource: 'BOX_CONTENT_PROVIDED', dimensions: { unitOfMeasurement: 'CM', length: L, width: W, height: H }, weight: { unit: 'KG', value: w }, items: shipItems.map(i => ({ msku: i.msku, quantity: i.quantity, prepOwner: i.prepOwner || 'NONE', labelOwner: i.labelOwner || 'SELLER' })), quantity: 1 }]
            });
        }
        await inbound.setPackingInformation(planId, groupings);
        await inbUpdate(planId, { stage: 'placement_confirm' });
        res.json({ success: true });
    } catch (e) { console.error('[inbound/packing]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// COMMIT: confirm placement → creates the shipments (packing must already be set).
router.post('/fba/inbound/:planId/placement/confirm', async (req, res) => {
    try {
        const planId = req.params.planId; const { placementOptionId, fee } = req.body || {};
        if (!placementOptionId) return res.status(400).json({ success: false, error: 'placementOptionId required' });
        await inbound.confirmPlacement(planId, placementOptionId);
        const plan = await inbound.getInboundPlan(planId);
        const shipments = plan.shipments || [];
        const enriched = [];
        for (const s of shipments) { try { enriched.push(await inbound.getShipment(planId, s.shipmentId)); } catch (_) { enriched.push(s); } }
        await inbUpdate(planId, { status: 'PLACEMENT_CONFIRMED', stage: 'transportation', placement_option_id: placementOptionId, placement_fee: fee || 0, shipment_ids: shipments.map(s => s.shipmentId), shipments: enriched });
        res.json({ success: true, shipments: enriched });
    } catch (e) { console.error('[inbound/confirm]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// Transportation options (carrier / mode / appointment). Builds the request from stored shipments.
router.post('/fba/inbound/:planId/transportation', async (req, res) => {
    try {
        const planId = req.params.planId;
        const { data: row } = await supabase.from('fba_inbound_ecom').select('*').eq('inbound_plan_id', planId).single();
        const shipments = (row && row.shipments) || [];
        const sa = (row && row.source_address) || inbound.DEFAULT_SOURCE;
        const readyStart = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 16) + 'Z'; // yyyy-MM-ddTHH:mmZ
        const body = {
            placementOptionId: row && row.placement_option_id,
            shipmentTransportationConfigurations: shipments.map(s => ({
                shipmentId: s.shipmentId,
                readyToShipWindow: { start: readyStart },
                contactInformation: { name: sa.name || 'Seller', phoneNumber: sa.phoneNumber || '0000000000', email: sa.email || 'noreply@example.com' }
            }))
        };
        const options = await inbound.generateTransportation(planId, body);
        res.json({ success: true, transportationOptions: options });
    } catch (e) { console.error('[inbound/transportation]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// COMMIT: confirm carrier/transportation (may incur freight cost for Amazon-partnered).
router.post('/fba/inbound/:planId/transportation/confirm', async (req, res) => {
    try {
        await inbound.confirmTransportation(req.params.planId, req.body.transportationSelections || []);
        await inbUpdate(req.params.planId, { status: 'TRANSPORT_CONFIRMED', stage: 'labels', transportation: req.body.transportationSelections });
        res.json({ success: true });
    } catch (e) { console.error('[inbound/transport-confirm]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// Labels (FBA box 2D-barcode PDF) — one download URL per shipment.
router.get('/fba/inbound/:planId/labels', async (req, res) => {
    try {
        const { data: row } = await supabase.from('fba_inbound_ecom').select('*').eq('inbound_plan_id', req.params.planId).single();
        const shipments = (row && row.shipments) || [];
        const labels = [];
        for (const s of shipments) {
            const conf = s.shipmentConfirmationId; if (!conf) continue;
            try {
                const doc = await inbound.getLabels(conf, { numBoxes: 1 });
                labels.push({ shipmentConfirmationId: conf, fc: s.destination && s.destination.warehouseId, url: doc.DownloadURL || doc.downloadURL || null });
            } catch (e) { labels.push({ shipmentConfirmationId: conf, error: e.message }); }
        }
        await inbUpdate(req.params.planId, { status: 'LABELS_READY', stage: 'done', labels });
        res.json({ success: true, labels });
    } catch (e) { console.error('[inbound/labels]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

router.post('/fba/inbound/:planId/cancel', async (req, res) => {
    try {
        try { await inbound.cancelInboundPlan(req.params.planId); } catch (_) {}
        await inbUpdate(req.params.planId, { status: 'CANCELLED', stage: 'cancelled' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, syncFbaLocations, initFbaLocationCron };
