// Repeat-COD hold rules — ONE definition, shared by the orders/create webhook (shopify_hold.holdReasons),
// the */2 auto-hold cron and the Call Queue Repeat tab (support_console.findRepeatCandidates).
//
// WHY THIS FILE EXISTS (2026-08-27, TE25-45095): the two copies of the rule both looked a customer up by
// PHONE only. A customer who had an RTO in April and a cancellation in May under one number placed a new
// COD order under a different number — same email, Shopify itself tagged it "Repeat" — and both copies saw
// a first-time buyer: no history, ₹798, long address, no hold. User: "don't depend on phone number only,
// make a robust system to check."
//
// IDENTITY = phone ∪ email, CLOSED one hop at a time: the seed phone/email finds orders; the phones and
// emails on THOSE orders find more; repeat until nothing new (bounded — see MAX_MERGE). This is the same
// idea Customer Profile uses (customer_profile.js ordersFor), applied to the hold decision. Placeholder
// phones (EasyEcom's 9999999999 etc.) and junk emails are never used as keys — one shared placeholder
// would fuse hundreds of strangers into one "customer".
//
// The RULES (unchanged in meaning, now evaluated in one place — evaluateReasons):
//   in_flight           an OLDER non-terminal order of this customer is still open (COD only)
//   recent_undelivered  none of the last 3 PRIOR orders delivered, and ≥1 of them is a non-delivery
//                       (RTO counts; cancelled does not; if ANY of the 3 delivered the customer is trusted)
//   high_value          ≥ ₹1500 — unless the customer has EVER taken delivery of a ≥ ₹1500 order (COD + partial-paid)
//   short_address       < 60 chars — unless a PAST DELIVERED order used the same address (COD only)
// Fully prepaid orders never hold; partially-paid orders hold on high_value only.
'use strict';

const HIGH_VALUE_MIN = 1500;
const SHORT_ADDR_MAX = 60;
const MAX_MERGE = 400;           // identity closure larger than this = a shared/dummy contact → fall back to the seed keys
const MAX_HOPS = 4;
const PLACEHOLDER_PHONES = new Set(['9999999999', '0000000000', '1111111111', '1234567890']);
const JUNK_EMAIL_RX = /^(dummy|test|testing|noemail|no-email|na|none|guest|customer)@|@(example\.com|test\.com|noemail\.com)$|^\s*$/i;
const TERMINAL_BUCKETS = new Set(['delivered', 'rto', 'cancelled']);

