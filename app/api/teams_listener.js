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
    // Log WHICH scopes the token actually carries, once per refresh. A 403 on the channel read is
    // almost always "the token is fine but it doesn't grant what we're asking for" — and without this
    // the two are indistinguishable in the log. `scp` is the granted delegated-scope list; if
    // ChannelMessage.Read.All is missing here, consent is the problem, not the code.
    try {
        const scp = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64').toString()).scp || '';
        if (scp !== _lastScp) { _lastScp = scp; console.log(`[TeamsListener] token scopes: ${scp || '(none)'}`); }
    } catch (_) { /* token shape is Microsoft's business — never break the poll over a log line */ }
    return accessToken;
}
let _lastScp = null;

// ── channel reading ──
function plainText(html) {
    return String(html || '')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

const lastSeen = {};       // channelId -> epoch ms watermark
const processedIds = new Set(); // message ids already acted on (belt-and-suspenders dedup)
const _lastReadErr = {};   // channelId -> last logged failure key, so a 20s poll doesn't spam one fault
let _diagnosed = false;    // the one-time access self-check below has already run

// One-shot access diagnosis, fired the first time a channel read fails. Uses the access token the
// poll already holds — it deliberately does NOT refresh, because the refresh token rotates and is
// shared with the live process. Read-only; logs a verdict and changes nothing.
async function diagnoseAccess(token) {
    const auth = { headers: { Authorization: 'Bearer ' + token }, validateStatus: () => true, timeout: 15000 };
    const get = async (url) => { try { return await axios.get(url, auth); } catch (e) { return { status: 0, data: { error: { message: e.message } } }; } };
    const line = (label, r, extra = '') =>
        console.log(`[TeamsListener] check ${label}: ${r.status}${r.status === 200 ? ' OK' : ' ' + ((r.data && r.data.error && (r.data.error.code || r.data.error.message)) || '')}${extra}`);

    const me = await get('https://graph.microsoft.com/v1.0/me');
    line('/me', me, me.status === 200 ? ` → ${me.data.userPrincipalName || me.data.displayName || ''}` : '');

    // ⚠️ These two probes need scopes this token does NOT carry — /me/joinedTeams wants
    // Team.ReadBasic.All and /teams/{id}/channels wants Channel.ReadBasic.All, while the listener only
    // requests ChannelMessage.Read.All + User.Read. A 403 here therefore means "we never asked for that
    // permission", NOT "the team is invisible" — an earlier version of this check drew exactly that
    // wrong conclusion and sent the investigation after a non-existent team-id problem. They are still
    // run because a 200 IS informative (it would prove membership outright); only the inference changes.
    const scopes = (() => { try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString()).scp || ''; } catch (_) { return ''; } })();
    const has = s => scopes.split(/\s+/).includes(s);

    const teams = await get('https://graph.microsoft.com/v1.0/me/joinedTeams');
    let member = null;
    if (teams.status === 200) {
        const list = teams.data.value || [];
        member = list.some(t => t.id === TEAM_ID());
        line('/me/joinedTeams', teams, ` → ${list.length} team(s); TEAMS_TEAM_ID ${member ? 'IS' : 'is NOT'} among them`);
        if (!member) console.log(`[TeamsListener]   joined team ids: ${list.map(t => t.id).join(', ') || '(none)'}`);
    } else line('/me/joinedTeams', teams, has('Team.ReadBasic.All') ? '' : '  (inconclusive — Team.ReadBasic.All not in token)');

    const chans = await get(`https://graph.microsoft.com/v1.0/teams/${TEAM_ID()}/channels`);
    line('/teams/{id}/channels', chans, chans.status === 200 ? ` → ${(chans.data.value || []).length} channel(s) visible`
        : (has('Channel.ReadBasic.All') ? '' : '  (inconclusive — Channel.ReadBasic.All not in token)'));

    // Verdict — say what to DO, and say so only where the evidence actually supports it.
    if (me.status !== 200) {
        console.error('[TeamsListener] VERDICT: the token cannot even identify the user — re-run the device-code sign-in to mint a fresh TEAMS_REFRESH_TOKEN.');
    } else if (member === false) {
        console.error('[TeamsListener] VERDICT: the signed-in user is NOT a member of TEAMS_TEAM_ID. Delegated auth reads AS that user, so add them to the team (or point TEAMS_TEAM_ID at a team they are in).');
    } else if (chans.status === 200) {
        console.error('[TeamsListener] VERDICT: team + channels ARE visible and ChannelMessage.Read.All is granted, yet /messages is refused — Microsoft gates the Teams MESSAGE APIs behind a separate approval. Request protected-API access for the app registration, or switch these approvals to an inbound Workflow instead of polling.');
    } else {
        console.error(`[TeamsListener] VERDICT: token is valid for ${me.data.userPrincipalName || 'this user'} and carries ChannelMessage.Read.All, but /messages returns 403. The team/channel probes could not confirm membership because the token lacks Team.ReadBasic.All / Channel.ReadBasic.All, so BOTH remain possible:`);
        console.error(`[TeamsListener]   (a) ${me.data.userPrincipalName || 'the account'} is not a member of the team — check it in the Teams UI, and confirm TEAMS_TEAM_ID matches that team's id;`);
        console.error('[TeamsListener]   (b) Microsoft is gating the Teams message APIs (protected API) — this turns on by tenant/rollout, which is why it can start failing with no change on our side.');
        console.error('[TeamsListener]   Fastest split: add the account to the team (or verify it already is). If /messages still 403s with confirmed membership, it is (b).');
    }
}

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
    // ⚠️ LOG THE GRAPH ERROR BODY, not just the status. A bare "→ 403" is unactionable: it cannot tell
    // apart a missing consent, a user who was removed from the team, and a private channel that this
    // API does not serve. Graph names the reason in error.code/message, and that one line is the whole
    // diagnosis. Repeats are collapsed so a persistent failure doesn't flood a 20s poll loop.
    if (res.status !== 200) {
        const err = (res.data && res.data.error) || {};
        const key = `${channelId}|${res.status}|${err.code || ''}`;
        if (_lastReadErr[channelId] !== key) {
            _lastReadErr[channelId] = key;
            console.error(`[TeamsListener] read ${channelId} → ${res.status} ${err.code || ''}: ${err.message || JSON.stringify(res.data).slice(0, 300)}`);
            // Graph answers a blocked channel read with a bare "Forbidden / UnknownError" that names
            // nothing. These three probes, on the SAME token, split the only causes that produce it:
            //   • /me                → who Graph thinks we are (delegated = we read AS this person)
            //   • /me/joinedTeams    → is that person actually IN the team? if not, 403 is correct
            //   • /teams/{id}/channels → can we see the team at all? if listing works but messages
            //     don't, membership is fine and the MESSAGES api itself is what is blocked (Microsoft
            //     gates the Teams message APIs behind a separate approval).
            // Runs at most once per process, and only after a real failure.
            if (!_diagnosed) { _diagnosed = true; diagnoseAccess(token).catch(() => {}); }
        }
        return [];
    }
    if (_lastReadErr[channelId]) { delete _lastReadErr[channelId]; console.log(`[TeamsListener] read ${channelId} recovered`); }
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

