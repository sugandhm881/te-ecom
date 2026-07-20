// Customer Support Console — port of the standalone Support Console app into Ecom Central.
// Reads the SAME Supabase tables/views that app used: order_buckets (view — the per-order bucket
// engine), order_notes, call_logs, escalation_contacts, undelivered_tracking, msg91_messages,
// tracking_run_lock, profiles. Auth/roles come from OUR portal (JWT + permissions), not Supabase auth:
// each portal user gets a deterministic uuid (md5 of email) + a profiles row so notes/calls attribute.
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { supabase } = require('../supabase');
const shopifyHold = require('./shopify_hold');

const UNDELIVERED_BUCKETS = ['undelivered'];   // per the console spec: single member
const CALL_OUTCOMES = ['no_answer', 'customer_will_accept', 'refused', 'reschedule', 'wrong_number', 'delivered_confirmed', 'other'];
const PREPAID_STATUSES = ['paid', 'partially_paid', 'refunded', 'partially_refunded'];

// ── identity: portal email → REAL Supabase auth user (created via admin API on first use) ───────────
// call_logs.agent_id / profiles.user_id FK to auth.users, so each portal agent gets a shadow auth user
// (email-confirmed, random password, never used to log in) — same thing the old console's signup did.
const _agentCache = new Map();   // email(lower) → auth user uuid
async function ensureProfile(email) {
    const key = String(email || '').toLowerCase().trim();
    if (_agentCache.has(key)) return _agentCache.get(key);
    let uid = null;
    // 1) Existing auth user with this email?
    try {
        for (let page = 1; page <= 5 && !uid; page++) {
            const { data } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
            const hit = (data && data.users || []).find(u => String(u.email || '').toLowerCase() === key);
            if (hit) uid = hit.id;
            if (!data || !data.users || data.users.length < 100) break;
        }
    } catch (_) {}
    // 2) Create a shadow auth user (portal agents don't log in through Supabase).
    if (!uid) {
        const { data, error } = await supabase.auth.admin.createUser({
            email: key, email_confirm: true, password: crypto.randomBytes(24).toString('hex'),
            user_metadata: { display_name: key.split('@')[0], portal_agent: true },
        });
        if (error) throw new Error('Could not provision support agent: ' + error.message);
        uid = data.user.id;
    }
    // 3) Ensure the profiles row (display name in call/note lists).
    try {
        const { data: p } = await supabase.from('profiles').select('id').eq('user_id', uid).maybeSingle();
        if (!p) await supabase.from('profiles').insert({ user_id: uid, display_name: key.split('@')[0] });
    } catch (_) { /* display-name attribution is best-effort */ }
    _agentCache.set(key, uid);
    return uid;
}
// Synchronous best-effort lookup for read paths (the "mine" flag) — resolves once the user has written
// anything this process lifetime; unknown users just get mine:false until their first write.
function agentUuid(email) { return _agentCache.get(String(email || '').toLowerCase().trim()) || null; }
const isAdmin = req => req.user && (req.user.role === 'admin' || (req.user.permissions || []).includes('*'));

