// ─────────────────────────────────────────────────────────────────────────────
// EcomBot — a real Microsoft Teams bot (Azure Bot Service, Single Tenant).
//
// WHY THIS EXISTS. Teams gave us three half-solutions and each hit a wall:
//   • Graph polling      → Microsoft gates the Teams MESSAGE APIs behind a protected-API approval;
//                          every read 403s however correct the token (see teams_listener.js).
//   • Incoming webhook   → posts fine, but the sender is "Workflows" and it can never RECEIVE.
//   • Outgoing webhook   → receives fine, but is REPLY-ONLY (it cannot start a message) and does
//                          not work in private channels at all.
// A bot registration is the only thing that does BOTH directions, under ONE identity, in private
// channels, with real buttons on cards.
//
// AUTH, BOTH WAYS — they are different mechanisms and it matters:
//   inbound  Teams → us: a JWT in `Authorization: Bearer …`, signed by Microsoft. We verify the
//            signature against Microsoft's published keys and require audience == our App ID.
//            Without that check ANYONE could POST a fake "approve the Tally push" activity.
//   outbound us → Teams: a client-credentials token for `https://api.botframework.com/.default`,
//            sent to the `serviceUrl` that came with an inbound activity.
//
// No Bot Framework SDK: the whole surface we need is three REST calls, and adding the SDK would mean
// a large dependency plus an npm install on the VPS for no gain (same reasoning as the base64 upload
// path in tally_bank.js).
//
// Env: TEAMS_BOT_APP_ID, TEAMS_BOT_APP_PASSWORD, TEAMS_TENANT_ID.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const router = express.Router();
const config = require('../../config');
const { supabase } = require('../supabase');

const cfg = k => process.env[k] || config[k];
const APP_ID = () => cfg('TEAMS_BOT_APP_ID');
const APP_PW = () => cfg('TEAMS_BOT_APP_PASSWORD');
const TENANT = () => cfg('TEAMS_TENANT_ID');
const enabled = () => !!(APP_ID() && APP_PW());

// ── outbound token (us → Teams) ──────────────────────────────────────────────────────────────────
let _tok = null, _tokExp = 0;
async function botToken() {
    if (_tok && Date.now() < _tokExp - 120000) return _tok;
    // Single-tenant bots authenticate against their own tenant, not the common endpoint.
    const url = `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/token`;
    const r = await axios.post(url, new URLSearchParams({
        grant_type: 'client_credentials', client_id: APP_ID(), client_secret: APP_PW(),
        scope: 'https://api.botframework.com/.default',
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000, validateStatus: () => true });
    if (r.status !== 200) throw new Error(`bot token ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    _tok = r.data.access_token;
    _tokExp = Date.now() + (r.data.expires_in || 3600) * 1000;
    return _tok;
}

// ── inbound token verification (Teams → us) ──────────────────────────────────────────────────────
// Microsoft publishes its signing keys at an OpenID metadata document. Which document depends on how
// the bot was registered, and getting it wrong looks identical to an attack — so BOTH are tried and a
// token is accepted if it verifies against either. Keys are cached for an hour; a `kid` we have not
// seen forces one refetch (Microsoft rotates keys without notice).
const JWKS_URLS = [
    'https://login.botframework.com/v1/.well-known/openidconfiguration',   // Bot Connector
    () => `https://login.microsoftonline.com/${TENANT()}/v2.0/.well-known/openid-configuration`, // single-tenant
];
let _keys = new Map(), _keysAt = 0;
const KEY_TTL = 60 * 60 * 1000;

async function loadKeys(force = false) {
    if (!force && _keys.size && Date.now() - _keysAt < KEY_TTL) return _keys;
    const map = new Map();
    for (const u of JWKS_URLS) {
        try {
            const metaUrl = typeof u === 'function' ? u() : u;
            const meta = await axios.get(metaUrl, { timeout: 12000 });
            const jwks = await axios.get(meta.data.jwks_uri, { timeout: 12000 });
            for (const k of (jwks.data.keys || [])) {
                if (!k.kid) continue;
                try { map.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }).export({ type: 'spki', format: 'pem' })); }
                catch (_) { /* a key we cannot import is simply not usable */ }
            }
        } catch (e) { console.warn('[TeamsBot] key fetch failed for one issuer:', e.message); }
    }
    if (map.size) { _keys = map; _keysAt = Date.now(); }
    return _keys;
}

