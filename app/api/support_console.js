// Customer Support Console — port of the standalone Support Console app into Pravidhi.
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
const { requirePermission } = require('../auth');
const shopifyHold = require('./shopify_hold');

const UNDELIVERED_BUCKETS = ['undelivered'];   // per the console spec: single member
// What "Status changed" means: an order that WAS undelivered and has since SETTLED. Delivered or RTO —
// the two outcomes the customer-support team acts on. Not merely "any bucket other than undelivered".
const SETTLED_BUCKETS = ['delivered', 'rto'];
const RR = require('./repeat_rules');   // the repeat-COD rules + phone∪email identity — ONE copy, shared with shopify_hold.js
const HIGH_VALUE_MIN = RR.HIGH_VALUE_MIN;
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
// Paginated fetch — Supabase caps EVERY response at 1000 rows (a .limit(2000) still returns 1000).
// `build(from, to)` returns the query with .range applied; rows are concatenated until a short page.
async function fetchPaged(build, maxRows = 20000) {
    const all = [];
    for (let ofs = 0; ofs < maxRows; ofs += 1000) {
        const { data, error } = await build(ofs, Math.min(ofs + 999, maxRows - 1));
        if (error) throw new Error(error.message);
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return all;
}
// PostgREST URL limits: big IN() lists are chunked at 300 and fetched in parallel (console pattern).
// AN ERROR HERE MUST THROW, NEVER RESOLVE TO AN EMPTY LIST. This used to end with
// `parts.flatMap(p => p.data || [])`, so any chunk that failed - throttling, a URL too long, a dropped
// socket - silently contributed zero rows and the caller reported a confident, WRONG number. Caught
// 2026-08-19: the Status-changed tab returned 0 rows for August while returning 207 for a range that
// CONTAINS August. The tab had grown to ~7,000 candidate ids (24 chunks) and fired another 48 lookups on
// top; chunks were being dropped. A 500 the user can see beats a total that quietly lies. Concurrency is
// capped for the same reason - the fan-out, not the query, was what broke.
async function chunkedIn(table, select, col, ids, extra, concurrency = 6) {
    const parts = chunk(ids, 300);
    const out = [];
    for (let i = 0; i < parts.length; i += concurrency) {
        const res = await Promise.all(parts.slice(i, i + concurrency).map(part => {
            let q = supabase.from(table).select(select).in(col, part);
            if (extra) q = extra(q);
            return q;
        }));
        res.forEach(r => {
            if (r.error) throw new Error(table + ' lookup failed: ' + r.error.message);
            out.push(...(r.data || []));
        });
    }
    return out;
}
// When each order was FIRST seen undelivered — the boundary between "worked pre-dispatch" (Call Queue /
// hold) and "worked as an undelivered parcel". Used to scope notes to the panel they were written in.
async function undeliveredSince(orderIds) {
    if (!orderIds.length) return {};
    const rows = await chunkedIn('undelivered_tracking', 'order_id, first_seen_at', 'order_id', orderIds);
    const m = {};
    rows.forEach(r => { m[String(r.order_id)] = r.first_seen_at; });
    return m;
}

// Latest note + count + author per order for a list of order_ids.
// `keep(note)` optionally scopes which notes count — see the note-context filter in /support/queue.
async function notesByOrder(orderIds, keep) {
    if (!orderIds.length) return {};
    let rows = await chunkedIn('order_notes', 'order_id, content, created_at, agent_id', 'order_id', orderIds);
    if (typeof keep === 'function') rows = rows.filter(keep);
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
    // FALLBACK ONLY — used when the journey has no recorded scan (see overlayJourneyScans).
    // ⚠️ Ordered by TRUSTWORTHINESS, not recency. `status_updated_at` is a real courier status change;
    // `last_tracked_at` / `updated_at` are OUR write times, so a sync that touched the row an hour ago
    // makes them look like fresh activity. Taking the newest of the three was exactly that mistake —
    // it reported "10h ago" (the last sync) on a parcel whose real last scan was four days earlier.
    const best = r => r.status_updated_at || r.last_tracked_at || r.updated_at || null;
    const map = {};
    rows.forEach(r => { const t = best(r); if (!t) return; if (!map[r.order_id] || new Date(t) > new Date(map[r.order_id])) map[r.order_id] = t; });
    return map;
}
// Overlay the journey's REAL newest scan on top of the order_tracking estimate.
// `order_tracking` is written by the nightly syncs, but the journey is updated in real time by the
// courier webhooks — so between runs the tracking row is hours stale. TE25-41004 had an Out-for-delivery
// scan at 11 Aug 09:17 IST while the queue showed "10h ago", which was simply the last time the sync had
// run. `last_scan_at` is the newest timestamp in the actual scan log, so it beats both.
async function overlayJourneyScans(rows, scans) {
    const awbs = [...new Set(rows.map(r => String(r.awb_number || '').trim()).filter(Boolean))];
    if (!awbs.length) return scans;
    const jr = await chunkedIn('shipment_journey_ecom', 'awb, last_scan_at', 'awb', awbs);
    const byAwb = {}; jr.forEach(j => { if (j.last_scan_at) byAwb[j.awb] = j.last_scan_at; });
    // ⚠️ AUTHORITATIVE — NOT "whichever is newer". `last_scan_at` is the newest entry in the actual scan
    // log; everything else is an estimate. Taking the later of the two looked safe but is precisely
    // wrong for a STALLED parcel: TE25-40300's last real scan was 07 Aug 18:23, while its tracking row
    // had been rewritten by a sync 10 hours ago — so max chose the sync and reported activity that never
    // happened. A shipment sitting still must LOOK like it is sitting still; that is the whole signal.
    rows.forEach(r => {
        const t = byAwb[String(r.awb_number || '').trim()];
        if (t) scans[r.order_id] = t;
    });
    return scans;
}
// Courier PLATFORM (the aggregator the parcel shipped through) per order — RapidShyp / DocPharma / KwikShip.
// `order_buckets.partner` looks like the obvious source but is NOT trustworthy for this: KwikShip shipments
// land there as the courier SERVICE name ('delhiverydirectsurface500g' — 532 rows), some RapidShyp rows as
// 'delhivery enterprise' / 'ekart brands', and 128 recent rows are null while the shipment clearly exists.
// The authoritative signal is `shipment_journey_ecom.source` — written by whichever sync owns the shipment.
// partner / courier / AWB prefix are fallbacks only, for orders with no journey row yet.
const PLATFORM_KEYS = new Set(['rapidshyp', 'docpharma', 'kwikship']);
const _pk = n => String(n || '').replace('#', '').trim();
// Customer name per order. `order_buckets` carries phone and email but no name, so the queue could only
// ever be searched by number — and agents look people up by name as often as by phone.
// Junk placeholders are dropped rather than shown: EasyEcom writes a literal "DUMMY" customer_name on
// some rows, and a queue full of "Dummy" is worse than a blank.
const JUNK_NAME = /^(dummy|test|testing|n\.?\/?a|na|none|guest|customer|xxx+|\.+|-+)$/i;
async function namesByOrder(orderIds) {
    if (!orderIds.length) return {};
    const rows = await chunkedIn('order_shipping_addresses', 'order_id, name, first_name, last_name', 'order_id', orderIds);
    const map = {};
    rows.forEach(a => {
        const n = String(a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || '').trim();
        if (n && !JUNK_NAME.test(n)) map[String(a.order_id)] = n;
    });
    return map;
}

// ── "Raised to courier" ──────────────────────────────────────────────────────────────────────────
// The team was recording this in free-text notes ("raised", "raised with VOC"), so it could not be
// filtered, sorted or counted, and the date it happened was only whatever the note timestamp said.
// Stored as an `order_marks_ecom` mark: one per order (the table is unique on order_name+mark_type),
// `note` holds WHICH kind, `created_at` is the raised date. Re-raising with the other kind updates in
// place rather than stacking marks — an order is either raised or not, not raised twice.
const RAISE_KINDS = { raised: 'Raised', raised_voc: 'Raised with VOC' };
async function raisedByOrder(names) {
    const uniq = [...new Set((names || []).map(n => String(n || '').replace('#', '').trim()).filter(Boolean))];
    if (!uniq.length) return {};
    const rows = await chunkedIn('order_marks_ecom', 'order_name, note, created_by, created_at', 'order_name', uniq,
        q => q.eq('mark_type', 'courier_raised'));
    const map = {};
    rows.forEach(m => { map[String(m.order_name).replace('#', '').trim()] = { kind: m.note || 'raised', at: m.created_at, by: m.created_by || null }; });
    return map;
}

// Shipments that have REACHED A TERMINAL OUTCOME per the courier journey — delivered / RTO / lost.
// The `order_buckets` view decides "undelivered" from `rapidshyp_tracking_ecom.raw_status` and
// `order_tracking.tracking_status`; both are periodic snapshots, so when a parcel moves on to RTO or is
// finally delivered, the bucket keeps saying "undelivered" until the next sync writes the new text.
// `shipment_journey_ecom.outcome` is the courier-derived truth and updates in real time from the
// webhooks — 21 RTO and 9 delivered orders were sitting on the Undelivered call list because of that lag.
// ⚠️ `in_transit` is deliberately NOT terminal: a parcel reattempting after a failed delivery reads
// in_transit while its NDR is still open and genuinely does need the call.
const TERMINAL_OUTCOMES = new Set(['delivered', 'rto', 'lost']);
async function terminalByAwb(rows) {
    const awbs = [...new Set(rows.map(r => String(r.awb_number || '').trim()).filter(Boolean))];
    const names = [...new Set(rows.map(r => String(r.order_name || '').replace('#', '').trim()).filter(Boolean))];
    // A MAP, not a Set: the Status-changed tab needs the OUTCOME itself, not just "is it finished".
    // `.has()` / `.size` behave identically, so the Undelivered caller is unaffected.
    const done = new Map();
    if (awbs.length) {
        const jr = await chunkedIn('shipment_journey_ecom', 'awb, outcome', 'awb', awbs);
        jr.filter(j => TERMINAL_OUTCOMES.has(String(j.outcome || ''))).forEach(j => done.set(j.awb, String(j.outcome)));
    }
    // ⚠️ DOCPHARMA ORDERS OFTEN HAVE NO JOURNEY ROW AT ALL, so the check above cannot see them — the
    // partner portal showed TE25-37876 delivered on 27 Jul while the panel still listed it as
    // "partially-delivered". `docpharma_orders` is DocPharma's own status, synced from their portal, and
    // is authoritative for their shipments. 6 of 168 undelivered rows had no journey row and every one
    // of them was already delivered per this table.
    if (names.length) {
        const dp = await chunkedIn('docpharma_orders', 'partner_order_id, order_status, awb', 'partner_order_id', names);
        const finished = /^(delivered|rto|returned|return|cancelled|canceled|lost)/i;
        const byName = {};
        rows.forEach(r => { byName[String(r.order_name || '').replace('#', '').trim()] = String(r.awb_number || '').trim(); });
        dp.filter(d => finished.test(String(d.order_status || '')))
            .forEach(d => { const awb = byName[d.partner_order_id] || d.awb;
                if (awb) done.set(awb, /^rto|^return/i.test(String(d.order_status)) ? 'rto' : /^deliver/i.test(String(d.order_status)) ? 'delivered' : 'lost'); });
    }
    return done;
}

// Put a batch of orders on the "was undelivered" record. Never deletes, only ever adds/refreshes
// last_seen_at — `first_seen_at` keeps its original value on conflict (that is the note-scoping boundary).
async function rememberUndelivered(rows) {
    const ids = [...new Set((rows || []).map(r => String(r.order_id || '')).filter(Boolean))];
    if (!ids.length) return 0;
    const now = new Date().toISOString();
    for (const part of chunk(ids.map(id => ({ order_id: id, last_seen_at: now })), 500)) {
        await supabase.from('undelivered_tracking').upsert(part, { onConflict: 'order_id' }).then(() => {}).catch(() => {});
    }
    return ids.length;
}

// WHAT COUNTS AS "UNDELIVERED" — the parcel was not in the customer's hands when it should have been.
// Two ways that happens, and BOTH count (settled with the user on TE25-39935, 2026-08-18):
//   (a) the courier logged a FAILED DELIVERY ATTEMPT — `ndr_count > 0`;
//   (b) the parcel went PAST ITS PROMISED DATE (`first_edd`) still undelivered — no failed attempt
//       needed. TE25-39935 was promised 09 Aug, sat in a Moradabad facility for a week, and delivered
//       on 18 Aug on its first and only attempt. `ndr_count` is 0 and always will be, so rule (a) alone
//       can never see it — yet it is exactly the parcel support spends its day chasing.
// An RTO or a lost parcel is undelivered by definition, whatever its dates say.
// Returns [momentISO] — when the parcel BECAME undelivered work, or [null] if it never did. That moment
// is the earlier of the first delivery attempt and the missed promise date; it is stored as
// `first_seen_at` and scopes which panel a note belongs to (see undeliveredSince).
function undeliveredMoment(j) {
    const outcome = String(j.outcome || '').toLowerCase();
    const firstOfd = Array.isArray(j.ofd_dates) && j.ofd_dates.length ? j.ofd_dates[0] : null;
    const edd = j.first_edd ? new Date(j.first_edd) : null;
    // The promise is a DATE, so it is only broken once that whole day is gone.
    const eddEnd = edd ? new Date(edd.getFullYear(), edd.getMonth(), edd.getDate(), 23, 59, 59) : null;
    const delivered = j.delivered_at ? new Date(j.delivered_at) : null;
    const overdue = !!eddEnd && (outcome === 'rto' || outcome === 'lost'
        || (delivered ? delivered > eddEnd : Date.now() > eddEnd.getTime()));
    if (!(Number(j.ndr_count || 0) > 0) && !overdue) return [null];
    const candidates = [firstOfd, overdue ? eddEnd.toISOString() : null].filter(Boolean)
        .sort((a, b) => new Date(a) - new Date(b));
    return [candidates[0] || j.order_date || null];
}

// ── Self-healing: "was undelivered" is a courier fact, not a record of who had a tab open ─────────
// `undelivered_tracking` was written ONLY as a side effect of somebody loading the Undelivered tab, so a
// parcel that failed a delivery attempt and then settled (delivered or RTO) between two visits was never
// recorded — and therefore could never appear on Status changed. Measured 2026-08-18: 447 orders with a
// real NDR (218 RTO + 229 delivered) had no row at all, plus 7 sitting in the undelivered bucket right
// now with a terminal journey, about to disappear the same way.
//
// The courier journey already knows: `ndr_count > 0` means the parcel failed at least one delivery
// attempt, whether or not anyone was watching. This backfills the missing rows from it — pure DB work,
// ZERO courier calls, ~1,500 journeys per 30 days — so it is cheap enough to run on every load of the tab.
// `first_seen_at` is set to the FIRST out-for-delivery scan, i.e. when the parcel actually became
// undelivered work. That is the boundary that decides which panel a note belongs to (see
// undeliveredSince), so a courier timestamp is strictly better than "when a human first refreshed".
// DocPharma shipments have no journey row and are still covered the old way, by rememberUndelivered().
// The Call Queue auto-refreshes every 30s and this derivation is pure catch-up work, so repeating it on
// every poll is waste, not freshness: an order that qualifies now still qualifies in a minute. Orders
// ALREADY tracked stay real-time regardless - their settled verdict comes from the journey at read time.
const _undSyncAt = new Map();   // `${from}|${to}` -> ms
const UND_SYNC_TTL_MS = 60000;
async function syncUndeliveredFromJourney(fromISO, toISO) {
    const key = fromISO + '|' + toISO;
    const last = _undSyncAt.get(key) || 0;
    if (Date.now() - last < UND_SYNC_TTL_MS) return 0;
    _undSyncAt.set(key, Date.now());
    const journeys = await fetchPaged((f, t) => supabase.from('shipment_journey_ecom')
        .select('awb, order_name, outcome, ndr_count, ofd_dates, first_edd, delivered_at, order_date')
        .gte('order_date', fromISO).lte('order_date', toISO)
        .order('order_date', { ascending: true }).order('awb', { ascending: true })
        .range(f, t));
    if (!journeys.length) return 0;
    // Earliest undelivered moment per order — an order re-shipped on a second AWB has two journey rows.
    const seenAt = {};
    journeys.forEach(j => {
        const key = String(j.order_name || '').replace('#', '').trim();
        if (!key) return;
        const [at] = undeliveredMoment(j);
        if (!at) return;
        if (!seenAt[key] || new Date(at) < new Date(seenAt[key])) seenAt[key] = at;
    });
    const names = Object.keys(seenAt);
    if (!names.length) return 0;
    // `shipment_journey_ecom.order_name` carries no '#'; `orders.name` does — look up both spellings.
    const ordRows = await chunkedIn('orders', 'id, name', 'name', names.flatMap(n => [n, '#' + n]));
    const idByName = {};
    ordRows.forEach(o => { idByName[String(o.name || '').replace('#', '').trim()] = String(o.id); });
    const known = names.filter(n => idByName[n]);
    if (!known.length) return 0;
    const have = new Set((await chunkedIn('undelivered_tracking', 'order_id', 'order_id', known.map(n => idByName[n])))
        .map(r => String(r.order_id)));
    const missing = known.filter(n => !have.has(idByName[n]))
        .map(n => ({ order_id: idByName[n], first_seen_at: new Date(seenAt[n]).toISOString(), last_seen_at: new Date(seenAt[n]).toISOString() }));
    if (!missing.length) return 0;
    for (const part of chunk(missing, 500)) {
        await supabase.from('undelivered_tracking').upsert(part, { onConflict: 'order_id' }).then(() => {}).catch(() => {});
    }
    return missing.length;
}

async function platformByOrder(rows) {
    const names = [...new Set(rows.map(r => _pk(r.order_name)).filter(Boolean))];
    const jr = names.length ? await chunkedIn('shipment_journey_ecom', 'order_name, source', 'order_name', names) : [];
    const bySrc = {};
    jr.forEach(j => { const k = _pk(j.order_name); if (k && j.source) bySrc[k] = String(j.source).toLowerCase(); });
    const map = {};
    rows.forEach(r => {
        const partner = String(r.partner || '').toLowerCase();
        const courier = String(r.courier || '').toLowerCase();
        map[r.order_id] = bySrc[_pk(r.order_name)]
            || (PLATFORM_KEYS.has(partner) ? partner : null)
            || ((courier.includes('docpharma') || /^EL/i.test(String(r.awb_number || ''))) ? 'docpharma' : null);
    });
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
    // Paginated — the old .limit(2000) silently capped at 1000 (server max), dropping the NEWEST rows
    // (ascending sort) once a window exceeded 1000 pre-dispatch orders.
    let cand = await fetchPaged((f, t) => supabase.from('order_buckets').select(SEL)
        .eq('bucket', 'order_to_dispatch')                               // (2) still pre-pickup / holdable
        .gte('created_at', fromISO).lte('created_at', toISO)
        .order('msg91_confirmed', { ascending: false }).order('created_at', { ascending: true })
        .order('order_id', { ascending: true })   // unique tiebreak — stable pages on tied timestamps
        .range(f, t));
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
    // (1) Drop FULLY-prepaid; keep COD + PARTIALLY-PAID (partial-paid still carries a COD balance, so it's held
    // on the high-value ≥₹1500 rule — the history/short-address reasons stay COD-only, gated by isPartialPaid below).
    const finRows = cand.length ? await chunkedIn('orders', 'id, financial_status', 'id', cand.map(c => c.order_id)) : [];
    const finById = {}; finRows.forEach(o => { finById[String(o.id)] = (o.financial_status || '').toLowerCase(); });
    const _fullyPrepaid = new Set(['paid', 'refunded', 'partially_refunded']);
    cand = cand.filter(c => !_fullyPrepaid.has(finById[String(c.order_id)] || ''));
    // Backfill a missing phone from the SHIPPING ADDRESS. The `order_buckets` view's `phone` is null for some
    // orders (it takes the order/customer phone, but COD orders often carry the number ONLY in the shipping
    // address) — which made them show "no phone" in the Call Queue AND blocked the phone-based reason recompute
    // (in-flight / recent-non-delivery), so a correctly-held order looked reasonless. Fill it before (4)/(5).
    const _noPhoneIds = cand.filter(c => !c.phone).map(c => c.order_id);
    if (_noPhoneIds.length) {
        const shipRows = await chunkedIn('order_shipping_addresses', 'order_id, phone', 'order_id', _noPhoneIds);
        const shipPhoneBy = {}; shipRows.forEach(s => { if (s.phone && !shipPhoneBy[String(s.order_id)]) shipPhoneBy[String(s.order_id)] = s.phone; });
        cand.forEach(c => { if (!c.phone && shipPhoneBy[String(c.order_id)]) c.phone = shipPhoneBy[String(c.order_id)]; });
    }
    // (4)/(5) The reasons. IDENTITY = phone ∪ email with transitive closure (repeat_rules.js) — a
    // customer who changed phone number but kept the email (TE25-45095) is still the same customer.
    // One batch of history fetches for every candidate's phones AND emails, expanding through the
    // contacts found on the way; then each candidate's identity is closed over that pool.
    const seedPhones = [...new Set(cand.map(c => c.phone).filter(Boolean))];
    const seedEmails = [...new Set(cand.map(c => c.email).filter(Boolean))];
    const hist = (seedPhones.length || seedEmails.length) ? await RR.fetchHistory(supabase, { phones: seedPhones, emails: seedEmails }) : [];
    // EasyEcom-cancelled prior orders read as active in order_buckets (Shopify lag) — treat them as cancelled
    // so a customer whose only "non-delivered" prior order was actually cancelled isn't flagged repeat-risk.
    const histCancelled = await eeCancelledSet(hist.map(h => h.order_name));
    const isCancelled = h => h.bucket === 'cancelled' || histCancelled.has(RR.orderKey(h.order_name));
    // COMPLETE-history high-value deliveries for the pool (delivered + ≥₹1500 only, so the set is tiny).
    const hvRows = hist.length ? await RR.chunkedIn(supabase, 'order_buckets', 'order_id, phone, email, created_at', 'phone',
        [...new Set(hist.map(h => RR.phoneKey(h.phone)).filter(Boolean))].flatMap(RR.phoneVariants),
        q => q.eq('bucket', 'delivered').gte('total_price', HIGH_VALUE_MIN)) : [];
    const hvByEmail = hist.length ? await RR.chunkedIn(supabase, 'order_buckets', 'order_id, phone, email, created_at', 'email',
        [...new Set(hist.map(h => RR.emailKey(h.email)).filter(Boolean))].flatMap(RR.emailVariants),
        q => q.eq('bucket', 'delivered').gte('total_price', HIGH_VALUE_MIN)) : [];
    const hvAll = [...hvRows, ...hvByEmail];
    // Addresses: the candidates' own + every DELIVERED order in the pool (for the short-address trust exception).
    const candAddrRows = cand.length ? await chunkedIn('order_shipping_addresses', 'order_id, address1, address2, city, province, zip', 'order_id', cand.map(c => c.order_id)) : [];
    const deliveredHistIds = hist.filter(h => h.bucket === 'delivered').map(h => h.order_id);
    const histAddrRows = deliveredHistIds.length ? await chunkedIn('order_shipping_addresses', 'order_id, address1, address2, city, province, zip', 'order_id', deliveredHistIds) : [];
    const candAddrById = {}; candAddrRows.forEach(a => { candAddrById[String(a.order_id)] = RR.fullAddr(a); });
    const histAddrNormById = {}; histAddrRows.forEach(a => { histAddrNormById[String(a.order_id)] = RR.normAddr(RR.fullAddr(a)); });
    return cand.filter(c => {
        const ident = RR.closeIdentity({ phone: c.phone, email: c.email }, hist);
        const all = ident.orders;
        c.orders_count = all.length;
        c.identity = { phones: [...ident.phones], emails: [...ident.emails], overflow: ident.overflow };
        const inIdent = r => (RR.phoneKey(r.phone) && ident.phones.has(RR.phoneKey(r.phone))) || (RR.emailKey(r.email) && ident.emails.has(RR.emailKey(r.email)));
        const deliveredHighValue = hvAll.some(h => inIdent(h) && new Date(h.created_at) < new Date(c.created_at));
        const deliveredAddrNorms = new Set(all.filter(h => h.bucket === 'delivered').map(h => histAddrNormById[String(h.order_id)]).filter(Boolean));
        const reasons = RR.evaluateReasons({
            cand: { order_id: c.order_id, created_at: c.created_at, total_price: c.total_price, financial_status: finById[String(c.order_id)] || '', address: candAddrById[String(c.order_id)] || '' },
            history: all, deliveredHighValue, deliveredAddrNorms, isCancelled,
        });
        c.reasons = reasons;
        // Dashboard (anyReason): return the whole tagged base — /support/queue filters it. Auto-hold cron:
        // qualify by ANY of the 4 reasons (so high-value / in-flight orders auto-hold too, matching the panel).
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
// Cancel a held order on Shopify (restock, no customer email) + refund any online-captured amount
// (COD fee/advance) + release the hold + log the reason & who. DESTRUCTIVE — cancels the real customer
// order. Gated by the dedicated `support-cancel-order` capability (admins pass via '*').
// ── POST /support/raise — mark an order raised with the courier (or clear it) ────────────────────
// { orderName, kind: 'raised' | 'raised_voc' | null }. Anyone who can work the queue can record this;
// it is a note about our own action, not a change to the order.
router.post('/support/raise', async (req, res) => {
    try {
        const name = String((req.body && req.body.orderName) || '').replace('#', '').trim();
        const kind = (req.body && req.body.kind) || null;
        if (!name) return res.status(400).json({ success: false, error: 'orderName is required.' });
        if (kind && !RAISE_KINDS[kind]) return res.status(400).json({ success: false, error: 'kind must be raised or raised_voc.' });
        if (!kind) {   // clear — raised by mistake
            await supabase.from('order_marks_ecom').delete().eq('order_name', name).eq('mark_type', 'courier_raised');
            return res.json({ success: true, raised: null });
        }
        const now = new Date().toISOString();
        // ⚠️ created_at is the RAISED DATE and is deliberately rewritten when the kind changes: switching
        // "Raised" → "Raised with VOC" is a fresh escalation, and the column must show when that happened.
        const { error } = await supabase.from('order_marks_ecom').upsert({
            order_name: name, mark_type: 'courier_raised', note: kind,
            created_by: (req.user && req.user.sub) || null, created_at: now, updated_at: now,
        }, { onConflict: 'order_name,mark_type' });
        if (error) throw new Error(error.message);
        res.json({ success: true, raised: { kind, at: now, by: (req.user && req.user.sub) || null } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/support/cancel-order', requirePermission('support-cancel-order'), async (req, res) => {
    try {
        const { orderId, orderName, reason } = req.body || {};
        if (!orderId || !orderName) return res.status(400).json({ success: false, error: 'orderId and orderName are required.' });
        const out = await shopifyHold.cancelOrder(orderName, orderId, (req.user && req.user.sub) || 'agent', reason);
        if (!out.ok) return res.status(502).json({ success: false, error: out.error || 'Cancel failed.' });
        res.json({ success: true, status: 'cancelled', refunded: out.refunded || 0 });
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
            // Paginated — .limit(2000) silently capped at 1000 (server max), dropping the newest rows.
            rows = await fetchPaged((f, t) => supabase.from('order_buckets').select(SEL)
                .in('bucket', UNDELIVERED_BUCKETS).gte('created_at', fromISO).lte('created_at', toISO)
                .order('msg91_confirmed', { ascending: false }).order('created_at', { ascending: true })
                .order('order_id', { ascending: true })
                .range(f, t));
            // ⚠️ REMEMBER FIRST, FILTER SECOND. Every order this query saw undelivered goes on record
            // BEFORE the terminal filter below removes any of them — a parcel that has just been delivered
            // or returned is exactly the one the Status-changed tab exists to show. This upsert used to sit
            // AFTER `rows` had already been reassigned by the filter, so the settled orders were the only
            // ones never recorded, and they vanished from both tabs at once.
            await rememberUndelivered(rows);
            // Drop anything the courier has already finished with — a delivered or returned parcel is not
            // a call to make.
            const done = await terminalByAwb(rows);
            if (done.size) rows = rows.filter(r => !done.has(String(r.awb_number || '').trim()));
        } else if (tab === 'rejected') {
            // ⚠ COD REJECTIONS COME FROM THE CUSTOMER, NOT THE COURIER. The MSG91 WhatsApp webhook writes
            // a CANCEL row when the customer taps REJECT on the confirmation template. By explicit
            // instruction this tab takes NO automatic action — no hold, no Shopify cancel — it exists so
            // the team SEES every rejection and decides. A tapped button means the customer told us, in
            // writing, that they do not want the parcel; shipping it anyway is a guaranteed RTO.
            const cancels = await fetchPaged((f, t) => supabase.from('cod_confirmations_msg91')
                .select('id_key, data, updated_at')
                .eq('data->>Confirmation received', 'CANCEL')
                .order('updated_at', { ascending: false })
                .range(f, t));
            const inWindow = cancels.filter(r => {
                const at = (r.data && (r.data['Received At'] || r.updated_at)) || r.updated_at;
                return at >= fromISO && at <= toISO;
            });
            // Resolve rejections to real orders for the queue columns. A rejection the webhook could not
            // pin to an order (id_key "PHONE:…") still gets a stub row — an invisible rejection is how a
            // told-you-so parcel ships anyway.
            const names = [...new Set(inWindow.map(r => String((r.data && r.data['Order Number']) || '').trim()).filter(Boolean))];
            const byName = new Map();
            (await chunkedIn('order_buckets', SEL, 'order_name', names)).forEach(o => byName.set(o.order_name, o));
            rows = inWindow.map(r => {
                const d = r.data || {};
                const name = String(d['Order Number'] || '').trim();
                const o = byName.get(name);
                return Object.assign({
                    order_id: name || r.id_key, order_name: name || null,
                    phone: d['Shipping Phone Number'] || null, email: null,
                    total_price: null, created_at: d['Received At'] || r.updated_at,
                    fulfillment_status: null, tracking_status: null, partner: null, courier: null,
                    awb_number: null, bucket: null, msg91_confirmed: false, is_repeat_customer: null,
                    dispatch_at: null, edd: null,
                }, o || {}, {
                    rejected_at: d['Received At'] || r.updated_at,
                    reject_reply: d['Raw Reply'] || null,
                    reject_customer: d['Customer Name'] || null,
                });
            });
        } else if (tab === 'changed') {
            // Put on record everything the COURIER says went undelivered in this window, so the tab does
            // not depend on who happened to have the Undelivered tab open — see syncUndeliveredFromJourney().
            await syncUndeliveredFromJourney(fromISO, toISO);
            // Paginated — .limit(3000) silently capped at 1000 (server max). The old 3000-row ceiling here
            // was itself a silent cap: ordered by last_seen_at DESC, it dropped the oldest-seen orders once
            // the table passed 3,000 rows (3,982 today), so old orders fell off the tab for good.
            // `first_seen_at` is never earlier than the order date (it is a delivery attempt, a missed
            // promise date, or the order date itself), so anything first seen BEFORE the window opened
            // cannot be an in-window order - a safe pre-filter that cut the candidate set from ~7,000 to
            // the low hundreds and the tab from 17.6s to about a second. No upper bound: an order placed
            // inside the window may only have gone undelivered after it closed, and it still belongs here.
            const tracked = await fetchPaged((f, t) => supabase.from('undelivered_tracking').select('order_id')
                .gte('first_seen_at', fromISO)
                .order('last_seen_at', { ascending: false }).order('order_id', { ascending: true }).range(f, t));
            const ids = tracked.map(t => t.order_id);
            const all = ids.length ? await chunkedIn('order_buckets', SEL, 'order_id', ids) : [];
            // ⚠️ APPLY THE DATE RANGE. This tab ignored the picker entirely — it listed every order ever
            // seen undelivered, so the range control above it did nothing and the list only grew. The
            // window is filtered here rather than in the query because the candidate ids come from
            // `undelivered_tracking`, which has no order date of its own.
            const fromMs = new Date(fromISO).getTime(), toMs = new Date(toISO).getTime();
            // THE RULE (set by the user 2026-08-18): "if an order is undelivered → delivered or RTO, it
            // should go on Status changed". So the tab lists SETTLED outcomes only, not merely "no longer
            // undelivered". Aug MTD this drops 72 orders that were cancelled after going undelivered and
            // 10 that are moving again (8 five_days_plus, 2 order_to_dispatch) — the latter are still in
            // flight, so they belong on no closed list. Was `!UNDELIVERED_BUCKETS.includes(bucket)`.
            //
            // ⚠️ SETTLED IS DECIDED BY THE JOURNEY, NOT THE BUCKET — the two tabs must hand over in the
            // SAME instant. Undelivered drops a parcel the moment `shipment_journey_ecom.outcome` turns
            // terminal (webhook, seconds), but `order_buckets.bucket` only follows once the periodic
            // `order_tracking` / `rapidshyp_tracking_ecom` snapshot is rewritten. Reading the bucket here
            // left a window where an order was on NEITHER tab — measured 2026-08-19: 3 orders, one of them
            // a RapidShyp RTO invisible since 11 Aug. Same source for both tabs = no window at all.
            // Window FIRST, courier lookups second. Resolving outcomes for every order ever seen
            // undelivered (~7,000) and then throwing 85% away is what blew the fan-out up.
            const inWindow = all.filter(r => { const t = new Date(r.created_at).getTime(); return t >= fromMs && t <= toMs; });
            const settled = await terminalByAwb(inWindow);
            // Only fills a bucket that has NOT yet resolved — never overrides `cancelled`, which is a
            // decision we made about the order, not a lagging courier snapshot. (Overriding it too pulled
            // 607 cancelled orders onto the tab, against the delivered-or-RTO rule.)
            const PENDING_BUCKET = b => !['delivered', 'rto', 'cancelled'].includes(b);
            inWindow.forEach(r => {                  // show the courier's verdict, not the stale snapshot
                const o = settled.get(String(r.awb_number || '').trim());
                if (o && PENDING_BUCKET(r.bucket) && SETTLED_BUCKETS.includes(o)) r.bucket = o;
            });
            rows = inWindow.filter(r => SETTLED_BUCKETS.includes(r.bucket))
                .sort((a, b) => (b.msg91_confirmed === true) - (a.msg91_confirmed === true) || new Date(a.created_at) - new Date(b.created_at));
        } else { // repeat — reason-tagged COD/pre-pickup base (see findRepeatCandidates); shown/filtered below.
            rows = await findRepeatCandidates({ fromISO, toISO, skipDispatchFilter: true, anyReason: true });
            rows = rows.filter(r => !r._moved);   // orders the courier already took are gone — drop before enriching
        }

        // NOTE CONTEXT — a note belongs to the panel it was written in, not to every panel that later
        // shows the order. A "confirmed" note added on the Call Queue while the order was still
        // pre-dispatch was surfacing on the Undelivered panel days later, where it reads as a statement
        // about the delivery. (Real case: TE25-37934 — note 27 Jul 08:35, first seen undelivered 30 Jul
        // 06:42.) The boundary is `undelivered_tracking.first_seen_at`:
        //   • Undelivered / Status-changed panels → only notes written AT OR AFTER that moment
        //   • Call Queue (repeat, pre-dispatch)   → only notes written BEFORE it
        // Derived from timestamps we already store, so it scopes the 2,000+ historical notes correctly
        // too — no column to backfill and no note is ever deleted, only shown in the right place.
        const orderIds = rows.map(r => r.order_id);
        const undSince = await undeliveredSince(orderIds);
        const isUndPanel = (tab === 'und' || tab === 'changed');
        const keepNote = n => {
            const since = undSince[String(n.order_id)];
            if (!since) return !isUndPanel;   // never tracked undelivered → it can only be pre-dispatch work
            return isUndPanel
                ? new Date(n.created_at) >= new Date(since)
                : new Date(n.created_at) < new Date(since);
        };
        const [notes, scansRaw, names] = await Promise.all([
            notesByOrder(orderIds, keepNote),
            // The Last-scan column renders on the Undelivered tab ONLY (a settled parcel's last scan IS
            // its outcome, and a pre-dispatch order has none), so paying for it elsewhere buys nothing.
            // Two table sweeps saved. It is NOT the tab's bottleneck (measured: no change) - the
            // `order_buckets` VIEW is, at ~1.1s per 300 rows. Kept because the work buys nothing.
            tab === 'und' ? scanTimesByOrder(orderIds) : Promise.resolve({}),
            namesByOrder(orderIds),
        ]);
        rows.forEach(r => { r.customer_name = names[String(r.order_id)] || null; });
        // Real-time courier scans beat the nightly tracking snapshot — see overlayJourneyScans().
        const scans = tab === 'und' ? await overlayJourneyScans(rows, scansRaw) : {};
        rows.forEach(r => { const n = notes[r.order_id]; r.note_count = n ? n.count : 0; r.latest_note = n ? n.latest : null; r.latest_note_by = n ? n.latest_by : null; r.latest_note_at = n ? n.latest_at : null; r.last_scan_at = scans[r.order_id] || null; });
        // Courier platform — only for the shipped panels. Repeat-tab orders are still pre-dispatch (no AWB,
        // no journey row), so the lookup would cost a query and return nothing but nulls.
        if (isUndPanel && rows.length) {
            const normNames = [...new Set(rows.map(r => String(r.order_name || '').replace('#', '').trim()).filter(Boolean))];
            const [plat, raised, escMarks] = await Promise.all([
                platformByOrder(rows),
                raisedByOrder(rows.map(r => r.order_name)),
                // Automated escalations — a sheet push or a critical email. Distinct from the manual
                // courier_raised mark: these carry WHEN the escalation actually left (mark timestamps),
                // which the Escalated column shows with date AND time (user, 2026-08-19).
                chunkedIn('order_marks_ecom', 'order_name, mark_type, updated_at, created_at', 'order_name', normNames,
                    q => q.in('mark_type', ['sheet_escalated', 'critical_mail_sent'])),
            ]);
            const escBy = {};
            (escMarks || []).forEach(m => {
                const k = String(m.order_name).replace('#', '').trim();
                const at = m.updated_at || m.created_at;
                const e = escBy[k] || (escBy[k] = { kinds: new Set(), at: null });
                e.kinds.add(m.mark_type === 'sheet_escalated' ? 'sheet' : 'mail');
                if (!e.at || String(at) > String(e.at)) e.at = at;   // the LATEST escalation
            });
            rows.forEach(r => {
                r.platform = plat[r.order_id] || null;
                const key = String(r.order_name || '').replace('#', '').trim();
                const rz = raised[key];
                r.raised_kind = rz ? rz.kind : null;      // 'raised' | 'raised_voc'
                r.raised_at = rz ? rz.at : null;          // sortable/filterable date
                r.raised_by = rz ? rz.by : null;
                const esc = escBy[key];
                r.escalated_kind = esc ? [...esc.kinds].sort().join('+') : null;   // 'mail' | 'sheet' | 'mail+sheet'
                r.escalated_at = esc ? esc.at : null;
            });
        }
        // Payment type (COD vs Prepaid) — `order_buckets` carries no payment column, so read
        // `orders.financial_status`. Same rule as the Orders dashboard: fully-settled = Prepaid;
        // anything else still has money to collect on delivery = COD (incl. partially_paid).
        if (rows.length) {
            const finRows = await chunkedIn('orders', 'id, financial_status', 'id', rows.map(r => r.order_id));
            const finBy = {}; finRows.forEach(o => { finBy[String(o.id)] = String(o.financial_status || '').toLowerCase(); });
            const PREPAID = new Set(['paid', 'refunded', 'partially_refunded']);
            rows.forEach(r => {
                const f = finBy[String(r.order_id)];
                r.financial_status = f || null;
                r.payment = f ? (PREPAID.has(f) ? 'Prepaid' : 'COD') : null;   // null = unknown (order row missing)
            });
        }
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
            const eeHoldIdRows = names.length ? await chunkedIn('b2c_order_easycom', 'reference_code, updated_at', 'reference_code', names, q => q.filter('raw_data->>order_status_id', 'eq', '44')) : [];
            const eeHeldById = new Map(eeHoldIdRows.map(r => [nk(r.reference_code), r.updated_at]));
            // ⚠️ Same staleness rule as /ee-hold-marks: `order_status_id` is a SYNCED copy, so it still reads
            // 44 after an unhold until the EasyEcom sync next touches the order. A human release newer than
            // that sync wins — otherwise the panel shows "held" on an order EasyEcom reports as unheld, and
            // the agent clicks Unhold over and over against an already-unheld order.
            const relRows = names.length ? await chunkedIn('order_marks_ecom', 'order_name, created_at', 'order_name', names, q => q.eq('mark_type', 'ee_hold_released')) : [];
            const releasedAt = {}; relRows.forEach(m => { releasedAt[nk(m.order_name)] = m.created_at; });
            const staleHold = (k, syncedAt) => { const rel = releasedAt[k]; if (!rel) return false;
                return !syncedAt || new Date(rel) > new Date(syncedAt); };
            // AI COD-confirmation call state (vobiz_auto_calls.js): outcome rides on each row so the
            // panel can highlight "denied on call" (red) / "not confirmed on call" (amber) — by explicit
            // instruction those take NO automatic action; only a confirmed call auto-releases the hold.
            const aiRows = names.length ? await chunkedIn('vobiz_auto_calls_ecom', 'order_name, status, detail, attempts, created_at', 'order_name', names, q => q.eq('purpose', 'cod_confirm')) : [];
            const aiBy = {}; aiRows.forEach(a => { aiBy[nk(a.order_name)] = a; });
            rows.forEach(r => {
                const k = nk(r.order_name);
                const a = aiBy[k];
                if (a) r.ai_call = { status: a.status, at: a.created_at, attempts: a.attempts || 1,
                    outcome: (a.detail && a.detail.outcome) || null,
                    note: (a.detail && (a.detail.outcome_note || a.detail.why)) || null };
                r.shopify_hold = holds[k] || null;
                const ee = eeBy[k];
                r.in_ee = !!ee;                                                   // imported into EasyEcom?
                r.easyecom_order_id = ee ? String(ee.order_id) : null;
                const syncedHeld = (eeHeldById.has(k) || /hold/i.test((ee && ee.order_status) || '')) && !staleHold(k, eeHeldById.get(k));
                r.ee_hold = eeHeld.has(k) || syncedHeld;                          // already held in EasyEcom?
            });
            // Show a candidate if it matches ≥1 call-reason (in_flight / recent_undelivered / high_value) OR the
            // team is already working it (held on EasyEcom/Shopify — incl. a failed hold — or has agent notes).
            // MOVED orders were already dropped above. Untouched, no-reason orders (e.g. a first-time low-value
            // COD customer) fall away.
            rows = rows.filter(r => (r.reasons && r.reasons.length > 0)
                || r.ee_hold
                || (r.shopify_hold && (r.shopify_hold.status === 'held' || r.shopify_hold.status === 'failed'))
                || r.note_count > 0)
                // …but once a hold has been RELEASED on Shopify and the order has moved forward (dispatched —
                // fulfilled / AWB assigned) and isn't still held in EasyEcom, the call is resolved and it's
                // shipping → drop it from the list in real-time. (Picked-up / delivered / RTO were already
                // dropped above via !_moved; this catches the AWB-assigned-but-not-yet-scanned gap.)
                .filter(r => !(r.shopify_hold && r.shopify_hold.status === 'released' && (r._dispatched || r.awb_number) && !r.ee_hold));
        }
        // ⚠️ THE RESPONSE IS CAPPED AND THE CLIENT MUST SAY SO. 1,500 rows keeps the payload and the
        // table render sane, but a silent truncation reads as "that is all of them" — Status changed
        // crossed the cap the day it started catching late parcels (1,500 shown of 1,905 over 30 days).
        // `total` lets the count line say "1,500 of 1,905 — narrow the dates" instead of lying.
        const ROW_CAP = 1500;
        res.json({ success: true, tab, total: rows.length, capped: rows.length > ROW_CAP,
            rows: rows.slice(0, ROW_CAP), lock: await lockState() });
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
        const [items, addr, tracking, calls, aiCalls, aiAttempts, notes, contactsAll, custByPhone, custByEmail] = await Promise.all([
            supabase.from('order_line_items').select('title, variant_title, sku, quantity, price').eq('order_id', oid),
            supabase.from('order_shipping_addresses').select('*').eq('order_id', oid).maybeSingle(),
            supabase.from('order_tracking').select('tracking_status, courier_name, awb_number, last_tracked_at, edd').eq('order_id', oid).order('last_tracked_at', { ascending: false }),
            supabase.from('call_logs').select('id, outcome, notes, called_at, next_followup_at, agent_id').eq('order_id', oid).order('called_at', { ascending: false }),
            // REAL AI phone calls (Vobiz bridge) — keyed by order NAME in agent_call_logs
            supabase.from('agent_call_logs').select('id, call_type, language, summary, transcript, transcript_en, exchanges, recording_url, called_at').eq('order_id', String(b.order_name || '').replace(/^#/, '')).order('called_at', { ascending: false }).limit(10),
            // AI dial-ATTEMPT history (turnstile) — an unanswered dial opens no bridge session and so
            // has no agent_call_logs row; without this the modal showed only answered calls.
            supabase.from('vobiz_auto_calls_ecom').select('status, attempts, next_attempt_at, attempt_log, detail').eq('order_name', String(b.order_name || '').replace(/^#/, '')).eq('purpose', 'cod_confirm').maybeSingle(),
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
        // Hold / unhold log — every auto/manual Shopify hold + release for THIS order (from api_logs_ecom),
        // oldest first, so the modal can render a full timeline (who, when, auto vs manual, reason).
        const onmNorm = nkn(b.order_name);
        // ⚠️ EasyEcom events belong here too. The log used to query only the three `shopify_*` actions, so an
        // order auto-held INSIDE EasyEcom (what holdOrderSmart does once the order has already imported —
        // now the common case) showed an empty timeline while the row wore an "EasyEcom hold" chip: held,
        // with nothing on record saying who or why. Two shapes have to be reconciled:
        //   • key      — shopify_* writes `payload.order` (no #), easyecom_* writes `payload.orderName` (with #)
        //   • success  — easyecom_* always returns HTTP 200; the REAL result is in the body (`response.code`
        //                / `response.message`), so `status_code < 400` would score every failure as a success.
        const { data: holdRows } = await supabase.from('api_logs_ecom')
            .select('action, status_code, payload, response, created_at')
            .in('action', ['shopify_hold', 'shopify_release', 'shopify_cancel', 'easyecom_hold_order', 'easyecom_unhold_order'])
            .order('created_at', { ascending: false }).limit(2000);
        // Exact match on the order key (never a JSON substring test — that made TE25-3810/3811/…'s events
        // bleed into TE25-381's timeline via the prefix).
        const isEE = a => a === 'easyecom_hold_order' || a === 'easyecom_unhold_order';
        const eeOk = resp => { const b = resp && typeof resp === 'object' ? resp : {};
            return b.code === 200 || /success/i.test(String(b.message || '')); };
        // A no-op ("Order already in Hold Status" / "already in Unhold status") changed nothing, so it is not
        // a timeline event. Before the re-hold fix the auto-holder produced hundreds of these per order —
        // rendering them would bury the three entries that actually matter.
        const eeNoop = resp => /already.{0,25}(in )?(un)?hold/i.test(String((resp || {}).message || ''));
        const holdLog = (holdRows || [])
            .filter(l => {
                const p = l.payload || {};
                if (nkn(isEE(l.action) ? p.orderName : p.order) !== onmNorm) return false;
                return !isEE(l.action) || !eeNoop(l.response);
            })
            .map(l => { const p = l.payload || {};
                return { action: l.action, by: p.by || (isEE(l.action) ? null : 'auto'), reason: p.reason || null,
                    ok: isEE(l.action) ? eeOk(l.response) : (l.status_code || 0) < 400,
                    result: isEE(l.action) ? ((l.response || {}).message || null) : l.response, at: l.created_at }; })
            .sort((x, y) => new Date(x.at) - new Date(y.at));
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
            ai_calls: (aiCalls.data || []),
            ai_attempts: aiAttempts.data || null,
            notes: (notes.data || []).map(n => ({ ...n, agent_name: nameById[n.agent_id] || null, mine: n.agent_id === myId })),
            escalation, customer_orders: custOrders.data || [],   // includes the current order (marked client-side)
            holdLog, isAdmin: isAdmin(req) });
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

// ── Blacklisted phone numbers (block a customer number with a reason · unblock later) ──────────────
// Any support user (the route group is already gated to support-view permissions) can block/unblock;
// the actor is recorded. Unblock is a SOFT delete (active=false + who/when) so history is preserved.
const cleanPhone = p => String(p || '').replace(/\D/g, '').slice(-10);   // normalize to 10-digit Indian mobile
router.get('/support/blacklist', async (req, res) => {
    try {
        const [act, hist] = await Promise.all([
            supabase.from('blocked_numbers_ecom').select('*').eq('active', true).order('created_at', { ascending: false }),
            supabase.from('blocked_numbers_ecom').select('*').eq('active', false).order('unblocked_at', { ascending: false }).limit(100),
        ]);
        if (act.error) throw new Error(act.error.message);
        res.json({ success: true, blocked: act.data || [], history: hist.data || [], isAdmin: isAdmin(req) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/support/blacklist', async (req, res) => {
    const b = req.body || {};
    const phone = cleanPhone(b.phone);
    if (phone.length !== 10) return res.status(400).json({ success: false, error: 'Enter a valid 10-digit phone number.' });
    const reason = String(b.reason || '').trim().slice(0, 500) || null;
    try {
        // Already actively blocked? Report it instead of erroring on the unique index.
        const { data: existing } = await supabase.from('blocked_numbers_ecom').select('id').eq('phone', phone).eq('active', true).maybeSingle();
        if (existing) return res.status(409).json({ success: false, error: 'This number is already blacklisted.' });
        const { error } = await supabase.from('blocked_numbers_ecom').insert({ phone, reason, added_by: req.user.sub, active: true });
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/support/blacklist/:id/unblock', async (req, res) => {
    try {
        const { error } = await supabase.from('blocked_numbers_ecom')
            .update({ active: false, unblocked_by: req.user.sub, unblocked_at: new Date().toISOString() })
            .eq('id', req.params.id).eq('active', true);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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
// Exported for the backfill/verification harness and any future cron — see the comment on the function.
// Translate an AI-call transcript to English on demand (dashboard button, user 2026-08-31: calls
// now open in English but switch to the customer's language — the team must be able to READ the
// regional half). Cached in agent_call_logs.transcript_en, so each call costs ONE AI pass ever.
router.post('/support/ai-call-translate/:id', async (req, res) => {
    try {
        const { data: call, error } = await supabase.from('agent_call_logs')
            .select('id, language, transcript, transcript_en').eq('id', req.params.id).maybeSingle();
        if (error || !call) return res.status(404).json({ success: false, error: 'call not found' });
        if (!call.transcript) return res.status(400).json({ success: false, error: 'no transcript on this call' });
        if (call.transcript_en) return res.json({ success: true, transcript_en: call.transcript_en, cached: true });
        // Language is the CALL's opening language — a call can open in English and end in Punjabi.
        // The transcript's own content decides: no Indic script anywhere -> nothing to translate.
        if (!/[\u0900-\u0D7F]/.test(String(call.transcript))) return res.json({ success: true, transcript_en: call.transcript, cached: true });
        const ai = require('./ai');
        const en = String(await ai.aiComplete([
            { role: 'system', content: 'Translate this Indian-language customer support phone transcript to English. Keep the exact line structure: every line starts with "agent:" or "customer:" exactly as in the input, followed by the English translation of that line. Lines in [square brackets] stay unchanged. Output ONLY the translated transcript, nothing else.' },
            { role: 'user', content: String(call.transcript).slice(0, 12000) },
        ], { temperature: 0.2, maxTokens: 2000 }) || '').trim();
        if (!en) return res.status(502).json({ success: false, error: ai.lastAiError ? (ai.lastAiError() || 'translation failed') : 'translation failed' });
        await supabase.from('agent_call_logs').update({ transcript_en: en }).eq('id', call.id);
        res.json({ success: true, transcript_en: en });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports.syncUndeliveredFromJourney = syncUndeliveredFromJourney;