const p10 = p => String(p || '').replace(/\D/g, '').slice(-10);
const phoneKey = p => { const k = p10(p); return k.length === 10 && !PLACEHOLDER_PHONES.has(k) ? k : null; };
const emailKey = e => { const k = String(e || '').trim().toLowerCase(); return k && k.includes('@') && !JUNK_EMAIL_RX.test(k) ? k : null; };
// The stored variants a phone may take ('+91…', '91…', bare) — for `.in()` lookups against mixed data.
const phoneVariants = p => { const k = p10(p); return k.length === 10 ? [String(p || '').trim(), k, '91' + k, '+91' + k].filter(Boolean) : (p ? [String(p)] : []); };
const emailVariants = e => { const k = String(e || '').trim(); return k ? [...new Set([k, k.toLowerCase()])] : []; };
const normAddr = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const fullAddr = a => [a && a.address1, a && a.address2, a && a.city, a && a.province, a && a.zip].filter(Boolean).join(', ');
const orderKey = n => String(n || '').replace(/^#/, '').trim();

// ── identity closure (pure) ───────────────────────────────────────────────────────────────────────
// seed: { phone?, email? }; rows: order_buckets-shaped rows { order_id, phone, email, ... }.
// Returns { phones:Set, emails:Set, orders:[rows in the identity], overflow }.
function closeIdentity(seed, rows) {
    const phones = new Set(), emails = new Set();
    const sp = phoneKey(seed.phone), se = emailKey(seed.email);
    if (sp) phones.add(sp);
    if (se) emails.add(se);
    if (!phones.size && !emails.size) return { phones, emails, orders: [], overflow: false };
    const inIdentity = r => (phoneKey(r.phone) && phones.has(phoneKey(r.phone))) || (emailKey(r.email) && emails.has(emailKey(r.email)));
    let matched = new Set();
    for (let hop = 0; hop < MAX_HOPS; hop++) {
        let grew = false;
        for (const r of rows) {
            if (!inIdentity(r)) continue;
            const id = String(r.order_id);
            if (!matched.has(id)) { matched.add(id); grew = true; }
            const pk = phoneKey(r.phone), ek = emailKey(r.email);
            if (pk && !phones.has(pk)) { phones.add(pk); grew = true; }
            if (ek && !emails.has(ek)) { emails.add(ek); grew = true; }
        }
        if (matched.size > MAX_MERGE) {
            // A contact shared by hundreds of orders is a placeholder we failed to recognise. Holding a
            // stranger on someone else's RTO is worse than missing a repeat — keep only the seed keys.
            const seedPhones = new Set(sp ? [sp] : []), seedEmails = new Set(se ? [se] : []);
            const seedOnly = rows.filter(r => (phoneKey(r.phone) && seedPhones.has(phoneKey(r.phone))) || (emailKey(r.email) && seedEmails.has(emailKey(r.email))));
            return { phones: seedPhones, emails: seedEmails, orders: seedOnly, overflow: true };
        }
        if (!grew) break;
    }
    return { phones, emails, orders: rows.filter(inIdentity), overflow: false };
}

// ── history fetch (one round trip per hop, chunked; order_buckets view) ───────────────────────────
async function chunkedIn(supabase, table, select, col, values, extra) {
    const out = [];
    const vals = [...new Set(values.filter(Boolean))];
    for (let i = 0; i < vals.length; i += 200) {
        let q = supabase.from(table).select(select).in(col, vals.slice(i, i + 200));
        if (extra) q = extra(q);
        const { data, error } = await q.limit(1000);
        if (error) throw new Error(`${table} lookup failed: ${error.message}`);
        out.push(...(data || []));
    }
    return out;
}
const HIST_SEL = 'order_id, order_name, phone, email, bucket, created_at, total_price';

// Fetch every order_buckets row reachable from the given phones/emails, expanding through the
// phones/emails found on the way (bounded by MAX_HOPS). Deduped by order_id.
async function fetchHistory(supabase, { phones = [], emails = [] }) {
    const seen = new Map();
    let pendP = new Set(phones.map(phoneKey).filter(Boolean)), pendE = new Set(emails.map(emailKey).filter(Boolean));
    const doneP = new Set(), doneE = new Set();
    for (let hop = 0; hop < MAX_HOPS && (pendP.size || pendE.size); hop++) {
        const pv = [...pendP].flatMap(phoneVariants), ev = [...pendE].flatMap(emailVariants);
        const [byP, byE] = await Promise.all([
            pv.length ? chunkedIn(supabase, 'order_buckets', HIST_SEL, 'phone', pv) : [],
            ev.length ? chunkedIn(supabase, 'order_buckets', HIST_SEL, 'email', ev) : [],
        ]);
        pendP.forEach(p => doneP.add(p)); pendE.forEach(e => doneE.add(e));
        pendP = new Set(); pendE = new Set();
        for (const r of [...byP, ...byE]) {
            if (!seen.has(String(r.order_id))) seen.set(String(r.order_id), r);
            const pk = phoneKey(r.phone), ek = emailKey(r.email);
            if (pk && !doneP.has(pk)) pendP.add(pk);
            if (ek && !doneE.has(ek)) pendE.add(ek);
        }
        if (seen.size > MAX_MERGE) break;                       // runaway placeholder — closeIdentity will fall back
    }
    return [...seen.values()];
}

// Has this identity EVER taken delivery of a ≥₹1500 order before `beforeISO`? Asked as its own tiny
// query (not sliced out of the history batch) so a >1000-order customer cannot hide the proving delivery.
async function deliveredHighValueBefore(supabase, ident, beforeISO) {
    const pv = [...ident.phones].flatMap(phoneVariants), ev = [...ident.emails].flatMap(emailVariants);
    const extra = q => q.eq('bucket', 'delivered').gte('total_price', HIGH_VALUE_MIN).lt('created_at', beforeISO);
    const [a, b] = await Promise.all([
        pv.length ? chunkedIn(supabase, 'order_buckets', 'order_id', 'phone', pv, extra) : [],
        ev.length ? chunkedIn(supabase, 'order_buckets', 'order_id', 'email', ev, extra) : [],
    ]);
    return a.length + b.length > 0;
}

// ── the rules (pure) ──────────────────────────────────────────────────────────────────────────────
// cand: { order_id, created_at, total_price, financial_status, address }
// history: rows in the identity (may include cand itself — excluded here)
// deliveredHighValue: boolean from deliveredHighValueBefore()
// deliveredAddrNorms: Set of normAddr(fullAddr) for the customer's PAST DELIVERED orders (only needed
//                     when the address is short; pass an empty Set otherwise)
// isCancelled: row → boolean (EasyEcom-cancelled orders read as active in order_buckets)
function evaluateReasons({ cand, history, deliveredHighValue, deliveredAddrNorms, isCancelled }) {
    const fin = String(cand.financial_status || '').toLowerCase();
    if (['paid', 'refunded', 'partially_refunded'].includes(fin)) return [];
    const isPartialPaid = fin === 'partially_paid';
    const cancelled = isCancelled || (h => h.bucket === 'cancelled');
    const before = new Date(cand.created_at || Date.now());
    const prior = history.filter(h => String(h.order_id) !== String(cand.order_id) && new Date(h.created_at) < before);
    const reasons = [];
    if (!isPartialPaid) {
        const last3 = prior.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 3);
        const reliable = last3.some(h => h.bucket === 'delivered');
        if (prior.some(h => !TERMINAL_BUCKETS.has(h.bucket) && !cancelled(h))) reasons.push('in_flight');
        if (!reliable && last3.some(h => h.bucket !== 'delivered' && !cancelled(h))) reasons.push('recent_undelivered');
    }
    if (Number(cand.total_price || 0) >= HIGH_VALUE_MIN && !deliveredHighValue) reasons.push('high_value');
    if (!isPartialPaid) {
        const addr = String(cand.address || '').trim();
        if (addr && addr.length < SHORT_ADDR_MAX && !(deliveredAddrNorms && deliveredAddrNorms.has(normAddr(addr)))) reasons.push('short_address');
    }
    return reasons;
}

