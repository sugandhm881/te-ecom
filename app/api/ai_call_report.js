// ─────────────────────────────────────────────────────────────────────────────
// AI Calling Report → Teams (user approved the design 2026-08-31; sample at the artifact preview).
// Daily at 20:15 IST — right after the calling window closes — one card posted BY THE PRAVIDHI BOT
// as a reply inside the Ops › Daily Reports thread (user: "i want report go through our Own Bot";
// verified live 2026-08-31). TEAMS_AI_CALLS_THREAD overrides the target; TEAMS_WEBHOOK_AI_CALLS is
// only a fallback if the bot errors. Sections mirror the approved design: outcomes (colors = the Call
// Queue chips), ₹ impact (released vs saved), call quality, per-order table capped at 10 rows,
// skipped footer. Manual trigger: POST /api/vobiz/ai-call-report (?preview=1 returns the payload
// without posting) — same capability gate as the other vobiz endpoints.
'use strict';
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');

const OUT = {
    confirmed: { chip: '✅ Confirmed', note: 'holds auto-released' },
    denied: { chip: '❌ Denied', note: 'flagged red — team decides' },
    unclear: { chip: '😕 Not confirmed', note: 'flagged amber' },
    no_answer: { chip: '🔇 No answer', note: '3 attempts — flagged violet' },
};
const inr = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

