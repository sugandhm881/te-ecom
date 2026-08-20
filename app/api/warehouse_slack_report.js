const axios  = require('axios');
const config = require('../../config');
const { supabase } = require('../supabase');
const { fetchDocpharmaDetails, extractDocpharmaStatusString } = require('./helpers');
const { fetchEasyecomOrderById, autoRouteRejectedToShifupro } = require('./easyecom');

const GQL_URL   = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2025-01/graphql.json`;
const WH_CHANNEL = 'C0BA25AFJBG'; // warehouse-ops
const DP_CHANNEL = 'C0BD64XT519'; // dp-to-mwh-orders
const HOLD_CHANNEL = 'C0BBQNDH1CG'; // easyecom on-hold orders

function fmtLocal(d) {
    return `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
}

// A RapidShyp status that means the shipment has left the warehouse (picked up,
// in transit, delivered, RTO, etc.) — so it must NOT appear in the pending report,
// even if Shopify's fulfillment status is still stale at "Ready for Pickup".
const RS_MOVED = ['deliver', 'rto', 'return', 'transit', 'out for delivery', 'ofd',
                  'reached', 'pickup completed', 'picked up', 'dispatch', 'shipped'];
function rsHasMoved(rawStatus) {
    const s = (rawStatus || '').toLowerCase();
    return !!s && RS_MOVED.some(k => s.includes(k));
}

// A RapidShyp status that means the shipment is labelled and sitting in the warehouse waiting for
// the courier (not yet moved) → it's genuinely "Ready for Pickup", regardless of Shopify's status.
const RS_READY = /pickup|manifest|label|awb assign|booked|ready to ship|in[- ]?scan|order placed/i;
function rsReadyForPickup(rawStatus) {
    return !!(rawStatus || '').trim() && RS_READY.test(rawStatus);
}

// Supabase .in() chokes on thousands of values; chunk the AWB → raw_status lookup.
async function fetchRsStatusByAwbs(awbs) {
    const uniq = [...new Set(awbs.filter(Boolean))];
    const CHUNK = 200;
    const map = {};
    const slices = [];
    for (let i = 0; i < uniq.length; i += CHUNK) slices.push(uniq.slice(i, i + CHUNK));
    await Promise.all(slices.map(async slice => {
        const { data, error } = await supabase
            .from('rapidshyp_tracking_ecom')
            .select('awb, raw_status')
            .in('awb', slice);
        if (error) { console.error('[WH Report] RS lookup chunk error:', error.message); return; }
        (data || []).forEach(r => { map[r.awb] = r.raw_status; });
    }));
    return map;
}

function orderAwb(order) {
    const ti = (order.fulfillments && order.fulfillments[0] && order.fulfillments[0].trackingInfo) || [];
    return ti.length ? ti[0].number : null;
}

// Normalize an order name for matching/storage (strip leading "#", trim).
function normName(n) { return String(n || '').replace('#', '').trim(); }

// "Handed to MWH" list: orders already reported as DocPharma-rejected. Once here, an order
// is NEVER DocPharma-checked again — MWH re-ships it and it's tracked via RapidShyp instead.
const HANDLED_TABLE = 'dp_rejected_handled_ecom';

// Returns the Set of already-reported order names, or NULL if the read failed. Callers that de-dupe on
// this list MUST treat null as "can't verify" and skip posting — returning an empty Set here would
// silently disable dedup and re-spam every handled order (the cause of the duplicate reports).
async function fetchHandledNames() {
    const { data, error } = await supabase.from(HANDLED_TABLE).select('order_name');
    if (error) { console.warn(`[WH Report] handled-list read failed (table missing?): ${error.message}`); return null; }
    return new Set((data || []).map(r => normName(r.order_name)));
}

async function recordHandled(rejected) {
    if (!rejected.length) return;
    const now = new Date().toISOString();
    const rows = rejected.map(r => ({ order_name: normName(r.name), status: 'reported', updated_at: now }));
    const { error } = await supabase.from(HANDLED_TABLE).upsert(rows, { onConflict: 'order_name' });
    if (error) console.warn(`[WH Report] handled-list write failed: ${error.message}`);
    else console.log(`[WH Report] Recorded ${rows.length} order(s) as handed to MWH (won't re-report)`);
}

// ── Warehouse auto-route pass — SEPARATE from detection, runs ~9 min later (cron :56). Detection
// (cron :47) reports rejections + records them here; this pass gently moves the not-yet-routed ones
// to Shifupro (MWH). Decoupling keeps each run light (no crash-inducing burst). `routed_at` marks the
// ones finished so they're never retried; transient failures (session/error/not-synced) stay null and
// retry next hour. Only looks back 24h so it never grinds through ancient backlog.
async function autoRouteHandledRejections() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from(HANDLED_TABLE)
        .select('order_name, updated_at, routed_at').is('routed_at', null).gte('updated_at', cutoff).limit(80);
    if (error) { console.warn('[AutoRoute] fetch failed:', error.message); return { processed: 0 }; }
    const names = (data || []).map(r => r.order_name).filter(Boolean);
    if (!names.length) { console.log('[AutoRoute] nothing to route'); return { processed: 0 }; }
    const results = await autoRouteRejectedToShifupro(names);   // gentle: ~1 req/order, paced internally
    const now = new Date().toISOString();
    // Mark DONE = successfully routed, already on Shifupro, or a permanent block (shipment already assigned).
    // Leave transient ones (session-expired / error / not-synced) null so they retry next pass.
    const done = results.filter(r => ['routed', 'already-shifupro'].includes(r.result) || /shipment.*assigned|already been assigned/i.test(r.result || '')).map(r => normName(r.order));
    if (done.length) await supabase.from(HANDLED_TABLE).update({ routed_at: now }).in('order_name', done);
    const routed = results.filter(r => r.result === 'routed').length;
    console.log(`[AutoRoute] processed ${names.length} · routed ${routed} · marked-done ${done.length}`);
    return { processed: names.length, routed, done: done.length, results };
}

// Returns 'CONFIRMED' | 'READY_FOR_PICKUP' | 'UNFULFILLABLE' | null
function classifyOrder(order) {
    const fs = order.fulfillments || [];
    const ds = fs.length ? (fs[0].displayStatus || '').toUpperCase() : '';
    const orderLevel = (order.displayFulfillmentStatus || '').toUpperCase();

    if (ds === 'CONFIRMED')        return 'CONFIRMED';
    if (ds === 'READY_FOR_PICKUP') return 'READY_FOR_PICKUP';
    if (ds === 'UNFULFILLABLE')    return 'UNFULFILLABLE';
    // Order placed but no fulfillment created yet
    if (!fs.length && orderLevel === 'UNFULFILLED') return 'UNFULFILLABLE';
    return null;
}

// ─── Real-time RapidShyp tracking — the source of truth for shipment status ───
const RAPIDSHYP_TRACK_URL = 'https://api.rapidshyp.com/rapidshyp/apis/v1/track_order';

// order name → { awbByName, cancelled }. Pulls the EasyEcom AWB (the fallback key for the RapidShyp
// lookup — Shopify often has no tracking number) and the order_status in ONE query. `cancelled` is a
// set of orders EasyEcom marks Cancelled, used only to drop dead orders (not for shipment status —
// EasyEcom's order_status lags and is not trusted for movement; the couriers are the source of truth).
async function fetchEasyecomInfoByName(names) {
    const awbByName = {};
    const cancelled = new Set();
    const clean = [...new Set(names.map(normName).filter(Boolean))];
    for (let i = 0; i < clean.length; i += 200) { // chunk .in() to stay under URL limits
        const { data, error } = await supabase
            .from('b2c_order_easycom')
            .select('reference_code, awb_number, order_status')
            .in('reference_code', clean.slice(i, i + 200));
        if (error) { console.warn(`[WH Report] EasyEcom lookup failed: ${error.message}`); continue; }
        (data || []).forEach(r => {
            const n = normName(r.reference_code);
            if (r.awb_number) awbByName[n] = String(r.awb_number);
            if (/cancel/i.test(r.order_status || '')) cancelled.add(n);
        });
    }
    return { awbByName, cancelled };
}

