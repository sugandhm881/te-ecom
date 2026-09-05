// ─────────────────────────────────────────────────────────────────────────────
// MANUAL CALL — a human agent, connected to the customer through Vobiz.
//
// User, 2026-09-05: "Manual Call will setup with new number on Vobiz and that number will use
// traditional call method — like when we click Manual Call, dialler will show on dashboard and our
// human agent will talk with customer."
//
// HOW IT WORKS. Nothing here speaks: it is click-to-call, the pattern Vobiz documents for exactly
// this. Vobiz rings the AGENT first, and only when the agent picks up does the answer webhook return
// <Dial><Number>customer</Number></Dial>, which bridges the two legs. Both people are on ordinary
// handsets — no browser audio, no WebRTC, nothing to install — and the agent is never made to wait
// listening to a customer's phone ring.
//
// RINGING THE AGENT FIRST IS THE SAFETY PROPERTY, not just a convenience: if the agent does not
// answer, the customer's phone never rings at all. Dialling the customer first and hoping someone
// is free is how a customer picks up to silence.
//
// SEPARATE FROM THE AI BRIDGE ON PURPOSE. vobiz_bridge.js owns the media socket, the STT/TTS
// pipeline and the prompt — none of which applies here — so this lives in its own file with its own
// answer webhook. The only thing shared is the Vobiz account and the call log both write to.
//
// ITS OWN CALLER ID. VOBIZ_MANUAL_FROM_NUMBER lets manual calls show a different number from the AI
// ones, which is what the user asked for; it falls back to the main number so the feature works
// before a second number is provisioned.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { supabase } = require('../supabase');
const callRegistry = require('./call_registry');   // one number = one call, AI or human

const V_AUTH_ID = () => String(process.env.VOBIZ_AUTH_ID || '').trim();
const V_AUTH_TOKEN = () => String(process.env.VOBIZ_AUTH_TOKEN || '').trim();
const V_BASE = () => String(process.env.VOBIZ_PUBLIC_BASE || '').trim().replace(/\/$/, '');
const V_TOKEN = () => String(process.env.VOBIZ_WEBHOOK_TOKEN || '').trim();
// The manual line, when one exists. Falls back to the AI number so this works on day one.
const V_FROM = () => String(process.env.VOBIZ_MANUAL_FROM_NUMBER || process.env.VOBIZ_FROM_NUMBER || '').replace(/\D/g, '');
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// Pending bridges, keyed by the id in the answer URL. In memory because a bridge only has to survive
// the seconds between the agent's phone ringing and their answering — a server restart mid-ring
// means the call was lost anyway, and nothing durable is owed.
const pending = new Map();
setInterval(() => {                       // never let a stale entry leak
    const cut = Date.now() - 10 * 60e3;
    for (const [k, v] of pending) if (v.at < cut) pending.delete(k);
}, 60e3).unref?.();

async function customerPhoneFor(orderName) {
    const clean = String(orderName || '').replace('#', '').trim();
    if (!clean) return null;
    const { data: o } = await supabase.from('orders').select('id, phone')
        .or(`name.eq.${clean},name.eq.#${clean}`).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!o) return null;
    // The number customers actually give lives on the shipping address; orders.phone is often empty
    // (TE25-44254 proved it). Address wins, orders is the fallback — same rule as the AI caller.
    const { data: a } = await supabase.from('order_shipping_addresses').select('phone').eq('order_id', o.id).maybeSingle();
    return last10((a && a.phone) || o.phone || '');
}

