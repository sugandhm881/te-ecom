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

// A call whose close() never ran (a restart mid-call) keeps its LIVE BACKUP summary — "⏳ call in
// progress (live backup, 36s so far)" — which carries no "Ns call to" and so read as ZERO seconds.
// One such call on 07 Sep had two customer turns across 36 seconds and was being filed under "never
// connected". Read the backup's own number when the final one is absent.
const durOf = (c) => {
    const s = String(c.summary || '');
    const m = s.match(/([0-9]+)s call to/) || s.match(/live backup, ([0-9]+)s/);
    return Number((m || [])[1] || 0);
};
const custTurns = (t) => (String(t || '').match(/^customer:/gim) || []).length;
const agentLines = (t) => String(t || '').split('\n').filter(l => /^agent:/i.test(l));

// Every counter here mirrors a RULE the agent is meant to follow, so a rising number is a
// regression and a falling one is proof a fix worked.
// Aggregate counters, summed from the SAME per-call flags the detail rows show — so a bar can never
// claim five breaches while the list underneath shows four.
function behaviour(calls) {
    const b = { double_intro: 0, hello_storm: 0, wantit_overasked: 0, reached_closing: 0,
        lang_switched: 0, agent_turns: 0, one_sided: 0 };
    for (const c of calls) {
        const f = flagsFor(c);
        b.agent_turns += f.agent_turns;
        if (f.double_intro) b.double_intro++;
        if (f.hello_storm) b.hello_storm++;
        if (f.wantit_overasked) b.wantit_overasked++;
        if (f.one_sided) b.one_sided++;
        if (f.reached_closing) b.reached_closing++;
        if (f.lang_switched) b.lang_switched++;
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
    // "OTHER" WAS 51 OF 121 CALLS AND MEANT NOTHING (user, 2026-09-08: "instead of other use actual
    // reason"). Every one of them was the MECHANICAL fallback line — "13s call to 9979549400 (stream
    // closed) · auto engine" — which is written when the summarizer never ran, because the call ended
    // before there was any conversation to summarise. That is a real outcome and the most common one
    // on a bad day, so it gets its own name instead of hiding in a bucket.
    if (/^[0-9]+s call to/.test(l.trim())) return 'no_conversation';
    // Wordings the model produces that the checks above miss — real answers, phrased its own way.
    if (/did not respond|no response|dropped before|call dropped|not reachable|switched off/.test(l)) return 'no_answer';
    if (/no clear answer|could not determine|not clear/.test(l)) return 'unclear';
    return 'other';
}

// PAGED, because Supabase caps a read at 1,000 rows and silently returns the first page — at ~60
// calls a day a month of history is ~1,800 and the tail would simply vanish from every number on
// the page. Walks in 1,000-row pages until a short page comes back, with a hard ceiling so a huge
// range cannot pull the server over.
async function loadCalls(fromIso, toIso, { cap = 5000 } = {}) {
    const out = [];
    for (let page = 0; page * 1000 < cap; page++) {
        const { data, error } = await supabase.from('agent_call_logs')
            .select('id, order_id, customer_name, call_type, language, exchanges, summary, transcript, called_at, recording_url, cost_meta')
            .gte('called_at', fromIso).lte('called_at', toIso)
            .order('called_at', { ascending: false })
            .range(page * 1000, page * 1000 + 999);
        if (error) throw new Error('call log read failed: ' + error.message);
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return out.filter(c => c.transcript && c.transcript.length > 30);
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE SOURCE OF TRUTH FOR THE RULE FLAGS. The compliance bars used to be counted inline, so the
// page could tell you five calls broke a rule but never WHICH five — and a per-call view computed
// separately would drift from the totals it sits under. Both now read this.
// Each flag is a rule the agent must follow; true means this call BROKE it, except `reached_closing`
// and `lang_switched`, which are good things and are counted as such.
// ─────────────────────────────────────────────────────────────────────────────
function flagsFor(c) {
    const ag = agentLines(c.transcript);
    const t = String(c.transcript || '');
    return {
        double_intro: ag.filter(l => /this is \w+ from The Element|मैं \w+ बोल|from The Element,? (calling|and)/i.test(l)).length > 1,
        hello_storm: t.split('\n').filter(l => /^customer:\s*(hello|हेलो|हैलो)[\s.,!?।]*$/i.test(l.trim())).length >= 3,
        wantit_overasked: ag.filter(l => /would you still like to receive|receive करना चाहेंगे|send (it|the .*) again|भेज (दूँ|दें|दीजिए)/i.test(l)).length >= 3,
        one_sided: durOf(c) > 0 && custTurns(c.transcript) === 0,
        reached_closing: /great day|दिन शुभ हो|choosing The Element|चुनने के लिए/i.test(ag[ag.length - 1] || ''),
        lang_switched: /\[language switched/.test(t),
        blocked_line: /\[not spoken — blocked by rule\]/.test(t),
        agent_turns: ag.length,
        customer_turns: custTurns(c.transcript),
    };
}

// What one call cost in Claude tokens, from the ledger the bridge writes per call (cost_meta).
// Anthropic list prices, the same ones the AI Calling Statement uses; null when a call predates
// the ledger rather than a fabricated zero.
const CLAUDE_RATES = { 'claude-haiku-4-5-20251001': [1, 5], 'claude-sonnet-5': [3, 15], 'claude-opus-5': [15, 75] };
function claudeCostOf(c) {
    const m = c.cost_meta && c.cost_meta.claude;
    if (!m || typeof m !== 'object') return null;
    let usd = 0, tokens = 0;
    for (const [model, u] of Object.entries(m)) {
        const [pin, pout] = CLAUDE_RATES[model] || CLAUDE_RATES['claude-haiku-4-5-20251001'];
        const i = +u.in || 0, o = +u.out || 0, cr = +u.cr || 0, cw = +u.cw || 0;
        usd += (i * pin + o * pout + cr * pin * 0.1 + cw * pin * 1.25) / 1e6;
        tokens += i + o + cr + cw;
    }
    return { inr: Math.round(usd * Number(process.env.COST_USD_INR || 88) * 100) / 100, tokens };
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
        // A HUMAN'S CALL IS NOT THE AGENT'S SCORE (user, 2026-09-08: "what is 117 call happen,
        // categorise that properly"). Manual calls are logged with "[manual human call — not
        // transcribed]" — there is no transcript by design — so every one of them counted as a call
        // where the customer never spoke. On 07 Sep that was 48 of 169 rows: the answered rate read
        // 31% when the agent's own 121 calls were 44%, and the one-sided bar was 40% padding.
        // This page audits what the AGENT says, so only her calls are scored. They stay in the list
        // below with their own badge — "every call" still means every call.
        // CALL TYPE IS NOW A FILTER, NOT A FIXED RULE (user, 2026-09-08: "give one more filter in
        // dashboard as Call Type - Manual Call and AI Call"). The page still DEFAULTS to the agent's own
        // calls, because that is what it is a report card for and every number on it was defined that
        // way. Choosing Manual or All re-scores everything from the same rows, so the tiles, the funnel
        // and the list underneath always describe the same set of calls — the failure mode worth
        // avoiding is a header that says Manual over totals that are still counting the AI.
        const isManual = c => String(c.call_type || '') === 'manual_human';
        // Deliberately no combined "All" option: a manual call is logged without a transcript, so folding
        // the two sets together puts rows where nobody COULD have been heard back into the answer rate —
        // the exact distortion (31% vs the real 44%) that splitting them fixed a few hours ago.
        const type = String(req.query.type) === 'manual' ? 'manual' : 'ai';
        const ai = calls.filter(c => isManual(c) === (type === 'manual'));
        const manualCalls = calls.filter(isManual).length;
        const connected = ai.filter(c => durOf(c) > 0);
        // "ANSWERED" MUST MEAN A PERSON SPOKE (user, 2026-09-08: "check the number showing on the
        // dashboard is correct?"). It did not. `connected` only asks whether the summary carries a
        // duration — and the bridge writes one for any leg that opened, including a call whose own
        // outcome line reads "no answer: customer never engaged" and which ran 36 seconds into a
        // ringing phone. So the tile read "Answered 19 · 100%" on a day when the Outcomes card
        // directly beneath it said no-answer 10 and the one-sided bar said 15 of 19. The page was
        // contradicting itself, and the flattering number was the wrong one.
        // The customer's own voice is the only honest test: a call is answered when they said
        // something. `connected` stays, but only for AVG LENGTH, where the question really is how
        // long the line was open.
        // ONE DEFINITION OF ANSWERED, used by the tile, the funnel and the per-type card alike (user,
        // 2026-09-08: "why these number are not matching"). This used to require durOf(c) > 0 AS WELL
        // as a customer turn, while the per-type card required only the turn — so one call fell between
        // them: the tile read 52 where RTO 51 + COD 2 made 53, and the funnel summed to 120 of 121.
        // Whether we reached someone is whether they SPOKE. How long the line was open is a different
        // question, and it stays where it belongs — on Avg length, which still uses `connected`.
        const answered = ai.filter(c => custTurns(c.transcript) > 0);
        const outcomes = {}, langs = {}, types = {}, byOrder = {};
        for (const c of ai) {
            const o = outcomeOf(c.summary); outcomes[o] = (outcomes[o] || 0) + 1;
            langs[c.language || '?'] = (langs[c.language || '?'] || 0) + 1;
            const t = String(c.call_type || '').replace('_vobiz', ''); types[t] = (types[t] || 0) + 1;
            byOrder[c.order_id] = (byOrder[c.order_id] || 0) + 1;
        }
        const repeatCalled = Object.values(byOrder).filter(n => n >= 3).length;
        const ordersCalled = Object.keys(byOrder).length;   // the denominator for "called 3+ times"
        // SILENCE, CATEGORISED. One "one-sided" bar counted 116 calls and told you nothing you could
        // act on. These four separate a customer who hung up on the greeting from a line that stayed
        // open for half a minute while the agent talked to nobody — the second is the deaf-agent
        // signature (the speech socket dies mid-call and never reconnects), and on 07 Sep it was 21
        // customers reached and lost. A number you can act on beats a number you learn to ignore.
        const byType = {};
        for (const c of ai) {
            const k = String(c.call_type || 'unknown').replace('_vobiz', '');
            const t = byType[k] = byType[k] || { calls: 0, answered: 0, silent_long: 0, won: 0, seconds: 0 };
            t.calls++;
            if (custTurns(c.transcript) > 0) t.answered++;
            if (custTurns(c.transcript) === 0 && durOf(c) >= 20) t.silent_long++;
            // the win condition differs by job: RTO wants a re-attempt agreed, COD wants a confirmation
            if (['reattempt', 'confirmed'].includes(outcomeOf(c.summary))) t.won++;
            t.seconds += durOf(c);
        }
        for (const k of Object.keys(byType)) {
            const t = byType[k];
            t.avg_seconds = t.calls ? Math.round(t.seconds / t.calls) : 0;
            t.answer_rate = t.calls ? Math.round(t.answered / t.calls * 100) : 0;
            delete t.seconds;
        }
        const silentCalls = ai.filter(c => custTurns(c.transcript) === 0);
        const silence = {
            never_connected: silentCalls.filter(c => durOf(c) === 0).length,
            hung_up_fast:    silentCalls.filter(c => durOf(c) > 0 && durOf(c) < 6).length,
            silent_short:    silentCalls.filter(c => durOf(c) >= 6 && durOf(c) < 20).length,
            silent_long:     silentCalls.filter(c => durOf(c) >= 20).length,
            total: silentCalls.length,
        };
        const b = behaviour(ai);

        // THE DIAL HISTORY, from the turnstile — ring seconds, hangup cause and attempt number come
        // from the carrier's CDR and exist nowhere in the call log. One chunked read keyed by order,
        // never a query per call, and a miss is simply absent rather than fatal: the detail rows are
        // a reporting surface and must never be the reason the page fails to load.
        const dials = {};
        try {
            const names = [...new Set(calls.map(c => c.order_id).filter(Boolean))];
            for (let i = 0; i < names.length; i += 200) {
                const { data } = await supabase.from('vobiz_auto_calls_ecom')
                    .select('order_name, purpose, status, attempts, next_attempt_at, attempt_log, detail')
                    .in('order_name', names.slice(i, i + 200));
                for (const r of (data || [])) (dials[r.order_name] = dials[r.order_name] || []).push(r);
            }
        } catch (e) { console.log('[CallInsights] dial history unavailable:', e.message); }

        // the cached audit for this window (newest first)
        const { data: cached } = await supabase.from('agent_call_insights_ecom')
            .select('*').eq('from_date', from).eq('to_date', to)
            .order('created_at', { ascending: false }).limit(1).maybeSingle();

        res.json({
            success: true,
            range: { from, to, type },
            // Manual calls are logged without a transcript by design, so every transcript-derived card on
            // the page (rule compliance, outcomes, the AI audit) has nothing to read. The client says so
            // in words rather than drawing five empty bars and letting them read as a perfect score.
            transcribed: type !== 'manual',
            metrics: {
                calls: ai.length, connected: connected.length, answered: answered.length, manual_calls: manualCalls,
                answer_rate: ai.length ? Math.round(answered.length / ai.length * 100) : 0,
                avg_seconds: connected.length ? Math.round(connected.reduce((a, c) => a + durOf(c), 0) / connected.length) : 0,
                avg_agent_turns: ai.length ? Number((b.agent_turns / ai.length).toFixed(1)) : 0,
                repeat_called_orders: repeatCalled, orders_called: ordersCalled,
            },
            outcomes, languages: langs, types, silence, by_type: byType,
            // EVERY CALL IN THE RANGE, with everything known about it (user, 2026-09-05: "i want full
            // detail of call and every log each and every"). The aggregates above are summed from the
            // very same flags, so a compliance bar and this list can never disagree. Transcripts are
            // sent whole — they are the point of the page — which is why the range is what bounds the
            // payload rather than an arbitrary row cap.
            calls: ai.map(c => {
                const f = flagsFor(c);
                const d = (dials[c.order_id] || []).find(r => String(c.call_type || '').startsWith(String(r.purpose || '').split('_')[0]))
                    || (dials[c.order_id] || [])[0] || null;
                const last = d && Array.isArray(d.attempt_log) ? d.attempt_log[d.attempt_log.length - 1] : null;
                return {
                    id: c.id, order_id: c.order_id, customer_name: c.customer_name || null,
                    call_type: String(c.call_type || '').replace('_vobiz', ''),
                    language: c.language, called_at: c.called_at,
                    seconds: durOf(c), outcome: outcomeOf(c.summary), summary: c.summary || '',
                    exchanges: c.exchanges, transcript: c.transcript || '',
                    recording_url: c.recording_url || null,
                    claude: claudeCostOf(c),
                    flags: f,
                    dial: d ? {
                        status: d.status, attempts: d.attempts, next_attempt_at: d.next_attempt_at,
                        ring_s: last && last.ring_s, cause: last && last.cause, hangup_by: last && last.hangup_by,
                        result: last && last.result, log: d.attempt_log || [],
                        note: (d.detail && (d.detail.outcome_note || d.detail.why)) || null,
                    } : null,
                };
            }),
            behaviour: {
                double_intro: b.double_intro, hello_storm: b.hello_storm,
                wantit_overasked: b.wantit_overasked, reached_closing: b.reached_closing,
                lang_switched: b.lang_switched, one_sided: b.one_sided, total: ai.length,
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
        const aiCalls = calls.filter(c => String(c.call_type || '') !== 'manual_human');   // a human's call is not her score
        const context = `PERIOD TOTALS: ${aiCalls.length} calls logged, ${aiCalls.filter(c => durOf(c) > 0).length} connected, outcome mix ${JSON.stringify(mix)}.
THE AGENT'S STANDING RULES (a breach is a real finding): introduce herself once per call; ask "do you still want it?" at most twice; never ask for a delivery time (the courier team schedules); answer "when will it arrive" with the courier-team assurance, never a date; give the courier's recorded NDR reason with attempt dates when asked; confirm the address ONLY when an address is provided in her prompt; acknowledge trouble in the customer's own language before continuing; never invent facts, never promise refunds; end with the brand closing.`;
        const model = process.env.CALL_INSIGHTS_MODEL || 'claude-sonnet-5';
        const SYSTEM = 'You audit outbound AI phone calls for an Indian D2C skincare brand. Call types: rto_recovery (order came back undelivered — does the customer still want it) and cod_confirm (verify a COD order before dispatch). Be blunt, specific and evidence-led; never pad with praise. Reply ONLY with JSON.';
        const ASK = context + '\n\n' + blob + `\n\nAudit ALL the calls above. Judge against the standing rules AND against what actually WON reattempts versus what lost them. Prefer findings you can tie to an outcome or a rule breach; say how many calls show each pattern. Reply with ONLY this JSON:
{"improve":[{"title":"the problem in <=9 words","evidence":"a real quote plus how many calls show it","fix":"one concrete change to the agent's rules or flow"}],
 "worst":{"title":"the single most damaging behaviour","detail":"what it costs, with evidence and how often"},
 "good":[{"title":"what genuinely works, <=9 words","evidence":"a real quote or the outcome it produced"}]}
Exactly 5 in "improve" and 5 in "good". No markdown, no text outside the JSON.`;

        // THE AUDIT RUNS ON CLAUDE CODE, NOT THE PAID API (user, 2026-09-04). This is the biggest
        // prompt the system sends — up to 60 whole transcripts — and nothing about it is
        // latency-critical, so it belongs on the Max subscription. The live call brain stays on the
        // API and is untouched.
        // If the CLI is unavailable this FAILS rather than quietly falling back to the billed API:
        // a free path that heals itself by spending money is the same bug as never having moved.
        let text = '';
        const allowApi = String(process.env.CALL_INSIGHTS_ALLOW_API || '') === 'true';
        try {
            text = await require('./claude_code').askClaudeCode(ASK, { system: SYSTEM, model });
            console.log(`[CallInsights] audit ran on Claude Code (${model}) — no API tokens billed`);
        } catch (e) {
            if (!allowApi) {
                return res.status(503).json({
                    success: false,
                    error: 'Claude Code could not run the audit: ' + e.message
                        + '. Install Claude Code on this machine and log in with the Max account, or set CLAUDE_CLI to its full path. '
                        + 'Set CALL_INSIGHTS_ALLOW_API=true to bill this to the API instead.',
                });
            }
            console.log('[CallInsights] Claude Code unavailable (' + e.message + ') — CALL_INSIGHTS_ALLOW_API is on, billing the API');
            const r = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({
                    // Sonnet 5 thinks before it writes and the thinking is billed against max_tokens —
                    // at 2,200 the whole budget went to thinking and the reply came back EMPTY (the
                    // Run-audit button did nothing). 9,000 leaves plenty of room for the JSON.
                    model, max_tokens: 9000, system: SYSTEM,
                    messages: [{ role: 'user', content: ASK }],
                }),
            });
            const d = await r.json();
            try { require('./claude_usage').logClaudeUsage('call_insights', d.model || model, d.usage, null); } catch (_) {}
            // Take the TEXT blocks, never content[0] — Claude 5 returns a thinking block first, and
            // reading index 0 silently yielded "" (the Run-audit button appeared to do nothing).
            text = ((d.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join('')).trim();
            if (!text) return res.status(502).json({ success: false, error: 'audit model returned nothing: ' + JSON.stringify(d).slice(0, 160) });
        }
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