// ── "Stuck in Ready for Pickup" ──────────────────────────────────────────────────────────────────
// How long has a labelled parcel been sitting on our shelf? The honest answer is the MANIFEST time —
// EasyEcom stamps `raw_data.manifest_date` when the parcel is manifested for the courier, and a whole
// batch shares one value, which is exactly the "handed over for pickup" moment.
//
// Two rejected alternatives, both of which would have produced confident wrong numbers:
//   · `shipment_journey_ecom.awb_assigned_at` — only ~26% populated (0% on Kwikship/DocPharma).
//   · the order's own date — a Shopify/EasyEcom order date is BEFORE labelling, so an order placed 3
//     days ago and labelled an hour ago would be reported as "stuck 3 days". Over-flagging a warehouse
//     report is how it gets ignored.
// An order with no manifest_date is simply not aged — never guessed at, never flagged.
const STUCK_HOURS = parseInt(process.env.WH_STUCK_HOURS, 10) || 48;

// EasyEcom returns "YYYY-MM-DD HH:mm:ss" with no zone, and it means IST. Parsing it as UTC (what
// `new Date(s)` does with a "T" or as local time on a UTC server) shifts every age by 5.5 hours —
// enough to flip an order across a 48-hour threshold, so the offset is explicit.
function parseIst(s) {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 5.5 * 3600 * 1000;
    return Number.isFinite(ms) ? ms : null;
}

// { normalisedOrderName: readySinceMs } for the given order names. Called with just the Ready-for-Pickup
// set (tens of orders), never the whole window — `raw_data` is a fat JSON blob and pulling it for a
// 30-day window would be a needless megabyte-scale read.
//
// Two sources, in order:
//   1. `manifest_date` — manifested for the courier. The real "waiting for pickup since".
//   2. `shipping_last_update_date` — for parcels stuck at shipping_status "Shipment Created": a label
//      exists but the parcel was never manifested. Skipping these would hide the worst cases, since
//      never-manifested IS the stuck condition (one such order had been sitting 5 days). This field is
//      "last shipping change", not "created", so a re-synced row reads younger than it is — the error
//      runs toward under-flagging, never toward crying wolf.
async function fetchReadySince(names) {
    const out = {};
    const clean = [...new Set(names.map(normName).filter(Boolean))];
    for (let i = 0; i < clean.length; i += 200) {
        const { data, error } = await supabase
            .from('b2c_order_easycom')
            .select('reference_code, raw_data->>manifest_date, raw_data->>shipping_last_update_date')
            .in('reference_code', clean.slice(i, i + 200));
        if (error) { console.warn(`[WH Report] ready-since lookup failed: ${error.message}`); return out; }
        (data || []).forEach(r => {
            const ms = parseIst(r.manifest_date) || parseIst(r.shipping_last_update_date);
            if (ms) out[normName(r.reference_code)] = ms;
        });
    }
    return out;
}

// Orders past the threshold, oldest first, each with its age in hours.
function stuckReadyOrders(ready, readySince, now = Date.now()) {
    return ready
        .map(o => ({ order: o, at: readySince[normName(o.name)] || null }))
        .filter(x => x.at && (now - x.at) >= STUCK_HOURS * 3600 * 1000)
        .map(x => ({ ...x, hours: Math.floor((now - x.at) / 3600000) }))
        .sort((a, b) => a.at - b.at);
}

const fmtAge = h => (h < 48 ? `${h}h` : `${Math.floor(h / 24)}d ${h % 24}h`);

// COURIER movement, straight from the carriers — RapidShyp + DocPharma + Kwikship all write
// `shipment_journey_ecom` (one row per AWB, tagged `source`). This is the courier-agnostic "has it
// left?" signal: the old code asked ONLY RapidShyp, so a parcel shipped on DocPharma/Kwikship (or any
// non-RapidShyp AWB) had no record → read as "not moved" → it fell through to Shopify's
// displayStatus=CONFIRMED and sat in the pending report forever.
// MOVED = a real movement EVENT: a pickup/OFD/delivery/RTO timestamp, or a terminal journey.
// Deliberately NOT "a journey row exists" — a label can be generated (row created, outcome
// 'in_transit') while the parcel is still on our shelf; those must stay in Ready-for-Pickup.
// Matched on BOTH awb and order_name, since the journey may be keyed by either.
async function fetchCourierMoved(names, awbs) {
    const moved = new Set();          // normalised order names the courier already has
    const movedAwbs = new Set();
    const SEL = 'awb, order_name, source, outcome, dispatched_at, out_for_delivery_at, delivered_at, rto_at, is_final';
    const hasMovedRow = j => !!(j.dispatched_at || j.out_for_delivery_at || j.delivered_at || j.rto_at || j.is_final);
    const take = rows => (rows || []).forEach(j => {
        if (!hasMovedRow(j)) return;
        if (j.order_name) moved.add(normName(j.order_name));
        if (j.awb) movedAwbs.add(String(j.awb));
    });
    const cleanNames = [...new Set(names.map(normName).filter(Boolean))];
    for (let i = 0; i < cleanNames.length; i += 200) {
        const { data, error } = await supabase.from('shipment_journey_ecom').select(SEL)
            .in('order_name', cleanNames.slice(i, i + 200));
        if (error) { console.warn(`[WH Report] journey lookup (by order) failed: ${error.message}`); break; }
        take(data);
    }
    const cleanAwbs = [...new Set(awbs.filter(Boolean).map(String))];
    for (let i = 0; i < cleanAwbs.length; i += 200) {
        const { data, error } = await supabase.from('shipment_journey_ecom').select(SEL)
            .in('awb', cleanAwbs.slice(i, i + 200));
        if (error) { console.warn(`[WH Report] journey lookup (by awb) failed: ${error.message}`); break; }
        take(data);
    }
    return { moved, movedAwbs };
}

