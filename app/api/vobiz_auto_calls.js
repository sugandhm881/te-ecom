// ─────────────────────────────────────────────────────────────────────────────
// High-value COD confirmation CALLS (user spec 2026-08-31): an order sitting in the hold list
// because of the ≥₹1500 rule — and ONLY that rule — gets a real AI phone call (Vobiz bridge,
// call_type cod_confirm) asking the customer to confirm the order.
//
// "This only reason" is literal: an order held for high_value AND repeat/short-address stays with
// the manual flow — the call goes only where the sole doubt is the amount.
// WIDENED same day (user): a multi-reason hold still gets the automatic call IF the customer's last
// THREE orders — counting this one — include at least one DELIVERED order ("his last 3 including
// this order had at least one delivered then call should go automatic"): a customer who provably
// takes delivery is worth a confirmation call even when repeat rules also fired.
//
// TEST MODE FIRST (user: "before apply of all order i want to test that, on our allowed order
// list"): placeOrderCall applies VOBIZ_CALL_ALLOWLIST; a refused number is recorded as status
// 'gated' — RETRYABLE, so after cut-over (unset the var) the same order still gets its call.
//
// The turnstile (vobiz_auto_calls_ecom, UNIQUE (order_name, purpose)) is READ before it is
// written — the 2026-08-30 lesson: the unique key is the race guard, never the normal path.
//
// A call is placed only when ALL of these hold:
//   · hold ledger has verdict='hold' with reasons exactly ["high_value"], 5 min – 48 h old
//     (5 min — user 2026-09-01, "auto call should initiate after 5 minute of order placed"; the
//     WhatsApp confirm still fires first at 3 min. 48 h is the age seal)
//   · the order is still COD-pending, not cancelled, not fulfilled
//   · the customer has NOT already replied to the WhatsApp confirmation (any reply = they spoke)
//   · IST clock is inside the calling window (10:00–19:59) — nobody gets a 2 AM robot call
// Outcome lands in agent_call_logs like every bridge call (call_type cod_confirm_vobiz), so the
// transcripts feed the same self-learning loop and dashboard.
//
// RETRY LADDER (user spec, same day): "if the customer is busy and confirmation not received, try
// 3 calls in 30 — 1st instant, 2nd after 10 minutes, 3rd after 20 minutes of the 2nd; if all 3
// unanswered, highlight the order and then no auto calls." An unanswered attempt (never picked up,
// or hung up before a real exchange) arms status 'retry' with next_attempt_at; the 10-minute cron
// redials due retries. Attempt 3 unanswered → status 'exhausted' (violet highlight in the Call
// Queue, never auto-dialed again). Answered-but-vague stays 'unclear' — no redial, a person decides.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../supabase');

// The carrier's own record of one dial (user, 2026-09-01: "complete ringing till hangup in call
// log"): ring seconds + hangup cause (Busy Line / No Answer / Rejected...). An unanswered call has
// no audio to record - this CDR is its complete story. Best-effort: a miss never blocks the ladder.
async function fetchVobizCdr(uuid) {
    try {
        if (!uuid) return null;
        const id = process.env.VOBIZ_AUTH_ID;
        const r = await axios.get(`https://api.vobiz.ai/api/v1/Account/${id}/Call/${uuid}/`,
            { headers: { 'X-Auth-ID': id, 'X-Auth-Token': process.env.VOBIZ_AUTH_TOKEN }, timeout: 10000, validateStatus: () => true });
        if (r.status !== 200 || !r.data) return null;
        const c = r.data;
        const t = v => v ? new Date(String(v).replace(' ', 'T')).getTime() : null;
        const ring = (t(c.initiation_time) && t(c.end_time)) ? Math.max(0, Math.round((t(c.end_time) - t(c.initiation_time)) / 1000)) : null;
        return { cause: c.hangup_cause_name || c.hangup_cause || null, by: c.hangup_source || null, ring_s: ring, answered: !!c.answer_time };
    } catch (_) { return null; }
}

const PURPOSE = 'cod_confirm';
const WINDOW = { from: 10, to: 20 };                                // IST hours, [from, to)
const PER_TICK_CAP = 10;
const istHour = () => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));

// "His last 3 orders, including this one, had at least one delivered." The identity comes from the
// hold ledger row (the exact phones/emails the hold evaluation itself merged); history via the same
// fetchHistory the rules use, so 'delivered' means the same thing everywhere. Window = this order +
// the two orders before it; a delivered row anywhere in those three opens the automatic-call door.
async function lastThreeIncludeDelivered(identity, orderName, orderCreatedAt) {
    const phones = (identity && identity.phones) || [], emails = (identity && identity.emails) || [];
    if (!phones.length && !emails.length) return false;
    const nk = n => String(n || '').replace('#', '').trim();
    try {
        const { fetchHistory } = require('./repeat_rules');
        const hist = await fetchHistory(supabase, { phones, emails });
        const cut = new Date(orderCreatedAt || Date.now());
        const upto = hist.filter(h => nk(h.order_name) === orderName || new Date(h.created_at) <= cut)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const hasSelf = upto.some(h => nk(h.order_name) === orderName);
        const window3 = upto.slice(0, hasSelf ? 3 : 2);          // this order + the 2 before it
        return window3.some(h => h.bucket === 'delivered');
    } catch (e) { console.warn('[HVCall] last-3 history check failed:', e.message); return false; }
}

