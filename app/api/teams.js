// Microsoft Teams reporting via a Workflows incoming webhook (replaces Slack chat.postMessage).
// Setup per channel: Teams → "Workflows" app → template "Post to a channel when a webhook request is
// received" → copy the URL into .env (TEAMS_WEBHOOK_WAREHOUSE / _DP / _HOLD / _AMAZON).
// We convert the existing Slack Block-Kit payload into an Adaptive Card, so report builders don't change.
const express = require('express');
const axios = require('axios');
const config = require('../../config');
const router = express.Router();

// Slack mrkdwn → Teams / Adaptive-Card markdown.
function mrkdwn(s) {
    return String(s == null ? '' : s)
        .replace(/<([^|>]+)\|([^>]+)>/g, '[$2]($1)')   // <url|label> → [label](url)
        .replace(/<(https?:[^>]+)>/g, '$1')            // <url> → url
        .replace(/\*([^*\n]+)\*/g, '**$1**')           // *bold* → **bold**
        .replace(/~([^~\n]+)~/g, '~~$1~~');            // ~strike~ → ~~strike~~  (_italic_ already works)
}

// Slack mrkdwn → HTML, for flows that reply into a thread via "Reply with a message in a channel"
// (that action renders HTML, not Adaptive Cards). Escape first, convert `code` before _italic_ so
// underscores inside order names (e.g. TE25-34089_94) can't be misread as italics.
function mrkdwnHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')   // escape
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')                          // `code`
        .replace(/&lt;([^|&]+)\|([^&]+)&gt;/g, '<a href="$1">$2</a>')         // <url|label>
        .replace(/&lt;(https?:[^&]+)&gt;/g, '<a href="$1">$1</a>')            // <url>
        .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')                              // *bold*
        .replace(/_([^_<>\n]+)_/g, '<i>$1</i>')                              // _italic_ (won't cross tags)
        .replace(/~([^~\n]+)~/g, '<s>$1</s>')                                // ~strike~
        .replace(/\n/g, '<br>');
}

// Render a Slack-style payload as one HTML string — the `text` twin used by thread-reply flows.
// Mirrors slackToCardBody(): header→bold, section→text, fields→stacked lines, context→subtle italic.
function slackToHtml(payload) {
    const parts = [];
    if (Array.isArray(payload.blocks) && payload.blocks.length) {
        for (const b of payload.blocks) {
            if (b.type === 'header' && b.text) parts.push(`<b>${mrkdwnHtml(b.text.text)}</b>`);
            else if (b.type === 'section' && b.text) parts.push(mrkdwnHtml(b.text.text));
            else if (b.type === 'section' && Array.isArray(b.fields)) parts.push(b.fields.map(f => mrkdwnHtml(f.text)).join('<br>'));
            else if (b.type === 'context' && Array.isArray(b.elements)) parts.push(mrkdwnHtml(b.elements.map(e => e.text || '').join('  ')));  // context text already carries its own _italics_
            else if (b.type === 'image' && b.image_url) parts.push(`<img src="${b.image_url}" alt="${String(b.alt_text || '').replace(/"/g, '&quot;')}" style="max-width:100%;border-radius:8px">`);
            else if (b.type === 'table' && Array.isArray(b.rows)) parts.push(tableToHtml(b));
            // dividers dropped — the blank line between parts already separates sections
        }
    } else if (payload.text) {
        parts.push(mrkdwnHtml(payload.text));
    }
    return parts.join('<br><br>');
}

