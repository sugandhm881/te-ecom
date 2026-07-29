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
        // Already picked up / fulfilled → can't be held. Not a failure, just not holdable anymore.
        return { ok: false, notHoldable: true, held: [], error: 'already fulfilled/picked up — can no longer be held' };
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
async function recordReleased(orderName, by) {
    // Preserve WHY it was held (the hold mark's reason note) so the Repeat panel can still show the category
    // after release — the live-recomputed reason may have since vanished (e.g. a prior undelivered order
    // finalised to RTO and hit the reliability exception).
    const prev = (await getHoldStates([orderName]))[norm(orderName)];
    const heldReason = (prev && prev.status === 'held' && prev.reason && prev.reason !== HOLD_NOTE) ? prev.reason : null;
    await clearHoldMarks(orderName, ['shopify_hold', 'shopify_hold_failed']);
    await setMark(orderName, 'shopify_hold_released', heldReason ? ('held for: ' + heldReason) : 'released', by);
}
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
    if (out.notHoldable) return { ok: false, error: 'Order already fulfilled/picked up — it can no longer be held on Shopify.' };
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

// ── Cancel a Shopify order (support Call Queue → held order) ──────────────────────────────────
// Shopify's cancel `reason` is a fixed enum (customer | inventory | fraud | declined | other) — map our
// human label onto it; the full label is stored on the mark. Restocks inventory, does NOT email the customer.
function cancelReasonEnum(label) {
    const l = String(label || '').toLowerCase();
    if (l.includes('fake') || l.includes('fraud')) return 'fraud';
    if (l.includes('refus') || l.includes('unreach') || l.includes('customer') || l.includes('duplicate')) return 'customer';
    return 'other';
}
async function cancelShopifyOrder(shopifyOrderId, reasonLabel) {
    const r = await axios.post(`${API()}/orders/${shopifyOrderId}/cancel.json`,
        { reason: cancelReasonEnum(reasonLabel), restock: true, email: false },
        { headers: HEADERS(), timeout: 20000, validateStatus: () => true });
    if (r.status >= 200 && r.status < 300) return { ok: true };
    const e = r.data && (r.data.errors || r.data.error);
    return { ok: false, error: (typeof e === 'string' ? e : JSON.stringify(e || `HTTP ${r.status}`)) };
}
// Refund any amount ALREADY CAPTURED online for a COD order — e.g. a COD fee / advance paid at checkout on a
// partially-paid order. Pure-COD held orders have nothing captured (financial_status 'pending') → returns 0.
// (Inventory itself is released automatically when an UNFULFILLED order is cancelled, so no line-item restock here.)
async function refundCapturedIfAny(shopifyOrderId) {
    const og = await axios.get(`${API()}/orders/${shopifyOrderId}.json?fields=financial_status,currency`, { headers: HEADERS(), timeout: 20000, validateStatus: () => true });
    const fin = og.data && og.data.order && og.data.order.financial_status;
    if (!['paid', 'partially_paid', 'partially_refunded'].includes(fin)) return { refunded: 0 };   // nothing captured online
    const tg = await axios.get(`${API()}/orders/${shopifyOrderId}/transactions.json`, { headers: HEADERS(), timeout: 20000, validateStatus: () => true });
    const txns = (tg.data && tg.data.transactions) || [];
    let captured = 0, refunded = 0, parent = null, gateway = null;
    for (const t of txns) {
        if (t.status !== 'success') continue;
        const amt = parseFloat(t.amount || 0) || 0;
        if (t.kind === 'sale' || t.kind === 'capture') { captured += amt; if (!parent) { parent = t.id; gateway = t.gateway; } }
        else if (t.kind === 'refund') refunded += amt;
    }
    const refundable = Math.max(0, +(captured - refunded).toFixed(2));
    if (refundable <= 0 || !parent) return { refunded: 0 };
    const rf = await axios.post(`${API()}/orders/${shopifyOrderId}/refunds.json`, {
        refund: {
            note: 'Order cancelled by support — refunding the amount paid online (COD fee / advance).',
            notify: false,
            transactions: [{ parent_id: parent, amount: refundable.toFixed(2), kind: 'refund', gateway: gateway || undefined }],
        },
    }, { headers: HEADERS(), timeout: 20000, validateStatus: () => true });
    if (rf.status >= 200 && rf.status < 300) return { refunded: refundable };
    const e = rf.data && (rf.data.errors || rf.data.error);
    return { refunded: 0, error: (typeof e === 'string' ? e : JSON.stringify(e || `HTTP ${rf.status}`)) };
}
// Orchestration: refund any online-captured amount → cancel on Shopify → clear hold marks → record a
// `shopify_cancelled` mark (reason + who). Refund runs FIRST so a refund failure aborts before cancelling
// (never cancel while the customer's online payment is stuck un-refunded).
async function cancelOrder(orderName, shopifyOrderId, by, reasonLabel) {
    const rf = await refundCapturedIfAny(shopifyOrderId);
    if (rf.error) {
        await logApi('shopify_cancel', 422, { order: norm(orderName), id: String(shopifyOrderId), by, reason: reasonLabel || null }, 'refund failed: ' + rf.error);
        return { ok: false, error: 'Could not refund the amount paid online: ' + rf.error + ' — order NOT cancelled.' };
    }
    const refunded = rf.refunded || 0;
    const out = await cancelShopifyOrder(shopifyOrderId, reasonLabel);
    await logApi('shopify_cancel', out.ok ? 200 : 422, { order: norm(orderName), id: String(shopifyOrderId), by, reason: reasonLabel || null, refunded }, out.ok ? ('cancelled' + (refunded ? ` · refunded ${refunded}` : '')) : out.error);
    if (out.ok) {
        await clearHoldMarks(orderName, ['shopify_hold', 'shopify_hold_failed']);
        await setMark(orderName, 'shopify_cancelled', reasonLabel || 'cancelled', by);
        return { ok: true, refunded };
    }
    return { ok: false, error: out.error };
}

