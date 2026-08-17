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

// 2026-08-17 — the yes/no approval step is GONE. An eligible batch is sent as soon as it is found and
// the result is posted to Teams. Approval used to hang on `pendingRun`, an in-memory variable, so every
// restart or redeploy silently voided a waiting batch: the card said "expires in 24 hours", the process
// forgot it in seconds, and a perfectly good "yes" was answered with "nothing is waiting for approval".
// Removing the wait removes the state, and state that does not exist cannot be lost.
let running = false;   // a bulk send is in flight — never start a second one on top of it
let lastRun = null;    // { at, mode, eligible, sent, failed } — surfaced by /auto-review/status

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
    const teamsUrl = config.TEAMS_WEBHOOK_AMAZON;
    // Footer history, because it kept lying about how to answer: it said Teams could not take a reply
    // (untrue once EcomBot arrived), then asked for a yes/no (untrue once approval was removed). There
    // is nothing to answer now, so it says so rather than inviting a reply nothing is listening for.
    if (teamsUrl) postTeams(teamsUrl, payload, { footer: '🤖 Runs automatically — no reply needed. Per-order history is on the Amazon Review page in the dashboard.' }).catch(() => {});
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

// ─────────────────────────────────────────────────────
// Main check — runs on cron, then sends immediately
// ─────────────────────────────────────────────────────

async function runAutoReviewCheck(failedOnly = false) {
    console.log(`[AutoReview] Running eligibility check${failedOnly ? ' (retry failed only)' : ''}...`);
    // The daily cron and the manual button can overlap (a 375-order send takes ~8 minutes at one request
    // every 1.2s). The send-time re-check in runBulkSend already prevents a duplicate Amazon call, but
    // two concurrent loops would still interleave their cards and double the request rate, so refuse.
    if (running) {
        console.log('[AutoReview] A send is already in progress — skipping this run.');
        return { skipped: true, reason: 'a send is already in progress' };
    }

    try {
        const result = await getEligibleOrders(failedOnly);
        const dateStr = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-'); // DD-MM-YYYY
        const titleSuffix = failedOnly ? ' (Retry Failed)' : '';

        if (!result.ordered.length) {
            await postToSlack({
                text: failedOnly
                    ? `✅ *Amazon Review — Retry Failed — ${dateStr}*\nNo previously-failed orders to retry in the ${MIN_DAYS}–${MAX_DAYS} day window.`
                    : `✅ *Amazon Auto Review — ${dateStr}*\nNo eligible orders in the ${MIN_DAYS}–${MAX_DAYS} day window. All caught up!`
            });
            console.log('[AutoReview] No eligible orders.');
            lastRun = { at: new Date().toISOString(), mode: failedOnly ? 'retry-failed' : 'full', eligible: 0, sent: 0, failed: 0 };
            return { sent: 0, failed: 0, eligible: 0 };
        }

        await postToSlack({
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
                        text: `_Prepaid orders are processed first, then COD — roughly ${Math.max(1, Math.round(result.ordered.length * SEND_DELAY_MS / 60000))} min at ${(SEND_DELAY_MS / 1000).toFixed(1)}s per request._\n\n🚀 *Sending now* — the result card follows when it finishes.`
                    }
                }
            ]
        });

        console.log(`[AutoReview] ${result.ordered.length} eligible (${result.prepaid.length} prepaid, ${result.cod.length} COD) — sending now.`);
        const out = await runBulkSend(result.ordered, failedOnly);
        return { eligible: result.ordered.length, ...out };

    } catch (e) {
        console.error('[AutoReview] Check error:', e.message);
        await postToSlack({ text: `⚠️ *Amazon Auto Review Check Failed*\n\`${e.message}\`` }).catch(() => {});
        return { error: e.message };
    }
}

// ─────────────────────────────────────────────────────
// Bulk send
// ─────────────────────────────────────────────────────

