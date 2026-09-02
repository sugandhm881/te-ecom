// Voice-agent SELF-LEARNING — the agent gets better from its own saved calls (2026-08-28).
//
// The loop (runLearning, nightly cron + "Run learning now"):
//   1. REVIEW  — every agent_call_logs transcript not yet reviewed goes to the AI once: outcome class,
//                six 0–10 scores, strengths, issues, customer signals, and generalisable LESSON candidates.
//   2. MERGE   — a candidate that matches an existing lesson (same category, similar rule) REINFORCES it
//                (times_reinforced++, new evidence); otherwise it is a new `proposed` lesson.
//   3. ACTIVATE— a lesson seen on ≥2 calls, or one the AI is ≥0.85 sure of, becomes `active`; humans
//                can activate / retire / edit from the dashboard. Active lessons (≤12, most reinforced
//                first) are injected into BOTH agents' prompts — vobiz_bridge.buildPrompt() and the
//                browser page via GET /api/voice-lessons — so the next call already behaves differently.
//   4. MEASURE — every review carries a date and an overall score, so the dashboard shows the trend, and
//                each lesson shows the calls BEFORE vs AFTER it was activated (score + confirmation rate).
//
// Guards, by design: a call is reviewed exactly once (call_id UNIQUE); lessons must be ORDER-AGNOSTIC and
// ≤240 chars (an order-specific "lesson" is a memory, not learning); the injected block is capped so the
// prompt cannot grow without bound; an AI outage skips the run and reviews nothing wrong — a missing review
// is picked up next run, a wrong review would poison every call after it.
'use strict';
const express = require('express');
const { supabase } = require('../supabase');
const { aiComplete, isConfigured, lastAiError } = require('./ai');
const { tokenRequired, requirePermission } = require('../auth');

const router = express.Router();
const MODEL_TAG = () => String(process.env.AI_MODEL || 'ai');
const CATEGORIES = ['opening', 'screening', 'confirmation', 'language', 'tone', 'objection', 'closing', 'other'];
const OUTCOMES = ['confirmed', 'cancelled', 'reattempt', 'no_answer', 'unclear', 'other'];
const MAX_ACTIVE_INJECT = 12;
const ACTIVATE_REINFORCED = 2;
const ACTIVATE_CONFIDENCE = 0.95;   // the model hands out 0.9 freely — a single call activates only when it is near-certain
const RETRY_WAITS_MS = [20e3, 45e3];  // rate-limit backoff inside a run before giving up until the next run
const LANG_NAMES = { 'hi-IN': 'Hindi', 'en-IN': 'English', 'pa-IN': 'Punjabi', 'bn-IN': 'Bengali', 'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam', 'gu-IN': 'Gujarati', 'mr-IN': 'Marathi' };
const langName = l => LANG_NAMES[l] || (l ? String(l).replace(/-.*$/, '') : 'Hindi');
// cod_confirm_vobiz and cod_confirm are the same purpose on two channels — lessons apply to both.
const baseType = t => String(t || 'other').replace(/_vobiz$/, '');

