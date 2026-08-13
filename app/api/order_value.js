// Order value (₹) for the REVENUE lens — shared by Delivery Performance AND Last-Mile Funnel.
//
// ⚠️ ONE IMPLEMENTATION, ON PURPOSE. This logic used to live inside delivery_reports.js. When Last-Mile
// gained a ₹ toggle (2026-08-13) the choice was copy it or share it — and hand-copied parsers are the
// single most expensive recurring bug in this codebase (four journey parsers, three multi-week data
// corruptions). It is shared. Anything that changes how revenue is derived changes it for both pages.
const { supabase } = require('../supabase');

// ── Who may see ₹ on Delivery Performance ───────────────────────────────────────────────────────
// Order value is commercially sensitive — a support agent needs the delivery numbers but not what the
// business bills. Gated on the `delivery-perf-revenue` capability (granted per user on the Users page).
//
// ⚠️ ENFORCED HERE, NOT ONLY IN THE UI. Hiding the toggle stops the button being clicked; it does not
// stop anyone reading the JSON straight off the endpoint they already have `delivery-perf` access to.
// When this returns false the value lookup is SKIPPED ENTIRELY — no order price is read from the
// database, let alone serialised — so there is nothing to leak rather than something hidden.
//
// A legacy token carries neither `role` nor `permissions` (bootstrap env-admin) → full access, matching
// applyPermissions() on the client.
function canSeeRevenue(req) {
    const u = req.user || {};
    if (u.role === undefined && u.permissions === undefined) return true;   // legacy bootstrap admin
    if (u.role === 'admin') return true;
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    return perms.includes('*') || perms.includes('delivery-perf-revenue');
}

// ── Order value for the REVENUE lens on Delivery Performance ────────────────────────────────────
// Attaches `order_value` (₹, gross Shopify order total) to each journey row, in place.
//
// ⚠️ IT MUST COME FROM `orders.total_price`, NOT `shipment_journey_ecom.shipment_value`. That column is
// populated by the RapidShyp freight fetch ONLY — measured over the last 30 days it covers 79.4% of
// RapidShyp rows and **0% of Kwikship and 0% of DocPharma** (0 of 1,799). A revenue view built on it
// would silently report ₹0 for ~46% of shipments and understate every total. The Shopify order covers
// 99.9% / 99.6% / 100% across the three sources, so that is the honest base.
//
// Deliberately NOT denormalised onto the journey row: that would be a fourth field the webhook and the
// cron must both remember to write, which is exactly the drift that froze 240 shipments on 2026-08-12.
// This derives it at read time from the one source of truth instead. Batched (Supabase caps any response
// at 1000 rows) and issued in parallel; ~6 extra queries for a 30-day window.
async function attachOrderValue(rows) {
    const EMPTY = { total: 0, matched: 0, failedBatches: 0, complete: true };
    if (!rows || !rows.length) return EMPTY;
    const names = [...new Set(rows.map(r => String(r.order_name || '').trim()).filter(Boolean))];
    if (!names.length) return EMPTY;
    // ⚠️ NEEDS `idx_orders_name` (migration add_orders_name_index). Without it each batch seq-scans all
    // ~41k orders and a 90-day window blew the statement timeout — and because the error is caught below,
    // the failure was SILENT: the ₹ view would have rendered 0 for whole batches instead of erroring.
    // Shopify stores every name '#'-prefixed (40,891 of 40,891 checked) while the journey stores it bare,
    // so '#'+name is the match that actually fires; the bare form is kept only as a cheap safety net.
    const price = new Map();
    let failed = 0, pageCount = 0;
    // Ask for the '#'-prefixed form ONLY, so a chunk of 900 names returns at most 900 rows and stays under
    // the 1000-row cap. Sending both spellings halved the usable chunk and tripled the round trips (50 for
    // a 90-day window). A second pass below covers the handful that don't match, so nothing is lost.
    const CHUNK = 900;
    const collect = async (reqs) => {
        const pages = await Promise.all(reqs);
        pageCount += pages.length;
        for (const p of pages) {
            if (p.error) { failed++; console.error('[DeliveryPerf] order value:', p.error.message); continue; }
            (p.data || []).forEach(o => {
                const key = String(o.name || '').replace(/^#/, '').trim();
                const v = Number(o.total_price);
                if (key && isFinite(v)) price.set(key, v);
            });
        }
    };
    const reqs = [];
    for (let i = 0; i < names.length; i += CHUNK) {
        reqs.push(supabase.from('orders').select('name, total_price')
            .in('name', names.slice(i, i + CHUNK).map(n => '#' + n)));
    }
    await collect(reqs);
    // Safety net for any order stored WITHOUT the '#' (none today — 40,891 of 40,891 have it — but the
    // fallback costs one query only when something actually missed, so it can never silently drop value).
    const missed = names.filter(n => !price.has(n));
    if (missed.length) {
        const back = [];
        for (let i = 0; i < missed.length; i += CHUNK) back.push(supabase.from('orders').select('name, total_price').in('name', missed.slice(i, i + CHUNK)));
        await collect(back);
    }
    // Unmatched rows get 0, never null — a missing price must not poison a SUM or an average.
    // ⚠️ ROUNDED TO WHOLE RUPEES HERE, ONCE. Shopify totals carry paise, and rounding each GROUP instead
    // let the parts disagree with the whole: the status strip summed to ₹46,60,506 against a stated total
    // of ₹46,60,507. A reconciliation strip that is off by ₹1 reads as broken, and "the parts add up" is
    // the entire promise of that strip — so every row is made an integer at the source and every sum
    // downstream is then exact by construction, in every section, forever.
    rows.forEach(r => { r.order_value = Math.round(price.get(String(r.order_name || '').trim()) || 0); });
    // Report coverage so the UI can SAY the ₹ figures are incomplete rather than quietly under-report.
    const matched = rows.filter(r => r.order_value > 0).length;
    if (failed) console.error(`[DeliveryPerf] order value: ${failed}/${pageCount} batch(es) FAILED — revenue figures are understated`);
    return { total: rows.length, matched, failedBatches: failed, complete: failed === 0 };
}
// Sum of order value over a row set (the revenue counterpart of `arr.length`). No rounding here — the
// inputs are already whole rupees (see above), so sums stay exact and partitions reconcile.
const sumV = arr => (arr || []).reduce((a, r) => a + (Number(r.order_value) || 0), 0);

module.exports = { canSeeRevenue, attachOrderValue, sumV };
