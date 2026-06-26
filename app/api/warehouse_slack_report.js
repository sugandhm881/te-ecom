const axios  = require('axios');
const config = require('../../config');

const GQL_URL   = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2025-01/graphql.json`;
const WH_CHANNEL = 'C0BA25AFJBG'; // warehouse-ops

function fmtLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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
    const total    = ready.length + confirmed.length + unful.length;

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
                { type: 'mrkdwn', text: `📊 *Total Pending*\n*${total}* orders` }
            ]
        },
        { type: 'divider' },
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

async function postSlack(payload) {
    const token = config.SLACK_BOT_TOKEN;
    if (!token) { console.warn('[WH Report] SLACK_BOT_TOKEN not configured'); return; }
    const res = await axios.post(
        'https://slack.com/api/chat.postMessage',
        { channel: WH_CHANNEL, ...payload },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (!res.data.ok) console.error('[WH Report] Slack error:', res.data.error);
    return res.data.ok;
}

// endOffsetDays: how many days before today the window ends.
//   8:30 AM run → 2 (data up to today−2),  5:30 PM run → 1 (data up to today−1).
// Window is the last 30 days ending at that cutoff.
async function sendWarehouseOpsReport(endOffsetDays = 2) {
    const now   = new Date();
    const endDate   = new Date(now.getFullYear(), now.getMonth(), now.getDate() - endOffsetDays);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 30);
    const start = fmtLocal(startDate);
    const end   = fmtLocal(endDate);

    console.log(`[WH Report] Fetching last-30d open orders ${start} → ${end} (cutoff −${endOffsetDays}d)…`);

    // Fetch ALL open MTD orders, oldest first (reverse:false)
    const allOrders = [];
    let cursor = null, hasNext = true;
    try {
        while (hasNext) {
            const after = cursor ? `, after:"${cursor}"` : '';
            const q = `processed_at:>='${start}' AND processed_at:<='${end}T23:59:59Z' AND status:open`;
            const gql = `{orders(first:50,sortKey:PROCESSED_AT,reverse:false,query:"${q}"${after}){edges{node{name processedAt displayFulfillmentStatus fulfillments{displayStatus}}}pageInfo{hasNextPage endCursor}}}`;

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
        await postSlack({ text: `⚠️ Warehouse Ops Report failed to fetch orders: ${e.message}` });
        return;
    }

    // Classify into status groups (order already old→new from reverse:false)
    const groups = {};
    allOrders.forEach(order => {
        const status = classifyOrder(order);
        if (!status) return;
        if (!groups[status]) groups[status] = [];
        groups[status].push(order);
    });

    const total = Object.values(groups).flat().length;
    console.log(`[WH Report] READY=${(groups.READY_FOR_PICKUP||[]).length} CONFIRMED=${(groups.CONFIRMED||[]).length} UNFULFILLABLE=${(groups.UNFULFILLABLE||[]).length} TOTAL=${total}`);

    if (total === 0) {
        await postSlack({
            blocks: [
                { type: 'header', text: { type: 'plain_text', text: `🏭 Warehouse Ops Report  |  Last 30 days · ${start} → ${end}`, emoji: true } },
                { type: 'section', text: { type: 'mrkdwn', text: '✅ *All clear!* No pending Confirmed / Ready for Pickup / Unfulfillable orders.' } },
                { type: 'context', elements: [{ type: 'mrkdwn', text: `_Auto-report_` }] }
            ]
        });
        console.log('[WH Report] Sent — all clear');
        return;
    }

    await postSlack(buildPayload(groups, start, end));
    console.log('[WH Report] Sent to warehouse-ops');
}

module.exports = { sendWarehouseOpsReport };

// --- Manual run ---
// Run on demand and post to Slack immediately, then exit.
//   node app/api/warehouse_slack_report.js        → 8:30 AM report (last 30d, cutoff −2)
//   node app/api/warehouse_slack_report.js 1      → 5:30 PM report (last 30d, cutoff −1)
if (require.main === module) {
    const offset = parseInt(process.argv[2] || '2', 10);
    console.log(`[WH Report] Manual run — cutoff −${offset}d`);
    sendWarehouseOpsReport(isNaN(offset) ? 2 : offset)
        .then(() => process.exit(0))
        .catch(e => { console.error('[WH Report] Manual run failed:', e.message); process.exit(1); });
}