// ── 1. review one call ──────────────────────────────────────────────────────────────────────────
function reviewPrompt(call) {
    return [
        { role: 'system', content: `You are a strict QA coach for an Indian D2C brand's phone agent ("The Element", Ayurvedic skincare). You review ONE call transcript and reply with JSON ONLY (no prose, no markdown fences).
Schema:
{"outcome":"confirmed|cancelled|reattempt|no_answer|unclear|other",
 "scores":{"clarity":0-10,"empathy":0-10,"brevity":0-10,"correctness":0-10,"language_fit":0-10,"overall":0-10},
 "strengths":["…"],"issues":["…"],"customer_signals":["…"],
 "lessons":[{"title":"≤60 chars","rule":"ONE imperative instruction the agent should follow on FUTURE calls, ≤240 chars, English, order-agnostic","category":"opening|screening|confirmation|language|tone|objection|closing|other","confidence":0-1,"evidence_quote":"short quote from the transcript"}]}
Rules: scores are honest, not kind. "correctness" = followed the call purpose, never pressured, never invented facts. "language_fit" = stayed in the customer's language, switched when asked. A lesson must generalise to other customers (never mention this order, name, amount or phone) and must be something the agent can DO differently. 0–3 lessons; return [] when the call was routine and fine. Screening-assistant calls (a robot asking for name and reason) are a normal case — judge how the agent handled it.` },
        { role: 'user', content: `Call type: ${baseType(call.call_type)}\nLanguage: ${langName(call.language)}\nExchanges: ${call.exchanges || 0}\nSummary on file: ${String(call.summary || '').slice(0, 300)}\n\nTRANSCRIPT:\n${String(call.transcript || '').slice(0, 6000)}` },
    ];
}
function parseJson(txt) {
    if (!txt) return null;
    const m = String(txt).replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (_) { return null; }
}
const clamp10 = v => Math.max(0, Math.min(10, Number(v) || 0));
function normaliseReview(raw) {
    const sc = raw.scores || {};
    const scores = {};
    ['clarity', 'empathy', 'brevity', 'correctness', 'language_fit', 'overall'].forEach(k => { scores[k] = clamp10(sc[k]); });
    if (!sc.overall) scores.overall = Math.round(((scores.clarity + scores.empathy + scores.brevity + scores.correctness + scores.language_fit) / 5) * 10) / 10;
    const arr = v => Array.isArray(v) ? v.map(x => String(x).slice(0, 300)).filter(Boolean).slice(0, 8) : [];
    const lessons = (Array.isArray(raw.lessons) ? raw.lessons : []).map(l => ({
        title: String(l.title || '').trim().slice(0, 60),
        rule: String(l.rule || '').trim().slice(0, 240),
        category: CATEGORIES.includes(String(l.category)) ? String(l.category) : 'other',
        confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0.5)),
        evidence_quote: String(l.evidence_quote || '').slice(0, 200),
    })).filter(l => l.rule.length >= 15 && l.title).slice(0, 3);
    return {
        outcome: OUTCOMES.includes(String(raw.outcome)) ? String(raw.outcome) : 'other',
        scores, strengths: arr(raw.strengths), issues: arr(raw.issues), customer_signals: arr(raw.customer_signals), lessons,
    };
}
const transientAi = m => /rate-limited|overloaded|timed out/i.test(String(m || ''));
async function reviewCall(call) {
    for (let attempt = 0; ; attempt++) {
        const txt = await aiComplete(reviewPrompt(call), { temperature: 0.2, maxTokens: 1200, source: 'agent_learning' });
        if (txt) {
            const raw = parseJson(txt);
            if (!raw) throw new Error('AI reply was not JSON');
            return normaliseReview(raw);
        }
        const why = lastAiError() || 'AI returned nothing';
        if (!transientAi(why) || attempt >= RETRY_WAITS_MS.length) throw new Error(why);
        console.warn(`[AgentLearn] ${why} — waiting ${RETRY_WAITS_MS[attempt] / 1000}s`);
        await new Promise(r => setTimeout(r, RETRY_WAITS_MS[attempt]));
    }
}

// ── 2. merge lessons ────────────────────────────────────────────────────────────────────────────
// Light stemming (first 5 letters) so "confirm/confirmation" and "greets/greeted" count as the same word —
// without it two phrasings of one lesson kept landing as two lessons.
const stem = w => (w.length > 5 ? w.slice(0, 5) : w);
const tokens = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).map(stem));
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'when', 'then', 'their', 'them', 'they', 'you', 'your', 'not', 'never', 'always', 'agent', 'customer', 'call', 'should', 'must', 'after', 'before', 'from', 'into', 'about', 'only', 'one', 'once', 'has', 'have', 'had', 'been', 'are', 'was']);
function similarity(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
    return inter / (A.size + B.size - inter);
}
const SIMILAR = 0.45;
async function mergeLesson(cand, call, existing) {
    const same = existing.filter(l => l.status !== 'retired' && l.category === cand.category && (l.call_type === 'all' || l.call_type === baseType(call.call_type)));
    let best = null, bestSim = 0;
    for (const l of same) { const s = Math.max(similarity(l.rule, cand.rule), similarity(l.title, cand.title) * 0.9); if (s > bestSim) { bestSim = s; best = l; } }
    const ev = { call_id: call.id, called_at: call.called_at, quote: cand.evidence_quote };
    if (best && bestSim >= SIMILAR) {
        const evidence = Array.isArray(best.evidence) ? best.evidence : [];
        if (!evidence.some(e => e.call_id === call.id)) evidence.push(ev);
        const upd = { times_reinforced: (best.times_reinforced || 1) + 1, evidence: evidence.slice(-20), last_seen_at: call.called_at || new Date().toISOString(), confidence: Math.min(1, Number(best.confidence) + 0.1) };
        const { data } = await supabase.from('agent_lessons_ecom').update(upd).eq('id', best.id).select().single();
        if (data) Object.assign(best, data);
        return { lesson: best, reinforced: true };
    }
    const { data, error } = await supabase.from('agent_lessons_ecom').insert({
        title: cand.title, rule: cand.rule, category: cand.category, call_type: baseType(call.call_type), language: 'all',
        status: cand.confidence >= ACTIVATE_CONFIDENCE ? 'active' : 'proposed', activated_at: cand.confidence >= ACTIVATE_CONFIDENCE ? new Date().toISOString() : null,
        source: 'auto', confidence: cand.confidence, times_reinforced: 1, evidence: [ev],
        first_seen_at: call.called_at || new Date().toISOString(), last_seen_at: call.called_at || new Date().toISOString(),
    }).select().single();
    if (error) throw new Error('lesson insert: ' + error.message);
    existing.push(data);
    return { lesson: data, reinforced: false };
}

