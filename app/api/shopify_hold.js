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

// ── A HUMAN RELEASE IS FINAL FOR AUTOMATION ──────────────────────────────────────────────────────
// One rule, one place: once ANY Ecom user unholds an order, no automatic path may ever hold it again.
// Only a human can (the manual Hold buttons, which clear the tombstone deliberately).
//
// Both systems record their release as a tombstone mark, and BOTH count — an order can be held on
// Shopify, in EasyEcom, or (since the batch-hold change) in both at once, and the agent only ever sees
// one Unhold button:
//   • `shopify_hold_released` — written by releaseOrder() / recordReleased()
//   • `ee_hold_released`      — written by POST /api/easyecom/unhold-order
// Neither is ever written by automation (there is no auto-unhold), so a tombstone always means a person.
//
// ⚠️ Do NOT fold this into getHoldStates(): that function reads only the three `shopify_*` HOLD_TYPES and
// is used for DISPLAY (which button to show). This is the automation gate, and it must see the EasyEcom
// release too — the gap that let the auto-holder re-hold TE25-40985 three minutes after a human released it.
const RELEASE_MARKS = ['shopify_hold_released', 'ee_hold_released'];
async function releasedByHuman(orderName) {
    const { data } = await supabase.from('order_marks_ecom')
        .select('mark_type, created_by, updated_at')
        .eq('order_name', norm(orderName)).in('mark_type', RELEASE_MARKS);
    if (!data || !data.length) return null;
    const m = data.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
    return { by: m.created_by || 'user', at: m.updated_at, where: m.mark_type === 'ee_hold_released' ? 'easyecom' : 'shopify' };
}

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
    // FAIL CLOSED: if we can't READ the payment status (429/5xx/timeout), we must not treat it as
    // "nothing captured" — return an error so cancelOrder aborts instead of cancelling un-refunded.
    if (og.status !== 200 || !(og.data && og.data.order)) return { refunded: 0, error: `could not verify payment status (HTTP ${og.status})` };
    const fin = og.data.order.financial_status;
    if (!['paid', 'partially_paid', 'partially_refunded'].includes(fin)) return { refunded: 0 };   // nothing captured online
    const tg = await axios.get(`${API()}/orders/${shopifyOrderId}/transactions.json`, { headers: HEADERS(), timeout: 20000, validateStatus: () => true });
    if (tg.status !== 200 || !(tg.data && tg.data.transactions)) return { refunded: 0, error: `could not read transactions (HTTP ${tg.status})` };
    const txns = tg.data.transactions;
    // Tally captures individually — a refund must be posted against ITS OWN parent transaction, capped at
    // that capture's remaining amount (one lump against the first parent gets rejected by Shopify when a
    // second capture exists, e.g. COD fee + later advance).
    let captured = 0, refundedTotal = 0;
    const caps = [], capById = {};
    for (const t of txns) {
        if (t.status !== 'success') continue;
        const amt = parseFloat(t.amount || 0) || 0;
        if (t.kind === 'sale' || t.kind === 'capture') { captured += amt; const c = { id: t.id, amount: amt, refunded: 0, gateway: t.gateway }; caps.push(c); capById[t.id] = c; }
        else if (t.kind === 'refund') { refundedTotal += amt; if (t.parent_id != null && capById[t.parent_id]) capById[t.parent_id].refunded += amt; }
    }
    const refundable = Math.max(0, +(captured - refundedTotal).toFixed(2));
    if (refundable <= 0 || !caps.length) return { refunded: 0 };
    const rtxns = [];
    let left = refundable;   // total cap — never refund more than (captured − already refunded) overall
    for (const c of caps) {
        if (left <= 0) break;
        const rem = Math.min(Math.max(0, +(c.amount - c.refunded).toFixed(2)), left);
        if (rem <= 0) continue;
        rtxns.push({ parent_id: c.id, amount: rem.toFixed(2), kind: 'refund', gateway: c.gateway || undefined });
        left = +(left - rem).toFixed(2);
    }
    if (!rtxns.length) return { refunded: 0 };
    const amount = +(refundable - left).toFixed(2);
    const rf = await axios.post(`${API()}/orders/${shopifyOrderId}/refunds.json`, {
        refund: {
            note: 'Order cancelled by support — refunding the amount paid online (COD fee / advance).',
            notify: false,
            transactions: rtxns,
        },
    }, { headers: HEADERS(), timeout: 20000, validateStatus: () => true });
    if (rf.status >= 200 && rf.status < 300) return { refunded: amount };
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
async function autoHoldOrder(orderName, shopifyOrderId, reasonNote, createdAt, opts) {
    // (0) HUMAN RELEASE WINS — checked FIRST, before every other guard, because this is the lowest-level
    //     automatic hold and EVERY auto path reaches it (webhook → holdOrderSmart, cron → holdOrderSmart,
    //     holdSiblingOrders → holdOrderSmart, and the EasyEcom mirror). Ordering matters: the checks below
    //     return early on their own conditions, so anything placed after them can be skipped over — which is
    //     exactly how the original re-hold bug worked (the `in-easyecom` check at (b) short-circuited before
    //     the release check at (c) ever ran). Nothing may precede this one.
    const rel = await releasedByHuman(orderName);
    if (rel) return { skipped: 'released-by-human', by: rel.by, where: rel.where };
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
    //     `allowImported` is passed ONLY by holdOrderSmart() below, which has already placed the
    //     EasyEcom hold — the Shopify hold is then added alongside it so both systems agree and a
    //     single Unhold can release both. Every other caller keeps the original refusal.
    if (ee && !(opts && opts.allowImported)) return { skipped: 'in-easyecom' };
    const st = (await getHoldStates([orderName]))[norm(orderName)];
    if (st && (st.status === 'held' || st.status === 'released')) return { skipped: st.status };
    const out = await holdShopifyOrder(shopifyOrderId, reasonNote);
    if (out.notHoldable) return { skipped: 'shipped' };   // already picked up — not a failure, don't mark
    await logApi('shopify_hold', out.ok ? 200 : 422, { order: norm(orderName), id: String(shopifyOrderId), by: 'auto', held: out.held, reason: reasonNote || null }, out.ok ? (out.already ? 'already-held' : 'held') : out.error);
    if (out.ok) { await recordHold(orderName, 'auto', reasonNote || HOLD_NOTE); return { held: true }; }
    await recordFailed(orderName, out.error);
    return { failed: out.error };
}