// ── the evaluation ledger — every decision leaves a row ───────────────────────────────────────────
// Fire-and-forget: a ledger write must never break a hold. verdict: hold | no_reason | prepaid | not_holdable.
async function recordEvaluation(supabase, { orderName, path, reasons, identity, historyCount, shopifyRepeatTag, action, financialStatus }) {
    try {
        const fin = String(financialStatus || '').toLowerCase();
        const verdict = ['paid', 'refunded', 'partially_refunded'].includes(fin) ? 'prepaid' : (reasons && reasons.length ? 'hold' : 'no_reason');
        await supabase.from('hold_evaluations_ecom').insert({
            order_name: orderKey(orderName), path, verdict, reasons: reasons || [],
            identity: identity ? { phones: [...(identity.phones || [])], emails: [...(identity.emails || [])], overflow: !!identity.overflow } : null,
            history_count: historyCount == null ? null : Number(historyCount),
            shopify_repeat_tag: shopifyRepeatTag == null ? null : !!shopifyRepeatTag,
            action: action || null,
        });
    } catch (e) { console.warn('[HoldLedger] write failed:', e.message); }
}

// COD orders in the window with NO evaluation row at all — the reconciler's work list. Window starts
// `minAgeMin` ago (give the webhook + its 3-minute neighbour a chance) and ends `maxAgeH` ago (older
// than that a hold is moot AND the age seal protects settled history).
async function unevaluatedCodOrders(supabase, { minAgeMin = 5, maxAgeH = 48 } = {}) {
    const from = new Date(Date.now() - maxAgeH * 3600e3).toISOString();
    const to = new Date(Date.now() - minAgeMin * 60e3).toISOString();
    const { data: orders, error } = await supabase.from('orders')
        .select('id, name, email, phone, created_at, financial_status, total_price, tags, cancelled_at, fulfillment_status')
        .in('financial_status', ['pending', 'partially_paid']).is('cancelled_at', null).neq('test', true)
        .gte('created_at', from).lte('created_at', to).order('created_at').limit(1000);
    if (error) throw new Error('orders lookup failed: ' + error.message);
    const names = (orders || []).map(o => orderKey(o.name)).filter(Boolean);
    const seen = new Set();
    for (let i = 0; i < names.length; i += 300) {
        const { data } = await supabase.from('hold_evaluations_ecom').select('order_name').in('order_name', names.slice(i, i + 300));
        (data || []).forEach(r => seen.add(r.order_name));
    }
    return (orders || []).filter(o => !seen.has(orderKey(o.name)));
}

module.exports = {
    recordEvaluation, unevaluatedCodOrders,
    HIGH_VALUE_MIN, SHORT_ADDR_MAX, MAX_MERGE, PLACEHOLDER_PHONES, TERMINAL_BUCKETS,
    p10, phoneKey, emailKey, phoneVariants, emailVariants, normAddr, fullAddr, orderKey,
    closeIdentity, fetchHistory, deliveredHighValueBefore, evaluateReasons, chunkedIn,
};
