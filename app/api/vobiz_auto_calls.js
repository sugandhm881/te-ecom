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
//   · hold ledger has verdict='hold' with reasons exactly ["high_value"], 30 min – 48 h old
//     (30 min gives the WhatsApp confirm + reminder first word; 48 h is the age seal)
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
const { supabase } = require('../supabase');

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
async function seal(orderName, status, detail, phone) {
    const { error } = await supabase.from('vobiz_auto_calls_ecom')
        .insert({ order_name: orderName, purpose: PURPOSE, status, detail: detail || null, phone: phone || null, last_attempt_at: new Date().toISOString() });
    if (!error) return true;
    if (String(error.code) === '23505') {
        await supabase.from('vobiz_auto_calls_ecom').update({ status, detail: detail || null, next_attempt_at: null })
            .eq('order_name', orderName).eq('purpose', PURPOSE);
        return true;
    }
    console.warn('[HVCall] turnstile write failed:', error.message);
    return false;
}

// Claim the turnstile before dialing. A first attempt INSERTS (the UNIQUE key is the race guard);
// a redial or a formerly gated row UPDATES in place, guarded on the status it left — two ticks can
// never both dial the same order.
async function claim(orderName, row, attemptNo) {
    if (!row) {
        const { error } = await supabase.from('vobiz_auto_calls_ecom')
            .insert({ order_name: orderName, purpose: PURPOSE, status: 'calling', attempts: 1, last_attempt_at: new Date().toISOString() });
        if (error && String(error.code) !== '23505') console.warn('[HVCall] turnstile write failed:', error.message);
        return !error;
    }
    const { data, error } = await supabase.from('vobiz_auto_calls_ecom')
        .update({ status: 'calling', attempts: attemptNo, last_attempt_at: new Date().toISOString(), next_attempt_at: null })
        .eq('order_name', orderName).eq('purpose', PURPOSE).eq('status', row.status).select('id');
    if (error) { console.warn('[HVCall] turnstile claim failed:', error.message); return false; }
    return !!(data && data.length);
}

// After an unanswered attempt: 1st → redial 10 min later, 2nd → 20 min after that, 3rd → exhausted
// (highlighted, no more auto calls). Delays anchor on the attempt time, so a late cron tick does
// not stretch the ladder.
const UNANSWERED_AFTER_MS = 7 * 60e3;
const RETRY_DELAY_MIN = { 1: 10, 2: 20 };
async function scheduleRetryOrExhaust(row, why) {
    const attempts = Number(row.attempts) || 1;
    if (attempts >= 3) {
        await supabase.from('vobiz_auto_calls_ecom')
            .update({ status: 'exhausted', next_attempt_at: null,
                detail: { ...(row.detail || {}), outcome: 'no_answer', outcome_note: 'no answer after 3 calls', last_reason: why, at: new Date().toISOString() } })
            .eq('order_name', row.order_name).eq('purpose', PURPOSE);
        console.log(`[HVCall] ${row.order_name}: 3 calls unanswered — exhausted, no more auto calls`);
    } else {
        const mins = RETRY_DELAY_MIN[attempts] || 10;
        const base = row.last_attempt_at ? new Date(row.last_attempt_at).getTime() : Date.now();
        await supabase.from('vobiz_auto_calls_ecom')
            .update({ status: 'retry', next_attempt_at: new Date(base + mins * 60e3).toISOString(),
                detail: { ...(row.detail || {}), last_reason: why } })
            .eq('order_name', row.order_name).eq('purpose', PURPOSE);
        console.log(`[HVCall] ${row.order_name}: ${why} (attempt ${attempts}) — retry ${mins} min after the attempt`);
    }
}

// A call nobody picked up leaves NO hangup-side outcome (the bridge session never opens), so the
// row sits at 'calling'/'placed' with no outcome. After 7 minutes that IS the outcome: no answer.
async function sweepUnanswered() {
    const cut = new Date(Date.now() - UNANSWERED_AFTER_MS).toISOString();
    const { data } = await supabase.from('vobiz_auto_calls_ecom')
        .select('order_name, status, attempts, last_attempt_at, created_at, detail')
        .eq('purpose', PURPOSE).in('status', ['calling', 'placed'])
        .or(`last_attempt_at.lt.${cut},and(last_attempt_at.is.null,created_at.lt.${cut})`)
        .limit(100);
    for (const row of (data || [])) {
        if (row.detail && row.detail.outcome) continue;              // an outcome landed after all
        await scheduleRetryOrExhaust(row, 'call not answered');
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
        const to = new Date(Date.now() - 30 * 60e3).toISOString();
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
    if (!targets.length) return { placed: 0, targets: 0 };

    // Unanswered calls first: they decide which rows below are due a redial.
    await sweepUnanswered();

    // Turnstile, read first — the WHOLE row: 'gated' stays retryable, 'retry' redials when due,
    // everything else is settled.
    const turn = new Map();
    const nameList = targets.map(t => t.name);
    for (let i = 0; i < nameList.length; i += 200) {
        const { data } = await supabase.from('vobiz_auto_calls_ecom')
            .select('order_name, status, attempts, next_attempt_at, detail')
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
                if (!row.next_attempt_at || new Date(row.next_attempt_at) > new Date()) continue;   // not due yet
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
        if (!await claim(name, row, attemptNo)) { results.push({ order: name, skip: 'claimed by another tick' }); continue; }
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
            await supabase.from('vobiz_auto_calls_ecom').update({ status: 'placed', sid: r.sid, phone: r.phone || null })
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
function classifyOutcome(summary, exchanges) {
    const line = String(summary || '').split('\n')[0] || '';
    if (!exchanges || exchanges < 2) return { outcome: 'no_answer', note: 'call not answered or too short' };
    if (/no clear|not confirm|unclear|no answer|couldn'?t|did not/i.test(line)) return { outcome: 'unclear', note: 'customer did not clearly confirm on call' };
    if (/cancel|denie|reject|refus|does ?n.t want|not want/i.test(line)) return { outcome: 'denied', note: 'customer denied on call' };
    if (/confirm/i.test(line)) return { outcome: 'confirmed', note: 'customer confirmed the order on call' };
    return { outcome: 'unclear', note: 'customer did not clearly confirm on call' };
}

async function handleCodCallOutcome({ orderName, summary, exchanges }) {
    const name = String(orderName || '').replace(/^#/, '').trim();
    if (!name) return;
    const { outcome, note } = classifyOutcome(summary, exchanges);
    if (outcome === 'no_answer') {
        // Busy / picked up and dropped — the retry ladder owns this, not the outcome record.
        const { data: row } = await supabase.from('vobiz_auto_calls_ecom')
            .select('order_name, attempts, last_attempt_at, detail')
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
    await supabase.from('vobiz_auto_calls_ecom').update({ detail }).eq('order_name', name).eq('purpose', PURPOSE);
}

module.exports = { router, highValueCallTick, handleCodCallOutcome, classifyOutcome };
