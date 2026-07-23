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
            // dividers dropped — the blank line between parts already separates sections
        }
    } else if (payload.text) {
        parts.push(mrkdwnHtml(payload.text));
    }
    return parts.join('<br><br>');
}

function slackToCardBody(payload) {
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
            else if (b.type === 'divider') pendingSep = true;
        }
    } else if (payload.text) {
        push({ type: 'TextBlock', text: mrkdwn(payload.text), wrap: true });
    }
    return body;
}

// Slack URL buttons → Adaptive-Card OpenUrl actions (interactive Slack buttons have no URL → skipped).
function slackToCardActions(payload) {
    const actions = [];
    (payload.blocks || []).forEach(b => {
        if (b.type === 'actions' && Array.isArray(b.elements)) b.elements.forEach(el => {
            if (el.type === 'button' && el.url) actions.push({ type: 'Action.OpenUrl', title: (el.text && el.text.text) || 'Open', url: el.url });
        });
    });
    return actions;
}

// Build just the Adaptive Card object from a Slack-style payload. opts: { footer, actionUrl, actionTitle }
function buildAdaptiveCard(payload, opts = {}) {
    const body = slackToCardBody(payload);
    if (opts.footer) body.push({ type: 'TextBlock', text: mrkdwn(opts.footer), isSubtle: true, size: 'Small', wrap: true, separator: true });
    if (!body.length) return null;
    const actions = slackToCardActions(payload);
    if (opts.actionUrl && opts.actionTitle) actions.push({ type: 'Action.OpenUrl', title: opts.actionTitle, url: opts.actionUrl });
    const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body };
    if (actions.length) card.actions = actions;
    return card;
}

// Build the Teams message envelope (Adaptive Card attachment) — kept for compatibility.
function buildCard(payload, opts = {}) {
    const card = buildAdaptiveCard(payload, opts);
    if (!card) return null;
    return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] };
}

// Post a Slack-style payload to a Teams Workflow webhook as a native Adaptive Card.
// The Workflow's "Post card in a chat or channel" reads triggerBody()?['card'] — a JSON string of the card.
async function postTeams(webhookUrl, payload, opts = {}) {
    if (!webhookUrl) return false;
    const card = buildAdaptiveCard(payload, opts);
    if (!card) return false;
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

const TARGETS = { warehouse: 'TEAMS_WEBHOOK_WAREHOUSE', dp: 'TEAMS_WEBHOOK_DP', hold: 'TEAMS_WEBHOOK_HOLD', amazon: 'TEAMS_WEBHOOK_AMAZON' };

// POST /api/teams/test?target=warehouse|dp|hold|amazon — verify a channel's webhook is wired up.
router.post('/teams/test', async (req, res) => {
    const target = String(req.query.target || 'warehouse');
    const key = TARGETS[target];
    const url = key && (config[key] || process.env[key]);
    if (!url) return res.status(400).json({ success: false, error: `No webhook configured for '${target}' — set ${key || 'TEAMS_WEBHOOK_*'} in .env` });
    const ok = await postTeams(url, { blocks: [
        { type: 'header', text: { type: 'plain_text', text: '✅ Teams webhook test' } },
        { type: 'section', text: { type: 'mrkdwn', text: `This is a *test* card from Ecom Central for the *${target}* channel. If you can see this, reports will arrive here.` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: new Date().toLocaleString('en-IN') }] }
    ] });
    res.json({ success: ok, target });
});

module.exports = { postTeams, buildCard, mrkdwn, router };