// IST day window (00:00 IST of `dayOffset` days ago → now/end of that day) in UTC ISO.
function istDay(dayOffset = 0) {
    const IST = 5.5 * 3600e3;
    const nowIst = Date.now() + IST;
    const startIst = Math.floor(nowIst / 86400e3) * 86400e3 - dayOffset * 86400e3;
    return { fromISO: new Date(startIst - IST).toISOString(), toISO: new Date(startIst + 86400e3 - IST).toISOString(),
        label: new Date(startIst).toISOString().slice(0, 10) };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DAILY CARD IS NOW THE CALL INSIGHTS PAGE (user, 2026-09-09: "i want same as this screenshot as
// call report of today in our Teams thread — where currently call report coming, stop that report and
// send this report, and also only AI call report not manual call").
//
// What it replaced: a COD-confirmation-only report (`purpose='cod_confirm'`), which by September was a
// minority of the calling — on 08 Sep, 30 of 116 AI calls. It reported on a slice and read like the
// whole day.
//
// ⚠️ Built from `computeInsights`, the SAME function the dashboard renders from, with type='ai' so
// manual human calls are excluded exactly as they are on screen. Re-deriving these numbers here would
// have been two implementations of "how many calls were answered today" — and the disagreement would
// have happened in a channel where the whole team can see it.
//
// Kept from the old report: the 20:15 IST cron, the post as a reply in Ops › Daily Reports by the
// Pravidhi bot, TEAMS_AI_CALLS_THREAD as the target override, and the webhook as a bot-failure
// fallback. An Adaptive Card rather than a rendered image — the image approach (edge function
// `ai-call-report-image`) was weighed and rejected on 2026-08-31 and that decision still holds: a card
// is searchable, readable on a phone, and does not go stale behind a URL.
// ─────────────────────────────────────────────────────────────────────────────

// Colour is meaning, not decoration — the same reading as the dashboard tiles.
const GOOD = 'Good', WARN = 'Warning', BAD = 'Attention', MUTE = 'Default';

const OUT_LABEL = {
    reattempt: 'Re-attempt agreed', confirmed: 'Confirmed', cancelled: 'Cancelled',
    unclear: 'Unclear', other: 'Other', no_outcome: 'Spoke, no outcome recorded',
    no_answer: 'No answer', no_conversation: 'Ended before any conversation',
};
const OUT_COLOR = {
    reattempt: GOOD, confirmed: GOOD, cancelled: BAD, unclear: WARN, other: WARN,
    no_outcome: WARN, no_answer: MUTE, no_conversation: MUTE,
};

const pct = (n, of) => (of > 0 ? Math.round((n / of) * 100) : 0);
// Tone per outcome for the rendered tiles — green won it back, rose lost it, amber needs a person.
const OUT_TONE = {
    reattempt: 'good', confirmed: 'good', cancelled: 'bad',
    unclear: 'warn', other: 'warn', no_outcome: 'warn',
};

// One row of the "fact set" Teams renders as a two-column table.
const fact = (title, value) => ({ title, value });

async function buildAiCallReport(dayOffset = 0) {
    const { label } = istDay(dayOffset);
    const { computeInsights } = require('./ai_call_insights');
    // type:'ai' — manual human calls are excluded, as the user asked and as the dashboard does.
    const d = await computeInsights({ from: label, to: label, type: 'ai' });
    const m = d.metrics, sil = d.silence || {}, calls = d.calls || [];

    // The three shares that partition the day, computed exactly as the page does: settled, reached but
    // unresolved (answered − settled, so an outcome nobody has named yet cannot make them sum to 97%),
    // and nobody spoke.
    const spoke = c => !!(c.flags && c.flags.customer_turns > 0);
    const SETTLED = ['reattempt', 'confirmed', 'cancelled'];
    const answered = calls.filter(spoke), silent = calls.filter(c => !spoke(c));
    const settledN = calls.filter(c => SETTLED.includes(c.outcome)).length;
    const unresolvedN = Math.max(0, answered.length - settledN);

    // Outcomes among the answered calls, with the same no_answer → no_outcome remap the page uses: a
    // call where the customer SPOKE cannot honestly be filed under "no answer".
    const tally = {};
    for (const c of answered) {
        let k = c.outcome || 'other';
        if (k === 'no_answer' || k === 'no_conversation') k = 'no_outcome';
        tally[k] = (tally[k] || 0) + 1;
    }
    const outRows = Object.entries(tally).sort((x, y) => y[1] - x[1]);

    const TYPE_LABEL = { rto_recovery: 'RTO recovery', cod_confirm: 'COD confirmation', cod_rejected: 'COD rejection check' };

    // ── THE REPORT IS AN IMAGE (user, 2026-09-09: "i want report in image format not table format").
    //
    // Why: an Adaptive Card cannot scroll horizontally and is ~360px wide on Teams mobile, so a table
    // of tiles either truncates or reflows to one word per line — the same reason the inventory DOI
    // report went to an image in August. `ai-call-report-image` (Satori→PNG) renders the Call Insights
    // layout in the dashboard's own palette and returns a public URL.
    //
    // ⚠️ The image is not the ONLY copy. The card keeps a one-line text headline so the report is
    // searchable in Teams and readable in a notification preview, and so a render failure still posts
    // something true rather than nothing — a report that silently stops arriving is worse than an ugly
    // one. If the render fails we fall back to the block layout this replaced.
    //
    // ⚠️ ASCII ONLY in anything sent to the renderer: the Roboto latin subset has no rupee sign, emoji,
    // en dash or middle dot, and the edge function strips them rather than drawing blank boxes. Hence
    // "-" and "/" below, not the typographic characters used elsewhere in this file.
    const T = (n, pct, lbl, sub, tone) => ({ n: String(n), pct: pct || '', label: lbl, sub: sub || '', tone: tone || '' });
    const share = n => `${pct(n, m.calls)}%`;

    const imgPayload = {
        label,
        subtitle: `The Element / AI calls only${m.manual_calls ? ` / ${m.manual_calls} manual calls not scored` : ''}`,
        headline: `Of ${m.calls} AI calls, ${m.answered} reached someone and ${d.outcomes.reattempt || 0} agreed to a re-attempt.` +
                  (sil.silent_long ? ` ${sil.silent_long} were lost to silence - the line stayed open 20 seconds or more and the customer was never heard.` : ''),
        // THE DAY IN THREES (user, 2026-09-09: "make card 3x3 ... remove order called 3+ time card").
        // Row 1 is the funnel down to a conversation, row 2 is the three-way partition of every call,
        // row 3 is the two averages — the only figures here that are not a count of calls, which is why
        // they sit apart at the bottom rather than interrupting the counts.
        //
        // Row 2 self-checks on the face of it: answered = settled + unresolved, and answered + nobody
        // spoke = the call count. If those ever stop adding up, the report is wrong and it shows.
        //
        // ⚠️ Every tile carries its share EXCEPT the two averages. A percentage on "29s" or "3.1 turns"
        // would be a number we invented — there is no whole for them to be a part of — so they are left
        // bare rather than given a meaningless one.
        kpis: [
            T(m.dials_placed != null ? m.dials_placed : m.calls,
              m.dials_placed ? `${pct(m.calls, m.dials_placed)}%` : '',
              'Dials placed', m.dials_placed ? `${m.calls} became a call with a transcript` : ''),
            T(m.calls, '100%', 'AI calls with transcripts', 'the denominator for everything below'),
            T(m.answered, share(m.answered), 'Answered - customer spoke', 'settled + unresolved', 'good'),

            T(silent.length, share(silent.length), 'Nobody spoke',
              'ended before any conversation + no answer', 'mute'),
            T(unresolvedN, share(unresolvedN), 'Reached but unresolved',
              'spoke with no outcome recorded + unclear', 'warn'),
            T(settledN, share(settledN), 'Settled - a real decision',
              're-attempt, confirmed or cancelled', 'good'),

            T(`${m.avg_seconds}s`, '', 'Avg length', 'connected calls'),
            T(m.avg_agent_turns, '', 'Avg agent turns', 'lower is tighter'),
        ],
        funnel: [
            T(m.answered, share(m.answered), 'Answered - customer spoke', '', 'good'),
            T(sil.hung_up_fast || 0, share(sil.hung_up_fast || 0), 'Hung up within 5 seconds'),
            T(sil.silent_short || 0, share(sil.silent_short || 0), 'Silent, under 20s'),
            T(sil.silent_long || 0, share(sil.silent_long || 0), 'Silent 20s+ - agent may be deaf', '', 'bad'),
            T(sil.never_connected || 0, share(sil.never_connected || 0), 'Never connected', '', 'mute'),
        ],
        answered_label: `Of the answered calls - ${answered.length} where the customer spoke`,
        answered: outRows.map(([k, v]) => T(v, `${pct(v, answered.length)}%`, OUT_LABEL[k] || k, '', OUT_TONE[k] || '')),
        silent_label: `Nobody spoke - ${silent.length} calls`,
        silent: Object.entries(silent.reduce((o, c) => {
            const k = c.outcome || 'other'; o[k] = (o[k] || 0) + 1; return o;
        }, {})).sort((x, y) => y[1] - x[1])
            .map(([k, v]) => T(v, `${pct(v, silent.length)}%`, OUT_LABEL[k] || k, '', 'mute')),
        by_type: Object.entries(d.by_type || {}).sort((x, y) => y[1].calls - x[1].calls).map(([k, t]) =>
            T(t.calls, `${pct(t.calls, m.calls)}%`, TYPE_LABEL[k] || k,
              `${t.orders ? `to ${t.orders} orders / ` : ''}answered ${t.answered} (${t.answer_rate}%) / won ${t.won} / avg ${t.avg_seconds}s`)),
    };

    let imageUrl = null;
    try {
        const axios = require('axios');
        const config = require('../../config');
        const r = await axios.post(`${config.SUPABASE_URL}/functions/v1/ai-call-report-image`, imgPayload, {
            headers: { Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
            timeout: 120000, validateStatus: () => true,
        });
        if (r.status >= 400 || !r.data || !r.data.image_url) throw new Error((r.data && r.data.error) || `render returned ${r.status}`);
        imageUrl = r.data.image_url;
    } catch (e) {
        console.warn('[AI-CallReport] image render failed - falling back to the text card:', e.message);
    }

    // ⚠️ SLACK BLOCK KIT, not Adaptive Card elements. teams.js translates blocks → card and returns
    // null for anything it does not recognise, and buildCard's caller treats null as "card build
    // failed" — which is exactly how the first version of this posted nothing at all while reporting
    // success in the logs. `*bold*` here is Slack's single-asterisk; mrkdwn() converts it.
    const fieldsOf = pairs => pairs.map(([t, v]) => ({ type: 'mrkdwn', text: `*${t}*\n${v}` }));
    const shareLine = (n) => `${n}  ·  ${pct(n, m.calls)}%`;

    const headlineText = `Of *${m.calls}* AI calls, *${m.answered} reached someone* and *${d.outcomes.reattempt || 0} agreed to a re-attempt*.` +
        (sil.silent_long ? ` *${sil.silent_long} were lost to silence* — the line stayed open 20 seconds or more and the customer was never heard.` : '');

    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `Call Insights — ${label}` } },
        { type: 'context', elements: [{ type: 'mrkdwn',
            text: `AI calls only${m.manual_calls ? `  ·  ${m.manual_calls} manual calls not scored` : ''}` }] },
        { type: 'section', text: { type: 'mrkdwn', text: headlineText } },
    ];

    if (imageUrl) {
        // allowExpand (set in teams.js) makes this tappable into Teams' own full-screen viewer, which is
        // what makes a dense report usable on a phone.
        blocks.push({ type: 'image', image_url: imageUrl, alt_text: `Call Insights ${label}` });
    } else {
        // The fallback: the same figures as text, so a render failure still posts a true report.
        blocks.push({ type: 'section', fields: fieldsOf([
            ['Answered', `${m.answered}  ·  ${m.answer_rate}% of calls`],
            ['Re-attempts won', `${d.outcomes.reattempt || 0}  ·  ${pct(d.outcomes.reattempt || 0, m.answered)}% of answered`],
            ['Settled — a real decision', shareLine(settledN)],
            ['Reached but unresolved', shareLine(unresolvedN)],
            ['Nobody spoke', shareLine(silent.length)],
            ['Silent 20s+ — agent may be deaf', shareLine(sil.silent_long || 0)],
        ]) });
    }

    if (sil.silent_long > 0) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn',
            text: `⚠️ *${sil.silent_long} call${sil.silent_long === 1 ? '' : 's'} stayed open 20s+ with nothing heard back* — check the speech socket before tomorrow's window.` } });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn',
        text: 'Full detail, per call → Pravidhi › Customer Support › Call Insights' }] });

    const payload = { blocks };
    const stats = {
        called: m.calls, answered: m.answered, reattempts: d.outcomes.reattempt || 0,
        settled: settledN, silent_long: sil.silent_long || 0, manual_excluded: m.manual_calls || 0,
    };
    return { payload, stats };
}