// Record a settled non-call state (skipped, and its why). Upserts: a retry/gated row that turns out
// to be cancelled/paid/replied must be closed too, or it would redial a dead order forever.
async function seal(orderName, status, detail, phone, purpose = PURPOSE) {
    const { error } = await supabase.from('vobiz_auto_calls_ecom')
        .insert({ order_name: orderName, purpose, status, detail: detail || null, phone: phone || null, last_attempt_at: new Date().toISOString() });
    if (!error) return true;
    if (String(error.code) === '23505') {
        await supabase.from('vobiz_auto_calls_ecom').update({ status, detail: detail || null, next_attempt_at: null })
            .eq('order_name', orderName).eq('purpose', purpose);
        return true;
    }
    console.warn('[HVCall] turnstile write failed:', error.message);
    return false;
}

// Claim the turnstile before dialing. A first attempt INSERTS (the UNIQUE key is the race guard);
// a redial or a formerly gated row UPDATES in place, guarded on the status it left — two ticks can
// never both dial the same order.
async function claim(orderName, row, attemptNo, purpose = PURPOSE) {
    const at = new Date().toISOString();
    if (!row) {
        const log0 = [{ n: 1, at }];
        const { error } = await supabase.from('vobiz_auto_calls_ecom')
            .insert({ order_name: orderName, purpose, status: 'calling', attempts: 1, last_attempt_at: at, attempt_log: log0 });
        if (error && String(error.code) !== '23505') console.warn('[HVCall] turnstile write failed:', error.message);
        return error ? null : log0;
    }
    // One log entry per attempt NUMBER: a re-claim of the same attempt (a dial that never connected,
    // a second tick) refreshes the entry instead of appending a duplicate — the modal card showed
    // "#2 … in progress" and "#2 … no answer" side by side (TE25-45950, 2026-09-01).
    const log = (row.attempt_log || []).slice();
    if (log.length && Number(log[log.length - 1].n) === attemptNo) log[log.length - 1] = { n: attemptNo, at };
    else log.push({ n: attemptNo, at });
    const { data, error } = await supabase.from('vobiz_auto_calls_ecom')
        .update({ status: 'calling', attempts: attemptNo, last_attempt_at: at, next_attempt_at: null,
            attempt_log: log })
        .eq('order_name', orderName).eq('purpose', purpose).eq('status', row.status).select('id');
    if (error) { console.warn('[HVCall] turnstile claim failed:', error.message); return null; }
    return (data && data.length) ? log : null;
}

// Stamp the result onto the LAST attempt entry — the modal's per-attempt history reads these.
function logResult(row, result) {
    const log = (row && Array.isArray(row.attempt_log)) ? row.attempt_log.slice() : [];
    if (log.length) log[log.length - 1] = { ...log[log.length - 1], result };
    return log;
}