// Returns null when valid, or a string reason when not. Reasons are logged, never returned to the
// caller — a probe must not learn WHY its forgery failed.
async function verifyInbound(req) {
    const auth = String(req.get('authorization') || '');
    if (!auth.startsWith('Bearer ')) return 'no bearer token';
    const token = auth.slice(7).trim();
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header || !decoded.header.kid) return 'unparseable token';

    let keys = await loadKeys();
    let pem = keys.get(decoded.header.kid);
    if (!pem) { keys = await loadKeys(true); pem = keys.get(decoded.header.kid); }   // rotated key
    if (!pem) return `unknown signing key ${decoded.header.kid}`;

    try {
        // audience MUST be our App ID — this is what stops a validly-signed token minted for some
        // OTHER bot from driving ours.
        jwt.verify(token, pem, { algorithms: ['RS256'], audience: APP_ID(), clockTolerance: 300 });
        return null;
    } catch (e) { return `signature/claims rejected: ${e.message}`; }
}

// ── remember where we can post ───────────────────────────────────────────────────────────────────
async function rememberChannel(activity) {
    const cd = activity.channelData || {};
    const channelId = (cd.channel && cd.channel.id) || (activity.conversation && String(activity.conversation.id || '').split(';')[0]);
    if (!channelId || !activity.serviceUrl) return;
    try {
        await supabase.from('teams_bot_channels_ecom').upsert({
            channel_id: channelId,
            service_url: String(activity.serviceUrl).replace(/\/+$/, ''),
            tenant_id: (cd.tenant && cd.tenant.id) || null,
            team_id: (cd.team && cd.team.id) || null,
            channel_name: (cd.channel && cd.channel.name) || null,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'channel_id' });
    } catch (e) { console.warn('[TeamsBot] could not remember channel:', e.message); }
}

// ── proactive post (scheduled reports) ───────────────────────────────────────────────────────────
// Two shapes, chosen by whether the target carries a thread root:
//
//   19:…@thread.tacv2                        → start a NEW thread in the channel
//   19:…@thread.tacv2;messageid=1784787628987 → REPLY inside that existing thread
//
// The second form matters because each report here already owns a thread that people read and reply
// under — Hold, Warehouse and Inventory all share the Ops › Daily Reports channel and would otherwise
// interleave as separate top-level posts, burying the history each one has built up. The `messageid`
// is the root post's id, straight out of a Teams "copy link to message" URL (`parentMessageId=…`).
// (Note this is something an incoming webhook simply cannot do — Adaptive Cards can't be posted as
// channel replies through a Workflow, only by a bot.)
async function sendToChannel(target, activity) {
    if (!enabled()) throw new Error('bot not configured (TEAMS_BOT_APP_ID / _APP_PASSWORD)');
    const [channelId, threadPart] = String(target).split(';');
    const rootId = (threadPart || '').startsWith('messageid=') ? threadPart.slice('messageid='.length) : null;

    let { data: row } = await supabase.from('teams_bot_channels_ecom')
        .select('service_url').eq('channel_id', channelId).maybeSingle();
    if (!row || !row.service_url) {
        // serviceUrl is TENANT-scoped, not per-channel — it reads
        // https://smba.trafficmanager.net/<region>/<tenant-id> and is identical for every channel in
        // the tenant. So any one we have already learned works for a channel we have never seen,
        // which means a new report channel only needs the bot INSTALLED in its team; nobody has to
        // remember to @mention it there first. (Installing still matters: without membership the
        // post is refused by Teams, not by us.)
        const { data: any } = await supabase.from('teams_bot_channels_ecom')
            .select('service_url').order('updated_at', { ascending: false }).limit(1);
        row = (any && any[0]) || null;
        if (!row) throw new Error(`no serviceUrl known yet — install EcomBot in a team and @mention it once so it learns the tenant endpoint`);
    }
    const token = await botToken();
    const auth = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000, validateStatus: () => true };

    if (rootId) {
        // A thread's conversation id IS "<channelId>;messageid=<rootId>" — post an activity to it and
        // the card lands as a reply under that root.
        const convId = `${channelId};messageid=${rootId}`;
        const r = await axios.post(`${row.service_url}/v3/conversations/${encodeURIComponent(convId)}/activities`, activity, auth);
        if (r.status >= 300) throw new Error(`reply to thread ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
        return r.data;
    }

    const r = await axios.post(`${row.service_url}/v3/conversations`, {
        isGroup: true,
        channelData: { channel: { id: channelId } },
        activity,
    }, auth);
    if (r.status >= 300) throw new Error(`post to channel ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    return r.data;
}

// Reply inside the thread an activity came from.
async function replyToActivity(activity, text) {
    const token = await botToken();
    const url = `${String(activity.serviceUrl).replace(/\/+$/, '')}/v3/conversations/${encodeURIComponent(activity.conversation.id)}/activities/${encodeURIComponent(activity.id)}`;
    await axios.post(url, { type: 'message', text }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000, validateStatus: () => true,
    });
}

