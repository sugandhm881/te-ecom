// ─────────────────────────────────────────────────────────────────────────────
// CALL INSIGHTS (user, 2026-09-02: "analyse all call transcripts and find top 5 things we need to
// improve, what top worse thing agent doing, and top 5 things agent good doing").
//
// Two halves, deliberately:
//   · HARD METRICS — counted straight from the transcripts, no model involved, so the numbers can
//     never drift or be argued with: connect rate, duration, outcome mix, language mix, and the
//     behaviour counters that map to the rules the agent is supposed to follow (double
//     introduction, hello-storms, the want-it question over-asked, calls that reached the brand
//     closing, mid-call language switches, repeat-called customers).
//   · AI AUDIT — one Claude pass over the period's richest conversations returning ranked lists
//     (improve / worst / good) with quotes. Cached in agent_call_insights_ecom because it costs
//     real money; the dashboard shows when it last ran and re-runs on the user's click.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');

const durOf = (c) => Number((String(c.summary || '').match(/(\d+)s call to/) || [])[1] || 0);
const custTurns = (t) => (String(t || '').match(/^customer:/gim) || []).length;
const agentLines = (t) => String(t || '').split('\n').filter(l => /^agent:/i.test(l));

// Every counter here mirrors a RULE the agent is meant to follow, so a rising number is a
// regression and a falling one is proof a fix worked.
function behaviour(calls) {
    const b = { double_intro: 0, hello_storm: 0, wantit_overasked: 0, reached_closing: 0,
        lang_switched: 0, agent_turns: 0, one_sided: 0 };
    for (const c of calls) {
        const ag = agentLines(c.transcript);
        b.agent_turns += ag.length;
        if (ag.filter(l => /this is \w+ from The Element|मैं \w+ बोल|from The Element,? (calling|and)/i.test(l)).length > 1) b.double_intro++;
        if (/\[language switched/.test(c.transcript || '')) b.lang_switched++;
        if ((String(c.transcript || '').split('\n').filter(l => /^customer:\s*(hello|हेलो|हैलो)[\s.,!?।]*$/i.test(l.trim())).length) >= 3) b.hello_storm++;
        if (ag.filter(l => /would you still like to receive|receive करना चाहेंगे|send (it|the .*) again|भेज (दूँ|देने)/i.test(l)).length > 2) b.wantit_overasked++;
        if (/great day|दिन शुभ हो|choosing The Element|चुनने के लिए/i.test(ag[ag.length - 1] || '')) b.reached_closing++;
        if (durOf(c) > 0 && custTurns(c.transcript) === 0) b.one_sided++;
    }
    return b;
}

function outcomeOf(summary) {
    const l = (String(summary || '').split('\n')[0] || '').toLowerCase();
    if (/reattempt agreed|will reattempt/.test(l)) return 'reattempt';
    if (/cancel/.test(l)) return 'cancelled';
    if (/no answer|unresponsive|never engaged|voicemail/.test(l)) return 'no_answer';
    if (/unclear/.test(l)) return 'unclear';
    if (/confirmed/.test(l)) return 'confirmed';
    return 'other';
}

async function loadCalls(fromIso, toIso) {
    const { data, error } = await supabase.from('agent_call_logs')
        .select('id, order_id, call_type, language, exchanges, summary, transcript, called_at')
        .gte('called_at', fromIso).lte('called_at', toIso)
        .order('called_at', { ascending: false }).limit(1200);
    if (error) throw new Error('call log read failed: ' + error.message);
    return (data || []).filter(c => c.transcript && c.transcript.length > 30);
}

router.get('/support/call-insights', async (req, res) => {
    try {
        const from = String(req.query.from || '').slice(0, 10);
        const to = String(req.query.to || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
            return res.status(400).json({ success: false, error: 'from/to (YYYY-MM-DD) required' });
        const fromIso = new Date(`${from}T00:00:00+05:30`).toISOString();
        const toIso = new Date(`${to}T23:59:59.999+05:30`).toISOString();

        const calls = await loadCalls(fromIso, toIso);
        const connected = calls.filter(c => durOf(c) > 0);
        const outcomes = {}, langs = {}, types = {}, byOrder = {};
        for (const c of calls) {
            const o = outcomeOf(c.summary); outcomes[o] = (outcomes[o] || 0) + 1;
            langs[c.language || '?'] = (langs[c.language || '?'] || 0) + 1;
            const t = String(c.call_type || '').replace('_vobiz', ''); types[t] = (types[t] || 0) + 1;
            byOrder[c.order_id] = (byOrder[c.order_id] || 0) + 1;
        }
        const repeatCalled = Object.values(byOrder).filter(n => n >= 3).length;
        const b = behaviour(calls);

        // the cached audit for this window (newest first)
        const { data: cached } = await supabase.from('agent_call_insights_ecom')
            .select('*').eq('from_date', from).eq('to_date', to)
            .order('created_at', { ascending: false }).limit(1).maybeSingle();

        res.json({
            success: true,
            range: { from, to },
            metrics: {
                calls: calls.length, connected: connected.length,
                answer_rate: calls.length ? Math.round(connected.length / calls.length * 100) : 0,
                avg_seconds: connected.length ? Math.round(connected.reduce((a, c) => a + durOf(c), 0) / connected.length) : 0,
                avg_agent_turns: calls.length ? Number((b.agent_turns / calls.length).toFixed(1)) : 0,
                repeat_called_orders: repeatCalled,
            },
            outcomes, languages: langs, types,
            behaviour: {
                double_intro: b.double_intro, hello_storm: b.hello_storm,
                wantit_overasked: b.wantit_overasked, reached_closing: b.reached_closing,
                lang_switched: b.lang_switched, one_sided: b.one_sided, total: calls.length,
            },
            audit: cached || null,
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Run (or re-run) the AI audit for a window. Costs one Claude call over the richest conversations.
router.post('/support/call-insights/run', async (req, res) => {
    try {
        const from = String((req.body || {}).from || '').slice(0, 10);
        const to = String((req.body || {}).to || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
            return res.status(400).json({ success: false, error: 'from/to required' });
        if (!process.env.CLAUDE_API_KEY) return res.status(400).json({ success: false, error: 'CLAUDE_API_KEY not configured' });
        const fromIso = new Date(`${from}T00:00:00+05:30`).toISOString();
        const toIso = new Date(`${to}T23:59:59.999+05:30`).toISOString();

        const calls = await loadCalls(fromIso, toIso);
        // Real CONVERSATIONS only — a hello-only call teaches the audit nothing, and 60 is plenty
        // of signal without paying for a novel-sized prompt.
        const rich = calls.filter(c => custTurns(c.transcript) >= 2).slice(0, 60);
        if (rich.length < 3) return res.json({ success: false, error: 'not enough real conversations in this range yet' });

        // Each call carries its OUTCOME and length, so the audit can correlate behaviour with
        // results ("the calls that ended in no_answer all did X") instead of only reading prose.
        const blob = rich.map((c, i) => `=== CALL ${i + 1} · ${c.order_id} · ${c.language} · ${durOf(c)}s · ${custTurns(c.transcript)} customer turns · outcome: ${outcomeOf(c.summary)}\n${String(c.transcript).slice(0, 1400)}`).join('\n\n');
        const mix = {}; for (const c of calls) { const o = outcomeOf(c.summary); mix[o] = (mix[o] || 0) + 1; }
        const context = `PERIOD TOTALS: ${calls.length} calls logged, ${calls.filter(c => durOf(c) > 0).length} connected, outcome mix ${JSON.stringify(mix)}.
THE AGENT'S STANDING RULES (a breach is a real finding): introduce herself once per call; ask "do you still want it?" at most twice; never ask for a delivery time (the courier team schedules); answer "when will it arrive" with the courier-team assurance, never a date; give the courier's recorded NDR reason with attempt dates when asked; confirm the address ONLY when an address is provided in her prompt; acknowledge trouble in the customer's own language before continuing; never invent facts, never promise refunds; end with the brand closing.`;
        const model = process.env.CALL_INSIGHTS_MODEL || 'claude-sonnet-5';
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                // Sonnet 5 thinks before it writes and the thinking is billed against max_tokens —
                // at 2,200 the whole budget went to thinking and the reply came back EMPTY (the
                // Run-audit button did nothing). 9,000 leaves plenty of room for the JSON.
                model, max_tokens: 9000,
                system: 'You audit outbound AI phone calls for an Indian D2C skincare brand. Call types: rto_recovery (order came back undelivered — does the customer still want it) and cod_confirm (verify a COD order before dispatch). Be blunt, specific and evidence-led; never pad with praise. Reply ONLY with JSON.',
                messages: [{ role: 'user', content: context + '\n\n' + blob + `\n\nAudit ALL the calls above. Judge against the standing rules AND against what actually WON reattempts versus what lost them. Prefer findings you can tie to an outcome or a rule breach; say how many calls show each pattern. Reply with ONLY this JSON:
{"improve":[{"title":"the problem in <=9 words","evidence":"a real quote plus how many calls show it","fix":"one concrete change to the agent's rules or flow"}],
 "worst":{"title":"the single most damaging behaviour","detail":"what it costs, with evidence and how often"},
 "good":[{"title":"what genuinely works, <=9 words","evidence":"a real quote or the outcome it produced"}]}
Exactly 5 in "improve" and 5 in "good". No markdown, no text outside the JSON.` }],
            }),
        });
        const d = await r.json();
        // Take the TEXT blocks, never content[0] — Claude 5 returns a thinking block first, and
        // reading index 0 silently yielded "" (the Run-audit button appeared to do nothing).
        const text = ((d.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join('')).trim();
        if (!text) return res.status(502).json({ success: false, error: 'audit model returned nothing: ' + JSON.stringify(d).slice(0, 160) });
        let parsed = null;
        try { parsed = JSON.parse(text.replace(/^```(json)?|```$/gm, '').trim()); } catch (_) { /* keep raw */ }

        const { data: row, error } = await supabase.from('agent_call_insights_ecom').insert({
            from_date: from, to_date: to, calls_analysed: rich.length,
            improve: (parsed && parsed.improve) || null,
            worst: (parsed && parsed.worst) || null,
            good: (parsed && parsed.good) || null,
            raw: text.slice(0, 12000), model,
        }).select('*').maybeSingle();
        if (error) throw new Error('insight save failed: ' + error.message);
        res.json({ success: true, audit: row, calls_analysed: rich.length });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router };
