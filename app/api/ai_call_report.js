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

async function buildAiCallReport(dayOffset = 0) {
    const { fromISO, toISO, label } = istDay(dayOffset);
    const { data: rows } = await supabase.from('vobiz_auto_calls_ecom')
        .select('order_name, status, attempts, detail, phone, last_attempt_at, created_at')
        .eq('purpose', 'cod_confirm')
        .or(`and(last_attempt_at.gte.${fromISO},last_attempt_at.lt.${toISO}),and(last_attempt_at.is.null,created_at.gte.${fromISO},created_at.lt.${toISO})`)
        .limit(500);
    const all = rows || [];
    const dialed = all.filter(r => ['placed', 'calling', 'retry', 'exhausted', 'failed'].includes(r.status));
    const skipped = all.filter(r => r.status === 'skipped');
    const gated = all.filter(r => r.status === 'gated');
    const outcomeOf = r => r.status === 'exhausted' ? 'no_answer' : ((r.detail && r.detail.outcome) || (r.status === 'retry' ? 'retrying' : (r.status === 'failed' ? 'failed' : 'pending')));

    // order values + the day's call logs (language, exchanges, summary) for the dialed orders
    const names = dialed.map(r => r.order_name);
    const priceBy = {}, logBy = {};
    for (let i = 0; i < names.length; i += 100) {
        const chunk = names.slice(i, i + 100);
        const { data: ords } = await supabase.from('orders').select('name, total_price')
            .in('name', chunk.flatMap(n => [n, '#' + n]));
        (ords || []).forEach(o => { priceBy[String(o.name).replace(/^#/, '')] = Number(o.total_price) || 0; });
        const { data: logs } = await supabase.from('agent_call_logs')
            .select('order_id, language, exchanges, summary, called_at')
            .in('order_id', chunk).gte('called_at', fromISO).lt('called_at', toISO)
            .order('called_at', { ascending: true });
        (logs || []).forEach(l => { logBy[l.order_id] = l; });        // last log of the day wins
    }

    const count = o => dialed.filter(r => outcomeOf(r) === o).length;
    const sumVal = o => dialed.filter(r => outcomeOf(r) === o).reduce((a, r) => a + (priceBy[r.order_name] || 0), 0);
    const totalDials = dialed.reduce((a, r) => a + (Number(r.attempts) || 1), 0);
    const answered = dialed.filter(r => ['confirmed', 'denied', 'unclear'].includes(outcomeOf(r)));
    const langs = {};
    let exch = 0, exchN = 0;
    Object.values(logBy).forEach(l => { const L = String(l.language || '').split('-')[0] || '?';
        langs[L] = (langs[L] || 0) + 1; if (l.exchanges) { exch += l.exchanges; exchN++; } });
    const langLine = Object.entries(langs).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${({ hi: 'Hindi', en: 'English', pa: 'Punjabi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', gu: 'Gujarati' })[k] || k} ${v}`).join(' · ') || '—';

    const said = r => {
        const l = logBy[r.order_name];
        if (!l || !l.summary) return '—';
        return String(l.summary).split('\n')[0].replace(/^OUTCOME[^:]*:\s*/i, '');
    };
    // TWO columns is the FINAL layout (user, 2026-08-31: "instead of image use this" after seeing
    // both) — the number of columns that renders well everywhere: a 5-column card table shattered on
    // the Teams phone app ("₹ Amount" one letter per line), and the PNG-image alternative (edge fn
    // ai-call-report-image, still deployed but unused) was rejected in favour of this. Left cell =
    // order + amount + tries stacked; right cell = outcome + quote. Worst outcomes first, cap 10.
    const rankOrder = { denied: 0, unclear: 1, no_answer: 2, retrying: 3, failed: 4, confirmed: 5, pending: 6 };
    const sorted = dialed.slice().sort((a, b) => (rankOrder[outcomeOf(a)] ?? 9) - (rankOrder[outcomeOf(b)] ?? 9));
    const tableRows = sorted
        .slice(0, 10).map(r => {
            const o = outcomeOf(r);
            const chip = (OUT[o] && OUT[o].chip) || (o === 'retrying' ? `📞 Retrying ${r.attempts}/3` : o);
            const quote = said(r);
            const tries = `${r.attempts || 1} ${(r.attempts || 1) === 1 ? 'try' : 'tries'}`;
            // '\n\n' on purpose: an Adaptive Card TextBlock treats a single newline as a space —
            // only the blank line forces the real line break inside a cell.
            return [`*${r.order_name}*\n\n${inr(priceBy[r.order_name])} · ${tries}`,
                `${chip}${quote && quote !== '—' ? `\n\n_"${quote}"_` : ''}`];
        });
    const extra = dialed.length - tableRows.length;

    const skipWhy = {};
    skipped.forEach(r => { const w = (r.detail && r.detail.why) || 'skipped'; skipWhy[w] = (skipWhy[w] || 0) + 1; });
    const skipLine = Object.entries(skipWhy).map(([w, n]) => `${n} ${w}`).join(' · ');

    const dateLbl = new Date(label + 'T00:00:00Z').toUTCString().slice(0, 11);
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `📞 AI Calling Report — ${dateLbl}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${dialed.length} order${dialed.length === 1 ? '' : 's'} called* · ${totalDials} dial${totalDials === 1 ? '' : 's'} including retries · window 10:00–19:59 IST` } },
        { type: 'section', fields: [
            { type: 'mrkdwn', text: `✅ *Confirmed: ${count('confirmed')}* — ${OUT.confirmed.note}` },
            { type: 'mrkdwn', text: `❌ *Denied: ${count('denied')}* — ${OUT.denied.note}` },
            { type: 'mrkdwn', text: `😕 *Not confirmed: ${count('unclear')}* — ${OUT.unclear.note}` },
            { type: 'mrkdwn', text: `🔇 *No answer: ${count('no_answer')}* — ${OUT.no_answer.note}` },
        ] },
        { type: 'section', text: { type: 'mrkdwn', text: `*₹ Impact:* ${inr(sumVal('confirmed'))} released to dispatch (confirmed) · ${inr(sumVal('denied'))} saved from likely RTO (denied caught before shipping)` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Call quality:* answer rate ${dialed.length ? Math.round(answered.length / dialed.length * 100) : 0}% · avg ${exchN ? Math.round(exch / exchN) : 0} exchanges · languages: ${langLine}` } },
    ];
    if (tableRows.length) blocks.push({ type: 'table',
        columns: [
            { title: 'Order · ₹ Amount · Tries', width: 2, align: 'Left', wrap: true },
            { title: 'Outcome — what the customer said', width: 5, align: 'Left', wrap: true },
        ], rows: tableRows });
    if (extra > 0) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `+ ${extra} more order${extra === 1 ? '' : 's'} — full list in Call Queue · Repeat` }] });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⏭ Skipped: ${skipLine || 'none'}${gated.length ? ` · ${gated.length} gated (test allowlist)` : ''} · transcripts & recordings → Pravidhi › Call Logs` }] });

    return { payload: { blocks }, stats: { called: dialed.length, dials: totalDials, confirmed: count('confirmed'), denied: count('denied'), unclear: count('unclear'), no_answer: count('no_answer'), skipped: skipped.length, gated: gated.length } };
}

// Delivery is BOT-FIRST by explicit instruction ("i want report go through our Own Bot"): the
// Pravidhi bot replies INSIDE the Ops › Daily Reports thread the user pinned (a webhook cannot
// reply into a thread at all), with the 1.5 rich card (real Table — the bot is not pinned to the
// Workflows connector's 1.4). TEAMS_AI_CALLS_THREAD overrides the target ('<channelId>' for a new
// channel post, '<channelId>;messageid=<rootId>' for a thread reply). TEAMS_WEBHOOK_AI_CALLS stays
// as an optional fallback if the bot errors; with neither working the failure is logged, never thrown.
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
        console.log(`[AI-CallReport] posted via the Pravidhi bot — ${stats.called} called, ${stats.confirmed} confirmed`);
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