// ── 2b. dedupe — two phrasings of one lesson become one (the survivor keeps every piece of evidence) ──
// Runs after every learning run. Non-retired lessons of the same category whose rules are ≥SIMILAR
// similar are merged into the more-reinforced one; the other is retired with a note naming the survivor.
async function dedupeLessons() {
    const { data } = await supabase.from('agent_lessons_ecom').select('*').neq('status', 'retired').order('times_reinforced', { ascending: false }).order('id');
    const list = data || []; const gone = new Set(); let merged = 0;
    for (let i = 0; i < list.length; i++) {
        const a = list[i]; if (gone.has(a.id)) continue;
        for (let j = i + 1; j < list.length; j++) {
            const b = list[j]; if (gone.has(b.id) || a.category !== b.category) continue;
            if (Math.max(similarity(a.rule, b.rule), similarity(a.title, b.title) * 0.9) < SIMILAR) continue;
            const evidence = [...(a.evidence || [])];
            (b.evidence || []).forEach(e => { if (!evidence.some(x => x.call_id === e.call_id)) evidence.push(e); });
            const upd = { times_reinforced: (a.times_reinforced || 1) + (b.times_reinforced || 1), evidence: evidence.slice(-20), confidence: Math.min(1, Math.max(Number(a.confidence), Number(b.confidence)) + 0.1), last_seen_at: a.last_seen_at > b.last_seen_at ? a.last_seen_at : b.last_seen_at };
            if (a.status !== 'active' && b.status === 'active') Object.assign(upd, { status: 'active', activated_at: b.activated_at || new Date().toISOString() });
            await supabase.from('agent_lessons_ecom').update(upd).eq('id', a.id);
            await supabase.from('agent_lessons_ecom').update({ status: 'retired', retired_at: new Date().toISOString(), decided_by: 'auto', note: `merged into #${a.id}` }).eq('id', b.id);
            Object.assign(a, upd); gone.add(b.id); merged++;
            // lesson_ids on reviews keep pointing at the retired row; the call modal still resolves it.
        }
    }
    if (merged) _cache = null;
    return merged;
}

