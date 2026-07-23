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
    const clean = rows.filter(r => r.warehouse && String(r.warehouse).trim().toUpperCase() !== 'N/A');
    return { snapshot_date: date, rows: clean };
}

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
    const payload = { blocks: [
        { type: 'header', text: { type: 'plain_text', text: `📦 Low Inventory (DOI < 30d) — ${label}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${nRows}* SKU×location need attention  ·  *${critical}* critical  ·  *${watch}* watch  ·  *${stockouts}* out of stock` } },
        ...(whLine ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: whLine }] }] : []),
        { type: 'image', image_url, alt_text: `Low Inventory DOI report — ${label}` },
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

module.exports = { router, sendInventoryTeamsReport, refreshSnapshot };