// ── Has the parcel already left? ─────────────────────────────────────────────────────────────────
// A hold is only meaningful BEFORE the courier takes the parcel. Shopify refuses a hold on a fulfilled
// order by itself (`notHoldable`), but the EasyEcom fallback has no such protection — without this
// check an in-transit order could be held in EasyEcom, which achieves nothing and confuses the WH team.
//
// ⚠️ An AWB alone is NOT "dispatched". EasyEcom can still hold an order after the AWB is assigned but
// before pickup/manifest — the Call Queue treats that state as holdable too. Only an actual courier
// movement or a fulfilled state proves the parcel is gone.
const DISPATCHED_RE = /IN.?TRANSIT|OUT.?FOR.?DELIVERY|\bOFD\b|DELIVERED|\bRTO\b|RETURN|PICKED.?UP|PICKUP.?COMPLETED|SORTING|DISPATCHED|\bLOST\b|EXCEPTION/i;
async function isDispatchedOrder(orderName) {
    const nm = norm(orderName);
    try {
        const { data: o } = await supabase.from('orders')
            .select('fulfillment_status, tracking_status, cancelled_at')
            .in('name', [nm, '#' + nm]).limit(1).maybeSingle();
        if (o) {
            if (o.cancelled_at) return { dispatched: true, why: 'cancelled' };
            if (String(o.fulfillment_status || '').toLowerCase() === 'fulfilled') return { dispatched: true, why: 'fulfilled' };
            if (DISPATCHED_RE.test(String(o.tracking_status || ''))) return { dispatched: true, why: 'tracking:' + o.tracking_status };
        }
        // Courier-side truth — a scan exists the moment the parcel physically moves.
        const { data: j } = await supabase.from('shipment_journey_ecom')
            .select('outcome, dispatched_at, out_for_delivery_at').eq('order_name', nm).limit(1).maybeSingle();
        if (j) {
            if (['delivered', 'rto', 'lost'].includes(String(j.outcome || ''))) return { dispatched: true, why: 'outcome:' + j.outcome };
            if (j.dispatched_at || j.out_for_delivery_at) return { dispatched: true, why: 'picked-up' };
        }
        return { dispatched: false };
    } catch (e) { return { dispatched: false, error: e.message }; }
}