// Auto-hold (cron/webhook). Skips if already held OR a human already released it OR it's past pickup.
// `reasonNote` (from reasonNoteFrom) records WHY it qualified, so the panel can show the category later.
async function autoHoldOrder(orderName, shopifyOrderId, reasonNote, createdAt) {
    // GUARD — an auto-hold only makes sense for a BRAND-NEW order, UPSTREAM of the EasyEcom import.
    // (a) AGE: a Shopify hold only keeps an order out of EasyEcom if placed before the import (~30-min
    //     lag). Once an order is hours old it's already imported/shipping, so holding does nothing — and
    //     a BULK re-scan of old orders would retroactively hold long-settled ones (happened 2026-07-28:
    //     53 already-"Shipped" orders held by a one-off <100-char sweep). Skip anything not freshly placed.
    if (createdAt) {
        const ageMs = Date.now() - new Date(createdAt).getTime();
        if (Number.isFinite(ageMs) && ageMs > 6 * 60 * 60 * 1000) return { skipped: 'stale' };
    }
    // (b) ALREADY IN EASYECOM: if EasyEcom has imported the order, a Shopify hold is a no-op (verified
    //     2026-07-20). reference_code holds the Shopify order name (e.g. TE25-38408). Never auto-hold it.
    const { data: ee } = await supabase.from('b2c_order_easycom')
        .select('order_id').eq('reference_code', norm(orderName)).limit(1).maybeSingle();
    if (ee) return { skipped: 'in-easyecom' };
    const st = (await getHoldStates([orderName]))[norm(orderName)];
    if (st && (st.status === 'held' || st.status === 'released')) return { skipped: st.status };
    const out = await holdShopifyOrder(shopifyOrderId, reasonNote);
    if (out.notHoldable) return { skipped: 'shipped' };   // already picked up — not a failure, don't mark
    await logApi('shopify_hold', out.ok ? 200 : 422, { order: norm(orderName), id: String(shopifyOrderId), by: 'auto', held: out.held, reason: reasonNote || null }, out.ok ? (out.already ? 'already-held' : 'held') : out.error);
    if (out.ok) { await recordHold(orderName, 'auto', reasonNote || HOLD_NOTE); return { held: true }; }
    await recordFailed(orderName, out.error);
    return { failed: out.error };
}

