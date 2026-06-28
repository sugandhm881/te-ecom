const axios  = require('axios');
const config = require('../../config');
const { supabase } = require('../supabase');
const { fetchDocpharmaDetails, extractDocpharmaStatusString } = require('./helpers');
const { fetchEasyecomOrderById } = require('./easyecom');

const GQL_URL   = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2025-01/graphql.json`;
const WH_CHANNEL = 'C0BA25AFJBG'; // warehouse-ops
const DP_CHANNEL = 'C0BD64XT519'; // dp-to-mwh-orders
const HOLD_CHANNEL = 'C0BBQNDH1CG'; // easyecom on-hold orders

function fmtLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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

async function fetchHandledNames() {
    const { data, error } = await supabase.from(HANDLED_TABLE).select('order_name');
    if (error) { console.warn(`[WH Report] handled-list read failed (table missing?): ${error.message}`); return new Set(); }
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

function buildPayload(groups, start, end) {
    const ready    = groups.READY_FOR_PICKUP || [];
    const confirmed = groups.CONFIRMED || [];
    const unful    = groups.UNFULFILLABLE || [];
    const realloc  = groups.REALLOCATION_REQUIRED || [];
    const total    = ready.length + confirmed.length + unful.length + realloc.length;

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
                { type: 'mrkdwn', text: `✅ *Confirmed*\n*${confirmed.length}* orders` },
                { type: 'mrkdwn', text: `⛔ *Unfulfillable*\n*${unful.length}* orders` },
                { type: 'mrkdwn', text: `🔁 *Reallocation Reqd*\n*${realloc.length}* orders` },
                { type: 'mrkdwn', text: `📊 *Total Pending*\n*${total}* orders` }
            ]
        },
        { type: 'divider' },
        ...orderBlocks('Reallocation Required (RapidShyp)', '🔁', realloc),
        ...orderBlocks('Ready for Pickup', '📦', ready),
        ...orderBlocks('Confirmed', '✅', confirmed),
        ...orderBlocks('Unfulfillable', '⛔', unful),
        { type: 'divider' },
        {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `_Auto-report · ${total} order${total !== 1 ? 's' : ''} need${total === 1 ? 's' : ''} attention_` }]
        }
    ];

    return { blocks };
}

async function postSlack(payload, channel = WH_CHANNEL) {
    const token = config.SLACK_BOT_TOKEN;
    if (!token) { console.warn('[WH Report] SLACK_BOT_TOKEN not configured'); return; }
    const res = await axios.post(
        'https://slack.com/api/chat.postMessage',
        { channel, ...payload },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (!res.data.ok) console.error('[WH Report] Slack error:', res.data.error);
    return res.data.ok;
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
        if (found && status && status.includes('REJECT')) rejected.push({ name: o.name, status });
        await new Promise(r => setTimeout(r, 1100)); // ~1 req/sec
    }
    return { rejected, checks };
}

// Highlighted alert for the dp-to-mwh-orders channel.
function buildDpRejectedPayload(rejected, start, end) {
    const lines = rejected.map(r => `🔴  \`${r.name}\`  —  *${r.status}*`);
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `🚨 DocPharma Rejected → Warehouse Action`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${rejected.length}* order${rejected.length !== 1 ? 's' : ''} with *no RapidShyp tracking* were *REJECTED by DocPharma* and need warehouse action _(re-route / re-ship)_.\n_Window: ${start} → ${end}_` } },
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
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 30);
    return { start: fmtLocal(startDate), end: fmtLocal(endDate) };
}

// Month-to-date window: 1st of the current month → today.
function mtdWindow() {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: fmtLocal(startDate), end: fmtLocal(now) };
}

// Fetch open orders for the window, RapidShyp-cross-check, and classify into pending groups.
// Returns { groups, rsMap, start, end } or null on Shopify fetch failure.
async function collectPendingGroups(start, end, label = 'open orders') {
    console.log(`[WH Report] Fetching ${label} ${start} → ${end}…`);

    const allOrders = [];
    let cursor = null, hasNext = true;
    try {
        while (hasNext) {
            const after = cursor ? `, after:"${cursor}"` : '';
            const q = `processed_at:>='${start}' AND processed_at:<='${end}T23:59:59Z' AND status:open`;
            const gql = `{orders(first:50,sortKey:PROCESSED_AT,reverse:false,query:"${q}"${after}){edges{node{name processedAt displayFulfillmentStatus fulfillments{displayStatus trackingInfo{number}}}}pageInfo{hasNextPage endCursor}}}`;

            const resp = await axios.post(
                GQL_URL,
                { query: gql },
                { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN } }
            );
            if (resp.data.errors) throw new Error(resp.data.errors[0].message);
            const { edges, pageInfo } = resp.data.data.orders;
            edges.forEach(e => allOrders.push(e.node));
            hasNext = pageInfo.hasNextPage;
            cursor  = pageInfo.endCursor;
        }
    } catch (e) {
        console.error('[WH Report] Shopify fetch failed:', e.message);
        return null;
    }

    // Cross-check RapidShyp: drop orders whose shipment has already moved/delivered.
    const rsMap = await fetchRsStatusByAwbs(allOrders.map(orderAwb));
    let movedSkipped = 0;
    const groups = {};
    allOrders.forEach(order => {
        const awb = orderAwb(order);
        const rs = awb ? rsMap[awb] : null;
        if (rs && rsHasMoved(rs)) { movedSkipped++; return; }
        // RapidShyp says the courier couldn't service it → needs reallocation (action required),
        // even if Shopify still shows Ready for Pickup / Confirmed.
        if (rs && /realloc/i.test(rs)) {
            (groups.REALLOCATION_REQUIRED = groups.REALLOCATION_REQUIRED || []).push(order);
            return;
        }
        const status = classifyOrder(order);
        if (!status) return;
        if (!groups[status]) groups[status] = [];
        groups[status].push(order);
    });

    const total = Object.values(groups).flat().length;
    console.log(`[WH Report] READY=${(groups.READY_FOR_PICKUP||[]).length} CONFIRMED=${(groups.CONFIRMED||[]).length} UNFULFILLABLE=${(groups.UNFULFILLABLE||[]).length} REALLOC=${(groups.REALLOCATION_REQUIRED||[]).length} TOTAL=${total} (skipped ${movedSkipped} already-moved per RapidShyp)`);
    return { groups, rsMap, start, end };
}

// Among pending orders that have NO RapidShyp tracking AND are not already handed to MWH,
// return ONLY the ones DocPharma explicitly reports as rejected: [{ name, status }].
// Orders DocPharma returns nothing (or a non-rejected status) for are NOT returned —
// they stay in the warehouse report. Orders already in the handled list are skipped
// entirely (RapidShyp-first from then on). This single classifier keeps the reports
// mutually exclusive and prevents re-reporting handled orders.
async function getDpRejectedOrders(groups, rsMap, handledSet) {
    const pending = Object.values(groups).flat();
    let noRsPending = pending.filter(o => { const awb = orderAwb(o); return !awb || !rsMap[awb]; });

    // Skip orders already handed to MWH — they're tracked via RapidShyp now, never DocPharma again.
    if (handledSet && handledSet.size) {
        const before = noRsPending.length;
        noRsPending = noRsPending.filter(o => !handledSet.has(normName(o.name)));
        if (before !== noRsPending.length) {
            console.log(`[WH Report] Skipped ${before - noRsPending.length} already-handled order(s) — RapidShyp-first`);
        }
    }
    if (!noRsPending.length) return [];

    // Skip orders DocPharma already said it doesn't have (cached "not found", fresh within TTL).
    // This is what stops re-checking ~100 non-DocPharma orders every run — they're checked ONCE.
    const cache = await fetchDpCheckCache(noRsPending.map(o => o.name));
    const toCheck = noRsPending.filter(o => {
        const c = cache[normName(o.name)];
        if (c && c.found === false && c.checked_at && (Date.now() - new Date(c.checked_at).getTime()) < DP_NOT_FOUND_TTL_MS) {
            return false; // known non-DocPharma order — don't re-check
        }
        return true;
    });
    const skipped = noRsPending.length - toCheck.length;
    if (skipped) console.log(`[WH Report] Skipped ${skipped} order(s) cached as not-in-DocPharma`);

    if (!toCheck.length) { console.log('[WH Report] No new DocPharma checks needed'); return []; }
    console.log(`[WH Report] DocPharma-checking ${toCheck.length} order(s) (new / known-DocPharma)…`);

    const { rejected, checks } = await findDocpharmaRejected(toCheck);
    await recordDpChecks(checks); // remember found/not-found so we don't re-check next run
    return rejected;
}

// Warehouse ops report → warehouse-ops channel only. Last-30-day window (cutoff −offset).
// EXCLUDES DocPharma-rejected orders (those belong only to the dp-to-mwh report) → no duplicates.
async function sendWarehouseOpsReport(endOffsetDays = 2) {
    const { start, end } = reportWindow(endOffsetDays);
    const res = await collectPendingGroups(start, end, `last-30d open orders (cutoff −${endOffsetDays}d)`);
    if (!res) { await postSlack({ text: '⚠️ Warehouse Ops Report failed to fetch orders.' }); return; }
    const { groups, rsMap } = res;

    // Route currently-rejected DocPharma orders OUT of the warehouse report (they go to dp-to-mwh
    // only). Already-handled orders are NOT rejected here, so they correctly stay in this report
    // and are tracked via RapidShyp. The warehouse report never records the handled list.
    const handledSet = await fetchHandledNames();
    const rejected = await getDpRejectedOrders(groups, rsMap, handledSet);
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
        });
        console.log('[WH Report] Sent — all clear');
    } else {
        await postSlack(buildPayload(groups, start, end));
        console.log('[WH Report] Sent to warehouse-ops');
    }
}

// Separate report → DocPharma-rejected orders ONLY, over the MTD window, to dp-to-mwh-orders.
// announceEmpty=true posts an "all clear" when nothing is rejected (manual / Slack-triggered runs).
async function sendDocpharmaRejectedReport(announceEmpty = false) {
    const { start, end } = mtdWindow();
    const res = await collectPendingGroups(start, end, 'MTD open orders (DocPharma check)');
    if (!res) { await postSlack({ text: '⚠️ DocPharma→MWH check failed to fetch orders.' }, DP_CHANNEL); return; }
    const { groups, rsMap } = res;

    const handledSet = await fetchHandledNames();
    const rejected = await getDpRejectedOrders(groups, rsMap, handledSet);
    if (rejected.length) {
        await postSlack(buildDpRejectedPayload(rejected, start, end), DP_CHANNEL);
        // Mark as handed to MWH so they're never re-reported (RapidShyp-first from here on).
        await recordHandled(rejected);
        console.log(`[WH Report] ${rejected.length} DocPharma-rejected order(s) → dp-to-mwh-orders`);
    } else if (announceEmpty) {
        await postSlack({ blocks: [
            { type: 'header', text: { type: 'plain_text', text: '✅ DocPharma → Warehouse — All Clear', emoji: true } },
            { type: 'section', text: { type: 'mrkdwn', text: `No DocPharma-rejected orders found.\n_Window (MTD): ${start} → ${end}_` } }
        ] }, DP_CHANNEL);
        console.log('[WH Report] No DocPharma-rejected orders — posted all-clear');
    } else {
        console.log('[WH Report] No DocPharma-rejected orders found');
    }
}

// ─── Slack trigger ─────────────────────────────────────────────────────────
// Typing "rejected" in #dp-to-mwh-orders runs the MTD DocPharma report on demand.
// Polls conversations.history; ignores the bot's own posts to avoid self-triggering.
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

    // Only human messages (skip bot posts / joins / edits) that say "rejected".
    const triggered = all.some(m => !m.bot_id && !m.subtype && /\brejected\b/i.test(m.text || ''));
    if (!triggered || _dpRunning) return;

    _dpRunning = true;
    console.log('[DP Trigger] "rejected" received — running MTD DocPharma report…');
    try {
        await postSlack({ text: '⏳ Running DocPharma-rejected (MTD) check…' }, DP_CHANNEL).catch(() => {});
        await sendDocpharmaRejectedReport(true); // announce even if none found
    } catch (e) {
        console.error('[DP Trigger] run error:', e.message);
    } finally {
        _dpRunning = false;
    }
}

function initDpSlackTrigger(intervalMs = 30000) {
    if (!config.SLACK_BOT_TOKEN) { console.warn('[DP Trigger] SLACK_BOT_TOKEN not set — trigger disabled'); return; }
    _dpPollTs = String(Date.now() / 1000); // ignore history before startup
    setInterval(() => { pollDpTrigger().catch(() => {}); }, intervalMs);
    console.log('[DP Trigger] Listening for "rejected" in dp-to-mwh-orders…');
}

// ─── EasyEcom On-Hold report → C0BBQNDH1CG ──────────────────────────────────
// Pure EasyEcom. Uses the webhook-synced table only to get the CANDIDATE list (cheap), then
// verifies each candidate's CURRENT status live with EasyEcom (1 API call each) because the
// webhook misses some cancel/unhold updates and the table goes stale. Stale ones are corrected
// in the table (self-healing) so the candidate list shrinks over time → few API calls per run.
// announceEmpty posts an "all clear" when none.
async function sendEasyecomHoldReport(announceEmpty = false) {
    // MTD window — 1st of the current month → now.
    const now = new Date();
    const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const mtdLabel = `${fmtLocal(new Date(now.getFullYear(), now.getMonth(), 1))} → ${fmtLocal(now)}`;

    const { data, error } = await supabase
        .from('b2c_order_easycom')
        .select('order_id, reference_code, store_order_id, marketplace_order_id, customer_name, order_total, order_date')
        .ilike('order_status', 'On Hold')
        .gte('order_date', mtdStart)
        .order('order_date', { ascending: true });
    if (error) { console.error('[Hold Report] DB read error:', error.message); return; }

    const candidates = data || [];
    console.log(`[Hold Report] ${candidates.length} On-Hold candidate(s) in table (MTD ${mtdLabel}) — verifying live with EasyEcom…`);

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

    if (!orders.length) {
        if (announceEmpty) {
            await postSlack({ blocks: [
                { type: 'header', text: { type: 'plain_text', text: `⏸️ EasyEcom On-Hold Orders — MTD`, emoji: true } },
                { type: 'section', text: { type: 'mrkdwn', text: `✅ *All clear!* No orders on hold in EasyEcom this month.\n_${mtdLabel}_` } }
            ] }, HOLD_CHANNEL);
        }
        return;
    }

    const ids = orders.map(o => o.reference_code || o.store_order_id || o.marketplace_order_id || `#${o.order_id}`);
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `⏸️ EasyEcom On-Hold Orders — ${orders.length} (MTD)`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${orders.length}* order${orders.length !== 1 ? 's are' : ' is'} *On Hold* in EasyEcom _(MTD: ${mtdLabel}, oldest → newest)_.` } },
        { type: 'divider' }
    ];
    const CHUNK = 60;
    for (let i = 0; i < ids.length; i += CHUNK) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ids.slice(i, i + CHUNK).map(x => `\`${x}\``).join('  ') } });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Auto-report · daily 11 AM IST_' }] });
    await postSlack({ blocks }, HOLD_CHANNEL);
    console.log('[Hold Report] Sent to channel');
}

module.exports = { sendWarehouseOpsReport, sendDocpharmaRejectedReport, initDpSlackTrigger, sendEasyecomHoldReport };

// --- Manual run ---
// Run on demand and post to Slack immediately, then exit.
//   node app/api/warehouse_slack_report.js          → full warehouse report (last-30d, cutoff −2)
//   node app/api/warehouse_slack_report.js 1        → full warehouse report (last-30d, cutoff −1)
//   node app/api/warehouse_slack_report.js dp       → DocPharma→MWH check only (MTD)
//   node app/api/warehouse_slack_report.js hold     → EasyEcom On-Hold report (no EasyEcom API)
if (require.main === module) {
    const args = process.argv.slice(2);
    const mode = (args[0] || '').toLowerCase();
    const dpOnly = mode === 'dp';

    let run;
    if (mode === 'hold') {
        console.log('[Hold Report] Manual EasyEcom On-Hold report');
        run = sendEasyecomHoldReport(true); // announce all-clear too
    } else if (dpOnly) {
        console.log('[WH Report] Manual DocPharma→MWH check (MTD)');
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