// Live RapidShyp status for one AWB; refreshes the cache. Retries on transient errors/timeouts/
// rate-limits (RapidShyp throttles bursts — individual calls are fast). Returns raw_status or ''.
async function fetchRsLive(awb, tries = 3) {
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const res = await axios.post(RAPIDSHYP_TRACK_URL, { awb },
                { headers: { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' }, timeout: 25000, validateStatus: () => true });
            const data = res.data;
            // Rate-limited / transient server error → back off and retry the same AWB.
            if (res.status === 429 || res.status >= 500 || (data && data.success === false && /limit|throttl|too many/i.test(JSON.stringify(data)))) {
                if (attempt < tries) { await new Promise(r => setTimeout(r, attempt * 2000)); continue; }
                return '';
            }
            if (data && data.success && Array.isArray(data.records) && data.records.length) {
                const rec = data.records[0];
                const sd = rec.shipment_details;
                const shipment = Array.isArray(sd) && sd.length ? sd[0] : (sd && typeof sd === 'object' ? sd : rec);
                const rawStatus = shipment.current_tracking_status_desc || shipment.shipment_status || '';
                if (rawStatus) {
                    await supabase.from('rapidshyp_tracking_ecom').upsert(
                        { awb, raw_status: rawStatus, last_checked: Date.now() / 1000, updated_at: new Date().toISOString() },
                        { onConflict: 'awb' });
                    return rawStatus;
                }
            }
            return ''; // success but no tracking yet — genuinely no status
        } catch (e) {
            if (attempt < tries) { await new Promise(r => setTimeout(r, attempt * 1500)); continue; } // timeout/network → retry
        }
    }
    return '';
}

// Read RapidShyp status for a set of AWBs from the CACHE only (the background sync keeps it fresh).
// The report uses this to drop orders the cache already knows have moved — no live calls here.
// Returns { awb: raw_status }.
async function resolveRsStatuses(awbs) {
    const uniq = [...new Set(awbs.filter(Boolean))];
    const status = {};
    for (let i = 0; i < uniq.length; i += 200) {
        const { data } = await supabase
            .from('rapidshyp_tracking_ecom')
            .select('awb, raw_status')
            .in('awb', uniq.slice(i, i + 200));
        (data || []).forEach(r => { if (r.raw_status) status[r.awb] = r.raw_status; });
    }
    return status;
}

// Background sync: refresh the RapidShyp cache for recent EasyEcom-shipped orders (1 req/sec, retry).
// Runs on a cron + at startup so the report & dashboard read fresh status straight from the DB.
// Skips terminal (delivered/RTO) and fresh (<3h) cache entries to bound the work.
async function syncRsCacheEasyecom(days = 30, opts = {}) {
    const force = !!opts.force; // refresh ALL non-terminal AWBs, ignoring the 3h freshness skip
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    // Paginate — Supabase caps every response at 1000 rows; a 30-day window holds ~5k orders, so a
    // single select silently truncated to the first 1000 AWBs and the rest never got their cache refreshed.
    const orders = [];
    for (let ofs = 0; ; ofs += 1000) {
        const { data, error } = await supabase
            .from('b2c_order_easycom')
            .select('awb_number')
            .gte('order_date', since)
            .not('awb_number', 'is', null)
            .order('order_id', { ascending: true })
            .range(ofs, ofs + 999);
        if (error) { console.error('[RS-EC Sync] read error:', error.message); return; }
        orders.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    const awbs = [...new Set(orders.map(o => o.awb_number).filter(Boolean))];

    const cache = {};
    for (let i = 0; i < awbs.length; i += 200) {
        const { data } = await supabase.from('rapidshyp_tracking_ecom').select('awb, raw_status, updated_at').in('awb', awbs.slice(i, i + 200));
        (data || []).forEach(r => { cache[r.awb] = r; });
    }
    // Skip AWBs the webhook already refreshed recently — the poll only backstops a gap. Default 12h (was 3h).
    const staleBeforeMs = Date.now() - (parseInt(process.env.RS_CACHE_TTL_HOURS, 10) || 12) * 3600 * 1000;
    const isTerminal = s => /deliver|rto|return/i.test(s || '');
    const todo = awbs.filter(a => {
        const c = cache[a];
        if (!c || !c.raw_status) return true;        // never tracked
        if (isTerminal(c.raw_status)) return false;  // delivered/RTO won't change — skip even on force
        if (force) return true;                      // force: refresh every non-terminal AWB
        return !c.updated_at || new Date(c.updated_at).getTime() < staleBeforeMs; // stale
    });

    console.log(`[RS-EC Sync]${force ? ' [FORCE]' : ''} ${awbs.length} EasyEcom AWBs · refreshing ${todo.length} (1/sec)…`);
    let ok = 0;
    for (const awb of todo) {
        if (await fetchRsLive(awb)) ok++;
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`[RS-EC Sync] done — refreshed ${ok}/${todo.length} into the cache`);
}

// ── Courier platform + courier per order, for the pickup-facing sections (2026-08-20, user ask:
// the WH team chases a specific courier's van, so Ready-for-Pickup and Stuck are grouped by
// “Platform · Courier”). Source of truth: shipment_journey_ecom (source + courier), joined on the
// normalized order name — the journey never carries '#', Shopify names always do.
const PLATFORM_LABEL_WH = { rapidshyp: 'RapidShyp', kwikship: 'KwikShip', docpharma: 'DocPharma' };
function courierShort(c) {
    const t = String(c || '');
    for (const [re, label] of [[/delhivery/i, 'Delhivery'], [/ekart/i, 'Ekart'], [/amazon/i, 'Amazon'],
        [/blue\s*dart/i, 'Bluedart'], [/xpress\s*bee/i, 'Xpressbees'], [/shadowfax/i, 'Shadowfax'],
        [/ecom\s*exp/i, 'Ecom Express'], [/dtdc/i, 'DTDC'], [/speed\s*post/i, 'Speed Post'], [/shree\s*maruti/i, 'Shree Maruti']]) if (re.test(t)) return label;
    // Unmapped couriers keep their FULL name - first-word truncation turned 'Speed Post' into a
    // meaningless 'Speed' on the first dry run.
    return t.trim() || null;
}
// EasyEcom's aggregator field → our platform label. EasyEcom knows the allocation the moment the
// label exists; the journey table only learns it at the first courier scan.
const EE_AGGREGATOR_WH = { 'rapidshyp- outbound': 'RapidShyp', 'gokwik outbound': 'KwikShip' };
async function fetchPlatformCourier(names) {
    const uniq = [...new Set((names || []).map(normName).filter(Boolean))];
    const map = {};
    for (let i = 0; i < uniq.length; i += 300) {
        const { data } = await supabase.from('shipment_journey_ecom')
            .select('order_name, source, courier').in('order_name', uniq.slice(i, i + 300));
        (data || []).forEach(j => {
            const k = normName(j.order_name);
            if (!k || map[k]) return;
            map[k] = {
                platform: PLATFORM_LABEL_WH[String(j.source || '').toLowerCase()] || (j.source || null),
                courier: courierShort(j.courier),
            };
        });
    }
    // ⚠️ FRESHLY-LABELLED PARCELS HAVE NO JOURNEY ROW YET (2026-08-20: TE25-43585/43609, manifested to
    // Shree Maruti at 03:35, read "No courier assigned yet" on the 06:30 card while EasyEcom knew both
    // the aggregator and the courier). The journey is written at the FIRST COURIER SCAN, which for a
    // parcel still on our shelf may be days away — and Ready-for-Pickup is precisely the pre-scan
    // population, so EasyEcom's own allocation is the right fallback: courier_name + the
    // raw_data.courier_aggregator_name marker (the same field the Kwikship sync keys on).
    const missing = uniq.filter(n => !map[n]);
    for (let i = 0; i < missing.length; i += 200) {
        const { data } = await supabase.from('b2c_order_easycom')
            .select('reference_code, courier_name, raw_data->courier_aggregator_name')
            .in('reference_code', missing.slice(i, i + 200));
        (data || []).forEach(r => {
            const k = normName(r.reference_code);
            if (!k || map[k] || !r.courier_name) return;
            map[k] = {
                platform: EE_AGGREGATOR_WH[String(r.courier_aggregator_name || '').toLowerCase().trim()] || null,
                courier: courierShort(r.courier_name),
            };
        });
    }
    return map;
}
// Group orders into “Platform · Courier” buckets (largest first), unassigned last — those have no
// journey row yet, i.e. no courier has been allocated, which is its own signal.
function groupByCourier(orders, pc) {
    const groups = new Map();
    for (const o of orders) {
        const info = pc[normName(o.name)];
        const key = info && (info.platform || info.courier)
            ? `${info.platform || 'Unknown platform'}${info.courier ? ' · ' + info.courier : ''}`
            : 'No courier assigned yet';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
    }
    return [...groups.entries()].sort((a, b) => {
        if (a[0] === 'No courier assigned yet') return 1;
        if (b[0] === 'No courier assigned yet') return -1;
        return b[1].length - a[1].length;
    });
}
// Ready-for-Pickup grouped by “Platform · Courier” — one block per courier group, chunked inside
// a group only when it alone would breach the 3000-char mrkdwn ceiling. Falls back to the flat
// list when no courier is known for anything (journey unreachable) — a degraded report, never none.
function groupedOrderBlocks(label, emoji, orders, pc) {
    if (!orders.length) return [];
    const grouped = groupByCourier(orders, pc);
    if (grouped.length === 1 && grouped[0][0] === 'No courier assigned yet') return orderBlocks(label, emoji, orders);
    const blocks = [{ type: 'section', text: { type: 'mrkdwn',
        text: `${emoji} *${label}* — ${orders.length} order${orders.length === 1 ? '' : 's'} · by courier (oldest → newest within each)` } }];
    const CHUNK = 60;
    for (const [key, list] of grouped) {
        for (let i = 0; i < list.length; i += CHUNK) {
            const head = i === 0 ? `▸ *${key}* (${list.length})\n` : `▸ *${key}* (continued)\n`;
            blocks.push({ type: 'section', text: { type: 'mrkdwn',
                text: head + list.slice(i, i + CHUNK).map(o => `\`${o.name}\``).join('  ') } });
        }
    }
    return blocks;
}

// Slack mrkdwn text limit is 3000 chars — chunk order names into safe blocks
function orderBlocks(label, emoji, orders) {
    if (!orders.length) return [];
    const CHUNK = 80; // order IDs per section block
    const blocks = [];
    for (let i = 0; i < orders.length; i += CHUNK) {
        const slice = orders.slice(i, i + CHUNK);
        const prefix = i === 0 ? `${emoji} *${label}* (oldest → newest)\n` : `${emoji} *${label}* (continued)\n`;
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: prefix + slice.map(o => `\`${o.name}\``).join('  ') }
        });
    }
    return blocks;
}