// ── holdOrderSmart — Shopify first, EasyEcom once the window has closed ───────────────────────────
// A Shopify hold is the PREFERRED stop: it keeps the order out of EasyEcom altogether. But it only
// works upstream of the import (~2 min in practice) — after that a Shopify hold does nothing to stop
// fulfilment, which is why autoHoldOrder refuses on `in-easyecom`.
//
// Measured on live data: repeat orders arrive 4 minutes to 15 hours apart, so by the time the newest
// order trips a rule the EARLIER one has almost always imported already. Shopify-only would therefore
// hold ~nothing on the real pattern (simulated over 24h: 5 bursts, 5 siblings, 0 holdable).
//
// So: try Shopify; if the order has already imported, hold it in EASYECOM instead — which still stops
// it before the batch/manifest — and then ALSO place the Shopify hold so both systems agree.
// The dashboard shows a single Unhold for such an order (EasyEcom's), and that release clears BOTH.
async function holdOrderSmart(orderName, shopifyOrderId, reasonNote, createdAt, actor = 'auto') {
    const name = norm(orderName);
    // 1) Preferred path — still upstream of EasyEcom.
    const first = await autoHoldOrder(name, shopifyOrderId, reasonNote, createdAt);
    if (first.held) return { held: true, where: 'shopify' };
    if (first.skipped !== 'in-easyecom') return first;   // stale / already held / released / shipped — leave it

    // ⚠️ RE-HOLD GUARD — SECOND LAYER. The human-release test now runs first inside autoHoldOrder(), so by
    // here we already know no tombstone exists. This layer is deliberately kept anyway: it is the reason the
    // original bug was possible (autoHoldOrder returned 'in-easyecom' BEFORE looking at the marks, and this
    // function read that as permission to hold in EasyEcom), and a re-hold is the one failure the team feels
    // directly — they release an order and watch it go back on hold minutes later. Cheap, and it also covers
    // the case the first layer does not: ALREADY held in EasyEcom, where re-calling the API is pure noise
    // (before this, the cron re-sent the hold every 2 minutes for hours — 88 calls in 74 minutes on 08-08).
    const marks = (await getHoldStates([name]))[name];
    if (marks && (marks.status === 'held' || marks.status === 'released')) return { skipped: marks.status };
    const rel = await releasedByHuman(name);
    if (rel) return { skipped: 'released-by-human', by: rel.by, where: rel.where };
    const { data: eeHeld } = await supabase.from('order_marks_ecom')
        .select('order_name').eq('order_name', name).eq('mark_type', 'ee_hold').limit(1).maybeSingle();
    if (eeHeld) return { skipped: 'ee-already-held' };

    // 2) Window closed — stop it inside EasyEcom instead, but ONLY if the parcel hasn't left yet.
    //    Shopify refuses a hold on a fulfilled order by itself; EasyEcom does not, so this is the guard
    //    that stops an already-dispatched order being pointlessly held.
    const disp = await isDispatchedOrder(name);
    if (disp.dispatched) return { skipped: 'dispatched:' + (disp.why || '') };
    const { holdOrderInEasyecom } = require('./easyecom');
    const ee = await holdOrderInEasyecom(name, reasonNote, actor);
    if (!ee.ok) return { failed: 'ee:' + ee.message };

    // 3) Mirror the hold onto Shopify so the two systems don't disagree. Best-effort: the EasyEcom hold
    //    is the one actually stopping the order, so a Shopify failure here must not fail the operation.
    const mirror = await autoHoldOrder(name, shopifyOrderId, reasonNote, createdAt, { allowImported: true });
    return { held: true, where: 'easyecom', mirroredToShopify: !!mirror.held, alreadyHeld: !!ee.alreadyHeld };
}

