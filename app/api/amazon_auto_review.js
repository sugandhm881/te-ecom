const express  = require('express');
const router   = express.Router();
const cron     = require('node-cron');
const axios    = require('axios');
const { supabase }             = require('../supabase');
const { makeSignedApiRequest } = require('./helpers');
const config   = require('../../config');

const MARKETPLACE_ID  = config.MARKETPLACE_ID || 'A21TJRUUN4KGV';
const MIN_DAYS        = 10;
const MAX_DAYS        = 30;
const SEND_DELAY_MS   = 1200;
const POLL_INTERVAL   = 20000; // check Slack every 20s

let pendingRun   = null; // { orders, expiry, messageTz }
let pollingTimer = null;

// ─────────────────────────────────────────────────────
// Order helpers
// ─────────────────────────────────────────────────────

function isCOD(order) {
    const p = (order.payment_method || '').toLowerCase();
    return p.includes('cod') || p.includes('cash');
}

function isExcluded(order) {
    const s = (order.order_status || '').toLowerCase();
    return s.includes('cancel') || s.includes('rto') ||
           s.includes('return') || s.includes('replac');
}

// A 4xx solicitation failure (esp. 403) is PERMANENT — Amazon already requested the review or the window
// is closed, so retrying always returns the same error. Only 429/5xx/network are worth re-attempting.
const isPermanentCode = c => [400, 403, 404, 405].includes(Number(c));

// Human-readable reason for a solicitation failure (instead of a bare "HTTP 403").
function failReason(code, body) {
    let msg = '';
    try { const b = typeof body === 'string' ? JSON.parse(body) : body; msg = (b && b.errors && b.errors[0] && b.errors[0].message) || ''; } catch (_) {}
    const c = Number(code);
    if (c === 403) return 'Not eligible — Amazon already sent a review request or the review window is closed';
    if (c === 400) return msg || 'Ineligible / bad request';
    if (c === 404) return 'Order not found at Amazon';
    if (c === 429) return 'Rate-limited — will retry next run';
    if (c >= 500) return 'Amazon server error — will retry next run';
    return msg || `HTTP ${c}`;
}

// failedOnly=true → retry ONLY orders whose previous request failed (manual button).
// failedOnly=false → normal cron behaviour: every eligible order not yet successfully sent.
async function getEligibleOrders(failedOnly = false) {
    const now   = Date.now();
    const minDt = new Date(now - MAX_DAYS * 86400000).toISOString();
    const maxDt = new Date(now - MIN_DAYS * 86400000).toISOString();

    const [ordersRes, requestsRes] = await Promise.all([
        supabase
            .from('amazon_orders')
            .select('amazon_order_id, order_status, payment_method, latest_delivery_date, purchase_date')
            .not('latest_delivery_date', 'is', null)
            .gte('latest_delivery_date', minDt)
            .lte('latest_delivery_date', maxDt),

        supabase
            .from('amazon_review_requests')
            .select('order_id, solicitation_status, response_code')
    ]);

    if (ordersRes.error) throw new Error('Orders query failed: ' + ordersRes.error.message);

    const reqs = requestsRes.data || [];
    const sentIds = new Set(reqs.filter(r => r.solicitation_status === 'sent').map(r => r.order_id));
    const ineligibleIds = new Set(reqs.filter(r => r.solicitation_status === 'ineligible').map(r => r.order_id));
    // Split failures: permanent (4xx → never retry) vs transient (429/5xx → retryable).
    const permanentFailIds = new Set(reqs.filter(r => r.solicitation_status === 'failed' &&  isPermanentCode(r.response_code)).map(r => r.order_id));
    const transientFailIds = new Set(reqs.filter(r => r.solicitation_status === 'failed' && !isPermanentCode(r.response_code)).map(r => r.order_id));
    // Orders Amazon won't accept a solicitation for → sent, 4xx-failed, or already marked ineligible.
    const permanentIds = id => permanentFailIds.has(id) || ineligibleIds.has(id);

    const allOrders   = ordersRes.data || [];
    const excluded    = allOrders.filter(o => isExcluded(o));
    const alreadySent = allOrders.filter(o => !isExcluded(o) && sentIds.has(o.amazon_order_id));
    // Permanently not-eligible (403 / ineligible) orders still in the window — reported as a count, never re-attempted.
    const skippedPermanent = allOrders.filter(o => !isExcluded(o) && !sentIds.has(o.amazon_order_id) && permanentIds(o.amazon_order_id));
    // Eligible = not excluded, not already sent, and NOT permanently ineligible → the same 403s stop reappearing every run.
    let eligible = allOrders.filter(o => !isExcluded(o) && !sentIds.has(o.amazon_order_id) && !permanentIds(o.amazon_order_id));

    // Manual retry mode: only the genuinely retryable (transient) failures.
    if (failedOnly) {
        eligible = eligible.filter(o => transientFailIds.has(o.amazon_order_id));
    }

    const prepaid = eligible.filter(o => !isCOD(o));
    const cod     = eligible.filter(o =>  isCOD(o));

    return { ordered: [...prepaid, ...cod], prepaid, cod, alreadySent, excluded, skippedPermanent, failedOnly };
}