// ── `table` block ────────────────────────────────────────────────────────────────────────────────
// A real tabular block, because neither of the obvious alternatives works in Teams: a ```code fence```
// renders as literal backticks with the whitespace collapsed, and Adaptive Card 1.5's native Table
// element isn't available to us (the Workflows connector pins 1.4).
//
// So we lay it out COLUMN-major: one ColumnSet whose N columns each hold a stack of TextBlocks
// (header + every value for that column). Columns share one container width, so proportional `width`
// weights line the rows up exactly — which separate per-row ColumnSets would not do.
//
//   { type: 'table', columns: [{ title, width?, align? }, ...], rows: [[c1, c2, ...], ...],
//     total?: [c1, c2, ...] }
// Cell values are mrkdwn strings. align: 'Center' (default — header and body share it) | 'Left' | 'Right'.
function tableCols(b) {
    return (b.columns || []).map(c => (typeof c === 'string' ? { title: c } : c))
        .map((c, i) => ({ title: c.title || '', width: String(c.width || (i === 0 ? 3 : 2)), align: c.align || 'Center' }));
}
function tableToCard(b) {
    const cols = tableCols(b);
    const rows = b.rows || [];
    const cellBlock = (txt, c, opts = {}) => ({
        type: 'TextBlock', text: mrkdwn(txt == null ? '' : String(txt)), wrap: false, spacing: opts.spacing || 'Small',
        horizontalAlignment: c.align, size: opts.size || 'Default',
        weight: opts.weight, isSubtle: opts.isSubtle, separator: opts.separator,
    });
    return {
        type: 'ColumnSet',
        columns: cols.map((c, ci) => {
            const items = [cellBlock(c.title, c, { weight: 'Bolder', size: 'Small', isSubtle: true, spacing: 'None' })];
            rows.forEach(r => items.push(cellBlock(r[ci], c, { weight: ci === 0 ? 'Bolder' : undefined })));
            if (b.total) items.push(cellBlock(b.total[ci], c, { weight: 'Bolder', separator: true }));
            return { type: 'Column', width: c.width, items };
        }),
    };
}
// Native Adaptive Card 1.5 `Table` — real cells with real grid lines.
//
// The ColumnSet version above exists only because the Workflows connector pins the card schema to
// 1.4, where `Table` does not exist. EcomBot is not bound by that: a bot sends the card itself, so it
// can declare 1.5 and get borders, proper cell padding and header styling for free. The ColumnSet
// path is still used for the WEBHOOK fallback, which is still 1.4 — hence two renderers rather than
// replacing one with the other.
function tableToNativeCard(b) {
    const cols = tableCols(b);
    const cell = (txt, c, opts = {}) => ({
        type: 'TableCell',
        items: [{
            type: 'TextBlock', text: mrkdwn(txt == null ? '' : String(txt)), wrap: false,
            horizontalAlignment: c.align, size: 'Small',
            weight: opts.weight, isSubtle: opts.isSubtle,
        }],
    });
    const rows = (b.rows || []).map(r => ({
        type: 'TableRow',
        cells: cols.map((c, ci) => cell(r[ci], c, { weight: ci === 0 ? 'Bolder' : undefined })),
    }));
    if (b.total) rows.push({ type: 'TableRow', cells: cols.map((c, ci) => cell(b.total[ci], c, { weight: 'Bolder' })) });
    return {
        type: 'Table',
        gridStyle: 'accent',
        showGridLines: true,
        firstRowAsHeaders: true,
        columns: cols.map(c => ({ width: Number(c.width) || 2 })),
        rows: [{ type: 'TableRow', style: 'accent',
            cells: cols.map(c => cell(c.title, c, { weight: 'Bolder', isSubtle: true })) }, ...rows],
    };
}

function tableToHtml(b) {
    const cols = tableCols(b);
    const th = 'padding:6px 14px;border-bottom:2px solid #cbd5e1;font-size:12px;color:#64748b';
    const td = 'padding:6px 14px;border-bottom:1px solid #e2e8f0;font-variant-numeric:tabular-nums';
    const al = c => (c.align === 'Right' ? 'right' : c.align === 'Left' ? 'left' : 'center');
    // Teams' HTML sanitizer drops `text-align` from inline styles on <td> (which is why only the header
    // row looked centred — that was Teams' own default <th> styling, not ours). The legacy `align`
    // attribute survives, so alignment goes there; the style is kept for every other client.
    const cell = (tag, v, c, style) => `<${tag} align="${al(c)}" style="${style};text-align:${al(c)}">${mrkdwnHtml(v == null ? '' : String(v))}</${tag}>`;
    return `<table style="border-collapse:collapse;font-size:14px;margin-top:6px"><thead><tr>`
        + cols.map(c => cell('th', c.title, c, th)).join('')
        + `</tr></thead><tbody>`
        + (b.rows || []).map(r => `<tr>` + cols.map((c, i) => cell('td', r[i], c, td)).join('') + `</tr>`).join('')
        + (b.total ? `<tr>` + cols.map((c, i) => cell('td', b.total[i], c, 'padding:8px 14px;font-weight:700')).join('') + `</tr>` : '')
        + `</tbody></table>`;
}

