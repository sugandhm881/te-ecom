// Teams keyword listener — replaces the old Slack inbound polling.
// Uses a delegated Microsoft Graph token (device-code flow, refresh token in .env) to READ the
// Amazon + DP channel messages and fire the same actions the Slack "yes"/"rejected" replies did:
//   • Amazon channel  →  "yes"/"no"   → approve & send / cancel the pending review run
//   • DP channel      →  "rejected"   → run the DocPharma-rejected check on demand
// Only NEW messages posted after startup are acted on. Set TEAMS_LISTENER_DRYRUN=1 to log-only.
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { postTeams } = require('./teams');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const DRYRUN = () => process.env.TEAMS_LISTENER_DRYRUN === '1';

const cfg = k => process.env[k] || config[k];
const TENANT = () => cfg('TEAMS_TENANT_ID');
const CLIENT = () => cfg('TEAMS_CLIENT_ID');
const TEAM_ID = () => cfg('TEAMS_TEAM_ID');
const CH_DP = () => cfg('TEAMS_CHANNEL_DP');
const CH_AMZ = () => cfg('TEAMS_CHANNEL_AMAZON');
// Finance channel — the Tally nightly-push approval boundary. Only admins should be members of it:
// Teams gives the listener no role information, so membership of this channel IS the authorisation.
const CH_FIN = () => cfg('TEAMS_CHANNEL_FINANCE');

// ── token management (refresh-token flow; persists the rotated refresh token) ──
let accessToken = null, tokenExpiry = 0;

function persistRefreshToken(rt) {
    try {
        let env = fs.readFileSync(ENV_PATH, 'utf8');
        const re = /^TEAMS_REFRESH_TOKEN=.*$/m;
        env = re.test(env) ? env.replace(re, `TEAMS_REFRESH_TOKEN=${rt}`) : env.replace(/\n?$/, '\n') + `TEAMS_REFRESH_TOKEN=${rt}\n`;
        fs.writeFileSync(ENV_PATH, env);
        process.env.TEAMS_REFRESH_TOKEN = rt;
    } catch (e) { console.error('[TeamsListener] persist refresh token failed:', e.message); }
}

async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiry - 120000) return accessToken;
    const refreshToken = process.env.TEAMS_REFRESH_TOKEN || config.TEAMS_REFRESH_TOKEN;
    if (!refreshToken) throw new Error('no TEAMS_REFRESH_TOKEN');
    const res = await axios.post(
        `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/token`,
        new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT(), refresh_token: refreshToken,
            scope: 'offline_access ChannelMessage.Read.All User.Read' }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true, timeout: 15000 }
    );
    if (res.status !== 200) throw new Error(`token refresh ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    accessToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
    if (res.data.refresh_token) persistRefreshToken(res.data.refresh_token);
    return accessToken;
}

// ── channel reading ──
function plainText(html) {
    return String(html || '')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

const lastSeen = {};       // channelId -> epoch ms watermark
const processedIds = new Set(); // message ids already acted on (belt-and-suspenders dedup)

// `/messages` returns ONLY top-level channel posts — Graph does not include thread replies there.
// That matters when a report is posted by a "Reply with a message in a channel" Flow: the card lands
// inside a thread, so the obvious place to type "yes" is that same thread, where the plain channel read
// would never see it. Pass withReplies for such a channel and the replies of the few most recent roots
// are scanned too (bounded on purpose — this runs every 20s).
async function fetchNewMessages(channelId, withReplies = false) {
    const token = await getAccessToken();
    const auth = { headers: { Authorization: 'Bearer ' + token }, validateStatus: () => true, timeout: 15000 };
    const res = await axios.get(
        `https://graph.microsoft.com/v1.0/teams/${TEAM_ID()}/channels/${channelId}/messages?$top=15`, auth);
    if (res.status !== 200) { console.error(`[TeamsListener] read ${channelId} → ${res.status}`); return []; }
    const msgs = (res.data.value || []).slice();

    if (withReplies) {
        // Only threads from the last 2 days, at most 3 — enough to catch an answer to the newest card
        // without turning a 20s poll into a Graph API firehose.
        const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
        const roots = msgs
            .filter(m => new Date(m.createdDateTime).getTime() > cutoff)
            .sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime))
            .slice(0, 3);
        for (const root of roots) {
            const rr = await axios.get(
                `https://graph.microsoft.com/v1.0/teams/${TEAM_ID()}/channels/${channelId}/messages/${root.id}/replies?$top=20`, auth);
            if (rr.status === 200) msgs.push(...(rr.data.value || []));
            else console.error(`[TeamsListener] replies ${root.id} → ${rr.status}`);
        }
    }

    const since = lastSeen[channelId] || 0;
    const fresh = msgs
        .filter(m => m.from && m.from.user)                                  // real user, not Flow bot/system
        .filter(m => new Date(m.createdDateTime).getTime() > since)
        .map(m => ({ id: m.id, ts: m.createdDateTime, from: m.from.user.displayName, text: plainText(m.body && m.body.content) }))
        .sort((a, b) => new Date(a.ts) - new Date(b.ts));                    // oldest-first for processing
    // Watermark spans roots AND replies, so a reply is never skipped just because a newer root arrived.
    const newest = msgs.reduce((mx, m) => Math.max(mx, new Date(m.createdDateTime).getTime()), since);
    lastSeen[channelId] = Math.max(since, newest);
    return fresh;
}