// ─────────────────────────────────────────────────────
// Slack helpers
// ─────────────────────────────────────────────────────

const { postTeams } = require('./teams');
async function postToSlack(payload) {
    // Teams — approvals moved to the dashboard, so the card links there instead of asking for a yes/no reply.
    const teamsUrl = config.TEAMS_WEBHOOK_AMAZON;
    if (teamsUrl) postTeams(teamsUrl, payload, { actionUrl: config.DASHBOARD_URL, actionTitle: 'Review & approve in dashboard', footer: '➡️ Approve & send review requests from the Amazon Review page in the dashboard (Teams can’t take a yes/no reply).' }).catch(() => {});
    const token   = config.SLACK_BOT_TOKEN;
    const channel = config.SLACK_CHANNEL_ID;
    if (!token || !channel) {
        if (!teamsUrl) console.warn('[AutoReview] no Slack + no Teams webhook set');
        return null;
    }
    const res = await axios.post(
        'https://slack.com/api/chat.postMessage',
        { channel, ...payload },
        { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (!res.data.ok) {
        console.error('[AutoReview] Slack API error:', res.data.error);
        return null;
    }
    return res.data.ts;
}

async function pollForReply(afterTs) {
    const token   = config.SLACK_BOT_TOKEN;
    const channel = config.SLACK_CHANNEL_ID;
    try {
        const res = await axios.get('https://slack.com/api/conversations.history', {
            params:  { channel, oldest: afterTs, limit: 10 },
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.data.ok) {
            console.error('[AutoReview] conversations.history error:', res.data.error);
            return null;
        }

        // Find first human message after the report
        const human = (res.data.messages || [])
            .filter(m => !m.bot_id && !m.subtype && m.ts !== afterTs)
            .reverse(); // oldest first

        for (const msg of human) {
            const t = (msg.text || '').toLowerCase().trim();
            if (t === 'yes' || t === 'y')  return 'yes';
            if (t === 'no'  || t === 'n')  return 'no';
        }
    } catch (e) {
        console.error('[AutoReview] Poll error:', e.message);
    }
    return null;
}

// ─────────────────────────────────────────────────────
// Polling loop — started after Slack report is sent
// ─────────────────────────────────────────────────────

function stopPolling() {
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
}

function startPolling(messageTz, orders) {
    stopPolling();
    const expiry = Date.now() + 24 * 60 * 60 * 1000;
    console.log('[AutoReview] Waiting for yes/no in Slack...');

    pollingTimer = setInterval(async () => {
        if (Date.now() > expiry) {
            stopPolling();
            pendingRun = null;
            await postToSlack({ text: '⏰ *Auto Review expired* — no response received in 24h. Run will not proceed.' }).catch(() => {});
            console.log('[AutoReview] Confirmation expired.');
            return;
        }

        const reply = await pollForReply(messageTz);
        if (!reply) return; // no answer yet

        stopPolling();
        pendingRun = null;

        if (reply === 'yes') {
            console.log('[AutoReview] Confirmed via Slack — starting bulk send');
            await postToSlack({
                text: `✅ *Confirmed!* Starting review requests for *${orders.length} orders*...\n_Prepaid first, then COD. Results will be posted when done._`
            }).catch(() => {});
            runBulkSend(orders).catch(e => console.error('[AutoReview] Bulk send error:', e.message));
        } else {
            console.log('[AutoReview] Cancelled via Slack');
            await postToSlack({ text: '❌ *Auto review cancelled.* No requests have been sent.' }).catch(() => {});
        }
    }, POLL_INTERVAL);
}

// ─────────────────────────────────────────────────────
// Main check — runs on cron
// ─────────────────────────────────────────────────────

async function runAutoReviewCheck(failedOnly = false) {
    console.log(`[AutoReview] Running eligibility check${failedOnly ? ' (retry failed only)' : ''}...`);
    stopPolling(); // cancel any previous pending run

    try {
        const result = await getEligibleOrders(failedOnly);
        const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        const titleSuffix = failedOnly ? ' (Retry Failed)' : '';

        if (!result.ordered.length) {
            await postToSlack({
                text: failedOnly
                    ? `✅ *Amazon Review — Retry Failed — ${dateStr}*\nNo previously-failed orders to retry in the ${MIN_DAYS}–${MAX_DAYS} day window.`
                    : `✅ *Amazon Auto Review — ${dateStr}*\nNo eligible orders in the ${MIN_DAYS}–${MAX_DAYS} day window. All caught up!`
            });
            console.log('[AutoReview] No eligible orders.');
            return;
        }

        const ts = await postToSlack({
            blocks: [
                {
                    type: 'header',
                    text: { type: 'plain_text', text: `🔔 Amazon Review Auto-Run${titleSuffix} — ${dateStr}`, emoji: true }
                },
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: failedOnly
                        ? `*Retrying previously-failed review requests (${MIN_DAYS}–${MAX_DAYS} days after delivery):*`
                        : `*Orders eligible for review request (${MIN_DAYS}–${MAX_DAYS} days after delivery):*` }
                },
                {
                    type: 'section',
                    fields: [
                        { type: 'mrkdwn', text: `💳 *Prepaid:*\n${result.prepaid.length} orders` },
                        { type: 'mrkdwn', text: `💵 *COD:*\n${result.cod.length} orders` },
                        { type: 'mrkdwn', text: `✅ *Total to Send:*\n${result.ordered.length} orders` },
                        { type: 'mrkdwn', text: `⏭ *Already Sent (skip):*\n${result.alreadySent.length} orders` },
                        { type: 'mrkdwn', text: `❌ *Excluded (RTO/Return/Cancel):*\n${result.excluded.length} orders` },
                        { type: 'mrkdwn', text: `🚫 *Not eligible (403 · won't retry):*\n${result.skippedPermanent.length} orders` }
                    ]
                },
                { type: 'divider' },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `_Prepaid orders will be processed first, then COD._\n\n*Reply in this channel:*\n• Type \`yes\` to confirm and start sending\n• Type \`no\` to cancel\n\n⏳ _Waiting for your reply (expires in 24 hours)_`
                    }
                }
            ]
        });

        // Set the pending run regardless of Slack — the Teams listener approves it via "yes"
        // when there's no Slack ts (Teams-only mode). The Slack yes/no poll runs only if Slack is on.
        pendingRun = { orders: result.ordered, ts: ts || null, expiry: Date.now() + 24 * 60 * 60 * 1000 };
        if (ts) startPolling(ts, result.ordered);

        console.log(`[AutoReview] Report sent — ${result.ordered.length} eligible (${result.prepaid.length} prepaid, ${result.cod.length} COD). Polling for reply...`);

    } catch (e) {
        console.error('[AutoReview] Check error:', e.message);
        await postToSlack({ text: `⚠️ *Amazon Auto Review Check Failed*\n\`${e.message}\`` }).catch(() => {});
    }
}