function slackToCardBody(payload, rich = false) {
    const body = [];
    let pendingSep = false;
    const push = el => { if (pendingSep) { el.separator = true; pendingSep = false; } body.push(el); };
    if (Array.isArray(payload.blocks) && payload.blocks.length) {
        for (const b of payload.blocks) {
            if (b.type === 'header' && b.text) push({ type: 'TextBlock', text: b.text.text, weight: 'Bolder', size: 'Large', wrap: true });
            else if (b.type === 'section' && b.text) push({ type: 'TextBlock', text: mrkdwn(b.text.text), wrap: true });
            else if (b.type === 'section' && Array.isArray(b.fields)) {
                // Slack renders `fields` in a 2-column grid (filled left→right, top→bottom). Mirror that with a ColumnSet.
                const toBlocks = idxs => idxs.map(i => ({ type: 'TextBlock', text: mrkdwn(b.fields[i].text), wrap: true, spacing: 'Small' }));
                const left = [], right = [];
                b.fields.forEach((f, i) => (i % 2 === 0 ? left : right).push(i));
                push({ type: 'ColumnSet', columns: [
                    { type: 'Column', width: 'stretch', items: toBlocks(left) },
                    { type: 'Column', width: 'stretch', items: toBlocks(right) },
                ] });
            }
            else if (b.type === 'context' && Array.isArray(b.elements)) push({ type: 'TextBlock', text: mrkdwn(b.elements.map(e => e.text || '').join('  ')), isSubtle: true, size: 'Small', wrap: true });
            else if (b.type === 'image' && b.image_url) push({ type: 'Image', url: b.image_url, altText: String(b.alt_text || ''), size: 'Stretch' });
            else if (b.type === 'table' && Array.isArray(b.rows)) push(rich ? tableToNativeCard(b) : tableToCard(b));
            else if (b.type === 'divider') pendingSep = true;
        }
    } else if (payload.text) {
        push({ type: 'TextBlock', text: mrkdwn(payload.text), wrap: true });
    }
    return body;
}

// Build just the Adaptive Card object from a Slack-style payload. opts: { footer }
//
// ⚠️ NO BUTTONS ON TEAMS CARDS — by explicit instruction (2026-08-14). Reports used to carry an
// "Open Inventory Dashboard" / "Open Voucher Register" / "Review & approve in dashboard" button.
// They are suppressed HERE rather than at the three call sites so a newly-added report cannot
// reintroduce one by passing actionUrl: the callers may still pass it, and it is simply ignored.
// The Slack-blocks → OpenUrl converter was removed with them, so Slack-derived URL buttons do not
// come back either. (If buttons are ever wanted again, re-enable in this one function.)
function buildAdaptiveCard(payload, opts = {}) {
    // `rich` = sent by EcomBot, which can declare schema 1.5 and therefore use the native Table
    // element with real grid lines. The webhook path must stay on 1.4 (the Workflows connector pins
    // it) and falls back to the ColumnSet imitation.
    const rich = !!opts.rich;
    const body = slackToCardBody(payload, rich);
    if (opts.footer) body.push({ type: 'TextBlock', text: mrkdwn(opts.footer), isSubtle: true, size: 'Small', wrap: true, separator: true });
    if (!body.length) return null;
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: rich ? '1.5' : '1.4',
        // ⚠️ WITHOUT THIS, TEAMS RENDERS EVERY CARD AT A NARROW FIXED WIDTH and leaves most of the
        // message area blank — which is what squeezed the reorder table into "16,8…" / "TE-BD…"
        // however few columns it had. `msteams.width: Full` is the only way to opt into the full
        // width, and it is a Teams-specific extension the schema itself does not describe. Any
        // future card with a table wants it.
        msteams: { width: 'Full' },
        body,
    };
}

// Build the Teams message envelope (Adaptive Card attachment) — kept for compatibility.
function buildCard(payload, opts = {}) {
    const card = buildAdaptiveCard(payload, opts);
    if (!card) return null;
    return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] };
}