// Strip the "<at>EcomBot</at>" mention (and any HTML) so the command is the whole message — the
// approval parser requires that, so leaving the bot name in makes every command unrecognised.
function plainCommand(activity) {
    let t = String(activity.text || '');
    for (const m of (activity.entities || [])) {
        if (m.type === 'mention' && m.text) t = t.split(m.text).join(' ');
    }
    return t.replace(/<at\b[^>]*>.*?<\/at>/gi, ' ').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// ── POST /api/bot/messages — the bot's messaging endpoint ────────────────────────────────────────
router.post('/bot/messages', async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'bot not configured' });
    const why = await verifyInbound(req);
    if (why) {
        console.warn('[TeamsBot] rejected inbound:', why);
        return res.status(401).json({ error: 'unauthorized' });
    }
    const a = req.body || {};
    // Every activity teaches us where the bot lives — including the install event, so scheduled posts
    // work before anyone has said a word to it.
    await rememberChannel(a);

    if (a.type === 'conversationUpdate') {
        console.log('[TeamsBot] installed/updated in', (a.channelData && a.channelData.team && a.channelData.team.name) || 'a team');
        return res.status(200).end();
    }
    if (a.type !== 'message') return res.status(200).end();

    const cd = a.channelData || {};
    const channelId = (cd.channel && cd.channel.id) || String((a.conversation && a.conversation.id) || '').split(';')[0];
    const text = plainCommand(a);
    const from = (a.from && a.from.name) || 'Teams';

    // Teams retries if we are slow, so ACK immediately and do the work after. An approval that fires
    // twice is far worse than one that answers a moment later.
    res.status(200).end();

    try {
        const r = await require('./teams_listener').handleInboundMessage({ id: a.id, text, from, channelId });
        if (r.acted && r.acted.length) {
            console.log(`[TeamsBot] "${text}" from ${from} → ${r.acted.join(', ')}`);
        } else if (!r.skipped) {
            // Three different situations, three different answers. Collapsing them (or staying
            // silent) is what made this look broken: after an explicit @mention, no reply is
            // indistinguishable from a dead bot.
            const why2 = !r.ok ? 'this channel is not wired to an action'
                : r.recognised ? 'I understood it, but nothing is waiting for approval right now'
                    : 'that is not a command I recognise';
            const hint = r.recognised ? '' : ' Try *yes*, *no*, or *rejected*.';
            await replyToActivity(a, `🤔 "${text}" — ${why2}.${hint}`);
        }
    } catch (e) { console.error('[TeamsBot] handler error:', e.message); }
});

// GET /api/bot/health — is the bot configured, and which channels can it post to?
router.get('/bot/health', async (_req, res) => {
    try {
        const { data } = await supabase.from('teams_bot_channels_ecom').select('channel_id, channel_name, service_url, updated_at');
        let token = null;
        if (enabled()) { try { await botToken(); token = 'ok'; } catch (e) { token = e.message; } }
        res.json({ success: true, configured: enabled(), appId: APP_ID() ? APP_ID().slice(0, 8) + '…' : null, token, channels: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
module.exports.sendToChannel = sendToChannel;
module.exports.botEnabled = enabled;
