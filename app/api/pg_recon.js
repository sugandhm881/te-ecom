// ─────────────────────────────────────────────────────────────────────────────
// Payment-gateway reconciliation (GoKwik PG).
//
// What it answers: for every Shopify order, what SHOULD GoKwik charge us, split into fee and the GST on
// that fee, and what settlement should follow. Rates live in `pg_charge_config_ecom` and are resolved
// per order by `pg_charge_for(payment_type, gateway, date)` — nothing is hardcoded here, and the config
// is effective-dated so renegotiating a rate never re-prices months already settled.
//
//   prepaid  2.15% of order value          (only when the payment actually went through GoKwik)
//   COD      2.00% of order value
//   partial  2.50% of order value EXCLUDING shipping — a COD order whose COD/shipping fee was paid online
//
// ⚠️ THE GATEWAY MUST COME FROM SHOPIFY, NOT EASYECOM. EasyEcom leaves `payment_gateway_name` blank on a
// large share of rows (124 of August's prepaid orders, ₹93,351). Sampling those against Shopify showed 7
// of 9 were GoKwik — but one was Cashfree and one was manual, so treating "blank" as GoKwik would bill
// GoKwik for payments it never processed. `syncOrderGateways()` fills `orders.gateway` from Shopify's
// `paymentGatewayNames`, and anything still unresolved is reported as `unclassified` rather than being
// quietly folded into the bill.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../supabase');
const config = require('../../config');