// POST /api/vobiz/manual-call  { order_name, agent_phone? }
// Permission-gated by server.js exactly like the AI dial routes — placing a real call is its own right.
router.post('/vobiz/manual-call', async (req, res) => {
    try {
        if (!V_AUTH_ID() || !V_AUTH_TOKEN() || !V_FROM() || !V_BASE() || !V_TOKEN())
            return res.status(400).json({ success: false, error: 'Vobiz is not configured for manual calls' });
        const b = req.body || {};
        const orderName = String(b.order_name || '').replace('#', '').trim();
        if (!orderName) return res.status(400).json({ success: false, error: 'order_name is required' });

        const customer = await customerPhoneFor(orderName);
        if (!customer || customer.length !== 10) return res.status(404).json({ success: false, error: 'no customer phone on this order' });

        // The agent's own handset: what they typed in the dialler, else the number on their profile.
        let agent = last10(b.agent_phone || '');
        // The JWT carries the address on `sub` (see auth_routes /me), not `email` — reading the
        // wrong claim logged "(unknown user)" and attributed the call to "agent" rather than a person.
        const email = (req.user && (req.user.sub || req.user.email)) || '';
        if (!agent && email) {
            const { data: u } = await supabase.from('app_users_ecom').select('mobile').eq('email', email).maybeSingle();
            agent = last10(u && u.mobile);
        }
        if (!agent || agent.length !== 10)
            return res.status(400).json({ success: false, error: 'your own phone number is needed — enter it in the dialler, or save a mobile on your profile' });
        if (agent === customer) return res.status(400).json({ success: false, error: 'that is the customer\'s own number' });

        // NO OVERLAP (user, 2026-09-05). Both numbers or neither: a half claim would leak the other
        // half for ten minutes. The refusal says WHO holds the line, because "call failed" tells the
        // person at the dashboard nothing they can act on.
        const lock = callRegistry.claim([customer, agent], 'manual', `${orderName} by ${email || 'agent'}`);
        if (!lock.ok) {
            const mine = lock.busy === agent;
            const h = lock.holder || {};
            return res.status(409).json({ success: false, error: mine
                ? 'your own phone is already on a call — hang up and try again'
                : (h.who === 'ai'
                    ? 'the AI agent is on a call with this customer right now — try again in a minute'
                    : `another agent is already on a call with this customer (${h.label || 'manual call'})`) });
        }
        const id = crypto.randomBytes(8).toString('hex');
        pending.set(id, { at: Date.now(), customer, agent, orderName, email });

        const r = await axios.post(`https://api.vobiz.ai/api/v1/Account/${V_AUTH_ID()}/Call/`, {
            from: V_FROM(), to: '91' + agent,          // the AGENT's phone rings first
            answer_url: `${V_BASE()}/api/vobiz/manual-answer?token=${V_TOKEN()}&id=${id}`, answer_method: 'POST',
            hangup_url: `${V_BASE()}/api/vobiz/manual-hangup?token=${V_TOKEN()}&id=${id}`,
            ring_timeout: 45,
        }, { headers: { 'X-Auth-ID': V_AUTH_ID(), 'X-Auth-Token': V_AUTH_TOKEN(), 'Content-Type': 'application/json' },
             timeout: 20000, validateStatus: () => true });
        if (r.status >= 300) { pending.delete(id); callRegistry.release([customer, agent]);   // the call never happened
            return res.status(502).json({ success: false, error: `Vobiz ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` }); }

        const p = pending.get(id); if (p && r.data) p.uuid = r.data.request_uuid || r.data.call_uuid || null;
        console.log(`[ManualCall] ${orderName}: ringing agent ${agent} → will bridge to ${customer} (${email || 'unknown user'})`);
        res.json({ success: true, id, agent, customer, vobiz: r.data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// The agent picked up. Bridge them to the customer.
// PUBLIC PATH (Vobiz calls it), so the webhook token is the only thing that makes it act.
router.all('/vobiz/manual-answer', (req, res) => {
    const q = req.query || {};
    const xml = (body) => res.set('Content-Type', 'application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`);
    if (q.token !== V_TOKEN()) return xml('<Hangup/>');
    const p = pending.get(String(q.id || ''));
    if (!p) return xml('<Hangup/>');            // expired or already used — never dial blind
    console.log(`[ManualCall] ${p.orderName}: agent answered, bridging to ${p.customer}`);
    p.bridgedAt = Date.now();
    // RECORD IT, exactly as the AI calls are recorded (user, 2026-09-05: "recording not come of this
    // manual call"). The live Record API rather than an XML <Record> verb: the verb was tried on the
    // AI path and captured only one leg while also slowing call setup, and here it would sit in front
    // of the Dial that the customer is waiting on. Fired after the XML is on its way, never before.
    startManualRecording(p);
    // callerId is the manual line, so the customer sees a consistent number rather than the agent's
    // personal one. The Dial verb bridges the legs and reports back when either side hangs up.
    xml(`<Dial callerId="${V_FROM()}" timeout="45"><Number>91${p.customer}</Number></Dial>`);
});

// time_limit: the Record API defaults to 60 seconds, which silently truncated every AI recording at
// 00:59 until it was found. 3600 covers any real support call.
async function startManualRecording(p) {
    if (String(process.env.VOBIZ_RECORD || 'true') === 'false' || !p.uuid) return;
    try {
        const r = await axios.post(`https://api.vobiz.ai/api/v1/Account/${V_AUTH_ID()}/Call/${p.uuid}/Record/`,
            { file_format: 'mp3', time_limit: 3600 },
            { headers: { 'X-Auth-ID': V_AUTH_ID(), 'X-Auth-Token': V_AUTH_TOKEN(), 'Content-Type': 'application/json' },
              timeout: 10000, validateStatus: () => true });
        if (r.data) p.recordingUrl = r.data.recording_url || r.data.url || null;
        console.log(`[ManualCall] ${p.orderName}: record API ${r.status}${p.recordingUrl ? ' — url stored' : ''}`);
    } catch (e) { console.log(`[ManualCall] ${p.orderName}: record API failed: ${e.message}`); }
}

// Either side hung up. Log it the same way an AI call is logged, so one order's history is one list
// and the Called column / ℹ️ popover pick it up with no special-casing.
router.all('/vobiz/manual-hangup', async (req, res) => {
    res.status(200).end();                       // never make Vobiz wait on our bookkeeping
    try {
        const q = req.query || {};
        if (q.token !== V_TOKEN()) return;
        const p = pending.get(String(q.id || ''));
        if (!p) return;
        // NOT deleted here any more: the dialler polls this record to show the call ending instead of
        // sitting on "Calling…" forever (user, 2026-09-05: "call cut but showing calling"). The sweeper
        // above clears it a few minutes later, which is long past anyone still watching the dialog.
        p.endedAt = Date.now();
        callRegistry.release([p.customer, p.agent]);   // both numbers free the moment the bridge ends
        const secs = p.bridgedAt ? Math.round((Date.now() - p.bridgedAt) / 1000) : 0;
        // "manual human call by <email>" is what classifies this as `manual` in the queue's call-type
        // filter — the same string the support console greps for.
        const summary = p.bridgedAt
            ? `OUTCOME: manual human call — spoke with the customer.\n${secs}s call to ${p.customer} · manual human call by ${p.email || 'agent'}`
            : `OUTCOME: manual human call not connected — the agent did not answer.\n0s call to ${p.customer} · manual human call by ${p.email || 'agent'}`;
        await supabase.from('agent_call_logs').insert({
            order_id: p.orderName, call_type: 'manual_human', language: null,
            transcript: '[manual human call — not transcribed]', summary, exchanges: 0,
            recording_url: p.recordingUrl || null,     // ▶ Play works on the row like any AI call
            called_at: new Date(p.at).toISOString(),
        });
        console.log(`[ManualCall] ${p.orderName}: ${p.bridgedAt ? secs + 's talk' : 'agent never answered'} — logged`);
    } catch (e) { console.log('[ManualCall] hangup log failed:', e.message); }
});

// GET /api/vobiz/manual-call/:id — what this bridge is doing right now, for the dialler.
// Deliberately thin: ringing → talking → ended, plus how long they spoke. Permission-gated with the
// other dial routes, and it only ever describes a bridge this server created.
router.get('/vobiz/manual-call/:id', (req, res) => {
    const p = pending.get(String(req.params.id || ''));
    if (!p) return res.json({ success: true, state: 'unknown' });
    const state = p.endedAt ? 'ended' : p.bridgedAt ? 'talking' : 'ringing';
    const secs = p.bridgedAt ? Math.round(((p.endedAt || Date.now()) - p.bridgedAt) / 1000) : 0;
    res.json({ success: true, state, seconds: secs, agent: p.agent, customer: p.customer, connected: !!p.bridgedAt });
});

module.exports = { router };