async function runBulkSend(orders, failedOnly = false) {
    running = true;
    try {
    // Idempotency guard — re-check each order's CURRENT status right before sending, so an order that was
    // already solicited ('sent') or permanently rejected (4xx / ineligible) since the report was built is
    // never hit at Amazon again. The eligibility check already excludes these at report time; this closes
    // the timing gap (stale 24h-old snapshot, a double "yes", or cron+manual retry overlapping).
    let toSend = orders;
    try {
        const ids = [...new Set(orders.map(o => o.amazon_order_id))];
        const done = new Set();
        for (let i = 0; i < ids.length; i += 300) {
            const { data } = await supabase.from('amazon_review_requests')
                .select('order_id, solicitation_status, response_code').in('order_id', ids.slice(i, i + 300));
            (data || []).forEach(r => {
                if (r.solicitation_status === 'sent' || r.solicitation_status === 'ineligible' ||
                    (r.solicitation_status === 'failed' && isPermanentCode(r.response_code))) done.add(r.order_id);
            });
        }
        const skipped = orders.filter(o => done.has(o.amazon_order_id)).length;
        if (skipped) { toSend = orders.filter(o => !done.has(o.amazon_order_id)); console.log(`[AutoReview] Send-time re-check: skipping ${skipped} already-done order(s) → no duplicate Amazon call`); }
    } catch (e) { console.error('[AutoReview] send-time re-check failed — proceeding with full list:', e.message); }

    console.log(`[AutoReview] Bulk send starting — ${toSend.length} orders`);
    let sent = 0, failed = 0;
    const failures = [];

    for (const order of toSend) {
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
    lastRun = { at: new Date().toISOString(), mode: failedOnly ? 'retry-failed' : 'full', eligible: orders.length, sent, failed };

    // The result card is the ONLY record most people see, so it posts even when nothing was sent —
    // a silent run is indistinguishable from a broken one.
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
    return { sent, failed };
    } finally { running = false; }   // must release even if a send throws, or every later run is refused
}

// ─────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────

// Manual trigger. Default stays retry-failed (what the dashboard button has always done); ?mode=full
// runs the same complete check the 10:00 cron runs — needed when a day's batch was missed, since
// retry-failed only revisits orders that previously errored and would find nothing.
// Both SEND IMMEDIATELY. There is no confirmation step any more.
router.post('/auto-review/trigger', (req, res) => {
    const full = String(req.query.mode || req.body?.mode || '') === 'full';
    if (running) return res.status(409).json({ success: false, error: 'A send is already in progress — wait for the result card in Teams.' });
    res.json({ success: true, mode: full ? 'full' : 'retry-failed', message: full
        ? 'Full eligibility check started — requests are being sent now; the result posts to Teams.'
        : 'Retry-failed check started — requests are being sent now; the result posts to Teams.' });
    runAutoReviewCheck(!full).catch(e => console.error('[AutoReview] Trigger error:', e.message));
});

router.get('/auto-review/status', (req, res) => {
    res.json({
        running,                                   // a bulk send is in flight right now
        approval_required: false,                  // removed 2026-08-17 — batches send automatically
        schedule: config.AUTO_REVIEW_CRON || '0 10 * * *',
        last_run: lastRun                          // { at, mode, eligible, sent, failed } | null
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

// ── Approval hooks kept for the Teams listener, which still routes "yes"/"no" and "amazon yes" ──
// Amazon no longer waits for anyone, so these only explain themselves. They stay because the listener
// shares a channel with the Tally approval: hasPendingReview() returning false is what lets a bare
// "yes" there resolve to the Tally batch instead of being reported as ambiguous.
const NO_APPROVAL = 'Amazon review no longer needs approval — eligible orders are sent automatically at 10:00 IST, and the result is posted here';

async function approvePendingReview() { return { ok: false, reason: NO_APPROVAL }; }
async function cancelPendingReview()  { return { ok: false, reason: `${NO_APPROVAL}. Nothing was cancelled` }; }
function hasPendingReview()           { return false; }

module.exports = { router, initAutoReviewCron, runAutoReviewCheck, approvePendingReview, cancelPendingReview, hasPendingReview };