// ── Sibling hold — hold the customer's OTHER open orders too ──────────────────────────────────────
// Why: the per-order rules hold the order that TRIPS them. When a customer places 2–3 orders, the
// `in_flight` reason fires on the newest ("an OLDER live order is open → THIS one is the repeat") and
// the EARLIER orders sail through, because when they were placed there was no prior live order to trip
// on. The team was left with one held order and one or two shipping — which defeats the purpose, since
// the risk being screened for (wrong address, wrong product) applies to the whole batch.
//
// ⚠️ TIMING IS THE WHOLE CONSTRAINT. A Shopify hold only works UPSTREAM of the EasyEcom import (~2 min
// in practice); `autoHoldOrder` already refuses once the order is in `b2c_order_easycom` because the
// hold is a verified no-op there. So a sibling placed seconds/minutes ago gets held; one placed long
// enough ago to have imported CANNOT be — no code can pull it back out of EasyEcom.
// Those are reported as `skip:in-easyecom` so the team can act on them by hand. EasyEcom hold behaviour
// is deliberately left untouched — it stays a manual action.
//
// BOUNDED DELIBERATELY. Only orders placed within SIBLING_WINDOW_H are considered. Without that bound a
// customer with an old open order would be retro-held — exactly the 2026-07-28 failure where a bulk
// re-scan held 53 already-shipped orders.
const SIBLING_WINDOW_H = Number(process.env.SHOPIFY_SIBLING_HOLD_HOURS || 24);