// ── helpers ──────────────────────────────────────────────────────────────────
function rangeISO(req, defDays = 14) {
    const now = new Date();
    const to = req.query.to ? new Date(req.query.to) : now;
    const from = req.query.from ? new Date(req.query.from) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - defDays);
    return {
        fromISO: new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString(),
        toISO: new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59).toISOString(),
    };
}
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
// PostgREST URL limits: big IN() lists are chunked at 300 and fetched in parallel (console pattern).
async function chunkedIn(table, select, col, ids, extra) {
    const parts = await Promise.all(chunk(ids, 300).map(part => {
        let q = supabase.from(table).select(select).in(col, part);
        if (extra) q = extra(q);
        return q;
    }));
    return parts.flatMap(p => p.data || []);
}
// Latest note + count + author per order for a list of order_ids.
async function notesByOrder(orderIds) {
    if (!orderIds.length) return {};
    const rows = await chunkedIn('order_notes', 'order_id, content, created_at, agent_id', 'order_id', orderIds);
    const map = {};
    rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    rows.forEach(n => { const m = map[n.order_id] || (map[n.order_id] = { count: 0, latest: null, latest_at: null, latest_agent: null }); m.count++; m.latest = n.content; m.latest_at = n.created_at; m.latest_agent = n.agent_id; });
    // Resolve author display names in one shot.
    const agentIds = [...new Set(Object.values(map).map(m => m.latest_agent).filter(Boolean))];
    if (agentIds.length) {
        const profs = await chunkedIn('profiles', 'user_id, display_name', 'user_id', agentIds);
        const nameById = {}; profs.forEach(p => { nameById[p.user_id] = p.display_name; });
        Object.values(map).forEach(m => { m.latest_by = nameById[m.latest_agent] || null; delete m.latest_agent; });
    }
    return map;
}
// Latest courier scan time per order — the most recent tracking movement (max of status_updated_at →
// last_tracked_at → updated_at across the order's tracking rows). Powers the Call Queue "Latest scan"
// sort so agents can work by freshest courier activity. order_tracking has ≤1 row per (order, source);
// we keep the newest across sources.
async function scanTimesByOrder(orderIds) {
    if (!orderIds.length) return {};
    const rows = await chunkedIn('order_tracking', 'order_id, status_updated_at, last_tracked_at, updated_at', 'order_id', orderIds);
    const best = r => r.status_updated_at || r.last_tracked_at || r.updated_at || null;
    const map = {};
    rows.forEach(r => { const t = best(r); if (!t) return; if (!map[r.order_id] || new Date(t) > new Date(map[r.order_id])) map[r.order_id] = t; });
    return map;
}
// Orders CANCELLED in EasyEcom (b2c_order_easycom.order_status "Cancelled"). EasyEcom can cancel an order
// while Shopify's `cancelled_at` + the `order_buckets` bucket still show it active (Shopify sync lags), so
// for EasyEcom-fulfilled orders this is the authoritative "cancelled" signal. (Unlike holds, the cancel text
// IS reliable — a cancelled order reads "Cancelled".) Returns a Set of normalized order names.
async function eeCancelledSet(names) {
    const uniq = [...new Set((names || []).map(n => String(n || '').replace('#', '').trim()).filter(Boolean))];
    if (!uniq.length) return new Set();
    const rows = await chunkedIn('b2c_order_easycom', 'reference_code', 'reference_code', uniq, q => q.ilike('order_status', '%cancel%'));
    return new Set(rows.map(r => String(r.reference_code || '').replace('#', '').trim()));
}
async function lockState() {
    const { data } = await supabase.from('tracking_run_lock').select('*').eq('id', 1).maybeSingle();
    return data || null;
}

