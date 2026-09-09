// ─────────────────────────────────────────────────────────────────────────────
// AI CALLING STATEMENT (user, 2026-09-02: "don't take any assumption in cost — take actual which
// platform provides"). Actuals, by source of truth:
//   · CLAUDE — exact tokens captured from every API response (agent_call_logs.cost_meta.claude,
//     written by the bridge), priced at Anthropic's PUBLISHED list prices per model
//     (cache reads 10% of input, cache writes 125%) × the USD→INR rate. Older calls without
//     cost_meta fall back to the per-turn estimate and are FLAGGED est.
//   · VOBIZ — the platform's own per-call `cost` from its CDR API, matched to our calls by phone +
//     answer time. What Vobiz reports is what we show — including ₹0 while the plan bills nothing.
//   · SARVAM — no usage/billing API exists, so: MEASURED usage (exact call minutes, exact characters
//     the agent spoke) × the official rate from dashboard.sarvam.ai — set COST_SARVAM_* env to the
//     dashboard's numbers; until then defaults are used and marked "est".
//   · FIXED — the Vobiz number rental etc., amortized over the selected range by calendar share.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../supabase');

const USD_INR = () => Number(process.env.COST_USD_INR || 88);
// THE PRICE TABLE LIVES IN claude_usage.js, AND ONLY THERE. This file used to carry its own copy of
// both the table and the arithmetic; they drifted — a stale prior (Sonnet 5 at $3/$15, Opus at
// $15/$75) mispriced every escalated turn for days before anyone compared them, and the cache-write
// multiplier was wrong in both at once. Two definitions of one price is two chances to be wrong.
const { usdFor } = require('./claude_usage');
// CALIBRATED against the user's own Sarvam usage export (02-Sep-2026, ₹75.20 total day):
//   · TTS ₹3.00/1k chars — EXACT match (22,084 chars billed ₹66.25 vs our measured ~21k+openings)
//   · STT — the ₹30/hr list bills PROCESSED AUDIO, not connection time: actual ₹8.69 for ~42
//     talk-minutes → effective ₹0.21 per call-minute (the old 0.50 over-billed 2.4×)
// Env still overrides if Sarvam's billing shifts.
const SARVAM = {
    stt_per_min: Number(process.env.COST_SARVAM_STT_PER_MIN || 0.21),
    tts_per_1k: Number(process.env.COST_SARVAM_TTS_PER_1K || 3.00),
    is_actual: true,
};
const CLAUDE_EST_PER_TURN = 0.40;                 // fallback for calls logged before token capture
// What each of Vobiz's debit kinds actually is. Discovered 2026-09-08 — we had no idea we were paying
// for the media stream or for recordings until the ledger itemised them.
const TXN_LABEL = {
    cdr: 'calls', stream_cdr: 'media stream', recording: 'recordings', ncc: 'unconnected-dial fees',
};

const FIXED_MONTHLY = [
    { name: 'Vobiz mobile number', amount: 708, note: '₹600 + 18% GST' },
];
const r2 = (n) => Math.round(n * 100) / 100;