// The Ops › Daily Reports thread the card replies into. Unchanged by the 2026-09-09 rewrite — only the
// card's CONTENTS changed — but the constant lived inside the block that was replaced and went with it,
// so the 20:15 cron would have thrown "AI_CALLS_THREAD is not defined" into an empty channel. The
// selftest that pins this messageid is what caught it.
const AI_CALLS_THREAD = () => String(process.env.TEAMS_AI_CALLS_THREAD
    || '19:69ffe3edf4044f958c54cb6bc57a4232@thread.tacv2;messageid=1788173520400').trim();

async function sendAiCallReport(dayOffset = 0) {
    const { payload, stats } = await buildAiCallReport(dayOffset);
    if (!stats.called && !stats.skipped) { console.log('[AI-CallReport] nothing to report — no calls today, no post'); return { skipped: 'no activity' }; }
    const { buildCard, postTeams } = require('./teams');
    try {
        const bot = require('./teams_bot');
        if (!bot.botEnabled()) throw new Error('bot not configured');
        const activity = buildCard(payload, { rich: true });   // { type:'message', attachments:[adaptive 1.5 card] }
        if (!activity) throw new Error('card build failed');
        await bot.sendToChannel(AI_CALLS_THREAD(), activity);
        console.log(`[AI-CallReport] posted via the Pravidhi bot — ${stats.called} AI calls, ${stats.answered} answered, ${stats.reattempts} re-attempts`);
        return { posted: true, via: 'bot', stats };
    } catch (e) {
        console.warn('[AI-CallReport] bot post failed:', e.message);
        const hook = String(process.env.TEAMS_WEBHOOK_AI_CALLS || '').trim();
        if (!hook) { console.log('[AI-CallReport] no TEAMS_WEBHOOK_AI_CALLS fallback — report not posted'); return { skipped: 'bot failed, no webhook', error: e.message, stats }; }
        const ok = await postTeams(hook, payload);
        console.log(`[AI-CallReport] webhook fallback ${ok ? 'posted' : 'FAILED'}`);
        return { posted: !!ok, via: 'webhook', stats };
    }
}

// Manual trigger / preview. ?preview=1 returns the payload; ?day=1 reports yesterday.
router.post('/vobiz/ai-call-report', async (req, res) => {
    try {
        const day = Number((req.query || {}).day || 0) || 0;
        if (String((req.query || {}).preview || '') === '1') return res.json({ success: true, ...(await buildAiCallReport(day)) });
        res.json({ success: true, ...(await sendAiCallReport(day)) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, buildAiCallReport, sendAiCallReport };