// ── action hooks (lazy-required to avoid circular deps at load) ──
function amazonApi()  { return require('./amazon_auto_review'); }
function whReport()   { return require('./warehouse_slack_report'); }
function tallyBatchApi() { return require('./tally_batch'); }

// Immediate acknowledgement back into the same channel so the user knows the keyword landed.
function ackTeams(webhookUrl, text) {
    if (!webhookUrl) return;
    postTeams(webhookUrl, { blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }).catch(() => {});
}

let polling = false;
// ── keyword handlers ──
function runDpCheck(from) {
    ackTeams(cfg('TEAMS_WEBHOOK_DP'), `🔄 *Got it — "rejected" from ${from}.* Running the DocPharma → warehouse check now _(≈1-2 min; the result card follows)_…`);
    whReport().sendDocpharmaRejectedReport(true).catch(e => console.error('[TeamsListener] DP run:', e.message));
}

function runAmazon(isYes, from) {
    const url = cfg('TEAMS_WEBHOOK_AMAZON');
    if (isYes) {
        ackTeams(url, `🔄 *Got it — "yes" from ${from}.* Approving & sending the review requests now…`);
        amazonApi().approvePendingReview().then(r => {
            console.log('[TeamsListener] amazon approve →', JSON.stringify(r));
            if (r.ok) ackTeams(url, `✅ *Sent ${r.sent} review request${r.sent === 1 ? '' : 's'}.*`);
            else ackTeams(url, `⚠️ *Nothing sent* — ${r.reason}.`);
        }).catch(e => console.error('[TeamsListener] amazon approve:', e.message));
    } else {
        ackTeams(url, `🛑 *Got it — "no" from ${from}.* Cancelling the pending review run.`);
        amazonApi().cancelPendingReview().then(r => console.log('[TeamsListener] amazon cancel →', JSON.stringify(r)))
            .catch(e => console.error('[TeamsListener] amazon cancel:', e.message));
    }
}

function runTally(cmd, from) {
    tallyBatchApi().handleTeamsKeyword(cmd, from).then(r => {
        console.log('[TeamsListener] tally batch →', JSON.stringify(r));
        if (!r.ok) ackTeams(cfg('TEAMS_WEBHOOK_FINANCE'), `⚠️ *Nothing to do* — ${r.reason}.`);
    }).catch(e => console.error('[TeamsListener] tally batch:', e.message));
}