// After an unanswered attempt: 1st → redial 10 min later, 2nd → 20 min after that, 3rd → exhausted
// (highlighted, no more auto calls). Delays anchor on the attempt time, so a late cron tick does
// not stretch the ladder.
const UNANSWERED_AFTER_MS = 7 * 60e3;
const RETRY_DELAY_MIN = { 1: 10, 2: 20 };                       // cod_confirm ladder (user spec 2026-08-31): 3 calls
const RTO_RETRY_DELAY_MIN = { 1: 60 };                          // rto_recovery ladder (user spec 2026-09-02 rev.2): only TWO calls — 2nd one hour after the 1st, then stop
// Each courier NDR attempt gets its OWN 2-call ladder (user rev.3: "NDR call should happen on NDR1,
// NDR2 & NDR3"): attempts count cumulatively (ladder 2 = attempts 3–4, ladder 3 = 5–6), the ladder
// number rides in detail.ndr_no, and the retry-delay key is the attempt's position INSIDE its ladder.
const rtoNdrNo = (row) => Math.min(3, Number(((row || {}).detail || {}).ndr_no || 1));
const DELAYS_FOR = (purpose, row) => purpose === 'rto_recovery' ? RTO_RETRY_DELAY_MIN : RETRY_DELAY_MIN;
const ladderKey = (purpose, row, attempts) => purpose === 'rto_recovery' ? attempts - 2 * (rtoNdrNo(row) - 1) : attempts;
const MAX_ATTEMPTS = (purpose, row) => purpose === 'rto_recovery' ? 2 * rtoNdrNo(row) : 3;
async function scheduleRetryOrExhaust(row, why, purpose = PURPOSE) {
    const attempts = Number(row.attempts) || 1;
    // Pull the carrier's record for the dial being closed: ring seconds + hangup cause land on the
    // attempt entry ("no answer - Busy Line, 8s"), which the order modal shows.
    try {
        const log = row.attempt_log || [];
        const last = log[log.length - 1];
        if (last && last.uuid && !last.cause) {
            const cdr = await fetchVobizCdr(last.uuid);
            if (cdr) { last.cause = cdr.cause; last.ring_s = cdr.ring_s; last.hangup_by = cdr.by; }
        }
    } catch (_) {}
    const maxA = MAX_ATTEMPTS(purpose, row);
    if (attempts >= maxA) {
        await supabase.from('vobiz_auto_calls_ecom')
            .update({ status: 'exhausted', next_attempt_at: null, attempt_log: logResult(row, 'no_answer'),
                detail: { ...(row.detail || {}), outcome: 'no_answer', outcome_note: `no answer after ${maxA} calls`, last_reason: why, at: new Date().toISOString() } })
            .eq('order_name', row.order_name).eq('purpose', purpose);
        console.log(`[HVCall] ${row.order_name}/${purpose}: ${maxA} calls unanswered — exhausted, no more auto calls`);
    } else {
        const mins = DELAYS_FOR(purpose, row)[ladderKey(purpose, row, attempts)] || 10;
        const base = row.last_attempt_at ? new Date(row.last_attempt_at).getTime() : Date.now();
        await supabase.from('vobiz_auto_calls_ecom')
            .update({ status: 'retry', next_attempt_at: new Date(base + mins * 60e3).toISOString(),
                attempt_log: logResult(row, 'no_answer'),
                detail: { ...(row.detail || {}), last_reason: why } })
            .eq('order_name', row.order_name).eq('purpose', purpose);
        console.log(`[HVCall] ${row.order_name}/${purpose}: ${why} (attempt ${attempts}) — retry ${mins} min after the attempt`);
    }
}