// Does a NEW order qualify for auto-hold? Mirrors the Call Queue Repeat reasons — COD (not prepaid) AND any
// of: HIGH-VALUE (> ₹1500) / a RECENT NON-DELIVERY (≥1 of the last 3 prior orders not delivered) / IN-FLIGHT
// (the customer has another live order AND no delivered order in the last 3). Sourced by a direct phone-history
// lookup because order_buckets isn't computed for the brand-new order yet. (A just-created order is always
// non-terminal + pre-pickup, so the callable/holdable checks are implicit.)
// Which of the 3 call-reasons a NEW order matches (empty array = doesn't qualify for hold). Mirrors the Call
// Queue Repeat logic. Returned (not just a boolean) so the auto-holder can RECORD *why* it held — the panel then
// shows the category even later, when the live-recomputed reason has changed (e.g. a prior order that was
// 'undelivered' at hold time finalised to RTO and now hits the reliability exception, leaving no live reason).
const REASON_LABEL = { high_value: 'high value (≥₹1500)', recent_undelivered: 'no delivery in last 3', in_flight: 'another live order', short_address: 'short address (<60 chars)' };
// Normalise an address for same-address comparison (case/space/punctuation-insensitive).
const _normAddr = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const _fullAddr = a => [a && a.address1, a && a.address2, a && a.city, a && a.province, a && a.zip].filter(Boolean).join(', ');
function reasonNoteFrom(reasons) { return (reasons || []).map(r => REASON_LABEL[r] || r).join(', ') || HOLD_NOTE; }
async function holdReasons({ phone, financialStatus, createdAt, shopifyOrderId, totalPrice, address }) {
    const fin = String(financialStatus || '').toLowerCase();
    // FULLY-prepaid (paid / refunded / partially_refunded) → no COD collectable → never held.
    // COD → all reasons below. PARTIALLY-PAID → still carries a COD balance, so held on the HIGH-VALUE (≥₹1500)
    // rule only (the history / short-address reasons stay COD-specific).
    if (['paid', 'refunded', 'partially_refunded'].includes(fin)) return [];
    const isPartialPaid = fin === 'partially_paid';
    const reasons = [];
    if (Number(totalPrice || 0) >= 1500) reasons.push('high_value');                          // high value ≥₹1500 — COD AND partial-paid
    if (!isPartialPaid) {                                                                      // history + address reasons are COD-only
        const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
        let deliveredIds = [];   // this phone's PAST delivered order ids (for the short-address trust exception)
        if (last10.length === 10) {
            const before = new Date(createdAt || Date.now());
            const { data } = await supabase.from('order_buckets').select('order_id, bucket, created_at').ilike('phone', `%${last10}`).limit(50);
            const others = (data || []).filter(h => String(h.order_id) !== String(shopifyOrderId));
            const last3Prior = others.filter(h => new Date(h.created_at) < before).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 3);
            // RULE: if ANY ONE of the last 3 prior orders was DELIVERED, the customer is trusted → skip the history reasons.
            const dCount    = last3Prior.filter(h => h.bucket === 'delivered').length;
            const reliable  = dCount >= 1;
            if (!reliable && last3Prior.some(h => !['delivered', 'cancelled'].includes(h.bucket))) reasons.push('recent_undelivered');   // reason #2 — skipped when any of last 3 delivered
            if (others.some(h => new Date(h.created_at) < before && !['delivered', 'rto', 'cancelled'].includes(h.bucket))) reasons.push('in_flight');   // reason #1 — an OLDER live order still open → THIS order is the repeat
            deliveredIds = others.filter(h => h.bucket === 'delivered').map(h => h.order_id);
        }
        // reason: SHORT ADDRESS (<60 chars) — terse/incomplete addresses are RTO-prone. Trust exception: skip if a
        // PAST DELIVERED order for this customer used the SAME address (that exact address is proven to deliver).
        const addrStr = String(address || '').trim();
        if (addrStr && addrStr.length < 60) {
            const curNorm = _normAddr(addrStr);
            let deliveredSameAddr = false;
            if (deliveredIds.length) {
                const { data: addrs } = await supabase.from('order_shipping_addresses')
                    .select('order_id, address1, address2, city, province, zip').in('order_id', deliveredIds);
                deliveredSameAddr = (addrs || []).some(a => _normAddr(_fullAddr(a)) === curNorm);
            }
            if (!deliveredSameAddr) reasons.push('short_address');
        }
    }
    return reasons;
}
async function qualifiesForHold(opts) { return (await holdReasons(opts)).length > 0; }   // back-compat boolean wrapper

module.exports = {
    listFulfillmentOrders, holdShopifyOrder, releaseShopifyOrder,
    getHoldStates, holdOrderManual, releaseOrder, cancelOrder, autoHoldOrder, qualifiesForHold, holdReasons, reasonNoteFrom, HOLD_NOTE,
};