// ── 3. activation policy ────────────────────────────────────────────────────────────────────────
async function autoActivate() {
    const { data } = await supabase.from('agent_lessons_ecom').select('id, times_reinforced, confidence').eq('status', 'proposed');
    const ids = (data || []).filter(l => (l.times_reinforced || 0) >= ACTIVATE_REINFORCED || Number(l.confidence) >= ACTIVATE_CONFIDENCE).map(l => l.id);
    if (!ids.length) return 0;
    await supabase.from('agent_lessons_ecom').update({ status: 'active', activated_at: new Date().toISOString(), decided_by: 'auto' }).in('id', ids);
    return ids.length;
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────
let _running = false;
async function runLearning({ trigger = 'cron', limit = 40 } = {}) {
    if (_running) return { skipped: 'already running' };
    if (!isConfigured()) return { skipped: 'AI not configured' };
    _running = true;
    const { data: run } = await supabase.from('agent_learning_runs_ecom').insert({ trigger }).select().single();
    const stats = { calls_reviewed: 0, calls_failed: 0, lessons_new: 0, lessons_reinforced: 0, lessons_activated: 0 };
    try {
        const { data: calls } = await supabase.from('agent_call_logs').select('id, call_type, language, transcript, summary, exchanges, called_at').order('called_at', { ascending: false }).limit(400);
        const { data: done } = await supabase.from('agent_call_reviews_ecom').select('call_id');
        const doneSet = new Set((done || []).map(r => r.call_id));
        const todo = (calls || []).filter(c => !doneSet.has(c.id) && String(c.transcript || '').trim().length >= 40).slice(0, limit);
        const { data: lessons } = await supabase.from('agent_lessons_ecom').select('*');
        const existing = lessons || [];
        for (const call of todo) {
            try {
                const r = await reviewCall(call);
                const lessonIds = [];
                for (const cand of r.lessons) {
                    const m = await mergeLesson(cand, call, existing);
                    lessonIds.push(m.lesson.id);
                    if (m.reinforced) stats.lessons_reinforced++; else stats.lessons_new++;
                }
                await supabase.from('agent_call_reviews_ecom').insert({
                    call_id: call.id, call_type: baseType(call.call_type), language: langName(call.language), called_at: call.called_at,
                    outcome: r.outcome, scores: r.scores, strengths: r.strengths, issues: r.issues, customer_signals: r.customer_signals,
                    lesson_candidates: r.lessons, lesson_ids: lessonIds, model: MODEL_TAG(),
                });
                stats.calls_reviewed++;
            } catch (e) {
                stats.calls_failed++;
                console.warn(`[AgentLearn] review failed for ${call.id}: ${e.message}`);
                if (transientAi(e.message)) break;   // backoff exhausted — stop the run, next run resumes
            }
            await new Promise(r => setTimeout(r, 700));
        }
        stats.lessons_merged = await dedupeLessons();
        stats.lessons_activated = await autoActivate();
        _cache = null;
        await supabase.from('agent_learning_runs_ecom').update({ ...stats, finished_at: new Date().toISOString() }).eq('id', run.id);
        console.log(`[AgentLearn] ${trigger}: reviewed ${stats.calls_reviewed} (failed ${stats.calls_failed}), lessons +${stats.lessons_new} new / ${stats.lessons_reinforced} reinforced / ${stats.lessons_activated} activated`);
        return { ...stats, pending: Math.max(0, (calls || []).filter(c => !doneSet.has(c.id)).length - todo.length) };
    } catch (e) {
        await supabase.from('agent_learning_runs_ecom').update({ ...stats, finished_at: new Date().toISOString(), error: e.message }).eq('id', run.id);
        console.error('[AgentLearn] run error:', e.message);
        throw e;
    } finally { _running = false; }
}

// ── 4. what the agents read ─────────────────────────────────────────────────────────────────────
let _cache = null;   // { at, lessons[] }
async function activeLessons() {
    if (_cache && Date.now() - _cache.at < 5 * 60e3) return _cache.lessons;
    const { data } = await supabase.from('agent_lessons_ecom').select('id, title, rule, category, call_type, language, times_reinforced, confidence').eq('status', 'active')
        .order('times_reinforced', { ascending: false }).order('confidence', { ascending: false }).limit(60);
    _cache = { at: Date.now(), lessons: data || [] };
    return _cache.lessons;
}
// Prompt block for one call: lessons for this call type (or 'all') and language (or 'all'), ≤ MAX_ACTIVE_INJECT.
async function lessonsPromptBlock(callType, lang) {
    const ct = baseType(callType), ln = langName(lang);
    const list = (await activeLessons()).filter(l => (l.call_type === 'all' || l.call_type === ct) && (l.language === 'all' || l.language === ln)).slice(0, MAX_ACTIVE_INJECT);
    if (!list.length) return '';
    return `\nLESSONS LEARNT FROM PREVIOUS CALLS (follow every one):\n` + list.map((l, i) => `${i + 1}. ${l.rule}`).join('\n');
}

// ── dashboard data ──────────────────────────────────────────────────────────────────────────────
const avg = a => a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 100) / 100 : null;
const SETTLED = new Set(['confirmed', 'cancelled', 'reattempt']);
function metricsOf(reviews) {
    const settled = reviews.filter(r => SETTLED.has(r.outcome));
    return {
        calls: reviews.length,
        avg_score: avg(reviews.map(r => Number(r.scores && r.scores.overall) || 0)),
        confirm_rate: settled.length ? Math.round((settled.filter(r => r.outcome === 'confirmed').length / settled.length) * 1000) / 10 : null,
        settled: settled.length,
    };
}
async function summary({ from, to }) {
    const fromISO = from ? new Date(from).toISOString() : new Date(Date.now() - 30 * 86400e3).toISOString();
    const toISO = to ? new Date(new Date(to).getTime() + 86399e3).toISOString() : new Date().toISOString();
    const [{ data: reviews }, { data: lessons }, { data: runs }, { data: allReviews }, { count: totalCalls }] = await Promise.all([
        supabase.from('agent_call_reviews_ecom').select('*').gte('called_at', fromISO).lte('called_at', toISO).order('called_at', { ascending: false }).limit(1000),
        supabase.from('agent_lessons_ecom').select('*').order('status').order('times_reinforced', { ascending: false }).limit(200),
        supabase.from('agent_learning_runs_ecom').select('*').order('started_at', { ascending: false }).limit(10),
        supabase.from('agent_call_reviews_ecom').select('call_id, called_at, outcome, scores').order('called_at', { ascending: true }).limit(5000),
        supabase.from('agent_call_logs').select('*', { count: 'exact', head: true }),
    ]);
    const R = reviews || [], L = lessons || [], ALL = allReviews || [];
    // daily trend (IST calendar day)
    const day = d => new Date(new Date(d).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const byDay = {};
    R.forEach(r => { const k = day(r.called_at); (byDay[k] = byDay[k] || []).push(r); });
    const daily = Object.keys(byDay).sort().map(k => { const m = metricsOf(byDay[k]); return { day: k, ...m, outcomes: OUTCOMES.reduce((o, oc) => { o[oc] = byDay[k].filter(r => r.outcome === oc).length; return o; }, {}) }; });
    // score dimensions + issue categories
    const dims = ['clarity', 'empathy', 'brevity', 'correctness', 'language_fit', 'overall'];
    const dimAvg = {}; dims.forEach(d => { dimAvg[d] = avg(R.map(r => Number(r.scores && r.scores[d]) || 0)); });
    const catCount = {}; R.forEach(r => (r.lesson_candidates || []).forEach(c => { catCount[c.category || 'other'] = (catCount[c.category || 'other'] || 0) + 1; }));
    const issueCount = {}; R.forEach(r => (r.issues || []).forEach(i => { const k = String(i).slice(0, 80); issueCount[k] = (issueCount[k] || 0) + 1; }));
    const topIssues = Object.entries(issueCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([issue, n]) => ({ issue, n }));
    // before / after per lesson — over ALL reviews, min 3 calls each side
    const lessonsOut = L.map(l => {
        let before = null, after = null;
        if (l.activated_at) {
            const t = new Date(l.activated_at).getTime();
            const b = ALL.filter(r => new Date(r.called_at).getTime() < t), a = ALL.filter(r => new Date(r.called_at).getTime() >= t);
            if (b.length >= 3) before = metricsOf(b);
            if (a.length >= 3) after = metricsOf(a);
        }
        return { ...l, before, after, delta_score: before && after && before.avg_score != null && after.avg_score != null ? Math.round((after.avg_score - before.avg_score) * 100) / 100 : null };
    });
    // period vs previous equal period
    const span = new Date(toISO) - new Date(fromISO);
    const prev = ALL.filter(r => { const t = new Date(r.called_at).getTime(); return t >= new Date(fromISO).getTime() - span && t < new Date(fromISO).getTime(); });
    const cur = metricsOf(R), prv = metricsOf(prev);
    return {
        range: { from: fromISO, to: toISO },
        kpis: {
            calls_total: totalCalls || 0, reviewed_total: ALL.length, reviewed_in_range: R.length,
            avg_score: cur.avg_score, avg_score_prev: prv.avg_score,
            confirm_rate: cur.confirm_rate, confirm_rate_prev: prv.confirm_rate,
            lessons_active: L.filter(l => l.status === 'active').length, lessons_proposed: L.filter(l => l.status === 'proposed').length, lessons_retired: L.filter(l => l.status === 'retired').length,
            lessons_learnt_in_range: L.filter(l => l.first_seen_at >= fromISO && l.first_seen_at <= toISO).length,
            ai_configured: isConfigured(), running: _running,
        },
        daily, dims: dimAvg, categories: catCount, top_issues: topIssues,
        outcomes: OUTCOMES.reduce((o, oc) => { o[oc] = R.filter(r => r.outcome === oc).length; return o; }, {}),
        lessons: lessonsOut, reviews: R.slice(0, 60).map(r => ({ id: r.id, call_id: r.call_id, call_type: r.call_type, language: r.language, called_at: r.called_at, outcome: r.outcome, scores: r.scores, issues: r.issues, strengths: r.strengths, customer_signals: r.customer_signals, lesson_ids: r.lesson_ids })),
        runs: runs || [],
    };
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────────
const canSee = requirePermission(['support-agent-learning', 'support-voice']);
router.get('/support/agent-learning/summary', tokenRequired, canSee, async (req, res) => {
    try { res.json({ success: true, ...(await summary({ from: req.query.from, to: req.query.to })) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.get('/support/agent-learning/call/:callId', tokenRequired, canSee, async (req, res) => {
    try {
        const [{ data: call }, { data: review }] = await Promise.all([
            supabase.from('agent_call_logs').select('*').eq('id', req.params.callId).maybeSingle(),
            supabase.from('agent_call_reviews_ecom').select('*').eq('call_id', req.params.callId).maybeSingle(),
        ]);
        if (!call) return res.status(404).json({ success: false, error: 'call not found' });
        let lessons = [];
        if (review && review.lesson_ids && review.lesson_ids.length) { const { data } = await supabase.from('agent_lessons_ecom').select('id, title, rule, category, status').in('id', review.lesson_ids); lessons = data || []; }
        res.json({ success: true, call, review, lessons });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/support/agent-learning/run', tokenRequired, canSee, async (req, res) => {
    try { const r = await runLearning({ trigger: 'manual', limit: Math.min(100, Number(req.body && req.body.limit) || 40) }); res.json({ success: true, ...r }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/support/agent-learning/lessons/:id/:action', tokenRequired, canSee, async (req, res) => {
    const { id, action } = req.params;
    const by = (req.user && req.user.sub) || 'user';
    const patch = action === 'activate' ? { status: 'active', activated_at: new Date().toISOString(), retired_at: null, decided_by: by }
        : action === 'retire' ? { status: 'retired', retired_at: new Date().toISOString(), decided_by: by, note: String((req.body || {}).note || '').slice(0, 300) || null }
        : action === 'edit' ? { rule: String((req.body || {}).rule || '').trim().slice(0, 240), title: String((req.body || {}).title || '').trim().slice(0, 60) || undefined, source: 'human', decided_by: by }
        : null;
    if (!patch) return res.status(400).json({ success: false, error: 'action must be activate | retire | edit' });
    if (action === 'edit' && patch.rule.length < 15) return res.status(400).json({ success: false, error: 'rule too short' });
    Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
    const { data, error } = await supabase.from('agent_lessons_ecom').update(patch).eq('id', id).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    _cache = null;
    res.json({ success: true, lesson: data });
});
router.post('/support/agent-learning/lessons', tokenRequired, canSee, async (req, res) => {
    const b = req.body || {};
    const rule = String(b.rule || '').trim().slice(0, 240), title = String(b.title || rule.slice(0, 60)).trim().slice(0, 60);
    if (rule.length < 15) return res.status(400).json({ success: false, error: 'rule too short' });
    const { data, error } = await supabase.from('agent_lessons_ecom').insert({ title, rule, category: CATEGORIES.includes(b.category) ? b.category : 'other', call_type: b.call_type || 'all', language: b.language || 'all', status: 'active', activated_at: new Date().toISOString(), source: 'human', confidence: 1, decided_by: (req.user && req.user.sub) || 'user' }).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    _cache = null;
    res.json({ success: true, lesson: data });
});
// The browser voice agent reads its lessons here (JWT + support-voice; gated in server.js).
router.get('/voice-lessons', tokenRequired, async (req, res) => {
    try { res.json({ success: true, block: await lessonsPromptBlock(req.query.call_type, req.query.lang) }); }
    catch (e) { res.json({ success: true, block: '' }); }
});

module.exports = { router, runLearning, dedupeLessons, lessonsPromptBlock, activeLessons, summary, similarity, normaliseReview, parseJson, baseType, langName, CATEGORIES, OUTCOMES, ACTIVATE_REINFORCED, ACTIVATE_CONFIDENCE, MAX_ACTIVE_INJECT };