// Which Teams channel does this webhook post into? Pairs TEAMS_WEBHOOK_<X> with TEAMS_CHANNEL_<X>.
// Returns null when that channel id is not configured, which simply leaves that report on its webhook.
//
// ⚠️ This used to check a HARD-CODED list of seven suffixes, and any webhook var outside it silently
// kept posting via Workflows however well the bot was set up. The On-Hold report was invisible to the
// bot for exactly that reason: it posts to TEAMS_WEBHOOK_WAREHOUSE_HOLD (the hold thread inside the Ops
// channel), which was not on the list. So the lookup now DISCOVERS every TEAMS_WEBHOOK_* var instead of
// naming them — add a webhook var tomorrow and the bot picks it up with no edit here.
const _envVal = k => process.env[k] || config[k];
// Compound names whose channel lives under a different suffix. Do NOT replace this with "trim the last
// _PART": WAREHOUSE_HOLD means *the hold report inside the warehouse channel*, so it belongs to
// TEAMS_CHANNEL_HOLD (its own thread) — trimming would send it to the warehouse thread instead.
const CHANNEL_ALIAS = { WAREHOUSE_HOLD: 'HOLD', FINANCE_RESULT: 'FINANCE' };
// Checked first, so a URL shared by two vars resolves the same way it always has.
const CHANNEL_ORDER = ['DP', 'AMAZON', 'FINANCE', 'INVENTORY', 'WAREHOUSE', 'HOLD', 'CRON'];
function channelForWebhook(url) {
    if (!url) return null;
    const suffixes = [...CHANNEL_ORDER];
    for (const k of [...Object.keys(process.env), ...Object.keys(config)]) {
        if (!k.startsWith('TEAMS_WEBHOOK_')) continue;
        const s = k.slice('TEAMS_WEBHOOK_'.length);
        if (s && !suffixes.includes(s)) suffixes.push(s);
    }
    for (const suffix of suffixes) {
        if (_envVal(`TEAMS_WEBHOOK_${suffix}`) !== url) continue;
        return _envVal(`TEAMS_CHANNEL_${suffix}`)
            || (CHANNEL_ALIAS[suffix] && _envVal(`TEAMS_CHANNEL_${CHANNEL_ALIAS[suffix]}`))
            || null;
    }
    return null;
}

// Post a Slack-style payload to a Teams Workflow webhook as a native Adaptive Card.
// The Workflow's "Post card in a chat or channel" reads triggerBody()?['card'] — a JSON string of the card.
async function postTeams(webhookUrl, payload, opts = {}) {
    // Built twice on purpose, and only when needed: the bot gets the 1.5 card with real tables, the
    // webhook fallback gets the 1.4 ColumnSet one. Building a single card for both would mean
    // sending 1.5 markup down a 1.4 connector, where a `Table` renders as nothing at all.
    const card = buildAdaptiveCard(payload, opts);
    if (!card) return false;

    // Prefer EcomBot when we can: the card then comes from the bot's own identity instead of the
    // generic "Workflows" sender, and the bot works in PRIVATE channels where an incoming webhook
    // cannot be created at all. Falls back to the webhook whenever the bot is not configured, has
    // never seen that channel (no serviceUrl learned yet), or errors — so this can only ever add a
    // delivery path, never remove one. A report failing to post because we got clever is not a
    // trade worth making.
    //
    // The channel is resolved from the WEBHOOK URL rather than passed by every caller: each
    // TEAMS_WEBHOOK_<X> has a matching TEAMS_CHANNEL_<X>, so one lookup switches every existing
    // report to the bot with no call-site changes — and any report whose channel id is not
    // configured simply keeps using its webhook.
    const channelId = opts.channelId || channelForWebhook(webhookUrl);
    if (channelId) {
        try {
            const bot = require('./teams_bot');
            if (bot.botEnabled()) {
                const richCard = buildAdaptiveCard(payload, { ...opts, rich: true }) || card;
                await bot.sendToChannel(channelId, {
                    type: 'message',
                    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: richCard }],
                });
                return true;
            }
        } catch (e) {
            console.warn(`[Teams] bot post failed (${e.message}) — falling back to the webhook`);
        }
    }

    if (!webhookUrl) return false;
    const body = { card: JSON.stringify(card) };
    // Optional plain HTML rendering, sent alongside the card. Used by flows that reply INTO a thread
    // via "Reply with a message in a channel" (Adaptive Cards can't be posted as channel replies, only
    // text/HTML). Harmless to flows that only read `card` — they ignore the extra field.
    if (opts.text) {
        // opts.text === true → auto-generate HTML from the payload blocks; a string is used verbatim.
        body.text = (opts.text === true) ? slackToHtml(payload) : opts.text;
        // That thread-reply flow wraps its Reply action in a `For each` over the request's `attachments`
        // (leftover card-template structure). Send a single-element attachments array so the loop runs
        // exactly once → exactly one reply. Also matches the standard Teams card-webhook payload shape.
        body.attachments = [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }];
    }
    try {
        const res = await axios.post(webhookUrl, body, { headers: { 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true });
        if (res.status >= 200 && res.status < 300) return true;
        console.error('[Teams] webhook', res.status, JSON.stringify(res.data).slice(0, 200));
        return false;
    } catch (e) { console.error('[Teams] error', e.message); return false; }
}

