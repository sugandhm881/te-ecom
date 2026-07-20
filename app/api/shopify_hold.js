// Shopify fulfillment-hold service — holds/releases orders on Shopify UPSTREAM of EasyEcom, so repeat
// COD orders can be phone-confirmed before they ship. A Shopify hold placed BEFORE EasyEcom imports the
// order keeps it out of EasyEcom entirely (verified 2026-07-20); holding after import does nothing —
// which is why the triggers (orders/create webhook + a 5-min cron backstop) hold as early as possible.
//
// Hold = a fulfillment-order hold (2-step: GET the order's OPEN fulfillment orders → POST hold on each).
// State is tracked as marks in order_marks_ecom (same table/pattern as ee_hold), keyed by order_name:
//   shopify_hold          → currently on hold (auto or manual)
//   shopify_hold_released → was held, a human released it → NEVER auto-re-hold (respect the decision)
//   shopify_hold_failed   → last hold attempt failed → the Repeat panel offers a manual Hold button
// At most one exists per order; every transition deletes the others.

const axios = require('axios');
const config = require('../../config');
const { supabase } = require('../supabase');

const API = () => `https://${config.SHOPIFY_SHOP_URL}/admin/api/2024-10`;
const HEADERS = () => ({ 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN, 'Content-Type': 'application/json' });
const HOLD_NOTE = 'Repeat COD — awaiting customer confirmation';
const PREPAID_STATUSES = ['paid', 'partially_paid', 'refunded', 'partially_refunded'];
const norm = n => String(n || '').replace('#', '').trim();

// ── Shopify Admin API ────────────────────────────────────────────────────────
async function listFulfillmentOrders(shopifyOrderId) {
    const r = await axios.get(`${API()}/orders/${shopifyOrderId}/fulfillment_orders.json`,
        { headers: HEADERS(), timeout: 20000, validateStatus: () => true });
    if (r.status !== 200) return { ok: false, status: r.status, fos: [], error: JSON.stringify(r.data || '').slice(0, 200) };
    return { ok: true, status: 200, fos: (r.data && r.data.fulfillment_orders) || [] };
}

// Hold every OPEN fulfillment order. Idempotent: if all FOs are already on_hold → ok. Returns
// { ok, held:[foIds], already?, error }. ok:false only when there is nothing holdable (fulfilled/
// shipped) or the API rejected the hold.
async function holdShopifyOrder(shopifyOrderId, note) {
    const list = await listFulfillmentOrders(shopifyOrderId);
    if (!list.ok) return { ok: false, held: [], error: `list FOs failed (${list.status}): ${list.error}` };
    const open = list.fos.filter(f => f.status === 'open' && (f.supported_actions || []).includes('hold'));
    if (!open.length) {
        if (list.fos.some(f => f.status === 'on_hold')) return { ok: true, held: [], already: true };
        return { ok: false, held: [], error: 'no open fulfillment order to hold (already fulfilled/shipped?)' };
    }
    const held = [];
    for (const fo of open) {
        const r = await axios.post(`${API()}/fulfillment_orders/${fo.id}/hold.json`,
            { fulfillment_hold: { reason: 'other', reason_notes: (note || HOLD_NOTE).slice(0, 200) } },
            { headers: HEADERS(), timeout: 20000, validateStatus: () => true });
        const okFO = r.status === 200 && r.data && r.data.fulfillment_order && r.data.fulfillment_order.status === 'on_hold';
        if (okFO) held.push(fo.id);
        else return { ok: false, held, error: `hold FO ${fo.id} failed (${r.status}): ${JSON.stringify(r.data || '').slice(0, 160)}` };
    }
    return { ok: true, held };
}

// Release every held fulfillment order. Idempotent: no held FO → ok (already released).
async function releaseShopifyOrder(shopifyOrderId) {
    const list = await listFulfillmentOrders(shopifyOrderId);
    if (!list.ok) return { ok: false, released: [], error: `list FOs failed (${list.status}): ${list.error}` };
    const onHold = list.fos.filter(f => f.status === 'on_hold');
    if (!onHold.length) return { ok: true, released: [], already: true };
    const released = [];
    for (const fo of onHold) {
        const r = await axios.post(`${API()}/fulfillment_orders/${fo.id}/release_hold.json`, {},
            { headers: HEADERS(), timeout: 20000, validateStatus: () => true });
        if (r.status === 200) released.push(fo.id);
        else return { ok: false, released, error: `release FO ${fo.id} failed (${r.status}): ${JSON.stringify(r.data || '').slice(0, 160)}` };
    }
    return { ok: true, released };
}