// The stuck list carries an age per order, so it cannot reuse orderBlocks (names only). Same 3000-char
// mrkdwn ceiling, so it chunks too.
function stuckBlocks(stuck, pc = {}) {
    if (!stuck.length) return [];
    const CHUNK = 40;
    const blocks = [{ type: 'section', text: { type: 'mrkdwn',
        text: `🚨 *Stuck in Ready for Pickup — over ${STUCK_HOURS}h* (${stuck.length}) · by courier, oldest first\n_Labelled and still on our shelf — that courier hasn't collected._` } }];
    // Grouped by the courier whose van hasn't come — that is WHO to chase, the report's whole job.
    const grouped = groupByCourier(stuck.map(s => s.order), pc);
    const bySt = new Map(stuck.map(s => [normName(s.order.name), s]));
    for (const [key, list] of grouped) {
        for (let i = 0; i < list.length; i += CHUNK) {
            const head = i === 0 ? `▸ *${key}* (${list.length})\n` : `▸ *${key}* (continued)\n`;
            blocks.push({ type: 'section', text: { type: 'mrkdwn',
                text: head + list.slice(i, i + CHUNK).map(o => { const st = bySt.get(normName(o.name)); return `\`${o.name}\` *${fmtAge(st ? st.hours : 0)}*`; }).join('   ') } });
        }
    }
    return blocks;
}

function buildPayload(groups, start, end, readySince = {}, pc = {}) {
    const ready    = groups.READY_FOR_PICKUP || [];
    const confirmed = groups.CONFIRMED || [];
    const unful    = groups.UNFULFILLABLE || [];
    const realloc  = groups.REALLOCATION_REQUIRED || [];
    const total    = ready.length + confirmed.length + unful.length + realloc.length;
    const stuck    = stuckReadyOrders(ready, readySince);

    const blocks = [
        {
            type: 'header',
            text: { type: 'plain_text', text: `🏭 Warehouse Ops Report  |  Last 30 days · ${start} → ${end}`, emoji: true }
        },
        { type: 'divider' },
        {
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `📦 *Ready for Pickup*\n*${ready.length}* orders` },
                { type: 'mrkdwn', text: `🚨 *Stuck >${STUCK_HOURS}h*\n*${stuck.length}* orders` },
                { type: 'mrkdwn', text: `✅ *Confirmed*\n*${confirmed.length}* orders` },
                { type: 'mrkdwn', text: `⛔ *Unfulfillable*\n*${unful.length}* orders` },
                { type: 'mrkdwn', text: `🔁 *Reallocation Reqd*\n*${realloc.length}* orders` },
                { type: 'mrkdwn', text: `📊 *Total Pending*\n*${total}* orders` }
            ]
        },
        { type: 'divider' },
        // Above every other list on purpose: this is the one section that is someone's job right now.
        ...stuckBlocks(stuck, pc),
        ...(stuck.length ? [{ type: 'divider' }] : []),
        ...orderBlocks('Reallocation Required (RapidShyp)', '🔁', realloc),
        ...groupedOrderBlocks('Ready for Pickup', '📦', ready, pc),
        ...groupedOrderBlocks('Confirmed', '✅', confirmed, pc),
        ...orderBlocks('Unfulfillable', '⛔', unful),
        { type: 'divider' },
        {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `_Auto-report · ${total} order${total !== 1 ? 's' : ''} need${total === 1 ? 's' : ''} attention_` }]
        }
    ];

    return { blocks };
}

let DRY_RUN = false; // CLI "dry" flag — print the report instead of posting to Slack

