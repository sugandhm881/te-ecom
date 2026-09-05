// ─────────────────────────────────────────────────────────────────────────────
// WHO IS ON A PHONE RIGHT NOW — the one thing the AI caller and the manual dialler share.
//
// User, 2026-09-05: "can we make something in code where all swill not overlap AI and Manual Both".
// Until now the two callers were blind to each other: the AI keeps its live calls in `sessions`
// (vobiz_bridge) and the manual dialler keeps its bridges in `pending` (vobiz_manual_call), and
// neither ever asked the other. Nothing stopped the robot dialling a customer at the same second a
// human did — the customer's phone rings twice, or worse, they answer the robot while a person is
// waiting on the other leg.
//
// KEYED BY THE 10-DIGIT NUMBER, NOT THE ORDER. One person can have two orders open, and ringing
// them twice at once is the same rudeness whichever order it is about. A number is the thing that
// can only be in one conversation at a time — that is the real resource, so that is the key.
//
// NOT A GLOBAL LOCK. Different customers still get called in parallel exactly as today (the logs
// show a peak of 3 concurrent AI calls over 30 days); serialising everything would slow the queue
// for no gain. One number = one call is the whole rule.
//
// IN MEMORY ON PURPOSE. A claim only has to outlive a phone call. A restart drops every claim,
// which is correct: a restart also drops every call.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// A claim can never outlive this, no matter what goes wrong. Without the ceiling one lost hangup
// webhook would block a customer from ever being called again until the next deploy — a silent,
// permanent failure, which is far worse than the double-dial it prevents.
const MAX_HOLD_MS = 10 * 60e3;

const live = new Map();          // '9167770975' → { who, label, at }
const key = (p) => String(p || '').replace(/\D/g, '').slice(-10);

function fresh(k) {
    const e = live.get(k);
    if (!e) return null;
    if (Date.now() - e.at > MAX_HOLD_MS) { live.delete(k); return null; }
    return e;
}

// Who holds this number, or null. Callers use it to explain the refusal in words a person can act
// on ("the AI agent is on a call with this customer right now") instead of a bare failure.
function holder(phone) { return fresh(key(phone)); }

// Claim one or more numbers as a set: all of them, or none. A manual call needs BOTH the customer
// and the agent's own handset, and half a claim would leak the other half forever.
// Returns { ok: true } or { ok: false, busy: '<number>', holder: {...} }.
function claim(phones, who, label) {
    const ks = [...new Set((Array.isArray(phones) ? phones : [phones]).map(key).filter(k => k.length === 10))];
    if (!ks.length) return { ok: true, keys: [] };            // nothing real to lock — never block a call over it
    for (const k of ks) { const e = fresh(k); if (e) return { ok: false, busy: k, holder: e }; }
    const at = Date.now();
    for (const k of ks) live.set(k, { who, label: label || '', at });
    return { ok: true, keys: ks };
}

// Idempotent by design: it is called from the hangup webhook AND from the session close AND from a
// sweep, because any one of the three can be the one that actually happens.
function release(phones) {
    for (const p of (Array.isArray(phones) ? phones : [phones])) { const k = key(p); if (k.length === 10) live.delete(k); }
}

function snapshot() {
    const out = [];
    for (const k of [...live.keys()]) { const e = fresh(k); if (e) out.push({ phone: k, ...e, seconds: Math.round((Date.now() - e.at) / 1000) }); }
    return out;
}

setInterval(() => { for (const k of [...live.keys()]) fresh(k); }, 60e3).unref?.();

module.exports = { claim, release, holder, snapshot, MAX_HOLD_MS };