// "amazon yes" / "amazon no" still reach here — people who learned the old habit will keep typing them
// for a while. Amazon sends automatically now, so the honest answer is to say so straight away rather
// than acknowledge an approval that is not happening (the old ack claimed "sending the review requests
// now…", which would be a flat lie).
function runAmazon(isYes, from) {
    const url = cfg('TEAMS_WEBHOOK_AMAZON');
    const api = amazonApi();
    (isYes ? api.approvePendingReview() : api.cancelPendingReview())
        .then(r => {
            console.log(`[TeamsListener] amazon ${isYes ? 'approve' : 'cancel'} →`, JSON.stringify(r));
            if (r.ok) ackTeams(url, `✅ *Sent ${r.sent} review request${r.sent === 1 ? '' : 's'}.*`);
            else ackTeams(url, `ℹ️ *Nothing to do, ${from}* — ${r.reason}.`);
        })
        .catch(e => console.error(`[TeamsListener] amazon ${isYes ? 'approve' : 'cancel'}:`, e.message));
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
// Returns WHAT it actually did ('tally' | 'amazon' | 'ambiguous') or null when nothing fired.
// ⚠️ The return value is load-bearing: callers use it to decide whether to tell the user anything.
// Reporting "acted" merely because the text PARSED as an approval made the bot sit silent when
// nothing was pending — after an explicit @mention that reads as a dead bot, not as "nothing to do".
async function handleApproval(m, roles) {
    const cmd = parseApproval(m.text);
    if (!cmd) return null;
    const isYes = cmd.verb === 'yes';
    // handleTeamsKeyword understands bare yes/no and "approve TB-…"/"reject TB-…".
    const tallyCmd = cmd.ref ? `${isYes ? 'approve' : 'reject'} ${cmd.ref}` : cmd.verb;

    if (cmd.target === 'tally' && roles.has('finance')) {
        console.log(`[TeamsListener] Tally "${m.text}" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
        if (!DRYRUN()) runTally(tallyCmd, m.from);
        return 'tally';
    }
    if (cmd.target === 'amazon' && roles.has('amazon')) {
        console.log(`[TeamsListener] Amazon "${m.text}" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
        if (!DRYRUN()) runAmazon(isYes, m.from);
        return 'amazon';
    }
    if (cmd.target) return null;   // named a flow this channel doesn't serve — not ours to action

    const tallyPending = roles.has('finance') ? await tallyBatchApi().hasPendingBatch().catch(() => null) : null;
    const amazonPending = roles.has('amazon') ? !!amazonApi().hasPendingReview() : false;

    if (tallyPending && amazonPending) {
        console.log(`[TeamsListener] ambiguous "${m.text}" from ${m.from} — Tally and Amazon are both pending`);
        if (!DRYRUN()) ackTeams(cfg('TEAMS_WEBHOOK_FINANCE') || cfg('TEAMS_WEBHOOK_AMAZON'),
            `⚠️ *Two things are waiting, so "${m.text}" is ambiguous — nothing has been actioned.*\n` +
            `· Tally batch *${tallyPending.ref}* (${tallyPending.voucher_count} voucher(s)) → reply *${isYes ? 'approve' : 'reject'} ${tallyPending.ref}*\n` +
            `· Amazon review batch → reply *amazon ${isYes ? 'yes' : 'no'}*`);
        return 'ambiguous';
    }
    if (tallyPending) {
        console.log(`[TeamsListener] Tally "${m.text}" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
        if (!DRYRUN()) runTally(tallyCmd, m.from);
        return 'tally';
    }
    if (amazonPending) {
        console.log(`[TeamsListener] Amazon "${m.text}" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
        if (!DRYRUN()) runAmazon(isYes, m.from);
        return 'amazon';
    }
    // Nothing pending. The POLLER should stay silent here — people hold ordinary conversations in
    // these channels — but the BOT is only ever reached by an explicit @mention, so its caller turns
    // this null into "nothing is pending". Same function, two audiences.
    return null;
}

// Which flows a channel serves. A channel may serve more than one (Finance and Amazon share one here).
function channelRoles() {
    const roles = new Map();
    const add = (id, role) => { if (!id) return; if (!roles.has(id)) roles.set(id, new Set()); roles.get(id).add(role); };
    add(CH_DP(), 'dp'); add(CH_AMZ(), 'amazon'); add(CH_FIN(), 'finance');
    return roles;
}

// ── The one place a channel message turns into an action ─────────────────────────────────────────
// Shared by the Graph poller and the inbound webhook, deliberately: two copies of "what does 'yes'
// mean here" is how one path ends up approving something the other would have refused. Dedup by
// message id is inside, so the same message arriving on BOTH paths acts exactly once.
async function handleInboundMessage(m) {
    const roles = channelRoles().get(m.channelId);
    if (!roles) return { ok: false, reason: 'channel not configured' };
    if (!m.text) return { ok: true, skipped: 'empty' };
    if (m.id && processedIds.has(m.id)) return { ok: true, skipped: 'duplicate' };
    if (m.id) processedIds.add(m.id);
    if (processedIds.size > 500) { const keep = [...processedIds].slice(-200); processedIds.clear(); keep.forEach(id => processedIds.add(id)); }

    const acted = [];
    let recognised = false;   // a valid command that simply had nothing waiting for it
    if (roles.has('dp') && /(^|\b)rejected(\b|$)/i.test(m.text)) {
        console.log(`[TeamsListener] DP "rejected" from ${m.from}${DRYRUN() ? ' [dry-run]' : ''}`);
        if (!DRYRUN()) runDpCheck(m.from);
        acted.push('dp');
    }
    if (roles.has('amazon') || roles.has('finance')) {
        // Record what handleApproval ACTUALLY did, not merely that the text looked like a command —
        // otherwise "yes" with nothing pending counts as handled and the bot answers with silence.
        const did = await handleApproval(m, roles);
        if (did) acted.push(did);
        else if (parseApproval(m.text)) recognised = true;   // understood, but nothing to act on
    }
    return { ok: true, acted, recognised, roles: [...roles] };
}

async function pollOnce() {
    if (polling) return; polling = true;
    try {
        // Map channel → the flows watching it, so a channel serving two flows is fetched ONCE. Fetching
        // it twice would be a bug, not just waste: `lastSeen` is keyed by channel id, so the first read
        // advances the watermark and the second sees nothing at all.
        const roles = channelRoles();

        for (const [channelId, set] of roles) {
            // Finance cards may be posted as thread replies, which `/messages` alone never returns.
            const msgs = await fetchNewMessages(channelId, set.has('finance'));
            for (const m of msgs) await handleInboundMessage({ ...m, channelId });
        }
    } catch (e) {
        console.error('[TeamsListener] poll error:', e.message);
    } finally {
        polling = false;
    }
}

let timer = null;
async function initTeamsListener() {
    // Graph POLLING can be turned off independently of the listener. Microsoft gates the Teams message
    // APIs behind a protected-API approval, so on a tenant without it EVERY read returns a bare
    // 403/UnknownError however correct the token is — and there is nothing to fix in code. Set
    // TEAMS_POLL=0 to stop the useless reads (and the hourly token refreshes) while keeping the inbound
    // webhook path, which needs no Graph permission at all.
    if (String(cfg('TEAMS_POLL') ?? '1') === '0') {
        console.log('[TeamsListener] Graph polling DISABLED (TEAMS_POLL=0) — inbound approvals come from the Teams Workflow webhook at POST /api/webhook/teams');
        return;
    }
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

module.exports = { initTeamsListener, pollOnce, fetchNewMessages, getAccessToken, parseApproval,
    handleInboundMessage, channelRoles, _lastSeen: lastSeen };