// ─────────────────────────────────────────────────────
// Bulk send
// ─────────────────────────────────────────────────────

async function runBulkSend(orders) {
    console.log(`[AutoReview] Bulk send starting — ${orders.length} orders`);
    let sent = 0, failed = 0;
    const failures = [];

    for (const order of orders) {
        try {
            await makeSignedApiRequest({
                method: 'POST',
                path: `/solicitations/v1/orders/${order.amazon_order_id}/solicitations/productReviewAndSellerFeedback`,
                queryParams: { marketplaceIds: MARKETPLACE_ID },
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
            await supabase.from('amazon_review_requests').upsert({
                order_id: order.amazon_order_id, solicitation_status: 'sent',
                attempted_at: new Date().toISOString(), response_code: 201, response_body: '{}'
            }, { onConflict: 'order_id' });
            sent++;
            console.log(`[AutoReview] ✅ ${order.amazon_order_id}`);
        } catch (e) {
            const code = e.response?.status || 500;
            const body = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            await supabase.from('amazon_review_requests').upsert({
                order_id: order.amazon_order_id, solicitation_status: 'failed',
                attempted_at: new Date().toISOString(), response_code: code, response_body: body
            }, { onConflict: 'order_id' });
            failures.push({ id: order.amazon_order_id, code, body });
            failed++;
            console.error(`[AutoReview] ✗ ${order.amazon_order_id} — HTTP ${code}`);
        }
        await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    }

    console.log(`[AutoReview] Done — ${sent} sent, ${failed} failed`);

    await postToSlack({
        blocks: [
            { type: 'header', text: { type: 'plain_text', text: '📊 Amazon Auto Review — Complete', emoji: true } },
            {
                type: 'section',
                fields: [
                    { type: 'mrkdwn', text: `✅ *Sent:*\n${sent} orders` },
                    { type: 'mrkdwn', text: `❌ *Failed:*\n${failed} orders` }
                ]
            },
            ...(failures.length ? [{
                type: 'section',
                text: { type: 'mrkdwn', text: '*Failed — grouped by reason:*\n' + (() => {
                    const byReason = {};
                    failures.forEach(f => { const r = failReason(f.code, f.body); (byReason[r] = byReason[r] || []).push(f.id); });
                    return Object.entries(byReason)
                        .sort((a, b) => b[1].length - a[1].length)
                        .map(([r, ids]) => `• *${ids.length}* — ${r}${ids.length <= 6 ? '\n   ' + ids.map(i => '`' + i + '`').join('  ') : ''}`)
                        .join('\n');
                })() }
            }] : []),
            { type: 'context', elements: [{ type: 'mrkdwn', text: `Completed at ${new Date().toLocaleString('en-IN')}` }] }
        ]
    }).catch(() => {});
}

// ─────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────

// Manual trigger → retry ONLY previously-failed orders (failedOnly=true).
router.post('/auto-review/trigger', (req, res) => {
    res.json({ success: true, message: 'Retry-failed check triggered — reply yes/no in Slack' });
    runAutoReviewCheck(true).catch(e => console.error('[AutoReview] Trigger error:', e.message));
});

router.get('/auto-review/status', (req, res) => {
    res.json({
        pending:    !!pendingRun,
        polling:    !!pollingTimer,
        orderCount: pendingRun?.orders?.length || 0,
        prepaid:    pendingRun?.orders?.filter(o => !isCOD(o)).length || 0,
        cod:        pendingRun?.orders?.filter(o =>  isCOD(o)).length || 0,
        expiry:     pendingRun?.expiry || null
    });
});

// ─────────────────────────────────────────────────────
// Cron
// ─────────────────────────────────────────────────────

function initAutoReviewCron() {
    const schedule = config.AUTO_REVIEW_CRON || '0 10 * * *';
    // Wrap so node-cron's execution context can't leak into `failedOnly` —
    // the daily cron always runs the full eligibility check (failedOnly=false).
    cron.schedule(schedule, () => runAutoReviewCheck(false), { timezone: 'Asia/Kolkata' });
    console.log(`[AutoReview] Cron scheduled: "${schedule}" (IST)`);
}

// ── Teams-triggered approval (the Teams listener calls these in place of the Slack yes/no reply) ──
async function approvePendingReview() {
    if (!pendingRun) return { ok: false, reason: 'no pending review run' };
    if (Date.now() > pendingRun.expiry) { pendingRun = null; return { ok: false, reason: 'pending run expired' }; }
    const orders = pendingRun.orders;
    pendingRun = null;
    stopPolling();
    await runBulkSend(orders);
    return { ok: true, sent: orders.length };
}

async function cancelPendingReview() {
    if (!pendingRun) return { ok: false, reason: 'no pending review run' };
    pendingRun = null;
    stopPolling();
    await postToSlack({ text: '❌ *Auto review cancelled.* No requests have been sent.' }).catch(() => {});
    return { ok: true };
}

module.exports = { router, initAutoReviewCron, runAutoReviewCheck, approvePendingReview, cancelPendingReview };