// PAGED, BECAUSE A BIG LIMIT IS A LIE. PostgREST caps every response at 1,000 rows and reports
// nothing — the old read asked for twenty thousand and got 1,000 of the 3,222 rows, so any range
// past about two days was priced from a third of itself. Worse, it had no .order(), so WHICH third
// was arbitrary. Same shape as loadCalls() in ai_call_insights.js: walk in 1,000-row pages ordered by
// a unique key until a short page comes back.
async function loadClaudeLedger(fromIso, toIso, { cap = 60000 } = {}) {
    const out = [];
    for (let page = 0; page * 1000 < cap; page++) {
        const { data, error } = await supabase.from('claude_usage_ecom')
            .select('source, model, tokens_in, tokens_out, cache_read, cache_write, cache_ttl')
            .gte('at', fromIso).lte('at', toIso)
            .order('id', { ascending: true })
            .range(page * 1000, page * 1000 + 999);
        if (error) { console.warn('[cost] claude ledger read failed:', error.message); break; }
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return { data: out };
}

function claudeCostINR(meta) {
    // meta = { '<model>': {in,out,cr,cw,ttl,turns} } → ₹ at list price
    let usd = 0;
    for (const [model, u] of Object.entries(meta || {})) usd += usdFor(model, u);
    return usd * USD_INR();
}

// The platform's own bill for the range: page the CDR list (newest first) until we pass `fromMs`.
// Returns { byKey: Map('<last10>|<minuteBucket>' → {costInr, uuid}), totalInr, calls }.
// One snapshot of the prepaid wallet. Called on a schedule, and once more whenever the statement is
// opened, so a range always has a reading at each end.
async function snapshotVobizBalance() {
    const id = process.env.VOBIZ_AUTH_ID, tok = process.env.VOBIZ_AUTH_TOKEN;
    if (!id || !tok) return null;
    try {
        const r = await axios.get(`https://api.vobiz.ai/api/v1/account/${id}/balance`,
            { headers: { 'X-Auth-ID': id, 'X-Auth-Token': tok }, timeout: 15000, validateStatus: () => true });
        const b = r.data && Array.isArray(r.data.balances) ? r.data.balances[0] : null;
        if (r.status !== 200 || !b) return null;
        const row = { balance_inr: Number(b.balance), available_inr: Number(b.available_balance), currency: b.currency || 'INR', raw: b };
        await supabase.from('vobiz_balance_ecom').insert(row);
        return row;
    } catch (e) { console.warn('[ai-costs] balance snapshot failed:', e.message); return null; }
}

// What the wallet actually paid out across a range. Sums only the DROPS between consecutive readings,
// so a top-up shows as a gap rather than cancelling out real spend — the mistake that would make a
// recharge look like a refund.
//
// ⚠️ AND IT REPORTS WHAT IT ACTUALLY MEASURED (user, 2026-09-09: "is this price correct?"). The line
// billed itself as "the only figure that cannot be argued with" while, on 08-Sep, the readings did not
// begin until 17:21 IST — it was measuring the last 6½ hours of a day and presenting it as the day,
// ₹21.40 against a real telephony bill of ₹141.86. A partial measurement announced as definitive is
// worse than no measurement, because it makes every honest figure beside it look wrong.
async function walletSpend(fromIso, toIso) {
    try {
        const { data } = await supabase.from('vobiz_balance_ecom')
            .select('at, balance_inr').gte('at', fromIso).lte('at', toIso).order('at', { ascending: true });
        const rows = data || [];
        if (rows.length < 2) return { inr: null, readings: rows.length, topups: 0, covers: false };
        let spent = 0, topups = 0;
        for (let i = 1; i < rows.length; i++) {
            const d = Number(rows[i - 1].balance_inr) - Number(rows[i].balance_inr);
            if (d > 0) spent += d; else if (d < 0) topups += -d;
        }
        // Does the measurement actually span the window it is being shown against? Snapshots run every
        // 15 minutes, so a reading within ~20 of each edge counts as covering it; and a range whose end
        // is still in the future is only ever expected to reach "now".
        const GRACE = 20 * 60e3;
        const startedAt = new Date(rows[0].at).getTime();
        const endedAt = new Date(rows[rows.length - 1].at).getTime();
        const wantEnd = Math.min(new Date(toIso).getTime(), Date.now());
        const covers = startedAt <= new Date(fromIso).getTime() + GRACE && endedAt >= wantEnd - GRACE;
        return { inr: r2(spent), readings: rows.length, topups: r2(topups),
            first: rows[0], last: rows[rows.length - 1],
            covers, measured_from: rows[0].at, measured_to: rows[rows.length - 1].at };
    } catch (e) { return { inr: null, readings: 0, topups: 0, covers: false }; }
}

// What Vobiz ACTUALLY charged in a range, itemised. The summary covers the whole range regardless of
// page size, so one request answers it — no paging, and none of the deep-paging limit that makes
// /Call/ stop returning records after ~820 of a claimed 2047.
async function vobizBilled(from, to) {
    const id = process.env.VOBIZ_AUTH_ID, tok = process.env.VOBIZ_AUTH_TOKEN;
    if (!id || !tok) return { ok: false, total: 0, byType: {}, count: 0 };
    try {
        const r = await axios.get(`https://api.vobiz.ai/api/v1/account/${id}/transactions`,
            { params: { page: 1, per_page: 1, from_date: from, to_date: to },
              headers: { 'X-Auth-ID': id, 'X-Auth-Token': tok }, timeout: 20000, validateStatus: () => true });
        const s = r.data && r.data.summary;
        if (r.status !== 200 || !s) return { ok: false, total: 0, byType: {}, count: 0 };
        const byType = {};
        for (const b of s.by_reference_type || []) byType[b.reference_type] = { inr: r2(b.total_debit), count: b.count };
        return { ok: true, total: r2(s.total_debit), credit: r2(s.total_credit || 0),
            byType, count: Number(r.data.total || 0) };
    } catch (e) { console.warn('[ai-costs] vobiz transactions failed:', e.message); return { ok: false, total: 0, byType: {}, count: 0 }; }
}

async function vobizActuals(fromMs, toMs) {
    const id = process.env.VOBIZ_AUTH_ID, tok = process.env.VOBIZ_AUTH_TOKEN;
    const byKey = new Map(); let totalInr = 0, count = 0;
    if (!id || !tok) return { byKey, totalInr, count, ok: false };
    try {
        for (let offset = 0; offset < 1000; offset += 50) {
            const r = await axios.get(`https://api.vobiz.ai/api/v1/Account/${id}/Call/?limit=50&offset=${offset}`,
                { headers: { 'X-Auth-ID': id, 'X-Auth-Token': tok }, timeout: 15000, validateStatus: () => true });
            const objs = (r.data && r.data.objects) || [];
            if (r.status !== 200 || !objs.length) break;
            let older = false;
            for (const c of objs) {
                const t = c.initiation_time ? new Date(String(c.initiation_time).replace(' ', 'T')).getTime() : 0;
                if (t && t < fromMs) { older = true; continue; }
                if (!t || t > toMs) continue;
                const raw = Number(c.cost || 0);
                // Vobiz labels currency "USD" but bills the prepaid ₹ wallet — decoded 2026-09-02
                // from real CDRs: ₹0.45 per started minute (6s→0.45, 78s→0.90, 124s→1.35). Treat as
                // INR unless COST_VOBIZ_CURRENCY=USD is set explicitly.
                const inr = String(process.env.COST_VOBIZ_CURRENCY || 'INR').toUpperCase() === 'USD' ? raw * USD_INR() : raw;
                totalInr += inr; count++;
                const last10 = String(c.to_number || '').replace(/\D/g, '').slice(-10);
                const at = c.answer_time || c.initiation_time;
                if (last10 && at) {
                    const mMs = new Date(String(at).replace(' ', 'T')).getTime();
                    for (const b of [0, -1, 1]) byKey.set(`${last10}|${Math.round(mMs / 60e3) + b}`, { costInr: inr, uuid: c.call_uuid });
                }
            }
            if (older) break;
        }
        return { byKey, totalInr: r2(totalInr), count, ok: true };
    } catch (e) { console.warn('[ai-costs] vobiz CDR fetch failed:', e.message); return { byKey, totalInr, count, ok: false }; }
}

router.get('/support/ai-call-costs', async (req, res) => {
    try {
        const from = String(req.query.from || '').slice(0, 10);
        const to = String(req.query.to || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
            return res.status(400).json({ success: false, error: 'from/to (YYYY-MM-DD) required' });
        const fromIso = new Date(`${from}T00:00:00+05:30`).toISOString();
        const toIso = new Date(`${to}T23:59:59.999+05:30`).toISOString();

        const [{ data: rows, error }, vob, _bal, billed, sarvamBill, { data: ledger }] = await Promise.all([
            supabase.from('agent_call_logs')
                .select('id, order_id, call_type, language, called_at, exchanges, summary, transcript, cost_meta')
                .gte('called_at', fromIso).lte('called_at', toIso)
                .order('called_at', { ascending: false }).limit(1500),
            vobizActuals(new Date(fromIso).getTime(), new Date(toIso).getTime()),
            snapshotVobizBalance(),           // a reading now, so today's range always has an end point
            vobizBilled(from, to),           // the itemised bill — the only telephony figure that reconciles
            require('./sarvam_usage').sarvamBilled(from, to),   // what Sarvam actually charged, when captured
            // EVERY Anthropic call this system made in the window (claude_usage_ecom) — the call
            // brain plus the work that is not attributable to one call: summaries, agent-learning
            // reviews, the Call Insights audit. Without this the statement showed only ~half of
            // what the Anthropic console billed (user, 2026-09-02).
            loadClaudeLedger(fromIso, toIso),
        ]);
        if (error) throw new Error('call log read failed: ' + error.message);
        const platform = {};
        let platformInr = 0, brainLedgerInr = 0;
        for (const u of (ledger || [])) {
            const inr = claudeCostINR({ [u.model]: { in: u.tokens_in, out: u.tokens_out, cr: u.cache_read, cw: u.cache_write, ttl: u.cache_ttl } });
            if (u.source === 'call_brain' || u.source === 'call_opening') { brainLedgerInr += inr; continue; }
            platform[u.source] = r2((platform[u.source] || 0) + inr);
            platformInr += inr;
        }

        const comp = { telephony: 0, stt: 0, tts: 0, brain: 0, platform: 0 };
        const byType = {};
        let brainActualCalls = 0, telActualCalls = 0, aiCalls = 0, manualCalls = 0;
        const calls = (rows || []).map(c => {
            const mech = String(c.summary || '');
            const durS = Number((mech.match(/(\d+)s call to/) || [])[1] || 0);
            const phone = String((mech.match(/call to (\d{6,})/) || [])[1] || '').slice(-10);
            const mins = durS > 0 ? Math.max(1, Math.ceil(durS / 60)) : 0;
            const agentChars = String(c.transcript || '').split('\n').filter(l => /^agent:/i.test(l))
                .reduce((s, l) => s + Math.max(0, l.length - 7), 0);
            // PREFER THE METER OVER THE TRANSCRIPT. Characters counted from `Agent:` lines miss every
            // one we paid to synthesize and never stored — above all the greeting pre-synthesized for
            // each dial while the phone rings, and on 08 Sep only 156 of 273 dials were answered.
            // Sarvam billed 47,296 characters that day; the transcript implied 22,697.
            // A MANUAL CALL COSTS TELEPHONY AND NOTHING ELSE (2026-09-09). A person dialled it from the
            // dashboard: Sarvam never heard it, never spoke on it, and Claude never thought about it. The
            // per-minute STT estimate was firing on all 49 of them anyway — ~₹10 a day of transcription we
            // were never charged for, which is most of the ₹17.64 the by-type card blamed on human calls.
            // (The brain estimate would do the same the moment a manual row ever carried an exchange count;
            // today they are all zero, which is the only reason it has not shown up too.)
            const isManual = String(c.call_type || '') === 'manual_human';
            const sMeter = (c.cost_meta && c.cost_meta.sarvam) || null;
            const ttsChars = sMeter && sMeter.tts_chars ? sMeter.tts_chars : agentChars;
            const sttSecs = sMeter && sMeter.stt_seconds ? sMeter.stt_seconds : null;
            const turns = Number(c.exchanges) || 0;

            // telephony: the platform's own number when we can match the CDR, else 0-with-flag
            let telephony = 0, telActual = false;
            if (phone) {
                const mMs = Math.round(new Date(c.called_at).getTime() / 60e3);
                for (const b of [0, 1, 2, 3, -1]) {
                    const hit = vob.byKey.get(`${phone}|${mMs + b}`);
                    if (hit) { telephony = r2(hit.costInr); telActual = true; telActualCalls++; break; }
                }
            }
            // brain: actual tokens when captured, else the flagged estimate
            let brain, brainActual = false;
            if (isManual) { brain = 0; brainActual = true; manualCalls++; }        // no agent, no tokens, no cost
            else if (c.cost_meta && c.cost_meta.claude) { brain = r2(claudeCostINR(c.cost_meta.claude)); brainActual = true; brainActualCalls++; aiCalls++; }
            else { brain = r2(turns * CLAUDE_EST_PER_TURN); aiCalls++; }

            const cost = {
                telephony,
                stt: isManual ? 0 : r2(sttSecs != null ? sttSecs / 60 * SARVAM.stt_per_min : mins * SARVAM.stt_per_min),
                tts: isManual ? 0 : r2(ttsChars / 1000 * SARVAM.tts_per_1k),
                brain,
            };
            cost.total = r2(cost.telephony + cost.stt + cost.tts + cost.brain);
            const t = String(c.call_type || 'other').replace('_vobiz', '');
            const outcome = (mech.split('\n')[0] || '').replace(/^(RESULT|OUTCOME)\s*:\s*/i, '').slice(0, 90);
            return { id: c.id, order: c.order_id, type: t, language: c.language, at: c.called_at,
                seconds: durS, turns, agent_chars: ttsChars, agent_chars_metered: !!(sMeter && sMeter.tts_chars), cost,
                actual: { telephony: telActual, brain: brainActual }, outcome };
        });

        // ── WHOSE CALLS ARE WE COSTING? (user, 2026-09-09: "give filter of AI Call Manual and change
        // calculation accordingly"). Every call is priced above regardless, because the FULL set is the
        // denominator for apportioning each vendor's bill — filtering the database query instead would
        // have thrown that denominator away and left the shares unknowable.
        const type = ['ai', 'manual'].includes(String(req.query.type || '')) ? String(req.query.type) : 'all';
        const isMan = (c) => c.type === 'manual_human';
        const picked = type === 'all' ? calls : calls.filter((c) => isMan(c) === (type === 'manual'));
        const sum = (arr, f) => arr.reduce((a, c) => a + f(c), 0);

        // A VENDOR BILL IS ONE NUMBER FOR THE WHOLE DAY; a filtered view has to apportion it, and the
        // basis matters. Telephony is split by each set's share of the per-call charges we could match to
        // Vobiz's CDR — the closest thing to a real per-call reading we have — falling back to a plain
        // call-count share if nothing matched. Sarvam is split by our own meter, which is per-call by
        // construction. Both shares are 1 for the unfiltered view, so it is unchanged to the rupee.
        const allTelMatched = sum(calls, (c) => c.cost.telephony);
        const telShare = type === 'all' ? 1
            : allTelMatched > 0 ? sum(picked, (c) => c.cost.telephony) / allTelMatched
            : calls.length ? picked.length / calls.length : 1;
        const allMeasTts = sum(calls, (c) => c.cost.tts), allMeasStt = sum(calls, (c) => c.cost.stt);
        const ttsShare = type === 'all' ? 1 : (allMeasTts > 0 ? sum(picked, (c) => c.cost.tts) / allMeasTts : 0);
        const sttShare = type === 'all' ? 1 : (allMeasStt > 0 ? sum(picked, (c) => c.cost.stt) / allMeasStt : 0);

        for (const c of picked) {
            for (const k of ['telephony', 'stt', 'tts', 'brain']) comp[k] += c.cost[k];
            byType[c.type] = byType[c.type] || { calls: 0, cost: 0, seconds: 0 };
            byType[c.type].calls++;
            byType[c.type].cost = r2(byType[c.type].cost + c.cost.total);
            byType[c.type].seconds += c.seconds;
        }
        for (const k of Object.keys(comp)) comp[k] = r2(comp[k]);
        // the ledger is the fuller truth for the brain (it also covers calls logged before
        // per-call token capture existed); platform work is money the old statement never showed.
        // NEITHER belongs to a manual call: a person dialling from the dashboard runs no brain, and the
        // summaries, agent-learning reviews and audits are all work done ON the agent's own calls.
        if (type !== 'manual' && brainLedgerInr > comp.brain) comp.brain = r2(brainLedgerInr);
        comp.platform = type === 'manual' ? 0 : r2(platformInr);
        // The Vobiz component row shows the PLATFORM total for the range (covers unanswered dials
        // our logs never see) — the more complete of the two numbers.
        // THE BILL REPLACES THE ESTIMATE. /Call/ was never the bill — it lists parent calls and stops
        // paging at ~820 of a claimed 2047 — and the manual-second-leg estimate written an hour before
        // this was a guess at one part of a gap that is now itemised in full. Vobiz's OWN dashboard
        // headline (₹83 on 08 Sep) is also short: it shows the `cdr` line alone and omits the stream
        // and recording charges, so matching it would have been wrong too.
        const telephonyBilled = billed.ok ? billed.total : null;
        const telephonyPlatformTotal = vob.ok ? vob.totalInr : null;
        if (telephonyBilled != null) comp.telephony = r2(telephonyBilled * telShare);
        else if (telephonyPlatformTotal != null && telephonyPlatformTotal * telShare >= comp.telephony) comp.telephony = r2(telephonyPlatformTotal * telShare);
        // ── SARVAM'S OWN BILL REPLACES OUR MEASUREMENT (user, 2026-09-09: "check this and fix
        // calculation"; standing instruction: "don't take any assumption in cost, take actual which the
        // platform provides"). The statement was SHOWING Sarvam's real figure — ₹198.69 on 08-Sep — in a
        // line of its own while quietly totalling our own ₹127.15 measurement, so the grand total ran 36%
        // light on Sarvam and ₹71.54 short on the day. Telephony has worked this way since 08-Sep; this is
        // the same rule, applied to the other vendor that publishes a real number.
        //
        // Split by MODEL, not by our own ratio, because Sarvam itemises it: bulbul is the voice (TTS),
        // saaras and saarika are the ears (STT). That keeps both component lines actual rather than
        // apportioning one total by an assumption.
        //
        // ⚠️ Only when the captured days COVER the range. The figures arrive from a bookmarklet the user
        // clicks, so a half-captured week must keep the measurement — replacing a 7-day range with 2 days
        // of real bills would understate far worse than the estimate does.
        const measuredSarvam = r2(comp.stt + comp.tts);   // of the PICKED set — comp is already filtered
        const rangeDays = Math.max(1, Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 864e5) + 1);
        let sarvamBasis = 'measured';
        if (sarvamBill.ok && sarvamBill.days >= rangeDays) {
            const isTts = (m) => /bulbul/i.test(String(m || ''));
            let bTts = 0, bStt = 0;
            for (const [model, inr] of Object.entries(sarvamBill.byModel || {})) {
                if (isTts(model)) bTts += Number(inr) || 0; else bStt += Number(inr) || 0;
            }
            // an unexpected model name must not silently vanish from the total
            const named = r2(bTts + bStt);
            if (named < sarvamBill.total) bStt = r2(bStt + (sarvamBill.total - named));
            // per-call figures are scaled by the same ratio, so the by-type card and the per-call rows
            // still sum to the component lines above them instead of quietly disagreeing
            // the picked set's share of the bill first, then the per-call scale within that set
            bTts = r2(bTts * ttsShare); bStt = r2(bStt * sttShare);
            const kTts = comp.tts > 0 ? bTts / comp.tts : 0, kStt = comp.stt > 0 ? bStt / comp.stt : 0;
            for (const c of picked) {
                c.cost.tts = r2(c.cost.tts * kTts); c.cost.stt = r2(c.cost.stt * kStt);
                c.cost.total = r2(c.cost.telephony + c.cost.stt + c.cost.tts + c.cost.brain);
            }
            for (const k of Object.keys(byType)) byType[k].cost = 0;
            for (const c of picked) byType[c.type].cost = r2(byType[c.type].cost + c.cost.total);
            comp.tts = r2(bTts); comp.stt = r2(bStt);
            sarvamBasis = 'billed';
        }
        const varTotal = r2(Object.values(comp).reduce((a, b) => a + b, 0));
        // THE WALLET'S OWN VERDICT. Not folded into the component maths — those add up to what we can
        // ATTRIBUTE, and this is what was actually paid. Shown side by side so the gap is visible
        // instead of hidden inside a total nobody can check.
        const wallet = await walletSpend(fromIso, toIso);

        const days = rangeDays;
        // The number rental is one bill for the line, not for a call — on a filtered view it is shared
        // out by call count, so AI + Manual add back to the whole rather than charging it twice.
        const fixShare = type === 'all' ? 1 : (calls.length ? picked.length / calls.length : 0);
        const fixed = FIXED_MONTHLY.map(f => ({ ...f, in_range: r2(f.amount * days / 30.44 * fixShare) }));
        const fixedTotal = r2(fixed.reduce((a, f) => a + f.in_range, 0));
        const connected = picked.filter(c => c.seconds > 0).length;

        res.json({
            success: true,
            range: { from, to, days, type },
            // How much of each shared vendor bill this view carries. On the unfiltered view every share
            // is 1; on a filtered one these are what makes AI + Manual add back to the whole.
            shares: type === 'all' ? null : { telephony: Math.round(telShare * 1000) / 1000,
                tts: Math.round(ttsShare * 1000) / 1000, stt: Math.round(sttShare * 1000) / 1000,
                fixed: Math.round(fixShare * 1000) / 1000, calls: picked.length, of_calls: calls.length },
            telephony_breakdown: billed.ok
                ? Object.entries(billed.byType).map(([k2, v]) => ({ kind: k2, label: TXN_LABEL[k2] || k2, inr: v.inr, count: v.count }))
                : null,
            // WHAT SARVAM BILLED, beside what we measured. Their console has no API and sits behind
            // Cloudflare, so this arrives from a bookmarklet the user clicks on their own usage page.
            // Shown next to our meter rather than replacing it: the gap is the interesting number.
            sarvam_billed: sarvamBill.ok
                ? { inr: sarvamBill.total, days: sarvamBill.days, by_model: sarvamBill.byModel, balance: sarvamBill.balance,
                    in_total: sarvamBasis === 'billed', measured_inr: measuredSarvam }
                : null,
            wallet: {
                spend_inr: wallet.inr, readings: wallet.readings, topups_inr: wallet.topups,
                balance_inr: wallet.last ? Number(wallet.last.balance_inr) : null,
                covers: !!wallet.covers,
                measured_from: wallet.measured_from || null, measured_to: wallet.measured_to || null,
                whole_line: type !== 'all',
                note: wallet.readings < 2
                    ? 'not enough balance readings in this range yet — snapshots run every 15 minutes'
                    : (wallet.covers
                        ? 'actual — the prepaid wallet fell by this much (top-ups excluded). The only figure that cannot be argued with.'
                        : 'PART OF THE RANGE ONLY — the balance snapshots do not span this window, so this is what fell between the first and last reading, not what the range cost. Compare it with the telephony bill above only once it covers the whole range.')
                    + (type !== 'all' ? ' The wallet is the whole phone line: it cannot be split by call type, so this figure covers AI and manual calls together.' : ''),
            },
            sources: {
                telephony: billed.ok
                    ? `ACTUAL — Vobiz's own transaction ledger (${billed.count} debits): `
                      + Object.entries(billed.byType).map(([k, v]) => `${TXN_LABEL[k] || k} ₹${v.inr} (${v.count})`).join(' · ')
                      + '. Reconciles with the wallet. Note their dashboard headline shows the calls line only.'
                    : 'Vobiz transaction ledger unreachable — falling back to the CDR list, which under-reports',
                // the denominator used to be EVERY call in the range, which counted human calls as ones
                // we had failed to measure — they have no brain to measure
                brain: `actual tokens × Anthropic list price for ${brainActualCalls}/${aiCalls} AI calls`
                    + (aiCalls > brainActualCalls ? ` (the rest estimated @ ₹${CLAUDE_EST_PER_TURN}/turn)` : '')
                    + (manualCalls ? ` · ${manualCalls} manual calls have no brain and are charged none` : ''),
                sarvam: sarvamBasis === 'billed'
                ? `ACTUAL — Sarvam's own usage figures for all ${rangeDays} day${rangeDays > 1 ? 's' : ''} in this range, split by model (bulbul = voice, saaras/saarika = ears). Our own meter measured ₹${r2(measuredSarvam)} of the same work.`
                : `measured usage × Sarvam's billing (TTS ₹${SARVAM.tts_per_1k}/1k chars — exact match to their export; STT ₹${SARVAM.stt_per_min}/call-min — calibrated to their processed-audio billing, 02-Sep export)`
                  + (sarvamBill.ok ? ` — their own figures cover only ${sarvamBill.days} of ${rangeDays} days in this range, so the measurement is used` : ''),
                usd_inr: USD_INR(),
                platform: (ledger || []).length
                    ? `actual tokens from ${(ledger || []).length} logged Anthropic calls (summaries, agent learning, audits) — reconciles with console.anthropic.com`
                    : 'no ledger rows yet in this range — restart the server so new Claude calls are logged',
            },
            calls: picked,
            by_type: byType,
            components: comp,
            platform_breakdown: platform,
            fixed,
            totals: {
                calls: picked.length, connected,
                talk_seconds: picked.reduce((a, c) => a + c.seconds, 0),
                variable: varTotal, fixed: fixedTotal, grand: r2(varTotal + fixedTotal),
                avg_per_call: connected ? r2((varTotal + fixedTotal) / connected) : 0,
            },
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, snapshotVobizBalance };