// INSTANT no-answer (user, 2026-09-01): Vobiz's hangup webhook fires seconds after a call dies
// unanswered — the bridge routes never-connected hangups here. A short delay lets the carrier CDR
// materialize so the attempt line carries the cause immediately ("Busy Line, 0s · by carrier").
async function handleUnansweredHangup(orderName, purpose = PURPOSE) {
    const name = String(orderName || '').replace(/^#/, '').trim();
    if (!name) return;
    await new Promise(r => setTimeout(r, 4000));
    const { data: row } = await supabase.from('vobiz_auto_calls_ecom')
        .select('order_name, status, attempts, last_attempt_at, detail, attempt_log')
        .eq('order_name', name).eq('purpose', purpose).maybeSingle();
    if (!row || !['calling', 'placed'].includes(row.status)) return;   // already settled/answered
    if (row.detail && row.detail.outcome) return;
    await scheduleRetryOrExhaust(row, 'call not answered (hangup webhook)', purpose);
    console.log(`[HVCall] ${name}/${purpose}: unanswered — marked instantly from the hangup webhook`);
}

// A call nobody picked up leaves NO hangup-side outcome (the bridge session never opens), so the
// row sits at 'calling'/'placed' with no outcome. After 7 minutes that IS the outcome: no answer.
async function sweepUnanswered(purpose = PURPOSE) {
    const cut = new Date(Date.now() - UNANSWERED_AFTER_MS).toISOString();
    const { data } = await supabase.from('vobiz_auto_calls_ecom')
        .select('order_name, status, attempts, last_attempt_at, created_at, detail, attempt_log')
        .eq('purpose', purpose).in('status', ['calling', 'placed'])
        .or(`last_attempt_at.lt.${cut},and(last_attempt_at.is.null,created_at.lt.${cut})`)
        .limit(100);
    for (const row of (data || [])) {
        if (row.detail && row.detail.outcome) continue;              // an outcome landed after all
        await scheduleRetryOrExhaust(row, 'call not answered', purpose);
    }
}

// One tick. opts.testOrder (manual endpoint only) targets a single order and skips the clock/age
// windows — the allowlist, the turnstile and the still-needs-a-call checks all still apply.
async function highValueCallTick(opts = {}) {
    const { placeOrderCall, vobizConfigured } = require('./vobiz_bridge');
    if (!vobizConfigured()) return { skip: 'Vobiz not configured' };
    const h = istHour();
    if (!opts.testOrder && (h < WINDOW.from || h >= WINDOW.to)) return { skip: `outside calling window (${WINDOW.from}:00–${WINDOW.to}:00 IST)` };

    let targets;
    if (opts.testOrder) {
        targets = [String(opts.testOrder).replace(/^#/, '').trim()];
    } else {
        const from = new Date(Date.now() - 48 * 3600e3).toISOString();
        const to = new Date(Date.now() - 5 * 60e3).toISOString();   // 5 min after placement (user, 2026-09-01; was 30)
        const { data: evals, error } = await supabase.from('hold_evaluations_ecom')
            .select('order_name, reasons, identity').eq('verdict', 'hold')
            .gte('created_at', from).lte('created_at', to)
            .order('created_at', { ascending: true }).limit(500);
        if (error) throw new Error('hold ledger read failed: ' + error.message);
        const seenN = new Set(); targets = [];
        for (const e of (evals || [])) {
            if (!e.order_name || seenN.has(e.order_name)) continue;
            if (!Array.isArray(e.reasons) || !e.reasons.includes('high_value')) continue;
            seenN.add(e.order_name);
            targets.push({ name: e.order_name, soleReason: e.reasons.length === 1, identity: e.identity || null });
        }
    }
    if (opts.testOrder) targets = targets.map(name => ({ name, soleReason: true, identity: null }));

    // DUE RETRIES ride on their own rail (TE25-45530 lesson, 2026-08-31): a retry that comes due
    // after the order's hold crosses the 48h ladder edge would otherwise never be seen again — the
    // ladder window gates the FIRST call, not the follow-ups an unanswered customer is owed.
    // Eligibility was already proven at attempt 1; the needs-a-call guards below still re-check.
    if (!opts.testOrder) {
        const have = new Set(targets.map(t => t.name));
        // 65s grace: the cron fires at :00 and a retry armed at :00:02 would otherwise slip a whole
        // 10-minute cycle over two seconds (TE25-46030, 2026-09-01).
        const { data: due } = await supabase.from('vobiz_auto_calls_ecom')
            .select('order_name').eq('purpose', PURPOSE).eq('status', 'retry')
            .lte('next_attempt_at', new Date(Date.now() + 65e3).toISOString()).limit(50);
        (due || []).forEach(r => { if (!have.has(r.order_name)) targets.push({ name: r.order_name, soleReason: true, identity: null }); });
    }
    if (!targets.length) return { placed: 0, targets: 0 };

    // Unanswered calls first: they decide which rows below are due a redial.
    await sweepUnanswered();

    // Turnstile, read first — the WHOLE row: 'gated' stays retryable, 'retry' redials when due,
    // everything else is settled.
    const turn = new Map();
    const nameList = targets.map(t => t.name);
    for (let i = 0; i < nameList.length; i += 200) {
        const { data } = await supabase.from('vobiz_auto_calls_ecom')
            .select('order_name, status, attempts, next_attempt_at, detail, attempt_log')
            .eq('purpose', PURPOSE).in('order_name', nameList.slice(i, i + 200));
        (data || []).forEach(r => turn.set(r.order_name, r));
    }

    let placed = 0, gated = 0; const results = [];
    for (const t of targets) {
        const name = t.name;
        const row = turn.get(name);
        let redial = false;
        if (row) {
            if (row.status === 'retry') {
                if (!row.next_attempt_at || new Date(row.next_attempt_at) > new Date(Date.now() + 65e3)) continue;   // not due (65s grace — see the rail note)
                redial = true;
            } else if (row.status !== 'gated') {
                if (opts.testOrder) results.push({ order: name, skip: 'already called (turnstile)' });
                continue;                                            // placed/failed/skipped/exhausted/calling
            }
        }
        if (placed >= PER_TICK_CAP) break;

        // Still needs the call? (cancelled / paid / shipped / already answered on WhatsApp → seal, no call)
        const { data: ord } = await supabase.from('orders')
            .select('cancelled_at, financial_status, fulfillment_status, created_at')
            .or(`name.eq.${name},name.eq.#${name}`).order('created_at', { ascending: false }).limit(1).maybeSingle();
        const why = !ord ? null
            : ord.cancelled_at ? 'order cancelled'
            : String(ord.financial_status) !== 'pending' ? `no longer COD-pending (${ord.financial_status})`
            : ord.fulfillment_status === 'fulfilled' ? 'already fulfilled' : null;
        if (why) { await seal(name, 'skipped', { why }); results.push({ order: name, skip: why }); continue; }

        // Multi-reason hold → eligible only through the delivered-in-last-3 door. NOT sealed when
        // ineligible: an in-flight order in that window may deliver tomorrow and open the door.
        if (!t.soleReason) {
            const okDelivered = await lastThreeIncludeDelivered(t.identity, name, ord.created_at);
            if (!okDelivered) { results.push({ order: name, skip: 'multi-reason hold, no delivered order in last 3' }); continue; }
        }
        const { data: reply } = await supabase.from('cod_confirmations_msg91').select('id_key').eq('id_key', name).limit(1);
        if (reply && reply.length) { await seal(name, 'skipped', { why: 'customer already replied on WhatsApp' }); results.push({ order: name, skip: 'already replied on WhatsApp' }); continue; }

        // Claim the turnstile BEFORE dialing (unique key / status guard = the race guard).
        const attemptNo = redial ? (Number(row.attempts) || 1) + 1 : (row ? (Number(row.attempts) || 1) : 1);
        const claimedLog = await claim(name, row, attemptNo);
        if (!claimedLog) { results.push({ order: name, skip: 'claimed by another tick' }); continue; }
        let r;
        try { r = await placeOrderCall({ order_name: name, call_type: PURPOSE, auto: true }); }
        catch (e) { r = { error: e.message }; }
        if (r.gated) {
            gated++;
            await supabase.from('vobiz_auto_calls_ecom').update({ status: 'gated', detail: { gate: r.error }, phone: r.phone || null })
                .eq('order_name', name).eq('purpose', PURPOSE);
            results.push({ order: name, gated: r.error });
        } else if (r.error) {
            await supabase.from('vobiz_auto_calls_ecom').update({ status: 'failed', detail: { error: r.error } })
                .eq('order_name', name).eq('purpose', PURPOSE);
            results.push({ order: name, error: r.error });
        } else {
            placed++;
            // remember the Vobiz call uuid on this attempt - the no-answer sweep pulls its CDR later
            const vuuid = (r.vobiz && (r.vobiz.request_uuid || r.vobiz.call_uuid)) || null;
            if (vuuid && claimedLog.length) claimedLog[claimedLog.length - 1].uuid = vuuid;
            await supabase.from('vobiz_auto_calls_ecom').update({ status: 'placed', sid: r.sid, phone: r.phone || null, attempt_log: claimedLog })
                .eq('order_name', name).eq('purpose', PURPOSE);
            console.log(`[HVCall] ${name}: COD confirmation call placed (sid ${r.sid})`);
            results.push({ order: name, placed: true, sid: r.sid });
        }
    }
    if (placed || gated) console.log(`[HVCall] tick: ${placed} placed, ${gated} gated (allowlist), ${targets.length} candidates`);
    return { placed, gated, targets: targets.length, results };
}

// Manual trigger for testing (same capability gate as /vobiz/call — see server.js CAPS):
// POST /api/vobiz/high-value-call-tick            → run a normal tick now (clock window still applies)
// POST /api/vobiz/high-value-call-tick {order_name} → force-evaluate ONE order (test path: skips the
//     clock/age windows, keeps allowlist + turnstile + the still-needs-a-call checks)
router.post('/vobiz/high-value-call-tick', async (req, res) => {
    try {
        const r = await highValueCallTick({ testOrder: (req.body || {}).order_name || null });
        res.json({ success: true, ...r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── outcome → action (2026-08-31 spec addition) ──────────────────────────────────────────────
// Called by vobiz_bridge close() for AUTO cod_confirm calls only, with the AI summary already made.
// confirmed → auto-unhold BOTH systems, documented (release tombstones name 'ai-call (customer
//             confirmed)', turnstile keeps outcome + summary).
// denied    → NO automatic action — recorded as outcome 'denied' so the Call Queue highlights the
//             row in red with "customer denied on call"; a person decides.
// unclear   → same, amber, "customer did not clearly confirm on call".
// The summary's first line is summarizeCall's fixed vocabulary (confirmed / wants cancel / will
// reattempt / no clear answer / other) — negations are checked FIRST so "not confirmed" and
// "no clear answer" can never read as a confirmation.
// `customerTurns` = how many times the CUSTOMER spoke — never the agent's own lines (the
// TE25-45877 lesson: an unanswered call carried 2 agent lines, counted as 2 exchanges, read as
// 'unclear', and the retry ladder never armed). Zero customer speech is ALWAYS no_answer; one brief
// turn with a disconnect cue in the summary (busy, dropped, cut) is no_answer too — both retry.
// 'unclear' stays reserved for a customer who actually talked but gave no clear yes/no.
function classifyOutcome(summary, customerTurns) {
    const line = String(summary || '').split('\n')[0] || '';
    if (!customerTurns) return { outcome: 'no_answer', note: 'call not answered — customer never spoke' };
    // VOICEMAIL looks like a talking customer (the machine's greeting transcribes as customer turns —
    // TE25-45530: 125s with an answering machine, filed 'unclear', no retry). The summary names it.
    if (/voice ?mail|answering machine|customer unavailable/i.test(line))
        return { outcome: 'no_answer', note: 'voicemail — customer unavailable' };
    if (customerTurns <= 1 && /disconnect|no response|did not respond|never answered|line dropped|call dropped|call cut/i.test(line))
        return { outcome: 'no_answer', note: 'customer could not respond (busy or call dropped)' };
    if (/no clear|not confirm|unclear|no answer|couldn'?t|did not/i.test(line)) return { outcome: 'unclear', note: 'customer did not clearly confirm on call' };
    if (/cancel|denie|reject|refus|does ?n.t want|not want/i.test(line)) return { outcome: 'denied', note: 'customer denied on call' };
    if (/confirm/i.test(line)) return { outcome: 'confirmed', note: 'customer confirmed the order on call' };
    return { outcome: 'unclear', note: 'customer did not clearly confirm on call' };
}

async function handleCodCallOutcome({ orderName, summary, customerTurns }) {
    const name = String(orderName || '').replace(/^#/, '').trim();
    if (!name) return;
    const { outcome, note } = classifyOutcome(summary, customerTurns);
    if (outcome === 'no_answer') {
        // Busy / picked up and dropped — the retry ladder owns this, not the outcome record.
        const { data: row } = await supabase.from('vobiz_auto_calls_ecom')
            .select('order_name, attempts, last_attempt_at, detail, attempt_log')
            .eq('order_name', name).eq('purpose', PURPOSE).maybeSingle();
        if (row) await scheduleRetryOrExhaust(row, note);
        return;
    }
    const detail = { outcome, outcome_note: note, summary: String(summary || '').slice(0, 400), at: new Date().toISOString() };
    if (outcome === 'confirmed') {
        const BY = 'ai-call (customer confirmed)';
        const unhold = {};
        try {
            const { data: ord } = await supabase.from('orders').select('id')
                .or(`name.eq.${name},name.eq.#${name}`).order('created_at', { ascending: false }).limit(1).maybeSingle();
            if (ord && ord.id) {
                const rel = await require('./shopify_hold').releaseOrder(name, ord.id, BY);
                unhold.shopify = rel.ok ? 'released' : ('failed: ' + rel.error);
            } else unhold.shopify = 'order id not found';
        } catch (e) { unhold.shopify = 'failed: ' + e.message; }
        try {
            const { data: eeHeld } = await supabase.from('order_marks_ecom').select('order_name')
                .eq('order_name', name).eq('mark_type', 'ee_hold').limit(1).maybeSingle();
            if (eeHeld) {
                const rel = await require('./easyecom').unholdOrderByAutomation(name, BY);
                unhold.easyecom = rel.ok ? 'released' : ('failed: ' + rel.error);
            }
        } catch (e) { unhold.easyecom = 'failed: ' + e.message; }
        detail.unhold = unhold;
        console.log(`[HVCall] ${name}: customer CONFIRMED on call → unhold`, JSON.stringify(unhold));
    } else {
        console.log(`[HVCall] ${name}: call outcome '${outcome}' — no automatic action (${note})`);
    }
    const { data: cur } = await supabase.from('vobiz_auto_calls_ecom').select('attempt_log')
        .eq('order_name', name).eq('purpose', PURPOSE).maybeSingle();
    await supabase.from('vobiz_auto_calls_ecom').update({ detail, attempt_log: logResult(cur, outcome) })
        .eq('order_name', name).eq('purpose', PURPOSE);
}

// ── RTO RECOVERY AUTO-CALLS (user spec 2026-09-02: "after live, any order that goes to NDR — call
// initiated 2 minutes after the NDR update; max three attempts: 1st call, if no answer or busy the
// 2nd after 5 minutes, if same the 3rd after 10 minutes of the 2nd; proper logs in the database and
// on the dashboard"). Same turnstile table (purpose 'rto_recovery'), same attempt_log/CDR/dashboard
// rails as the COD engine. GATED by VOBIZ_RTO_ENABLED — shipping this is inert until that flag is
// true (the same kill-switch that already gates rto_recovery in placeOrderCall), so "live for all"
// happens exactly when the user flips it on the VPS.
const RTO_PURPOSE = 'rto_recovery';
async function rtoCallTick(opts = {}) {
    const { placeOrderCall, vobizConfigured } = require('./vobiz_bridge');
    if (!vobizConfigured()) return { skip: 'Vobiz not configured' };
    if (String(process.env.VOBIZ_RTO_ENABLED || '') !== 'true') return { skip: 'RTO calling disabled (VOBIZ_RTO_ENABLED)' };
    const h = istHour();
    if (!opts.testOrder && (h < WINDOW.from || h >= WINDOW.to)) return { skip: `outside calling window (${WINDOW.from}:00–${WINDOW.to}:00 IST)` };

    let targets = [];
    if (opts.testOrder) {
        targets = [String(opts.testOrder).replace(/^#/, '').trim()];
    } else {
        // An order "goes to NDR" = its shipment journey shows outcome 'ndr_pending' with an NDR on
        // record. 5-minute floor after the update lands in our DB (user rev.2, 2026-09-02).
        // LOOKBACK is deliberately SHORT (user rev.4, same evening: "only call new NDR received, no
        // old ones") — a fresh NDR is dialed within minutes, so a long window buys nothing and only
        // risks robo-dialing a backlog. VOBIZ_RTO_LOOKBACK_H overrides; VOBIZ_RTO_MIN_NDR_AT (ISO)
        // is a hard floor: nothing whose NDR predates that moment is ever a candidate.
        const lookbackH = Number(process.env.VOBIZ_RTO_LOOKBACK_H || 6);
        let fromMs = Date.now() - lookbackH * 3600e3;
        const floor = Date.parse(process.env.VOBIZ_RTO_MIN_NDR_AT || '');
        if (!Number.isNaN(floor)) fromMs = Math.max(fromMs, floor);
        const from = new Date(fromMs).toISOString();
        const to = new Date(Date.now() - 5 * 60e3).toISOString();
        const { data: rows, error } = await supabase.from('shipment_journey_ecom')
            .select('order_name, ndr_count, updated_at').eq('outcome', 'ndr_pending').gte('ndr_count', 1)
            .gte('updated_at', from).lte('updated_at', to)
            .order('updated_at', { ascending: true }).limit(300);
        if (error) throw new Error('journey read failed: ' + error.message);
        const seen = new Set();
        for (const r of (rows || [])) {
            const nm = String(r.order_name || '').replace(/^#/, '').trim();
            if (nm && !seen.has(nm)) { seen.add(nm); targets.push({ name: nm, ndr: Math.min(3, Number(r.ndr_count) || 1) }); }
        }
        // due retries ride their own rail (same 65s-grace lesson as the COD ladder)
        const { data: due } = await supabase.from('vobiz_auto_calls_ecom')
            .select('order_name').eq('purpose', RTO_PURPOSE).eq('status', 'retry')
            .lte('next_attempt_at', new Date(Date.now() + 65e3).toISOString()).limit(50);
        (due || []).forEach(r => { if (!seen.has(r.order_name)) { seen.add(r.order_name); targets.push({ name: r.order_name, ndr: null }); } });
    }
    if (opts.testOrder) targets = targets.map(t => (typeof t === 'string' ? { name: t, ndr: null } : t));
    if (!targets.length) return { placed: 0, targets: 0 };

    await sweepUnanswered(RTO_PURPOSE);

    const turn = new Map();
    const nameList = targets.map(t => t.name);
    for (let i = 0; i < nameList.length; i += 200) {
        const { data } = await supabase.from('vobiz_auto_calls_ecom')
            .select('order_name, status, attempts, next_attempt_at, detail, attempt_log')
            .eq('purpose', RTO_PURPOSE).in('order_name', nameList.slice(i, i + 200));
        (data || []).forEach(r => turn.set(r.order_name, r));
    }

    let placed = 0, gated = 0; const results = [];
    for (const t of targets) {
        const name = t.name;
        let row = turn.get(name);
        let redial = false;
        // A NEW courier NDR (NDR2/NDR3) re-arms a settled row with a FRESH 2-call ladder (user
        // rev.3): the old outcome is archived into prev_outcome, ndr_no advances, and the row is
        // treated as a due redial — attempts keep counting up so the modal shows the full history.
        if (row && t.ndr && t.ndr > rtoNdrNo(row) && t.ndr <= 3
            && !['calling', 'retry', 'gated'].includes(row.status)) {
            const det = { ...(row.detail || {}) };
            if (det.outcome) { det['prev_outcome_ndr' + rtoNdrNo(row)] = det.outcome + (det.outcome_note ? ` (${det.outcome_note})` : ''); }
            delete det.outcome; delete det.outcome_note; delete det.summary;
            det.ndr_no = t.ndr;
            const { data: upd } = await supabase.from('vobiz_auto_calls_ecom')
                .update({ status: 'retry', next_attempt_at: new Date().toISOString(), detail: det })
                .eq('order_name', name).eq('purpose', RTO_PURPOSE).eq('status', row.status).select('order_name, status, attempts, next_attempt_at, detail, attempt_log');
            if (upd && upd.length) { row = upd[0]; console.log(`[RTOCall] ${name}: courier NDR${t.ndr} recorded — fresh ladder armed`); }
        }
        if (row) {
            if (row.status === 'retry') {
                if (!row.next_attempt_at || new Date(row.next_attempt_at) > new Date(Date.now() + 65e3)) continue;
                redial = true;
            } else if (row.status !== 'gated') {
                if (opts.testOrder) results.push({ order: name, skip: 'already called (turnstile)' });
                continue;
            }
        }
        if (placed >= PER_TICK_CAP) break;

        // still worth the call? cancelled orders and journeys that moved on are sealed, never dialed
        const { data: ord } = await supabase.from('orders').select('cancelled_at')
            .or(`name.eq.${name},name.eq.#${name}`).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (ord && ord.cancelled_at) { await seal(name, 'skipped', { why: 'order cancelled' }, null, RTO_PURPOSE); results.push({ order: name, skip: 'order cancelled' }); continue; }
        if (!opts.testOrder) {
            const { data: j } = await supabase.from('shipment_journey_ecom').select('outcome')
                .eq('order_name', name).order('updated_at', { ascending: false }).limit(1).maybeSingle();
            if (j && j.outcome !== 'ndr_pending') { await seal(name, 'skipped', { why: `no longer NDR (${j.outcome})` }, null, RTO_PURPOSE); results.push({ order: name, skip: `no longer NDR (${j.outcome})` }); continue; }
        }

        const attemptNo = redial ? (Number(row.attempts) || 1) + 1 : (row ? (Number(row.attempts) || 1) : 1);
        const claimedLog = await claim(name, row, attemptNo, RTO_PURPOSE);
        if (!claimedLog) { results.push({ order: name, skip: 'claimed by another tick' }); continue; }
        let r;
        try { r = await placeOrderCall({ order_name: name, call_type: 'rto_recovery', auto: true }); }
        catch (e) { r = { error: e.message }; }
        const ndrStamp = { ...((row && row.detail) || {}), ndr_no: t.ndr || rtoNdrNo(row) };
        if (r.gated) {
            gated++;
            await supabase.from('vobiz_auto_calls_ecom').update({ status: 'gated', detail: { ...ndrStamp, gate: r.error }, phone: r.phone || null })
                .eq('order_name', name).eq('purpose', RTO_PURPOSE);
            results.push({ order: name, gated: r.error });
        } else if (r.error) {
            await supabase.from('vobiz_auto_calls_ecom').update({ status: 'failed', detail: { ...ndrStamp, error: r.error } })
                .eq('order_name', name).eq('purpose', RTO_PURPOSE);
            results.push({ order: name, error: r.error });
        } else {
            placed++;
            const vuuid = (r.vobiz && (r.vobiz.request_uuid || r.vobiz.call_uuid)) || null;
            if (vuuid && claimedLog.length) claimedLog[claimedLog.length - 1].uuid = vuuid;
            await supabase.from('vobiz_auto_calls_ecom').update({ status: 'placed', sid: r.sid, phone: r.phone || null, attempt_log: claimedLog, detail: ndrStamp })
                .eq('order_name', name).eq('purpose', RTO_PURPOSE);
            console.log(`[RTOCall] ${name}: RTO recovery call placed (sid ${r.sid})`);
            results.push({ order: name, placed: true, sid: r.sid });
        }
    }
    if (placed || gated) console.log(`[RTOCall] tick: ${placed} placed, ${gated} gated (allowlist), ${targets.length} candidates`);
    return { placed, gated, targets: targets.length, results };
}

// Outcome for AUTO rto_recovery calls, from the bridge's close(): answered calls record the result
// (reattempt / cancelled / unclear) on the turnstile; unanswered ones arm the 5/10-minute ladder.
async function handleRtoCallOutcome({ orderName, summary, customerTurns }) {
    const name = String(orderName || '').replace(/^#/, '').trim();
    if (!name) return;
    const line = String(summary || '').split('\n')[0] || '';
    // Only a RESULT/OUTCOME-shaped summary line may set a real outcome — a summarizer glitch that
    // ASKS for the transcript ("…about re-delivery or cancellation") must never read as a decision
    // (first live day: a 10s hello-only call got marked CANCELLED exactly this way).
    const shaped = /^\s*(RESULT|OUTCOME)\b/i.test(line);
    let outcome = 'unclear', note = 'customer talked but outcome unclear';
    if (!customerTurns || /voice ?mail|answering machine|no answer/i.test(line)) { outcome = 'no_answer'; note = 'call not answered / never engaged'; }
    else if (shaped && /reattempt agreed|will reattempt|agreed/i.test(line)) { outcome = 'reattempt'; note = 'customer agreed to the reattempt'; }
    else if (shaped && /cancel/i.test(line)) { outcome = 'cancelled'; note = 'customer wants to cancel'; }
    if (outcome === 'no_answer') {
        const { data: row } = await supabase.from('vobiz_auto_calls_ecom')
            .select('order_name, attempts, last_attempt_at, detail, attempt_log')
            .eq('order_name', name).eq('purpose', RTO_PURPOSE).maybeSingle();
        if (row) await scheduleRetryOrExhaust(row, note, RTO_PURPOSE);
        return;
    }
    const { data: cur } = await supabase.from('vobiz_auto_calls_ecom').select('attempt_log, detail')
        .eq('order_name', name).eq('purpose', RTO_PURPOSE).maybeSingle();
    await supabase.from('vobiz_auto_calls_ecom')
        .update({ detail: { ...((cur && cur.detail) || {}), outcome, outcome_note: note, summary: String(summary || '').slice(0, 400), at: new Date().toISOString() },
            attempt_log: logResult(cur, outcome), next_attempt_at: null })
        .eq('order_name', name).eq('purpose', RTO_PURPOSE);
    console.log(`[RTOCall] ${name}: outcome '${outcome}' (${note})`);
}

// Manual trigger, same capability gate pattern as the COD tick:
// POST /api/vobiz/rto-call-tick            → run a tick now (window + RTO flag still apply)
// POST /api/vobiz/rto-call-tick {order_name} → force ONE order through (skips windows, keeps gates)
router.post('/vobiz/rto-call-tick', async (req, res) => {
    try {
        const r = await rtoCallTick({ testOrder: (req.body || {}).order_name || null });
        res.json({ success: true, ...r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, highValueCallTick, rtoCallTick, handleCodCallOutcome, handleRtoCallOutcome, handleUnansweredHangup, classifyOutcome };