const { postTeams } = require('./teams');
function _teamsUrlFor(channel) {
    if (channel === WH_CHANNEL) return config.TEAMS_WEBHOOK_WAREHOUSE;
    if (channel === DP_CHANNEL) return config.TEAMS_WEBHOOK_DP;
    if (channel === HOLD_CHANNEL) return config.TEAMS_WEBHOOK_WAREHOUSE_HOLD || config.TEAMS_WEBHOOK_HOLD;
    return null;
}
async function postSlack(payload, channel = WH_CHANNEL, teamsOpts = {}) {
    if (DRY_RUN) {
        let preview = payload.text || '';
        if (Array.isArray(payload.blocks)) {
            preview = payload.blocks.map(b => {
                if (b.type === 'header')                 return `# ${b.text.text}`;
                if (b.type === 'section' && b.text)      return b.text.text;
                if (b.type === 'section' && b.fields)    return b.fields.map(f => f.text).join('   |   ');
                if (b.type === 'context')                return b.elements.map(e => e.text).join(' ');
                if (b.type === 'divider')                return '──────────';
                return '';
            }).filter(Boolean).join('\n');
        }
        console.log(`\n════ DRY RUN — would post to ${channel} (no Slack message sent) ════\n${preview}\n════════════════════════════════════════════════════════════\n`);
        return true;
    }
    // Teams is the ONLY target (migration complete). Slack posting stays off unless SLACK_ENABLED=true —
    // this prevents a stray SLACK_BOT_TOKEN on the server from re-posting every report to Slack.
    const teamsUrl = _teamsUrlFor(channel);
    if (teamsUrl) await postTeams(teamsUrl, payload, teamsOpts).catch(() => {});
    else console.warn('[WH Report] no Teams webhook set for channel', channel);
    if (config.SLACK_ENABLED && config.SLACK_BOT_TOKEN) {
        try {
            const res = await axios.post('https://slack.com/api/chat.postMessage',
                { channel, ...payload },
                { headers: { Authorization: `Bearer ${config.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } });
            if (!res.data.ok) console.error('[WH Report] Slack error:', res.data.error);
        } catch (e) { console.error('[WH Report] Slack post failed:', e.message); }
    }
    return true;
}

// For pending orders with NO RapidShyp status, ask DocPharma and collect the ones
// it REJECTED. Throttled ~1 req/sec (DocPharma is rate-limited).
// Cache of DocPharma check results so we don't re-hit DocPharma for the same orders every run.
// found=false → DocPharma doesn't have the order (a non-DocPharma order) → skip it next time.
const DP_CHECK_TABLE = 'docpharma_check_ecom';
const DP_NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-verify "not found" weekly (guards transient errors)

async function fetchDpCheckCache(names) {
    const uniq = [...new Set(names.map(normName).filter(Boolean))];
    const map = {};
    const CHUNK = 200;
    for (let i = 0; i < uniq.length; i += CHUNK) {
        const slice = uniq.slice(i, i + CHUNK);
        const { data, error } = await supabase.from(DP_CHECK_TABLE).select('order_name, found, status, checked_at').in('order_name', slice);
        if (error) { console.warn(`[WH Report] dp-check cache read failed (table missing?): ${error.message}`); return map; }
        (data || []).forEach(r => { map[r.order_name] = r; });
    }
    return map;
}

async function recordDpChecks(checks) {
    if (!checks.length) return;
    const now = new Date().toISOString();
    const rows = checks.map(c => ({ order_name: normName(c.name), found: c.found, status: c.status || null, checked_at: now, updated_at: now }));
    const { error } = await supabase.from(DP_CHECK_TABLE).upsert(rows, { onConflict: 'order_name' });
    if (error) console.warn(`[WH Report] dp-check cache write failed: ${error.message}`);
}

// Authoritative DocPharma status from the synced `docpharma_orders` table (partner_order_id carries NO
// leading "#"). This reflects DocPharma's REAL state (cancelled / rejected / delivered / rto / …) and is
// immune to the live-check ingestion-lag/timing AND the sticky "not-found" cache — so a genuinely
// cancelled/rejected order is never suppressed. Returns { normalizedName: order_status }.
async function fetchDpOrderStatuses(names) {
    const uniq = [...new Set(names.map(normName).filter(Boolean))];
    const map = {};
    const CHUNK = 200;
    for (let i = 0; i < uniq.length; i += CHUNK) {
        const { data, error } = await supabase
            .from('docpharma_orders')
            .select('partner_order_id, order_status')
            .in('partner_order_id', uniq.slice(i, i + CHUNK));
        if (error) { console.warn(`[WH Report] docpharma_orders lookup failed: ${error.message}`); continue; }
        (data || []).forEach(r => { if (r.partner_order_id) map[normName(r.partner_order_id)] = r.order_status; });
    }
    return map;
}

// Check DocPharma for the given orders. Returns { rejected:[{name,status}], checks:[{name,found,status}] }.
async function findDocpharmaRejected(orders) {
    const rejected = [], checks = [];
    const MAX_CHECK = 200;
    const toCheck = orders.slice(0, MAX_CHECK);
    if (orders.length > MAX_CHECK) console.warn(`[WH Report] DocPharma check capped at ${MAX_CHECK}/${orders.length}`);
    for (const o of toCheck) {
        const orderName = (o.name || '').replace('#', '').trim();
        if (!orderName) continue;
        let dp = null;
        try { dp = await fetchDocpharmaDetails(orderName); } catch (e) { /* treat as not found */ }
        const found = dp !== null;                                    // DocPharma has the order
        const status = found ? extractDocpharmaStatusString(dp) : null;
        checks.push({ name: o.name, found, status });
        // DocPharma "Cancelled" is an indirect rejection (they won't ship it) → treat like Rejected.
        if (found && status && (status.includes('REJECT') || status.includes('CANCEL'))) rejected.push({ name: o.name, status });
        await new Promise(r => setTimeout(r, 1100)); // ~1 req/sec
    }
    return { rejected, checks };
}

// Highlighted alert for the dp-to-mwh-orders channel.
function buildDpRejectedPayload(rejected, start, end, autoResults = []) {
    const byName = {}; autoResults.forEach(a => { byName[String(a.order).replace('#', '').trim()] = a.result; });
    const mark = r => { const res = byName[String(r.name).replace('#', '').trim()];
        if (res === 'routed') return '  ✅ _moved to Shifupro_';
        if (res === 'already-shifupro') return '  ✅ _already on Shifupro_';
        if (res === 'session-expired' || res === 'no-session') return '  ⚠️ _auto-move needs EasyEcom session_';
        if (res && res !== 'not-synced') return `  ⚠️ _${res}_`;
        return ''; };
    const lines = rejected.map(r => `🔴  \`${r.name}\`  —  *${r.status}*${mark(r)}`);
    const routed = autoResults.filter(a => a.result === 'routed').length;
    const autoLine = autoResults.length ? `\n🏬 *Auto-routed ${routed}/${autoResults.length}* to Shifupro (MWH).` : '';
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `🚨 DocPharma Rejected → Warehouse Action`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${rejected.length}* order${rejected.length !== 1 ? 's' : ''} with *no RapidShyp tracking* were *Rejected / Cancelled by DocPharma* and need warehouse action _(re-route / re-ship)_.${autoLine}\n_Window: ${start} → ${end}_` } },
        { type: 'divider' }
    ];
    const CHUNK = 40;
    for (let i = 0; i < lines.length; i += CHUNK) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.slice(i, i + CHUNK).join('\n') } });
    }
    return { blocks };
}

// endOffsetDays: how many days before today the window ends.
//   8:30 AM run → 2 (data up to today−2),  5:30 PM run → 1 (data up to today−1).
// Window is the last 30 days ending at that cutoff.
function reportWindow(endOffsetDays) {
    const now = new Date();
    const endDate   = new Date(now.getFullYear(), now.getMonth(), now.getDate() - endOffsetDays);
    // Start is anchored to TODAY (fixed 32-day lookback), NOT to the cutoff — so the −1 (evening)
    // window is always a superset of the −2 (morning) window and no pending order is missed between
    // the two runs.
    const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 32);
    return { start: fmtLocal(startDate), end: fmtLocal(endDate) };
}

// Rolling last-30-days window: today−30 → today.
function last30Window() {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
    return { start: fmtLocal(startDate), end: fmtLocal(now) };
}

// Fetch open orders for the window, RapidShyp-cross-check, and classify into pending groups.
// Returns { groups, rsMap, start, end } or null on Shopify fetch failure.
async function collectPendingGroups(start, end, label = 'open orders') {
    console.log(`[WH Report] Fetching ${label} ${start} → ${end}…`);

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // start/end arrive as DD-MM-YYYY (fmtLocal — the report DISPLAY format), but Shopify's search
    // syntax needs ISO YYYY-MM-DD; convert here so the query is valid while every label keeps DD-MM-YYYY.
    const toIso = s => { const m = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : s; };
    const q = `processed_at:>='${toIso(start)}' AND processed_at:<='${toIso(end)}T23:59:59Z' AND status:open`;
    const MAX_TRIES = 6;

    const allOrders = [];
    let cursor = null, hasNext = true;
    try {
        while (hasNext) {
            const after = cursor ? `, after:"${cursor}"` : '';
            const gql = `{orders(first:50,sortKey:PROCESSED_AT,reverse:false,query:"${q}"${after}){edges{node{name processedAt displayFulfillmentStatus fulfillments{displayStatus trackingInfo{number}}}}pageInfo{hasNextPage endCursor}}}`;

            // Fetch each page with retry/backoff so one transient Shopify hiccup (throttle, 5xx,
            // network blip) retries instead of failing the whole report.
            let orders = null;
            for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
                try {
                    const resp = await axios.post(
                        GQL_URL,
                        { query: gql },
                        { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN }, timeout: 20000 }
                    );
                    const errs = resp.data && resp.data.errors;
                    const throttled = Array.isArray(errs) && errs.some(e =>
                        (e.extensions && e.extensions.code) === 'THROTTLED' || /throttle/i.test(e.message || ''));
                    if (throttled) {
                        // Wait for the GraphQL cost bucket to refill, then retry this same page.
                        const cost = resp.data.extensions && resp.data.extensions.cost;
                        const ts = cost && cost.throttleStatus;
                        const need = (cost && cost.requestedQueryCost) || 100;
                        let wait = 2000;
                        if (ts && ts.restoreRate && ts.currentlyAvailable < need) {
                            wait = Math.ceil((need - ts.currentlyAvailable) / ts.restoreRate * 1000);
                        }
                        wait = Math.max(1000, Math.min(10000, wait));
                        console.warn(`[WH Report] Shopify throttled — waiting ${wait}ms (try ${attempt}/${MAX_TRIES})`);
                        await sleep(wait);
                        continue;
                    }
                    if (Array.isArray(errs) && errs.length) throw new Error(errs[0].message);
                    if (!resp.data.data || !resp.data.data.orders) throw new Error('empty Shopify response');
                    orders = resp.data.data.orders;
                    break;
                } catch (e) {
                    if (attempt === MAX_TRIES) throw e;
                    const wait = Math.min(8000, 500 * 2 ** (attempt - 1));
                    console.warn(`[WH Report] Shopify fetch error "${e.message}" — retry ${attempt}/${MAX_TRIES} in ${wait}ms`);
                    await sleep(wait);
                }
            }

            orders.edges.forEach(e => allOrders.push(e.node));
            hasNext = orders.pageInfo.hasNextPage;
            cursor  = orders.pageInfo.endCursor;
        }
    } catch (e) {
        console.error('[WH Report] Shopify fetch failed after retries:', e.message);
        return null;
    }

    // Resolve each order's AWB — Shopify fulfillment AWB first, else the EasyEcom AWB.
    const { awbByName: ecAwbByName, cancelled: ecCancelled } = await fetchEasyecomInfoByName(allOrders.map(o => o.name));
    const awbByName = {};
    allOrders.forEach(o => {
        const awb = orderAwb(o) || ecAwbByName[normName(o.name)] || null;
        if (awb) awbByName[normName(o.name)] = String(awb);
    });

    // Phase 1 — from the DB CACHE: drop dead orders (EasyEcom-cancelled) and shipments the cache
    // already knows have moved/delivered (the bulk — no live call). What remains = candidates.
    const cacheStatus = await resolveRsStatuses(Object.values(awbByName));
    // Courier truth for ALL carriers (RapidShyp + DocPharma + Kwikship) from shipment_journey_ecom.
    const { moved: jMoved, movedAwbs: jMovedAwbs } = await fetchCourierMoved(allOrders.map(o => o.name), Object.values(awbByName));
    let movedSkipped = 0, cancelledSkipped = 0, courierMovedSkipped = 0;
    const candidates = [];
    allOrders.forEach(order => {
        const nm = normName(order.name);
        if (ecCancelled.has(nm)) { cancelledSkipped++; return; }
        const awb = awbByName[nm];
        // A carrier has physically moved it — covers DocPharma/Kwikship/any non-RapidShyp AWB that the
        // RapidShyp lookup below can never resolve. Checked first so those orders also skip the live
        // verify (which would 400 on an AWB RapidShyp never issued).
        if (jMoved.has(nm) || (awb && jMovedAwbs.has(String(awb)))) { courierMovedSkipped++; return; }
        const rs = awb ? cacheStatus[awb] : null;
        if (rs && rsHasMoved(rs)) { movedSkipped++; return; } // cache says gone → drop, no live needed
        candidates.push(order);
    });

    // Phase 2 — LIVE-verify ONLY the candidates (the orders that would appear in the report) with
    // RapidShyp for the freshest status right before posting; this also refreshes the cache.
    const rsMap = { ...cacheStatus };
    const candAwbs = [...new Set(candidates.map(o => awbByName[normName(o.name)]).filter(Boolean))];
    if (candAwbs.length) {
        console.log(`[WH Report] Live-verifying ${candAwbs.length} report order(s) with RapidShyp…`);
        let i = 0, done = 0;
        const worker = async () => {
            while (i < candAwbs.length) {
                const awb = candAwbs[i++];
                const live = await fetchRsLive(awb);
                if (live) rsMap[awb] = live;
                if (++done % 50 === 0) console.log(`[WH Report]   …verified ${done}/${candAwbs.length}`);
                await sleep(200);
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, candAwbs.length) }, worker));
    }

    // Phase 3 — classify the candidates from the FRESH RapidShyp status.
    const groups = {};
    candidates.forEach(order => {
        const awb = awbByName[normName(order.name)] || null;
        const rs = awb ? rsMap[awb] : null;
        if (rs && rsHasMoved(rs)) { movedSkipped++; return; }               // moved since cache → drop
        if (rs && /realloc/i.test(rs)) {                                    // courier failed → action
            (groups.REALLOCATION_REQUIRED = groups.REALLOCATION_REQUIRED || []).push(order);
            return;
        }
        if (rs && rsReadyForPickup(rs)) {                                   // labelled & awaiting pickup
            (groups.READY_FOR_PICKUP = groups.READY_FOR_PICKUP || []).push(order);
            return;
        }
        const status = classifyOrder(order);                               // no RS signal → Shopify
        if (!status) return;
        if (!groups[status]) groups[status] = [];
        groups[status].push(order);
    });

    const total = Object.values(groups).flat().length;
    console.log(`[WH Report] READY=${(groups.READY_FOR_PICKUP||[]).length} CONFIRMED=${(groups.CONFIRMED||[]).length} UNFULFILLABLE=${(groups.UNFULFILLABLE||[]).length} REALLOC=${(groups.REALLOCATION_REQUIRED||[]).length} TOTAL=${total} (dropped ${courierMovedSkipped} courier-moved · ${movedSkipped} RS-moved · ${cancelledSkipped} cancelled)`);
    return { groups, rsMap, awbByName, start, end };
}

// Among pending orders that have NO RapidShyp tracking AND are not already handed to MWH,
// return ONLY the ones DocPharma explicitly reports as rejected: [{ name, status }].
// Orders DocPharma returns nothing (or a non-rejected status) for are NOT returned —
// they stay in the warehouse report. Orders already in the handled list are skipped
// entirely (RapidShyp-first from then on). This single classifier keeps the reports
// mutually exclusive and prevents re-reporting handled orders.
async function getDpRejectedOrders(groups, rsMap, handledSet, awbByName = {}) {
    const pending = Object.values(groups).flat();
    let noRsPending = pending.filter(o => { const awb = awbByName[normName(o.name)] || orderAwb(o); return !awb || !rsMap[awb]; });

    // Skip orders already handed to MWH — they're tracked via RapidShyp now, never DocPharma again.
    if (handledSet && handledSet.size) {
        const before = noRsPending.length;
        noRsPending = noRsPending.filter(o => !handledSet.has(normName(o.name)));
        if (before !== noRsPending.length) {
            console.log(`[WH Report] Skipped ${before - noRsPending.length} already-handled order(s) — RapidShyp-first`);
        }
    }
    if (!noRsPending.length) return [];

    // ── PRIMARY (authoritative): the synced docpharma_orders table. Holds DocPharma's REAL status and is
    // immune to the live-check ingestion-lag/timing and the sticky "not-found" cache — so a genuinely
    // cancelled/rejected order can never be suppressed (the bug that hid e.g. TE25-35181, which DocPharma
    // ingested 38s AFTER the report's live check cached it as "not found" for 7 days).
    const rejected = [];
    const dpStatus = await fetchDpOrderStatuses(noRsPending.map(o => o.name));
    const notInSyncedTable = [];
    for (const o of noRsPending) {
        const st = dpStatus[normName(o.name)];
        if (st && /reject|cancel/i.test(st)) rejected.push({ name: o.name, status: String(st).toUpperCase() });
        else if (!st) notInSyncedTable.push(o); // synced table doesn't have it yet → live-check fallback
        // else: DocPharma has it in a non-rejected state (delivered/rto/shipped/lost/…) → not a rejection
    }
    if (rejected.length) console.log(`[WH Report] ${rejected.length} DocPharma cancelled/rejected via synced docpharma_orders (authoritative)`);

    // ── FALLBACK: live-check ONLY orders the synced table doesn't have yet (freshly created / sync gaps).
    // Uses the "not-found" cache so genuine non-DocPharma orders are checked once, not every run.
    if (notInSyncedTable.length) {
        const cache = await fetchDpCheckCache(notInSyncedTable.map(o => o.name));
        const toCheck = notInSyncedTable.filter(o => {
            const c = cache[normName(o.name)];
            if (c && c.found === false && c.checked_at && (Date.now() - new Date(c.checked_at).getTime()) < DP_NOT_FOUND_TTL_MS) {
                return false; // known non-DocPharma order — don't re-check
            }
            return true;
        });
        const skipped = notInSyncedTable.length - toCheck.length;
        if (skipped) console.log(`[WH Report] Skipped ${skipped} order(s) cached as not-in-DocPharma`);
        if (toCheck.length) {
            console.log(`[WH Report] Live DocPharma-checking ${toCheck.length} order(s) not in synced table…`);
            const { rejected: liveRej, checks } = await findDocpharmaRejected(toCheck);
            await recordDpChecks(checks); // remember found/not-found so we don't re-check next run
            rejected.push(...liveRej);
        } else {
            console.log('[WH Report] No new live DocPharma checks needed');
        }
    }

    // Dedupe by normalized name (an order can't be in both paths, but guard anyway).
    const seen = new Set();
    return rejected.filter(r => { const k = normName(r.name); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Warehouse ops report → warehouse-ops channel only. Last-30-day window (cutoff −offset).
// EXCLUDES DocPharma-rejected orders (those belong only to the dp-to-mwh report) → no duplicates.
async function sendWarehouseOpsReport(endOffsetDays = 2, { dry = false } = {}) {
    const { start, end } = reportWindow(endOffsetDays);
    const res = await collectPendingGroups(start, end, `last-30d open orders (cutoff −${endOffsetDays}d)`);
    if (!res) { await postSlack({ text: '⚠️ Warehouse Ops Report failed to fetch orders.' }, WH_CHANNEL, { text: true }); return; }
    const { groups, rsMap, awbByName } = res;

    // Route currently-rejected DocPharma orders OUT of the warehouse report (they go to dp-to-mwh
    // only). Already-handled orders are NOT rejected here, so they correctly stay in this report
    // and are tracked via RapidShyp. The warehouse report never records the handled list.
    const handledSet = await fetchHandledNames();
    const rejected = await getDpRejectedOrders(groups, rsMap, handledSet, awbByName);
    if (rejected.length) {
        const rejectedNames = new Set(rejected.map(r => normName(r.name)));
        for (const k of Object.keys(groups)) groups[k] = groups[k].filter(o => !rejectedNames.has(normName(o.name)));
        console.log(`[WH Report] Excluded ${rejected.length} DocPharma-rejected order(s) from warehouse report`);
    }

    const total = Object.values(groups).flat().length;
    if (total === 0) {
        await postSlack({
            blocks: [
                { type: 'header', text: { type: 'plain_text', text: `🏭 Warehouse Ops Report  |  Last 30 days · ${start} → ${end}`, emoji: true } },
                { type: 'section', text: { type: 'mrkdwn', text: '✅ *All clear!* No pending Confirmed / Ready for Pickup / Unfulfillable orders.' } },
                { type: 'context', elements: [{ type: 'mrkdwn', text: `_Auto-report_` }] }
            ]
        }, WH_CHANNEL, { text: true });
        console.log('[WH Report] Sent — all clear');
    } else {
        // Ages only for the Ready-for-Pickup set — the only group the stuck check applies to.
        const ready = groups.READY_FOR_PICKUP || [];
        const readySince = ready.length ? await fetchReadySince(ready.map(o => o.name)) : {};
        const stuckCount = stuckReadyOrders(ready, readySince).length;
        const noAge = ready.filter(o => !readySince[normName(o.name)]).length;
        // Courier grouping covers Ready-for-Pickup, Stuck AND Confirmed (user, 2026-08-20) — an
        // order can be courier-allocated while Shopify still reads CONFIRMED, and those have a
        // journey row to group on; the rest fall under “No courier assigned yet”, its own signal.
        // Unfulfillable stays flat: nothing is allocated on a dead order.
        const confirmed = groups.CONFIRMED || [];
        const pcNames = [...ready, ...confirmed].map(o => o.name);
        const pc = pcNames.length ? await fetchPlatformCourier(pcNames) : {};
        console.log(`[WH Report] Ready=${ready.length} · stuck >${STUCK_HOURS}h=${stuckCount}${noAge ? ` · ${noAge} with no EasyEcom timestamp (not aged)` : ''}`);
        const payload = buildPayload(groups, start, end, readySince, pc);
        if (dry) { console.log('[WH Report] DRY RUN — nothing posted'); return payload; }
        await postSlack(payload, WH_CHANNEL, { text: true });
        console.log('[WH Report] Sent to warehouse-ops');
    }
    return null;
}

// Separate report → DocPharma-rejected orders ONLY, over the last-30-days window, to dp-to-mwh-orders.
// announceEmpty=true posts an "all clear" when nothing is rejected (manual / Slack-triggered runs).
async function sendDocpharmaRejectedReport(announceEmpty = false) {
    const { start, end } = last30Window();
    const res = await collectPendingGroups(start, end, 'last-30d open orders (DocPharma check)');
    if (!res) { await postSlack({ text: '⚠️ DocPharma→MWH check failed to fetch orders.' }, DP_CHANNEL); return; }
    const { groups, rsMap, awbByName } = res;

    const handledSet = await fetchHandledNames();
    // FAIL-SAFE: if the handled list couldn't load, ABORT — posting now would re-report every already-handled
    // order (this is exactly what produced the duplicate reports). Better to skip a run than to re-spam.
    if (handledSet === null) { console.error('[WH Report] DP report aborted — handled list unavailable; not posting to avoid duplicate reports.'); return; }
    const rejected = await getDpRejectedOrders(groups, rsMap, handledSet, awbByName);
    if (rejected.length) {
        await postSlack(buildDpRejectedPayload(rejected, start, end), DP_CHANNEL);
        // Mark as handed to MWH so they're never re-reported (RapidShyp-first from here on). The actual
        // warehouse auto-routing runs in a SEPARATE, gentler pass ~9 min later (autoRouteHandledRejections,
        // cron :56) so detection and routing never pile up in one heavy run.
        // Skip in dry-run so a preview never mutates the handled list.
        if (!DRY_RUN) await recordHandled(rejected);
        console.log(`[WH Report] ${rejected.length} DocPharma-rejected order(s) → dp-to-mwh-orders (auto-route pass will handle warehouse move)`);
    } else if (announceEmpty) {
        await postSlack({ blocks: [
            { type: 'header', text: { type: 'plain_text', text: '✅ DocPharma → Warehouse — All Clear', emoji: true } },
            { type: 'section', text: { type: 'mrkdwn', text: `No DocPharma-rejected orders found.\n_Window (last 30 days): ${start} → ${end}_` } }
        ] }, DP_CHANNEL);
        console.log('[WH Report] No DocPharma-rejected orders — posted all-clear');
    } else {
        console.log('[WH Report] No DocPharma-rejected orders found');
    }
}

// ─── Slack trigger ─────────────────────────────────────────────────────────
// Typing the trigger word in #dp-to-mwh-orders runs the DocPharma report (last 30 days) on demand.
// The word is configurable (env DP_TRIGGER_WORD) so the LIVE server and a LOCAL test instance can
// listen for DIFFERENT words and not both fire on the same message:
//   LIVE  (.env unset or DP_TRIGGER_WORD=rejected) → responds to "rejected"
//   LOCAL (.env DP_TRIGGER_WORD=test)              → responds to "test"
// Polls conversations.history; ignores the bot's own posts to avoid self-triggering.
const DP_TRIGGER_WORD = String(config.DP_TRIGGER_WORD || 'rejected').toLowerCase().trim();
const DP_TRIGGER_RE   = new RegExp(`\\b${DP_TRIGGER_WORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
let _dpPollTs = null;
let _dpRunning = false;

async function pollDpTrigger() {
    const token = config.SLACK_BOT_TOKEN;
    if (!token) return;
    let res;
    try {
        res = await axios.get('https://slack.com/api/conversations.history', {
            params:  { channel: DP_CHANNEL, oldest: _dpPollTs, limit: 20 },
            headers: { Authorization: `Bearer ${token}` }
        });
    } catch (e) { console.error('[DP Trigger] poll error:', e.message); return; }

    if (!res.data.ok) { console.error('[DP Trigger] history error:', res.data.error); return; }
    const all = res.data.messages || [];
    if (all.length) _dpPollTs = String(Math.max(...all.map(m => parseFloat(m.ts)))); // advance cursor

    // Only human messages (skip bot posts / joins / edits) that say the trigger word.
    const triggered = all.some(m => !m.bot_id && !m.subtype && DP_TRIGGER_RE.test(m.text || ''));
    if (!triggered || _dpRunning) return;

    _dpRunning = true;
    console.log(`[DP Trigger] "${DP_TRIGGER_WORD}" received — running DocPharma report (last 30 days)…`);
    try {
        await postSlack({ text: '⏳ Running DocPharma-rejected (last 30 days) check…' }, DP_CHANNEL).catch(() => {});
        await sendDocpharmaRejectedReport(true); // announce even if none found
    } catch (e) {
        console.error('[DP Trigger] run error:', e.message);
    } finally {
        _dpRunning = false;
    }
}

function initDpSlackTrigger(intervalMs = 30000) {
    // Teams-only: the Teams keyword listener handles "rejected" now. Slack trigger stays off unless SLACK_ENABLED=true.
    if (!config.SLACK_ENABLED || !config.SLACK_BOT_TOKEN) { console.log('[DP Trigger] Slack keyword trigger disabled (Teams-only)'); return; }
    _dpPollTs = String(Date.now() / 1000); // ignore history before startup
    setInterval(() => { pollDpTrigger().catch(() => {}); }, intervalMs);
    console.log(`[DP Trigger] Listening for "${DP_TRIGGER_WORD}" in dp-to-mwh-orders…`);
}

// ─── On-Hold report (EasyEcom + Shopify) → C0BBQNDH1CG / Teams ──────────────────────────────
// TWO hold sources in one report:
//   • EasyEcom — webhook-synced table gives the CANDIDATE list (cheap), then each is verified live
//     with EasyEcom (1 API call each) because the webhook misses some cancel/unhold updates and the
//     table goes stale; stale ones are self-healed so the candidate list shrinks over time.
//   • Shopify — active `shopify_hold` marks (order_marks_ecom) shown WITH their reason (the note);
//     our own hold/release logic is the source of truth, so no live Shopify call is needed.
// announceEmpty posts an "all clear" when BOTH are empty.
async function sendEasyecomHoldReport(announceEmpty = false) {
    // Rolling last-30-days window — today−30 → now.
    const now = new Date();
    const winStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
    const since30 = winStartDate.toISOString();
    const winLabel = `${fmtLocal(winStartDate)} → ${fmtLocal(now)}`;

    const { data, error } = await supabase
        .from('b2c_order_easycom')
        .select('order_id, reference_code, store_order_id, marketplace_order_id, customer_name, order_total, order_date')
        .ilike('order_status', 'On Hold')
        .gte('order_date', since30)
        .order('order_date', { ascending: true });
    if (error) { console.error('[Hold Report] DB read error:', error.message); return; }

    const candidates = data || [];
    console.log(`[Hold Report] ${candidates.length} On-Hold candidate(s) in table (last 30d ${winLabel}) — verifying live with EasyEcom…`);

    // Verify each candidate's CURRENT status live (1 EasyEcom API call each). Correct the table
    // when it's stale (self-heal) and keep only orders EasyEcom *still* holds.
    const orders = [];
    let healed = 0;
    for (const o of candidates) {
        let liveStatus = null;
        try {
            const live = await fetchEasyecomOrderById(o.order_id);
            liveStatus = live ? (live.order_status || live.status || null) : null;
        } catch (e) { /* on failure, keep candidate conservatively */ }

        if (liveStatus && liveStatus.toLowerCase() !== 'on hold') {
            await supabase.from('b2c_order_easycom')
                .update({ order_status: liveStatus, updated_at: new Date().toISOString() })
                .eq('order_id', o.order_id);
            healed++;
            console.log(`[Hold Report]   ${o.reference_code || o.order_id}: ${liveStatus} (was On Hold) → corrected`);
        } else {
            orders.push(o); // still on hold (or unverifiable → keep)
        }
        await new Promise(r => setTimeout(r, 400)); // gentle on EasyEcom API
    }
    console.log(`[Hold Report] ${orders.length} genuinely On-Hold · ${healed} stale corrected · ${candidates.length} verified`);

    // ── Shopify holds — active `shopify_hold` marks in the last 30 days, WITH their reason (the mark's
    //    note, e.g. "high value (≥₹1500), short address"). The mark is NOT always cleared when an order
    //    moves past the hold (cancelled / released-and-shipped), so we DON'T trust the mark alone — we
    //    cross-check the order's live state and drop any that are cancelled, fulfilled, or already
    //    shipped (has AWB / tracking). Matches how the dashboard decides the hold chip. ──
    let shopHolds = [];
    try {
        const { data: sh } = await supabase.from('order_marks_ecom')
            .select('order_name, note, created_by, created_at')
            .eq('mark_type', 'shopify_hold')
            .gte('created_at', since30)
            .order('created_at', { ascending: true });
        const marks = sh || [];
        const before = marks.length;
        if (marks.length) {
            const names = [...new Set(marks.map(m => m.order_name).filter(Boolean))];
            const variants = names.flatMap(n => [n, '#' + n]);
            const state = {};
            for (let i = 0; i < variants.length; i += 300) {
                const { data: ords } = await supabase.from('orders')
                    .select('name, cancelled_at, fulfillment_status, awb_number, tracking_status')
                    .in('name', variants.slice(i, i + 300));
                (ords || []).forEach(o => { state[String(o.name || '').replace('#', '').trim()] = o; });
            }
            shopHolds = marks.filter(m => {
                const o = state[String(m.order_name || '').replace('#', '').trim()];
                if (!o) return true;   // order not found → keep (conservative)
                // Still genuinely on hold = not cancelled, not fulfilled, no AWB, no tracking yet.
                return !o.cancelled_at && o.fulfillment_status !== 'fulfilled' && !o.awb_number && !o.tracking_status;
            });
        }
        console.log(`[Hold Report] Shopify holds: ${shopHolds.length} genuinely held · ${before - shopHolds.length} stale (cancelled/shipped) dropped · ${before} marks`);
    } catch (e) { console.error('[Hold Report] Shopify hold read error:', e.message); }

    const eeCount = orders.length, shCount = shopHolds.length, total = eeCount + shCount;
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (!total) {
        if (announceEmpty) {
            // Plain HTML twin (for the Teams thread-reply flow — "Reply with a message in a channel").
            const clearText = `<b>⏸️ On-Hold Orders — Last 30 Days</b><br>`
                + `✅ <b>All clear!</b> No orders on hold in EasyEcom or Shopify in the last 30 days.<br><i>${winLabel}</i>`;
            await postSlack({ blocks: [
                { type: 'header', text: { type: 'plain_text', text: `⏸️ On-Hold Orders — Last 30 Days`, emoji: true } },
                { type: 'section', text: { type: 'mrkdwn', text: `✅ *All clear!* No orders on hold in EasyEcom or Shopify in the last 30 days.\n_${winLabel}_` } }
            ] }, HOLD_CHANNEL, { text: clearText });
        }
        return;
    }

    const eeIds = orders.map(o => o.reference_code || o.store_order_id || o.marketplace_order_id || `#${o.order_id}`);
    // Group Shopify holds BY REASON (the mark note) — each reason becomes a heading, with its orders
    // listed HORIZONTALLY as chips beneath it (biggest reason group first). EasyEcom holds carry no
    // per-order reason, so they stay one group.
    const shopGroupMap = new Map();
    for (const m of shopHolds) {
        const key = (m.note && String(m.note).trim()) || 'No reason recorded';
        if (!shopGroupMap.has(key)) shopGroupMap.set(key, []);
        shopGroupMap.get(key).push(m.order_name);
    }
    const shopGroups = [...shopGroupMap.entries()].sort((a, b) => b[1].length - a[1].length);
    const CHUNK = 60;   // order-chips per section (Slack's 3000-char section limit)

    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `⏸️ On-Hold Orders — ${total} (Last 30 Days)`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${total}* order${total !== 1 ? 's' : ''} on hold _(last 30 days: ${winLabel})_ — *EasyEcom: ${eeCount}* · *Shopify: ${shCount}*.` } },
        { type: 'divider' }
    ];
    if (eeCount) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🟠 EasyEcom hold — On Hold (${eeCount})*` } });
        for (let i = 0; i < eeIds.length; i += CHUNK) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: eeIds.slice(i, i + CHUNK).map(x => `\`#${x}\``).join('  ') } });
        }
    }
    if (shCount) {
        if (eeCount) blocks.push({ type: 'divider' });
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🔵 Shopify — On Hold (${shCount})*  _(grouped by reason)_` } });
        for (const [reason, names] of shopGroups) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${reason}* · ${names.length}` } });
            for (let i = 0; i < names.length; i += CHUNK) {
                blocks.push({ type: 'section', text: { type: 'mrkdwn', text: names.slice(i, i + CHUNK).map(x => `\`#${x}\``).join('  ') } });
            }
        }
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Auto-report · 11 AM & 6 PM IST_' }] });

    // Plain HTML twin of the card (Teams thread-reply flow — a channel reply can carry only text/HTML,
    // not an Adaptive Card). Mirrors the card: a reason heading, then its order IDs as chips laid out
    // horizontally on one line (they wrap into the grid seen in the channel).
    let teamsText = `<b>⏸️ On-Hold Orders — ${total} (Last 30 Days)</b><br>`
        + `<b>${total}</b> order${total !== 1 ? 's' : ''} on hold <i>(last 30 days: ${winLabel})</i> — `
        + `<b>EasyEcom: ${eeCount}</b> · <b>Shopify: ${shCount}</b>.<br>`;
    if (eeCount) {
        teamsText += `<br><b>🟠 EasyEcom hold — On Hold (${eeCount})</b><br>` + eeIds.map(x => `<code>#${esc(x)}</code>`).join(' ') + `<br>`;
    }
    if (shCount) {
        teamsText += `<br><b>🔵 Shopify — On Hold (${shCount})</b> <i>(grouped by reason)</i><br>`;
        for (const [reason, names] of shopGroups) {
            teamsText += `<br><b>${esc(reason)}</b> · ${names.length}<br>` + names.map(x => `<code>#${esc(x)}</code>`).join(' ') + `<br>`;
        }
    }
    teamsText += `<br><i>Auto-report · 11 AM & 6 PM IST</i>`;

    await postSlack({ blocks }, HOLD_CHANNEL, { text: teamsText });
    console.log(`[Hold Report] Sent — EasyEcom: ${eeCount}, Shopify: ${shCount}`);
}