// Parses an approval instruction out of a chat message, or returns null for ordinary conversation.
//
// The command must be the WHOLE message (optionally prefixed with a flow name, optionally followed by a
// batch ref). Loose prefix matching is dangerous here: `/^no\b/` would treat "no idea what happened
// there" as a rejection, and in a channel where people actually talk that WILL happen.
//
//   yes | y | confirm | approve | ok        → approve whatever is pending
//   no  | n | cancel  | reject             → reject it
//   tally yes / amazon no                   → target one flow explicitly
//   approve TB-20260730-1 / reject TB-…     → target one specific batch
function parseApproval(raw) {
    const text = String(raw || '').trim().replace(/[.!\s]+$/, '');
    const t = text.toLowerCase();

    let target = null, rest = t;
    const pre = t.match(/^(tally|amazon)\s+(.+)$/);
    if (pre) { target = pre[1]; rest = pre[2].trim(); }

    const ref = text.match(/\b(TB-\d{8}-\d+)\b/i);
    if (ref) target = 'tally';                      // a batch ref can only mean the Tally push

    const YES = /^(yes|y|confirm|approve|ok)$/;
    const NO = /^(no|n|cancel|reject)$/;
    let verb = null;
    if (YES.test(rest)) verb = 'yes';
    else if (NO.test(rest)) verb = 'no';
    else {
        // "approve TB-20260730-1" — verb plus a ref, and nothing else.
        const m = rest.match(/^(approve|reject|yes|no)\s+tb-\d{8}-\d+$/);
        if (m) verb = /^(approve|yes)$/.test(m[1]) ? 'yes' : 'no';
    }
    if (!verb) return null;
    return { verb, target, ref: ref ? ref[1].toUpperCase() : null };
}