// ── GET /support/summary — dashboard KPIs + bucket counts + calls in range ──
router.get('/support/summary', async (req, res) => {
    try {
        const { fromISO, toISO } = rangeISO(req);
        const today = new Date(); const dayISO = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
        const B = () => supabase.from('order_buckets').select('*', { count: 'exact', head: true }).gte('created_at', fromISO).lte('created_at', toISO);
        const buckets = ['order_to_dispatch', 'dispatch_plus_2', 'two_to_five_days', 'five_days_plus', 'undelivered', 'delivered', 'rto', 'cancelled'];
        const [total, callsToday, deliveredToday, pending, msg91, callsRange, ...bucketCounts] = await Promise.all([
            B(),
            supabase.from('call_logs').select('*', { count: 'exact', head: true }).gte('called_at', dayISO),
            supabase.from('order_buckets').select('*', { count: 'exact', head: true }).eq('bucket', 'delivered').gte('delivered_date', dayISO),
            B().in('bucket', UNDELIVERED_BUCKETS),
            B().in('bucket', UNDELIVERED_BUCKETS).eq('msg91_confirmed', true),
            supabase.from('call_logs').select('*', { count: 'exact', head: true }).gte('called_at', fromISO).lte('called_at', toISO),
            ...buckets.map(b => B().eq('bucket', b)),
        ]);
        const bucketMap = {}; buckets.forEach((b, i) => { bucketMap[b] = bucketCounts[i].count || 0; });
        res.json({ success: true, kpis: {
            totalOrders: total.count || 0, callsToday: callsToday.count || 0, deliveredToday: deliveredToday.count || 0,
            pendingUndelivered: pending.count || 0, msg91Confirmed: msg91.count || 0, callsInRange: callsRange.count || 0,
        }, buckets: bucketMap, lock: await lockState() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Repeat-call candidates. BASE (always): (a) COD (financial_status not paid-ish) — only COD carries the RTO
// risk worth calling; (b) still callable — bucket `order_to_dispatch`, before the courier collects it.
// Each candidate is TAGGED with which of THREE call-reasons it matches (`c.reasons`):
//   • `in_flight`          — the customer has ANOTHER order that hasn't reached a terminal status
//                            (delivered/RTO/cancelled) → a live/pending delivery.
//   • `recent_undelivered` — ≥1 of the customer's last 3 PRIOR orders (by phone) was not delivered
//                            (RTO/undelivered/in-transit; cancelled doesn't count) → recent non-delivery.
//   • `high_value`         — this order is above ₹1500.
// `anyReason` (Call Queue dashboard) returns the whole COD/pre-pickup base tagged, and the /support/queue
// repeat block decides what to show (drops MOVED orders, keeps reason-tagged + held/noted). Default
// (Shopify auto-hold cron) keeps the STRICTER original rule — only `recent_undelivered` — so it doesn't
// start auto-holding every high-value / in-flight order.
async function findRepeatCandidates({ fromISO, toISO, skipDispatchFilter = false, anyReason = false }) {
    const SEL = 'order_id, order_name, phone, email, total_price, created_at, fulfillment_status, tracking_status, partner, courier, awb_number, bucket, msg91_confirmed, is_repeat_customer, dispatch_at, edd';
    const { data, error } = await supabase.from('order_buckets').select(SEL)
        .eq('bucket', 'order_to_dispatch')                               // (2) still pre-pickup / holdable
        .gte('created_at', fromISO).lte('created_at', toISO)
        .order('msg91_confirmed', { ascending: false }).order('created_at', { ascending: true }).limit(2000);
    if (error) throw new Error(error.message);
    let cand = data || [];
    // "Dispatched" = already fulfilled / picked up / in transit. The `order_to_dispatch` bucket is keyed off
    // a Shopify-fulfillment state that lags, so a fulfilled order (AWB assigned, courier "out for pickup" /
    // "pickup scheduled", or DocPharma "in-progress") wrongly stays in the bucket even though it has already
    // been dispatched and can no longer be held (Shopify won't hold a fulfilled order; EasyEcom won't after
    // manifest). Primary signal = `fulfillment_status` (fulfilled/partial); tracking-status regex is a safety
    // net for the rare unfulfilled-but-moving row.
    // "MOVED" = the courier has physically taken the parcel — picked up / in transit / out-for-delivery /
    // sorting / delivered / RTO. Read from the courier `tracking_status` (fresher & more truthful than the
    // Shopify-fulfillment bucket). A moved order is GONE: it can never be held/called before dispatch again,
    // so it must drop from the Repeat panel EVEN IF it carries a hold mark or agent notes.
    // "DISPATCHED" = moved OR merely fulfilled (AWB assigned but maybe not yet picked up — e.g. pickup
    // scheduled / out-for-pickup, which is still holdable). The cron drops all dispatched; the queue keeps a
    // dispatched-but-not-moved order if it's being worked (held/noted) and hides moved ones outright.
    const MOVED_RE = /IN.?TRANSIT|IN.?PROGRESS|OUT.?FOR.?DELIVERY|\bOFD\b|DELIVERED|\bRTO\b|RETURN|REACHED|UNDELIVERED|PICKUP.?COMPLETED|PICKED.?UP|SORTING|DISPATCHED|\bLOST\b|EXCEPTION/i;
    const DISPATCHED_FULFIL = new Set(['fulfilled', 'partial']);
    const hasMoved = c => MOVED_RE.test(String(c.tracking_status || ''));
    const isDispatched = c => DISPATCHED_FULFIL.has(String(c.fulfillment_status || '').toLowerCase()) || hasMoved(c);
    if (skipDispatchFilter) cand.forEach(c => { c._dispatched = isDispatched(c); c._moved = hasMoved(c); });
    else cand = cand.filter(c => !isDispatched(c));
    // Drop candidates CANCELLED in EasyEcom — Shopify's cancelled_at / the bucket may still say active (sync
    // lag), but a cancelled order can't be held or called, so it's never a repeat candidate.
    const candCancelled = await eeCancelledSet(cand.map(c => c.order_name));
    cand = cand.filter(c => !candCancelled.has(String(c.order_name || '').replace('#', '').trim()));
    // (1) COD only.
    const finRows = cand.length ? await chunkedIn('orders', 'id, financial_status', 'id', cand.map(c => c.order_id)) : [];
    const finById = {}; finRows.forEach(o => { finById[String(o.id)] = (o.financial_status || '').toLowerCase(); });
    cand = cand.filter(c => !PREPAID_STATUSES.includes(finById[String(c.order_id)] || ''));
    // (4) ≥1 of the customer's last 3 PRIOR orders not delivered.
    const phones = [...new Set(cand.map(c => c.phone).filter(Boolean))];
    const hist = phones.length ? await chunkedIn('order_buckets', 'order_id, order_name, phone, bucket, created_at', 'phone', phones) : [];
    // EasyEcom-cancelled prior orders read as active in order_buckets (Shopify lag) — treat them as cancelled
    // so a customer whose only "non-delivered" prior order was actually cancelled isn't flagged repeat-risk.
    const histCancelled = await eeCancelledSet(hist.map(h => h.order_name));
    const nkn = n => String(n || '').replace('#', '').trim();
    const byPhone = {}; hist.forEach(h => { (byPhone[h.phone] = byPhone[h.phone] || []).push(h); });
    const TERMINAL = new Set(['delivered', 'rto', 'cancelled']);                 // final states → not "in-flight"
    const isCancelled = h => h.bucket === 'cancelled' || histCancelled.has(nkn(h.order_name));   // Shopify OR EasyEcom cancel
    return cand.filter(c => {
        const all = byPhone[c.phone] || [];
        c.orders_count = all.length;
        // Reason `recent_undelivered` — ≥1 of the customer's last 3 PRIOR orders not delivered.
        const last3Prior = all
            .filter(h => h.order_id !== c.order_id && new Date(h.created_at) < new Date(c.created_at))
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 3);
        // Reliability from the last 3 orders (last3Prior[0] = most recent). RTO counts as "not delivered" (a
        // real failure) → it triggers a hold. EXCEPTION (don't hold on the history reasons): the customer HAS
        // 1–2 delivered in the last 3 AND their latest or 2nd-latest order is an RTO — treated as a one-off RTO
        // for an otherwise-delivering customer. (All-3-delivered has no "not delivered" order, so never holds.)
        const dCount    = last3Prior.filter(h => h.bucket === 'delivered').length;
        const recentRTO = (last3Prior[0] && last3Prior[0].bucket === 'rto') || (last3Prior[1] && last3Prior[1].bucket === 'rto');
        const reliable  = (dCount === 1 || dCount === 2) && recentRTO;
        // Reason `recent_undelivered` — ≥1 of the last 3 not delivered (RTO included), unless reliable.
        const rRecent   = !reliable && last3Prior.some(h => h.bucket !== 'delivered' && !isCancelled(h));
        // Reason `in_flight` — the customer has ANOTHER order still non-terminal (a live/pending delivery), unless reliable.
        const rInflight = !reliable && all.some(h => h.order_id !== c.order_id && !TERMINAL.has(h.bucket) && !isCancelled(h));
        // Reason `high_value` — this order is ₹1500 and above.
        const rValue    = Number(c.total_price || 0) >= 1500;
        const reasons = [];
        if (rInflight) reasons.push('in_flight');
        if (rRecent)   reasons.push('recent_undelivered');
        if (rValue)    reasons.push('high_value');
        c.reasons = reasons;
        // Dashboard (anyReason): return the whole tagged base — /support/queue filters it. Auto-hold cron:
        // qualify by ANY of the 3 reasons (so high-value / in-flight orders auto-hold too, matching the panel).
        return anyReason ? true : reasons.length > 0;
    });
}

// ── POST /support/shopify-hold | /support/shopify-unhold — Repeat-panel hold controls ──
// Hold an order's fulfillment on Shopify (upstream of EasyEcom) or release it after the customer
// confirms. orderId = Shopify order id (order_buckets.order_id); orderName = "TE25-…" for the mark.
router.post('/support/shopify-hold', async (req, res) => {
    try {
        const { orderId, orderName, reason } = req.body || {};
        if (!orderId || !orderName) return res.status(400).json({ success: false, error: 'orderId and orderName are required.' });
        const out = await shopifyHold.holdOrderManual(orderName, orderId, (req.user && req.user.sub) || 'agent', reason);
        if (!out.ok) return res.status(502).json({ success: false, error: out.error || 'Hold failed.' });
        res.json({ success: true, status: 'held' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/support/shopify-unhold', async (req, res) => {
    try {
        const { orderId, orderName } = req.body || {};
        if (!orderId || !orderName) return res.status(400).json({ success: false, error: 'orderId and orderName are required.' });
        const out = await shopifyHold.releaseOrder(orderName, orderId, (req.user && req.user.sub) || 'agent');
        if (!out.ok) return res.status(502).json({ success: false, error: out.error || 'Release failed.' });
        res.json({ success: true, status: 'released' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /support/queue?tab=repeat|und|changed ────────────────────────────────
router.get('/support/queue', async (req, res) => {
    try {
        const tab = req.query.tab || 'und';
        const { fromISO, toISO } = rangeISO(req);
        const SEL = 'order_id, order_name, phone, email, total_price, created_at, fulfillment_status, tracking_status, partner, courier, awb_number, bucket, msg91_confirmed, is_repeat_customer, dispatch_at, edd';
        let rows = [];

        if (tab === 'und') {
            const { data, error } = await supabase.from('order_buckets').select(SEL)
                .in('bucket', UNDELIVERED_BUCKETS).gte('created_at', fromISO).lte('created_at', toISO)
                .order('msg91_confirmed', { ascending: false }).order('created_at', { ascending: true }).limit(2000);
            if (error) throw new Error(error.message);
            rows = data || [];
            // Remember every order ever seen undelivered — powers the Status-changed tab.
            if (rows.length) {
                const now = new Date().toISOString();
                for (const part of chunk(rows.map(r => ({ order_id: r.order_id, last_seen_at: now })), 500)) {
                    await supabase.from('undelivered_tracking').upsert(part, { onConflict: 'order_id' }).then(() => {}).catch(() => {});
                }
            }
        } else if (tab === 'changed') {
            const { data: tracked } = await supabase.from('undelivered_tracking').select('order_id').order('last_seen_at', { ascending: false }).limit(3000);
            const ids = (tracked || []).map(t => t.order_id);
            const all = ids.length ? await chunkedIn('order_buckets', SEL, 'order_id', ids) : [];
            rows = all.filter(r => !UNDELIVERED_BUCKETS.includes(r.bucket))
                .sort((a, b) => (b.msg91_confirmed === true) - (a.msg91_confirmed === true) || new Date(a.created_at) - new Date(b.created_at));
        } else { // repeat — reason-tagged COD/pre-pickup base (see findRepeatCandidates); shown/filtered below.
            rows = await findRepeatCandidates({ fromISO, toISO, skipDispatchFilter: true, anyReason: true });
            rows = rows.filter(r => !r._moved);   // orders the courier already took are gone — drop before enriching
        }

        const [notes, scans] = await Promise.all([
            notesByOrder(rows.map(r => r.order_id)),
            scanTimesByOrder(rows.map(r => r.order_id)),
        ]);
        rows.forEach(r => { const n = notes[r.order_id]; r.note_count = n ? n.count : 0; r.latest_note = n ? n.latest : null; r.latest_note_by = n ? n.latest_by : null; r.latest_note_at = n ? n.latest_at : null; r.last_scan_at = scans[r.order_id] || null; });
        // Repeat tab: attach hold state + EasyEcom-import state so the panel offers the RIGHT control —
        // Shopify hold only while the order is still upstream of EasyEcom; once imported into EasyEcom the
        // Shopify hold is pointless, so offer an EasyEcom hold instead.
        if (tab === 'repeat') {
            const nk = n => String(n || '').replace('#', '').trim();
            const holds = await shopifyHold.getHoldStates(rows.map(r => r.order_name));
            const names = [...new Set(rows.map(r => nk(r.order_name)).filter(Boolean))];
            const eeRows = names.length ? await chunkedIn('b2c_order_easycom', 'reference_code, order_id, order_status', 'reference_code', names) : [];
            const eeBy = {}; eeRows.forEach(e => { eeBy[nk(e.reference_code)] = e; });
            const eeHoldRows = names.length ? await chunkedIn('order_marks_ecom', 'order_name', 'order_name', names, q => q.eq('mark_type', 'ee_hold')) : [];
            const eeHeld = new Set(eeHoldRows.map(m => nk(m.order_name)));
            // EasyEcom's text `order_status` often stays "Open"/"Shipped" while the item is actually On Hold, so
            // the authoritative held signal is `raw_data.order_status_id = 44` — without this, panel-held orders
            // showed a "Hold" button instead of "Unhold" and were dropped as untouched-dispatched.
            const eeHoldIdRows = names.length ? await chunkedIn('b2c_order_easycom', 'reference_code', 'reference_code', names, q => q.filter('raw_data->>order_status_id', 'eq', '44')) : [];
            const eeHeldById = new Set(eeHoldIdRows.map(r => nk(r.reference_code)));
            rows.forEach(r => {
                const k = nk(r.order_name);
                r.shopify_hold = holds[k] || null;
                const ee = eeBy[k];
                r.in_ee = !!ee;                                                   // imported into EasyEcom?
                r.easyecom_order_id = ee ? String(ee.order_id) : null;
                r.ee_hold = eeHeld.has(k) || eeHeldById.has(k) || /hold/i.test((ee && ee.order_status) || '');   // already held in EasyEcom?
            });
            // Show a candidate if it matches ≥1 call-reason (in_flight / recent_undelivered / high_value) OR the
            // team is already working it (held on EasyEcom/Shopify — incl. a failed hold — or has agent notes).
            // MOVED orders were already dropped above. Untouched, no-reason orders (e.g. a first-time low-value
            // COD customer) fall away.
            rows = rows.filter(r => (r.reasons && r.reasons.length > 0)
                || r.ee_hold
                || (r.shopify_hold && (r.shopify_hold.status === 'held' || r.shopify_hold.status === 'failed'))
                || r.note_count > 0);
        }
        res.json({ success: true, tab, rows: rows.slice(0, 1500), lock: await lockState() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /support/orders — search with filters + pagination + facets ─────────
router.get('/support/orders', async (req, res) => {
    try {
        const { fromISO, toISO } = rangeISO(req, 30);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const PER = 50;
        let q = supabase.from('order_buckets').select('*', { count: 'exact' }).gte('created_at', fromISO).lte('created_at', toISO);
        if (req.query.bucket) q = q.eq('bucket', req.query.bucket);
        if (req.query.partner) q = q.eq('partner', req.query.partner);
        if (req.query.courier) q = q.eq('courier', req.query.courier);
        if (req.query.status) q = q.eq('tracking_status', req.query.status);
        const raw = String(req.query.q || '').trim();
        if (raw) {
            const safe = raw.replace(/[%,()]/g, '');
            q = q.or(`order_name.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%,awb_number.ilike.%${safe}%`);
        }
        const { data, count, error } = await q.order('created_at', { ascending: false }).range((page - 1) * PER, page * PER - 1);
        if (error) throw new Error(error.message);
        // Facets for the courier/status dropdowns (from the current window, unfiltered).
        const { data: fac } = await supabase.from('order_buckets').select('courier, tracking_status').gte('created_at', fromISO).lte('created_at', toISO).limit(5000);
        const couriers = [...new Set((fac || []).map(f => f.courier).filter(Boolean))].sort();
        const statuses = [...new Set((fac || []).map(f => f.tracking_status).filter(Boolean))].sort();
        res.json({ success: true, rows: data || [], total: count || 0, page, pages: Math.max(1, Math.ceil((count || 0) / PER)), facets: { couriers, statuses } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /support/order/:orderId — full detail bundle (7 parallel queries) ───
router.get('/support/order/:orderId', async (req, res) => {
    try {
        const oid = String(req.params.orderId).trim();
        const { data: b } = await supabase.from('order_buckets').select('*').eq('order_id', oid).maybeSingle();
        if (!b) return res.status(404).json({ success: false, error: 'Order not found' });
        // Customer's other orders — match by NORMALIZED phone (last 10 digits) OR email, because the
        // stored phone format varies per order (+91…, bare 10-digit, spaced). Exact-match misses them.
        const last10 = String(b.phone || '').replace(/\D/g, '').slice(-10);
        const custEmail = String(b.email || '').trim();
        const CUST_SEL = 'order_id, order_name, bucket, created_at, total_price, tracking_status, courier, awb_number, phone, email';
        const [items, addr, tracking, calls, notes, contactsAll, custByPhone, custByEmail] = await Promise.all([
            supabase.from('order_line_items').select('title, variant_title, sku, quantity, price').eq('order_id', oid),
            supabase.from('order_shipping_addresses').select('*').eq('order_id', oid).maybeSingle(),
            supabase.from('order_tracking').select('tracking_status, courier_name, awb_number, last_tracked_at, edd').eq('order_id', oid).order('last_tracked_at', { ascending: false }),
            supabase.from('call_logs').select('id, outcome, notes, called_at, next_followup_at, agent_id').eq('order_id', oid).order('called_at', { ascending: false }),
            supabase.from('order_notes').select('id, content, created_at, agent_id').eq('order_id', oid).order('created_at', { ascending: false }),
            supabase.from('escalation_contacts').select('*'),
            last10 ? supabase.from('order_buckets').select(CUST_SEL).ilike('phone', `%${last10}`).order('created_at', { ascending: false }).limit(30) : Promise.resolve({ data: [] }),
            custEmail ? supabase.from('order_buckets').select(CUST_SEL).ilike('email', custEmail).order('created_at', { ascending: false }).limit(30) : Promise.resolve({ data: [] }),
        ]);
        // Merge phone- and email-matched orders (deduped), newest first.
        const custMap = new Map();
        [...(custByPhone.data || []), ...(custByEmail.data || [])].forEach(o => { if (!custMap.has(o.order_id)) custMap.set(o.order_id, o); });
        const custOrders = { data: [...custMap.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 25) };
        // Reflect EasyEcom cancellations Shopify hasn't synced yet — an order cancelled in EasyEcom still reads
        // as active (bucket order_to_dispatch) in order_buckets, which misleads the customer-history table. Show
        // it as cancelled so the agent isn't misguided into calling/holding a dead order.
        const eeCanc = await eeCancelledSet([...custOrders.data.map(o => o.order_name), b.order_name]);
        const nkn = n => String(n || '').replace('#', '').trim();
        if (eeCanc.has(nkn(b.order_name))) b.bucket = 'cancelled';
        custOrders.data.forEach(o => { if (eeCanc.has(nkn(o.order_name))) o.bucket = 'cancelled'; });
        // MSG91 thread by phone (last 20).
        let msg91 = [];
        if (b.phone) {
            const last10 = String(b.phone).replace(/\D/g, '').slice(-10);
            const { data: msgs } = await supabase.from('msg91_messages').select('direction, template_name, content, status, sent_at')
                .ilike('phone', `%${last10}`).order('sent_at', { ascending: false }).limit(20);
            msg91 = msgs || [];
        }
        // Agent names for calls/notes.
        const agentIds = [...new Set([...(calls.data || []), ...(notes.data || [])].map(x => x.agent_id).filter(Boolean))];
        const profs = agentIds.length ? await chunkedIn('profiles', 'user_id, display_name', 'user_id', agentIds) : [];
        const nameById = {}; profs.forEach(p => { nameById[p.user_id] = p.display_name; });
        // Whom-to-call: courier match → pincode prefix → region → first contact for that courier.
        const zip = (addr.data && addr.data.zip) || '';
        const province = ((addr.data && addr.data.province) || '').toLowerCase();
        const city = ((addr.data && addr.data.city) || '').toLowerCase();
        const forCourier = (contactsAll.data || []).filter(c => String(c.courier || '').toLowerCase() === String(b.courier || b.partner || '').toLowerCase());
        const escalation = forCourier.find(c => c.pincode_pattern && zip && String(zip).startsWith(c.pincode_pattern))
            || forCourier.find(c => c.region && (province.includes(c.region.toLowerCase()) || city.includes(c.region.toLowerCase())))
            || forCourier[0] || null;
        const myId = await ensureProfile(req.user.sub).catch(() => null);
        res.json({ success: true, order: b, items: items.data || [], address: addr.data || null,
            tracking: tracking.data || [], msg91,
            calls: (calls.data || []).map(c => ({ ...c, agent_name: nameById[c.agent_id] || null })),
            notes: (notes.data || []).map(n => ({ ...n, agent_name: nameById[n.agent_id] || null, mine: n.agent_id === myId })),
            escalation, customer_orders: custOrders.data || [],   // includes the current order (marked client-side)
            isAdmin: isAdmin(req) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Notes CRUD (edit/delete own only; admins can moderate) ──────────────────
router.post('/support/notes', async (req, res) => {
    try {
        const { order_id, content } = req.body || {};
        if (!order_id || !String(content || '').trim()) return res.status(400).json({ success: false, error: 'order_id and content required' });
        const uid = await ensureProfile(req.user.sub);
        const { error } = await supabase.from('order_notes').insert({ order_id: String(order_id), agent_id: uid, content: String(content).trim().slice(0, 2000) });
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.put('/support/notes/:id', async (req, res) => {
    try {
        const content = String((req.body || {}).content || '').trim();
        if (!content) return res.status(400).json({ success: false, error: 'content required' });
        const { data: n } = await supabase.from('order_notes').select('agent_id').eq('id', req.params.id).maybeSingle();
        if (!n) return res.status(404).json({ success: false, error: 'Note not found' });
        if (n.agent_id !== await ensureProfile(req.user.sub).catch(() => null) && !isAdmin(req)) return res.status(403).json({ success: false, error: 'You can only edit your own notes' });
        const { error } = await supabase.from('order_notes').update({ content: content.slice(0, 2000) }).eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.delete('/support/notes/:id', async (req, res) => {
    try {
        const { data: n } = await supabase.from('order_notes').select('agent_id').eq('id', req.params.id).maybeSingle();
        if (!n) return res.status(404).json({ success: false, error: 'Note not found' });
        if (n.agent_id !== await ensureProfile(req.user.sub).catch(() => null) && !isAdmin(req)) return res.status(403).json({ success: false, error: 'You can only delete your own notes' });
        const { error } = await supabase.from('order_notes').delete().eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /support/calls — log a call ─────────────────────────────────────────
router.post('/support/calls', async (req, res) => {
    try {
        const { order_id, outcome, notes, next_followup_at } = req.body || {};
        if (!order_id) return res.status(400).json({ success: false, error: 'order_id required' });
        if (!CALL_OUTCOMES.includes(outcome)) return res.status(400).json({ success: false, error: 'invalid outcome' });
        const uid = await ensureProfile(req.user.sub);
        const { error } = await supabase.from('call_logs').insert({
            order_id: String(order_id), agent_id: uid, outcome,
            notes: String(notes || '').trim().slice(0, 2000) || null,
            next_followup_at: next_followup_at || null,
        });
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /support/calls — my calls (admin: everyone's) ───────────────────────
router.get('/support/calls', async (req, res) => {
    try {
        const { fromISO, toISO } = rangeISO(req);
        let q = supabase.from('call_logs').select('id, order_id, agent_id, outcome, notes, called_at, next_followup_at')
            .gte('called_at', fromISO).lte('called_at', toISO).order('called_at', { ascending: false }).limit(500);
        if (!isAdmin(req)) q = q.eq('agent_id', await ensureProfile(req.user.sub).catch(() => null));
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        const calls = data || [];
        const [profs, bucketRows] = await Promise.all([
            chunkedIn('profiles', 'user_id, display_name', 'user_id', [...new Set(calls.map(c => c.agent_id).filter(Boolean))]),
            chunkedIn('order_buckets', 'order_id, order_name, bucket, tracking_status', 'order_id', [...new Set(calls.map(c => c.order_id))]),
        ]);
        const nameById = {}; profs.forEach(p => { nameById[p.user_id] = p.display_name; });
        const ordById = {}; bucketRows.forEach(o => { ordById[o.order_id] = o; });
        res.json({ success: true, isAdmin: isAdmin(req), calls: calls.map(c => ({ ...c,
            agent_name: nameById[c.agent_id] || '—',
            order_name: (ordById[c.order_id] || {}).order_name || c.order_id,
            bucket: (ordById[c.order_id] || {}).bucket || null,
            tracking_status: (ordById[c.order_id] || {}).tracking_status || null })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Escalation contacts (read: support users · write: admins) ───────────────
router.get('/support/contacts', async (req, res) => {
    const { data, error } = await supabase.from('escalation_contacts').select('*').order('courier').order('region');
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, contacts: data || [], isAdmin: isAdmin(req) });
});
router.post('/support/contacts', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, error: 'Admin access required' });
    const b = req.body || {};
    if (!b.courier || !b.contact_name || !b.phone) return res.status(400).json({ success: false, error: 'courier, contact_name and phone are required' });
    const { error } = await supabase.from('escalation_contacts').insert({
        courier: String(b.courier).toLowerCase(), region: b.region || null, pincode_pattern: b.pincode_pattern || null,
        contact_name: b.contact_name, phone: b.phone, email: b.email || null, notes: b.notes || null });
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true });
});
router.delete('/support/contacts/:id', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, error: 'Admin access required' });
    const { error } = await supabase.from('escalation_contacts').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true });
});

// ── Support Console Team (old console's /admin/team, now inside our Users page) ─────────────────────
// Lists the Supabase-auth agents (profiles + user_roles) that the ORIGINAL console used; promote/demote
// writes user_roles ('admin' row present = admin). These roles govern the old console; our portal RBAC
// stays separate. Admin-only.
router.get('/support/team', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, error: 'Admin access required' });
    try {
        const [profs, roles] = await Promise.all([
            supabase.from('profiles').select('user_id, display_name, created_at').order('created_at', { ascending: true }),
            supabase.from('user_roles').select('user_id, role'),
        ]);
        const emailById = {};
        try {
            for (let page = 1; page <= 5; page++) {
                const { data } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
                (data && data.users || []).forEach(u => { emailById[u.id] = u.email; });
                if (!data || !data.users || data.users.length < 100) break;
            }
        } catch (_) {}
        const rolesById = {};
        (roles.data || []).forEach(r => { (rolesById[r.user_id] = rolesById[r.user_id] || []).push(r.role); });
        const myId = agentUuid(req.user.sub);
        res.json({ success: true, team: (profs.data || []).map(p => ({
            user_id: p.user_id, display_name: p.display_name || (emailById[p.user_id] || '').split('@')[0] || p.user_id.slice(0, 8),
            email: emailById[p.user_id] || null, roles: rolesById[p.user_id] || ['agent'],
            joined: p.created_at, self: p.user_id === myId })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/support/team/:userId/role', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, error: 'Admin access required' });
    try {
        const uid = String(req.params.userId), action = (req.body || {}).action;
        if (uid === agentUuid(req.user.sub)) return res.status(400).json({ success: false, error: 'You cannot change your own role.' });
        if (action === 'promote') {
            const { error } = await supabase.from('user_roles').insert({ user_id: uid, role: 'admin' });
            if (error && !/duplicate/i.test(error.message)) throw new Error(error.message);   // duplicate = already admin
            return res.json({ success: true, message: 'Promoted to admin' });
        }
        if (action === 'demote') {
            const { error } = await supabase.from('user_roles').delete().eq('user_id', uid).eq('role', 'admin');
            if (error) throw new Error(error.message);
            return res.json({ success: true, message: 'Demoted to agent' });
        }
        res.status(400).json({ success: false, error: 'action must be promote or demote' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /support/refresh-tracking — invoke the 'track-orders' edge function ─
router.post('/support/refresh-tracking', async (req, res) => {
    try {
        const r = await axios.post(`${config.SUPABASE_URL}/functions/v1/track-orders`, { time: 'now' },
            { headers: { Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' }, timeout: 120000, validateStatus: () => true });
        if (r.status >= 400) return res.status(502).json({ success: false, error: `track-orders returned ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` });
        res.json({ success: true, result: r.data, lock: await lockState() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
module.exports.findRepeatCandidates = findRepeatCandidates;   // reused by the Shopify auto-hold cron
