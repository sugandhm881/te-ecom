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

async function fetchNewMessages(channelId) {
    const token = await getAccessToken();
    const res = await axios.get(
        `https://graph.microsoft.com/v1.0/teams/${TEAM_ID()}/channels/${channelId}/messages?$top=15`,
        { headers: { Authorization: 'Bearer ' + token }, validateStatus: () => true, timeout: 15000 }
    );
    if (res.status !== 200) { console.error(`[TeamsListener] read ${channelId} → ${res.status}`); return []; }
    const msgs = res.data.value || [];
    const since = lastSeen[channelId] || 0;
    const fresh = msgs
        .filter(m => m.from && m.from.user)                                  // real user, not Flow bot/system
        .filter(m => new Date(m.createdDateTime).getTime() > since)
        .map(m => ({ id: m.id, ts: m.createdDateTime, from: m.from.user.displayName, text: plainText(m.body && m.body.content) }))
        .sort((a, b) => new Date(a.ts) - new Date(b.ts));                    // oldest-first for processing
    const newest = msgs.reduce((mx, m) => Math.max(mx, new Date(m.createdDateTime).getTime()), since);
    lastSeen[channelId] = Math.max(since, newest);
    return fresh;
}

// ── action hooks (lazy-required to avoid circular deps at load) ──
function amazonApi()  { return require('./amazon_auto_review'); }
function whReport()   { return require('./warehouse_slack_report'); }

// Immediate acknowledgement back into the same channel so the user knows the keyword landed.
function ackTeams(webhookUrl, text) {
    if (!webhookUrl) return;
    postTeams(webhookUrl, { blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }).catch(() => {});
}

let polling = false;
async function pollOnce() {
    if (polling) return; polling = true;
    try {
        if (CH_DP()) {
            for (const m of await fetchNewMessages(CH_DP())) {
                if (processedIds.has(m.id)) continue; processedIds.add(m.id);
                if (/(^|\b)rejected(\b|$)/i.test(m.text)) {
                    console.log(`[TeamsListener] DP "rejected" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
                    if (!DRYRUN()) {
                        ackTeams(cfg('TEAMS_WEBHOOK_DP'), `🔄 *Got it — "rejected" from ${m.from}.* Running the DocPharma → warehouse check now _(≈1-2 min; the result card follows)_…`);
                        whReport().sendDocpharmaRejectedReport(true).catch(e => console.error('[TeamsListener] DP run:', e.message));
                    }
                }
            }
        }
        if (CH_AMZ()) {
            for (const m of await fetchNewMessages(CH_AMZ())) {
                if (processedIds.has(m.id)) continue; processedIds.add(m.id);
                const t = m.text.trim().toLowerCase();
                if (t === 'yes' || t === 'y' || t === 'confirm') {
                    console.log(`[TeamsListener] Amazon "yes" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
                    if (!DRYRUN()) {
                        ackTeams(cfg('TEAMS_WEBHOOK_AMAZON'), `🔄 *Got it — "yes" from ${m.from}.* Approving & sending the review requests now…`);
                        amazonApi().approvePendingReview().then(r => {
                            console.log('[TeamsListener] approve →', JSON.stringify(r));
                            if (r.ok) ackTeams(cfg('TEAMS_WEBHOOK_AMAZON'), `✅ *Sent ${r.sent} review request${r.sent === 1 ? '' : 's'}.*`);
                            else ackTeams(cfg('TEAMS_WEBHOOK_AMAZON'), `⚠️ *Nothing sent* — ${r.reason}. _(Run the Amazon review check first so there's a batch to approve.)_`);
                        }).catch(e => console.error('[TeamsListener] approve:', e.message));
                    }
                } else if (t === 'no' || t === 'cancel') {
                    console.log(`[TeamsListener] Amazon "no" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
                    if (!DRYRUN()) {
                        ackTeams(cfg('TEAMS_WEBHOOK_AMAZON'), `🛑 *Got it — "no" from ${m.from}.* Cancelling the pending review run.`);
                        amazonApi().cancelPendingReview().then(r => console.log('[TeamsListener] cancel →', JSON.stringify(r))).catch(e => console.error('[TeamsListener] cancel:', e.message));
                    }
                }
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
    if (!TEAM_ID() || (!CH_DP() && !CH_AMZ())) { console.log('[TeamsListener] disabled (no team/channel IDs)'); return; }
    const now = Date.now();
    if (CH_DP()) lastSeen[CH_DP()] = now;   // ignore anything posted before startup
    if (CH_AMZ()) lastSeen[CH_AMZ()] = now;
    try { await getAccessToken(); }
    catch (e) { console.error('[TeamsListener] token init failed — NOT started:', e.message); return; }
    const interval = parseInt(process.env.TEAMS_LISTENER_INTERVAL_MS || '20000', 10);
    if (timer) clearInterval(timer);
    timer = setInterval(pollOnce, interval);
    console.log(`[TeamsListener] started${DRYRUN() ? ' (DRY-RUN)' : ''} — watching Amazon + DP channels every ${interval / 1000}s`);
}

module.exports = { initTeamsListener, pollOnce, fetchNewMessages, getAccessToken, _lastSeen: lastSeen };