const GQL_URL = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2024-07/graphql.json`;
const GQL_HDR = { 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

// Shopify's financial status → the rate bucket. Only these three are charged; a voided or refunded
// order is deliberately left unpriced and surfaced separately (see the `other` bucket in the summary),
// because whether GoKwik bills and then reverses is a question for the statement, not an assumption.
const PAYMENT_TYPE = { paid: 'prepaid', partially_paid: 'partial', pending: 'cod' };

// Pull `paymentGatewayNames` from Shopify for orders whose gateway we do not yet know, and write it to
// `orders.gateway`. Paged 50 at a time (Shopify's per-query cost limit), newest first.
async function syncOrderGateways({ since = null, days = 45, max = 40000, onProgress = null } = {}) {
    const from = since ? new Date(since).toISOString()
                       : new Date(Date.now() - days * 86400000).toISOString();
    const missing = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('orders')
            .select('id, name')
            .is('gateway', null).gte('created_at', from)
            .order('created_at', { ascending: false }).range(off, off + 999);
        if (error) throw new Error(error.message);
        missing.push(...(data || []));
        if (!data || data.length < 1000 || missing.length >= max) break;
    }
    if (!missing.length) return { checked: 0, updated: 0, unresolved: 0 };

    // id → gateway, accumulated across every Shopify page.
    // ⚠️ Written back in BULK, grouped by gateway value: one UPDATE ... WHERE id IN (…) per group of
    // 200 instead of one call per order. At ~28k orders the per-order version would be ~40 minutes of
    // round-trips for work the database does in seconds.
    const found = new Map();
    let checked = 0;
    for (let i = 0; i < missing.length && i < max; i += 50) {
        const slice = missing.slice(i, i + 50);
        const q = slice.map(o => `name:${String(o.name).replace('#', '')}`).join(' OR ');
        const gql = `{orders(first:50, query:"${q}"){edges{node{name paymentGatewayNames}}}}`;
        let nodes = [];
        try {
            const r = await axios.post(GQL_URL, { query: gql }, { headers: GQL_HDR, timeout: 25000 });
            if (r.data.errors) { console.warn('[PG] shopify:', JSON.stringify(r.data.errors).slice(0, 160)); continue; }
            nodes = (r.data.data.orders.edges || []).map(e => e.node);
        } catch (e) { console.warn('[PG] fetch failed:', e.message); continue; }
        checked += slice.length;
        const byName = {};
        nodes.forEach(n => { byName[String(n.name).replace('#', '')] = (n.paymentGatewayNames || [])[0] || null; });
        slice.forEach(o => {
            const gw = byName[String(o.name).replace('#', '')];
            if (gw) found.set(o.id, gw);       // no gateway → leave null; it reports as unclassified
        });
        if (onProgress && (i / 50) % 20 === 0) onProgress(checked, missing.length, found.size);
        await new Promise(r => setTimeout(r, 200));
    }

    const byGateway = new Map();
    for (const [id, gw] of found) { if (!byGateway.has(gw)) byGateway.set(gw, []); byGateway.get(gw).push(id); }
    let updated = 0;
    for (const [gw, ids] of byGateway) {
        for (let i = 0; i < ids.length; i += 200) {
            const { error } = await supabase.from('orders').update({ gateway: gw }).in('id', ids.slice(i, i + 200));
            if (error) console.warn('[PG] update failed:', error.message);
            else updated += Math.min(200, ids.length - i);
        }
    }
    console.log(`[PG] gateway sync — ${updated}/${checked} labelled, ${checked - updated} left unresolved`);
    return { checked, updated, unresolved: checked - updated };
}

// ── Endpoints ───────────────────────────────────────────────────────────────
// Every figure comes from pg_recon_summary()/pg_recon_rows() in SQL — the charge is defined once, so a
// dashboard, an export and any later report cannot quietly disagree about the same money.
const ROW_CAP = 5000;

router.get('/pg-recon', async (req, res) => {
    try {
        const to = req.query.to ? new Date(req.query.to) : new Date();
        const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
        if (isNaN(from) || isNaN(to)) return res.status(400).json({ success: false, error: 'Invalid date range.' });
        to.setHours(23, 59, 59, 999);

        const args = { p_from: from.toISOString(), p_to: to.toISOString() };
        // ⚠️ PAGE THE RPC. PostgREST caps a set-returning function at 1000 rows exactly as it caps a
        // table select, and it does so SILENTLY — the first build reported "1000 of 1000" for a 42,000
        // order window and truncated both the table and the CSV. The summary is computed inside SQL so
        // it was never affected, which is precisely what makes this kind of cap hard to notice.
        const sum = await supabase.rpc('pg_recon_summary', args);
        if (sum.error) throw new Error(sum.error.message);

        const all = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.rpc('pg_recon_rows', args).range(off, off + 999);
            if (error) throw new Error(error.message);
            all.push(...(data || []));
            if (!data || data.length < 1000 || all.length >= 60000) break;   // hard stop, never an infinite page
        }
        all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        // Refunds get their own slice, taken from the FULL set before the table cap — they are rare and
        // scattered, so filtering the capped page would show only the ones that happen to be recent.
        const REFUND = new Set(['refunded', 'partially_refunded']);
        const refunds = all.filter(r => REFUND.has(r.financial_status));
        const rTot = refunds.reduce((a, r) => ({
            orders: a.orders + 1,
            gross:  a.gross  + Number(r.order_value || 0),
            fee:    a.fee    + (r.charged ? Number(r.fee || 0) : 0),
            gst:    a.gst    + (r.charged ? Number(r.gst || 0) : 0),
            charge: a.charge + (r.charged ? Number(r.total_charge || 0) : 0),
        }), { orders: 0, gross: 0, fee: 0, gst: 0, charge: 0 });

        res.json({
            success: true,
            range: { from: from.toISOString(), to: to.toISOString() },
            summary: sum.data || {},
            rows: all.slice(0, ROW_CAP),
            rowsTotal: all.length,
            capped: all.length > ROW_CAP,
            refunds: refunds.slice(0, 3000),
            refundTotals: rTot,
        });
    } catch (e) {
        console.error('[PG recon] error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// The rate card, so the dashboard can show what it charged against rather than restating it in code.
router.get('/pg-recon/rates', async (_req, res) => {
    try {
        const { data, error } = await supabase.from('pg_charge_config_ecom')
            .select('payment_type, gateway_pattern, fee_percent, gst_percent, base_excludes_shipping, effective_from, note')
            .order('payment_type').order('effective_from', { ascending: false });
        if (error) throw new Error(error.message);
        res.json({ success: true, rates: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Manual gateway refresh — the ingest labels new orders, this catches ones whose payment was captured
// after the webhook fired.
router.post('/pg-recon/sync-gateways', async (req, res) => {
    try {
        const days = Math.min(parseInt(req.query.days, 10) || 7, 120);
        res.json({ success: true, message: `Refreshing gateways for the last ${days} days — this runs in the background.` });
        syncOrderGateways({ days }).catch(e => console.error('[PG] gateway sync:', e.message));
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, syncOrderGateways, PAYMENT_TYPE };