// ── Hold-state marks (order_marks_ecom) ──────────────────────────────────────
const HOLD_TYPES = ['shopify_hold', 'shopify_hold_released', 'shopify_hold_failed'];
async function clearHoldMarks(orderName, types) {
    for (const t of types) await supabase.from('order_marks_ecom').delete().eq('order_name', norm(orderName)).eq('mark_type', t).then(() => {}).catch(() => {});
}
async function setMark(orderName, type, note, by) {
    await supabase.from('order_marks_ecom').upsert({
        order_name: norm(orderName), mark_type: type, note: String(note || '').slice(0, 200),
        created_by: by || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'order_name,mark_type' }).then(() => {}).catch(() => {});
}
async function recordHold(orderName, by, reason) { await clearHoldMarks(orderName, ['shopify_hold_released', 'shopify_hold_failed']); await setMark(orderName, 'shopify_hold', reason || HOLD_NOTE, by); }
async function recordReleased(orderName, by) { await clearHoldMarks(orderName, ['shopify_hold', 'shopify_hold_failed']); await setMark(orderName, 'shopify_hold_released', 'released', by); }
async function recordFailed(orderName, error) { await clearHoldMarks(orderName, ['shopify_hold']); await setMark(orderName, 'shopify_hold_failed', error, 'auto'); }

// Hold-state map for a set of order names → { [orderName]: { status:'held'|'released'|'failed', reason, by, at } }.
async function getHoldStates(orderNames) {
    const names = [...new Set((orderNames || []).map(norm).filter(Boolean))];
    const out = {};
    const rank = { held: 3, failed: 2, released: 1 };
    for (let i = 0; i < names.length; i += 300) {
        const part = names.slice(i, i + 300);
        const { data } = await supabase.from('order_marks_ecom').select('order_name, mark_type, note, created_by, updated_at').in('order_name', part).in('mark_type', HOLD_TYPES);
        (data || []).forEach(m => {
            const status = m.mark_type === 'shopify_hold' ? 'held' : m.mark_type === 'shopify_hold_released' ? 'released' : 'failed';
            const prev = out[m.order_name];
            if (!prev || rank[status] > rank[prev.status]) out[m.order_name] = { status, reason: m.note, by: m.created_by, at: m.updated_at };
        });
    }
    return out;
}

async function logApi(action, status, payload, response) {
    await supabase.from('api_logs_ecom').insert({ action, status_code: status, payload, response: String(response || '').slice(0, 300) }).then(() => {}).catch(() => {});
}

// ── Orchestration ────────────────────────────────────────────────────────────
// Manual hold (UI Hold button) — always attempts, clears any prior release tombstone on success.
async function holdOrderManual(orderName, shopifyOrderId, by, reason) {
    const out = await holdShopifyOrder(shopifyOrderId, reason);
    await logApi('shopify_hold', out.ok ? 200 : 422, { order: norm(orderName), id: String(shopifyOrderId), by, held: out.held }, out.ok ? (out.already ? 'already-held' : 'held') : out.error);
    if (out.ok) { await recordHold(orderName, by, reason); return { ok: true }; }
    await recordFailed(orderName, out.error);
    return { ok: false, error: out.error };
}

// Release (UI Release button) — records a release tombstone so the auto-holder won't re-hold it.
async function releaseOrder(orderName, shopifyOrderId, by) {
    const out = await releaseShopifyOrder(shopifyOrderId);
    await logApi('shopify_release', out.ok ? 200 : 422, { order: norm(orderName), id: String(shopifyOrderId), by, released: out.released }, out.ok ? 'released' : out.error);
    if (out.ok) { await recordReleased(orderName, by); return { ok: true }; }
    return { ok: false, error: out.error };
}

// Auto-hold (cron/webhook). Skips if already held OR a human already released it.
async function autoHoldOrder(orderName, shopifyOrderId) {
    const st = (await getHoldStates([orderName]))[norm(orderName)];
    if (st && (st.status === 'held' || st.status === 'released')) return { skipped: st.status };
    const out = await holdShopifyOrder(shopifyOrderId);
    await logApi('shopify_hold', out.ok ? 200 : 422, { order: norm(orderName), id: String(shopifyOrderId), by: 'auto', held: out.held }, out.ok ? (out.already ? 'already-held' : 'held') : out.error);
    if (out.ok) { await recordHold(orderName, 'auto', HOLD_NOTE); return { held: true }; }
    await recordFailed(orderName, out.error);
    return { failed: out.error };
}

// Does a NEW order (by phone) qualify for auto-hold? COD (not prepaid) + ≥1 prior non-delivered order
// on the same phone. Used by the orders/create webhook, where order_buckets isn't computed for the new
// order yet — same criteria as findRepeatCandidates, sourced by a direct phone-history lookup.
async function qualifiesForHold({ phone, financialStatus, createdAt, shopifyOrderId }) {
    if (PREPAID_STATUSES.includes(String(financialStatus || '').toLowerCase())) return false;   // prepaid → no RTO risk
    const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
    if (last10.length !== 10) return false;
    const before = new Date(createdAt || Date.now());
    const { data } = await supabase.from('order_buckets').select('order_id, bucket, created_at').ilike('phone', `%${last10}`).limit(50);
    return (data || []).some(h => String(h.order_id) !== String(shopifyOrderId) && new Date(h.created_at) < before && !['delivered', 'cancelled'].includes(h.bucket));
}

module.exports = {
    listFulfillmentOrders, holdShopifyOrder, releaseShopifyOrder,
    getHoldStates, holdOrderManual, releaseOrder, autoHoldOrder, qualifiesForHold, HOLD_NOTE,
};