// Every webhook var a report can post to, keyed by the ?target= name. warehouse_hold and finance_result
// are the compound ones the old channel lookup could not see — they are listed here so a test can prove
// they now resolve to the bot.
const TARGETS = {
    warehouse: 'TEAMS_WEBHOOK_WAREHOUSE', dp: 'TEAMS_WEBHOOK_DP', hold: 'TEAMS_WEBHOOK_HOLD',
    amazon: 'TEAMS_WEBHOOK_AMAZON', cron: 'TEAMS_WEBHOOK_CRON', inventory: 'TEAMS_WEBHOOK_INVENTORY',
    finance: 'TEAMS_WEBHOOK_FINANCE', warehouse_hold: 'TEAMS_WEBHOOK_WAREHOUSE_HOLD',
    finance_result: 'TEAMS_WEBHOOK_FINANCE_RESULT',
};

// GET /api/teams/routing — which delivery path each report will actually take, WITHOUT posting anything.
// A report silently falling back to the Workflows webhook is invisible in Teams apart from the sender
// name, so this answers "is it really coming from EcomBot?" in one call instead of waiting for a cron.
router.get('/teams/routing', (req, res) => {
    let botOn = false;
    try { botOn = require('./teams_bot').botEnabled(); } catch (_) { /* bot module absent → webhook only */ }
    const rows = Object.entries(TARGETS).map(([target, key]) => {
        const url = _envVal(key);
        const channelId = url ? channelForWebhook(url) : null;
        return {
            target, env_var: key,
            webhook: !!url,
            channel_id: channelId,
            via: (botOn && channelId) ? 'bot' : (url ? 'webhook' : 'not configured'),
            why: !url ? `${key} is not set` : !channelId ? `no TEAMS_CHANNEL_* matches ${key}` : !botOn ? 'bot disabled (TEAMS_BOT_APP_ID / _APP_PASSWORD missing)' : null,
        };
    });
    res.json({ success: true, bot_enabled: botOn, targets: rows });
});

// POST /api/teams/test?target=<one of TARGETS> — verify a channel is wired up, and report which path it used.
router.post('/teams/test', async (req, res) => {
    const target = String(req.query.target || 'warehouse');
    const key = TARGETS[target];
    const url = key && _envVal(key);
    if (!url) return res.status(400).json({ success: false, error: `No webhook configured for '${target}' — set ${key || 'TEAMS_WEBHOOK_*'} in .env` });
    let botOn = false;
    try { botOn = require('./teams_bot').botEnabled(); } catch (_) {}
    const channelId = channelForWebhook(url);
    const via = (botOn && channelId) ? 'bot' : 'webhook';
    const ok = await postTeams(url, { blocks: [
        { type: 'header', text: { type: 'plain_text', text: '✅ Teams webhook test' } },
        { type: 'section', text: { type: 'mrkdwn', text: `This is a *test* card from Ecom Central for the *${target}* channel, sent via *${via === 'bot' ? 'EcomBot' : 'the Workflows webhook'}*. If you can see this, reports will arrive here.` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: new Date().toLocaleString('en-IN') }] }
    ] });
    res.json({ success: ok, target, via, channel_id: channelId });
});

module.exports = { postTeams, buildCard, mrkdwn, router, channelForWebhook };