// Routes an approval when a channel may serve BOTH the Amazon review batch and the Tally push. An
// explicit target always wins; a bare yes/no goes to whichever flow is genuinely pending, and if BOTH
// are pending it refuses to guess — approving the wrong one either spams customers or posts money.
async function handleApproval(m, roles) {
    const cmd = parseApproval(m.text);
    if (!cmd) return;
    const isYes = cmd.verb === 'yes';
    // handleTeamsKeyword understands bare yes/no and "approve TB-…"/"reject TB-…".
    const tallyCmd = cmd.ref ? `${isYes ? 'approve' : 'reject'} ${cmd.ref}` : cmd.verb;

    if (cmd.target === 'tally' && roles.has('finance')) {
        console.log(`[TeamsListener] Tally "${m.text}" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
        if (!DRYRUN()) runTally(tallyCmd, m.from);
        return;
    }
    if (cmd.target === 'amazon' && roles.has('amazon')) {
        console.log(`[TeamsListener] Amazon "${m.text}" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
        if (!DRYRUN()) runAmazon(isYes, m.from);
        return;
    }
    if (cmd.target) return;   // named a flow this channel doesn't serve — not ours to action

    const tallyPending = roles.has('finance') ? await tallyBatchApi().hasPendingBatch().catch(() => null) : null;
    const amazonPending = roles.has('amazon') ? !!amazonApi().hasPendingReview() : false;

    if (tallyPending && amazonPending) {
        console.log(`[TeamsListener] ambiguous "${m.text}" from ${m.from} — Tally and Amazon are both pending`);
        if (!DRYRUN()) ackTeams(cfg('TEAMS_WEBHOOK_FINANCE') || cfg('TEAMS_WEBHOOK_AMAZON'),
            `⚠️ *Two things are waiting, so "${m.text}" is ambiguous — nothing has been actioned.*\n` +
            `· Tally batch *${tallyPending.ref}* (${tallyPending.voucher_count} voucher(s)) → reply *${isYes ? 'approve' : 'reject'} ${tallyPending.ref}*\n` +
            `· Amazon review batch → reply *amazon ${isYes ? 'yes' : 'no'}*`);
        return;
    }
    if (tallyPending) {
        console.log(`[TeamsListener] Tally "${m.text}" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
        if (!DRYRUN()) runTally(tallyCmd, m.from);
        return;
    }
    if (amazonPending) {
        console.log(`[TeamsListener] Amazon "${m.text}" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
        if (!DRYRUN()) runAmazon(isYes, m.from);
        return;
    }
    // Nothing pending — stay silent. People hold ordinary conversations in these channels.
}

async function pollOnce() {
    if (polling) return; polling = true;
    try {
        // Map channel → the flows watching it, so a channel serving two flows is fetched ONCE. Fetching
        // it twice would be a bug, not just waste: `lastSeen` is keyed by channel id, so the first read
        // advances the watermark and the second sees nothing at all.
        const roles = new Map();
        const add = (id, role) => { if (!id) return; if (!roles.has(id)) roles.set(id, new Set()); roles.get(id).add(role); };
        add(CH_DP(), 'dp'); add(CH_AMZ(), 'amazon'); add(CH_FIN(), 'finance');

        for (const [channelId, set] of roles) {
            // Finance cards may be posted as thread replies, which `/messages` alone never returns.
            const msgs = await fetchNewMessages(channelId, set.has('finance'));
            for (const m of msgs) {
                if (processedIds.has(m.id)) continue; processedIds.add(m.id);
                if (set.has('dp') && /(^|\b)rejected(\b|$)/i.test(m.text)) {
                    console.log(`[TeamsListener] DP "rejected" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
                    if (!DRYRUN()) runDpCheck(m.from);
                }
                if (set.has('amazon') || set.has('finance')) await handleApproval(m, set);
            }
        }
    } catch (e) {
        console.error('[TeamsListener] poll error:', e.message);
    } finally {
        if (processedIds.size > 500) { const keep = [...processedIds].slice(-200); processedIds.clear(); keep.forEach(id => processedIds.add(id)); }
        polling = false;
    }
}

let timer = null;
async function initTeamsListener() {
    if (!cfg('TEAMS_REFRESH_TOKEN')) { console.log('[TeamsListener] disabled (no TEAMS_REFRESH_TOKEN)'); return; }
    if (!TEAM_ID() || (!CH_DP() && !CH_AMZ() && !CH_FIN())) { console.log('[TeamsListener] disabled (no team/channel IDs)'); return; }
    const now = Date.now();
    if (CH_DP()) lastSeen[CH_DP()] = now;   // ignore anything posted before startup
    if (CH_AMZ()) lastSeen[CH_AMZ()] = now;
    // Sharing one channel between the Tally push and the Amazon review approval IS supported: the poll
    // loop fetches each channel once and routes a bare yes/no to whichever flow is actually pending
    // (and refuses to guess when both are). Worth logging, because it also means anyone who can post in
    // that channel can approve a Tally push — channel membership is the only authorisation Graph gives us.
    if (CH_FIN() && (CH_FIN() === CH_AMZ() || CH_FIN() === CH_DP())) {
        console.warn('[TeamsListener] note: TEAMS_CHANNEL_FINANCE shares a channel with ' +
            (CH_FIN() === CH_AMZ() ? 'TEAMS_CHANNEL_AMAZON' : 'TEAMS_CHANNEL_DP') +
            ' — supported; bare yes/no is routed by what is pending. Everyone in that channel can approve a Tally push.');
    }
    if (CH_FIN()) lastSeen[CH_FIN()] = now;
    try { await getAccessToken(); }
    catch (e) { console.error('[TeamsListener] token init failed — NOT started:', e.message); return; }
    const interval = parseInt(process.env.TEAMS_LISTENER_INTERVAL_MS || '20000', 10);
    if (timer) clearInterval(timer);
    timer = setInterval(pollOnce, interval);
    console.log(`[TeamsListener] started${DRYRUN() ? ' (DRY-RUN)' : ''} — watching ${[CH_DP() && 'DP', CH_AMZ() && 'Amazon', CH_FIN() && 'Finance'].filter(Boolean).join(' + ')} channel(s) every ${interval / 1000}s`);
}

module.exports = { initTeamsListener, pollOnce, fetchNewMessages, getAccessToken, parseApproval, _lastSeen: lastSeen };