module.exports = { sendWarehouseOpsReport, sendDocpharmaRejectedReport, initDpSlackTrigger, sendEasyecomHoldReport, syncRsCacheEasyecom, autoRouteHandledRejections, fetchPlatformCourier };

// --- Manual run ---
// Run on demand and post to Slack immediately, then exit.
//   node app/api/warehouse_slack_report.js          → full warehouse report (last-30d, cutoff −2)
//   node app/api/warehouse_slack_report.js 1        → full warehouse report (last-30d, cutoff −1)
//   node app/api/warehouse_slack_report.js dp       → DocPharma→MWH check only (last 30 days)
//   node app/api/warehouse_slack_report.js hold     → EasyEcom On-Hold report (no EasyEcom API)
if (require.main === module) {
    const rawArgs = process.argv.slice(2);
    if (rawArgs.some(a => a.toLowerCase() === 'dry')) { DRY_RUN = true; console.log('[WH Report] DRY RUN — nothing will be posted to Slack'); }
    const args = rawArgs.filter(a => a.toLowerCase() !== 'dry');
    const mode = (args[0] || '').toLowerCase();
    const dpOnly = mode === 'dp';

    let run;
    if (mode === 'hold') {
        console.log('[Hold Report] Manual EasyEcom On-Hold report');
        run = sendEasyecomHoldReport(true); // announce all-clear too
    } else if (dpOnly) {
        console.log('[WH Report] Manual DocPharma→MWH check (last 30 days)');
        run = sendDocpharmaRejectedReport(true); // announce all-clear too
    } else {
        let offset = parseInt(args[0] || '2', 10);
        if (isNaN(offset)) offset = 2;
        console.log(`[WH Report] Manual full report — cutoff −${offset}d`);
        run = sendWarehouseOpsReport(offset);
    }

    run.then(() => process.exit(0))
       .catch(e => { console.error('[WH Report] Manual run failed:', e.message); process.exit(1); });
}