async function holdSiblingOrders({ phone, excludeOrderName, reasonNote }) {
    const out = { checked: 0, held: 0, skipped: 0, failed: 0, orders: [] };
    const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
    if (last10.length !== 10) return out;

    const sinceISO = new Date(Date.now() - SIBLING_WINDOW_H * 3600 * 1000).toISOString();
    // Open = not delivered / RTO / cancelled. order_buckets is the same source the hold rules use.
    const { data } = await supabase.from('order_buckets')
        .select('order_id, order_name, bucket, created_at')
        .ilike('phone', `%${last10}`).gte('created_at', sinceISO)
        .order('created_at', { ascending: false }).limit(20);

    const exclude = norm(excludeOrderName);
    const siblings = (data || []).filter(o =>
        norm(o.order_name) !== exclude && !['delivered', 'rto', 'cancelled'].includes(String(o.bucket || '')));
    out.checked = siblings.length;
    if (!siblings.length) return out;

    const note = `${reasonNote || HOLD_NOTE} · batch with ${exclude}`;
    for (const o of siblings) {
        const name = norm(o.order_name);
        try {
            // Never touch a parcel the courier already has — order_buckets only rules out
            // delivered/RTO/cancelled, so an in-transit order would otherwise reach the hold call.
            const d = await isDispatchedOrder(name);
            if (d.dispatched) { out.skipped++; out.orders.push({ order: name, result: 'skip:dispatched:' + (d.why || '') }); continue; }
            // holdOrderSmart enforces the rest: not already held/released, not stale, Shopify first,
            // EasyEcom only once the import window has closed.
            const r = await holdOrderSmart(name, String(o.order_id), note, o.created_at);
            if (r.held) { out.held++; out.orders.push({ order: name, result: 'held:' + (r.where || 'shopify') }); }
            else if (r.skipped) { out.skipped++; out.orders.push({ order: name, result: 'skip:' + r.skipped }); }
            else { out.failed++; out.orders.push({ order: name, result: 'failed:' + r.failed }); }
        } catch (e) { out.failed++; out.orders.push({ order: name, result: 'error:' + e.message }); }
        await new Promise(x => setTimeout(x, 400));   // gentle on the Shopify API
    }
    if (out.held || out.failed) {
        console.log(`[ShopifyHold] siblings of ${exclude}: held ${out.held}, skipped ${out.skipped}, failed ${out.failed} (of ${out.checked})`);
    }
    return out;
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
const HIGH_VALUE_MIN = 1500;   // ₹ — the high-value hold threshold; also the bar a PAST DELIVERED order
                               // must clear to earn the trust exception. Keep in sync with support_console.js.
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
    // ── Customer history by phone. Fetched for EVERY payment type now (not just COD) because the
    //    high-value rule below needs it too. Ordered newest-first so the 50-row cap keeps the RECENT
    //    orders rather than an arbitrary slice.
    const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
    let others = [], deliveredIds = [];
    if (last10.length === 10) {
        const { data } = await supabase.from('order_buckets')
            .select('order_id, bucket, created_at, total_price')
            .ilike('phone', `%${last10}`)
            .order('created_at', { ascending: false })
            .limit(50);
        others = (data || []).filter(h => String(h.order_id) !== String(shopifyOrderId));
        deliveredIds = others.filter(h => h.bucket === 'delivered').map(h => h.order_id);   // for the short-address trust exception
    }
    const before = new Date(createdAt || Date.now());
    const prior = others.filter(h => new Date(h.created_at) < before);
    // reason: HIGH VALUE (≥₹1500) — applies to COD AND partial-paid.
    // TRUST EXCEPTION (2026-08-01): skip when this customer has EVER TAKEN DELIVERY of a ≥₹1500 order.
    // NO last-3 window and NO time limit — the customer's COMPLETE order history counts, because once
    // someone has accepted a high-value COD parcel the value alone stops being a risk signal.
    // Asked as its own targeted existence query (not filtered from the 50-row recent-history window
    // above), so a customer with >50 orders can't have their proving delivery fall outside it.
    if (Number(totalPrice || 0) >= HIGH_VALUE_MIN) {
        let deliveredHighValue = false;
        if (last10.length === 10) {
            const { data: hv } = await supabase.from('order_buckets')
                .select('order_id')
                .ilike('phone', `%${last10}`)
                .eq('bucket', 'delivered')
                .gte('total_price', HIGH_VALUE_MIN)
                .lt('created_at', before.toISOString())
                .limit(1);
            deliveredHighValue = !!(hv && hv.length);
        }
        if (!deliveredHighValue) reasons.push('high_value');
    }
    if (!isPartialPaid) {                                                                      // history + address reasons are COD-only
        {
            const last3Prior = prior.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 3);
            // RULE: if ANY ONE of the last 3 prior orders was DELIVERED, the customer is trusted → skip the history reasons.
            const dCount    = last3Prior.filter(h => h.bucket === 'delivered').length;
            const reliable  = dCount >= 1;
            if (!reliable && last3Prior.some(h => !['delivered', 'cancelled'].includes(h.bucket))) reasons.push('recent_undelivered');   // reason #2 — skipped when any of last 3 delivered
            if (prior.some(h => !['delivered', 'rto', 'cancelled'].includes(h.bucket))) reasons.push('in_flight');   // reason #1 — an OLDER live order still open → THIS order is the repeat
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
    getHoldStates, releasedByHuman, holdOrderManual, releaseOrder, cancelOrder, autoHoldOrder, holdOrderSmart, holdSiblingOrders, isDispatchedOrder, qualifiesForHold, holdReasons, reasonNoteFrom, HOLD_NOTE,
};
