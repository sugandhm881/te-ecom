// ─────────────────────────────────────────────────────────────────────────────
// Manual WhatsApp sends via MSG91 — template sequences, driven by DATA.
//
// THE PLAN (2026-08-26, superseding 08-24's manual-only rule): AUTOMATIC sequences are back by
// explicit plan — cod_auto (instant on order create + 30-min reminder) and ndr_auto (delivery-attempt
// driven) are sent by the system; MANUAL sequences stay as popup buttons (cod_confirmation call
// ladder; cod_hold, which exists only while the order is held). mode/gate/requires_hold live on the
// registry rows. "Next" is decided HERE from the send log, not by the browser, so two agents with
// the same popup open cannot both send V1: the UNIQUE(order,sequence,version) row is the turnstile.
//
// TEMPLATES ARE ROWS, NOT CODE (`wa_template_sequences_msg91`). Adding template V2, or an entirely new
// sequence, is an INSERT: sequence_key, version, MSG91 template name, its EXACT language code, its
// namespace, and a `variables` array naming which order fields fill body_1..body_N in order. The field
// vocabulary lives in resolveOrderFields() below — the one place to extend when a template needs a
// value no template needed before.
//
// ⚠️ LESSONS ALREADY PAID FOR, ALL ENFORCED HERE:
//   * language must match the template's registration EXACTLY — en/en_US sends were accepted with
//     status:success and never delivered (cod_confirmation_v1 is en_GB);
//   * MSG91_COD_ALLOWLIST in .env restricts every send to the named phones/orders — 41 real customers
//     were messaged during testing before this existed. CUT OVER 2026-08-27 (user: "make it happen for
//     everyone"): the var is REMOVED from .env, so every customer is messaged. Setting it again re-enters
//     test mode instantly, no deploy. Vobiz CALLS keep their own list, VOBIZ_CALL_ALLOWLIST.
//   * n8n's own cod_confirmation_v1 flow must be OFF once this is live — sentToPhoneRecently() skips our
//     send when the same template already reached the phone, but the msg91_messages mirror syncs only
//     HOURLY (IST timestamps), so it cannot catch a duplicate inside the 3-minute window;
//   * log-then-send with a unique key: a crash can lose one message, never send it twice.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../supabase');

const AUTH = () => String(process.env.MSG91_AUTHKEY || '').trim().split(/\s/)[0];
const WA_NUMBER = () => String(process.env.MSG91_WA_NUMBER || '').replace(/\D/g, '');
const configured = () => !!AUTH() && !!WA_NUMBER();
const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);

// The operator's explicit test rule: while an allowlist var is set, nobody off it can be reached.
// EMPTY / unset = open to everyone (the production state since 2026-08-27). WhatsApp reads
// MSG91_COD_ALLOWLIST; Vobiz calls read VOBIZ_CALL_ALLOWLIST — separate on purpose, so opening the
// messages did not silently open AI phone calls to every customer.
function allowlistBlocksFor(envVar) {
    return function (orderName, phone) {
        const raw = String(process.env[envVar] || '').trim();
        if (!raw) return null;
        const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
        const p10 = last10(phone), name = String(orderName || '').replace(/^#/, '');
        const ok = entries.some(e => e.replace(/^#/, '') === name || last10(e) === p10);
        return ok ? null : `not on ${envVar} (test mode)`;
    };
}
const allowlistBlocks = allowlistBlocksFor('MSG91_COD_ALLOWLIST');

// Did this phone ALREADY receive this template recently, from anyone? Checks our own send log and
// the msg91_messages mirror (every MSG91 send incl. n8n's). ⚠ The mirror's sent_at is IST wall-clock
// stored as UTC (+5:30) and it syncs only hourly, so this is a backstop for late/second sends, not a
// real-time dedupe. Window: 6 h.
async function sentToPhoneRecently(phone, templateName, hours = 6) {
    const p10 = last10(phone);
    if (p10.length !== 10 || !templateName) return null;
    const sinceUtc = new Date(Date.now() - hours * 3600e3);
    const { data: ours } = await supabase.from('wa_sends_msg91').select('id, order_name, created_at')
        .eq('phone', p10).eq('template_name', templateName).eq('status', 'sent').gte('created_at', sinceUtc.toISOString()).limit(1);
    if (ours && ours.length) return `already sent to this phone for ${ours[0].order_name} at ${ours[0].created_at}`;
    const sinceIst = new Date(sinceUtc.getTime() + 5.5 * 3600e3).toISOString();      // mirror stores IST as UTC
    const { data: mirror } = await supabase.from('msg91_messages').select('id, sent_at')
        .eq('template_name', templateName).ilike('phone', `%${p10}`).gte('sent_at', sinceIst).limit(1);
    if (mirror && mirror.length) return `already sent to this phone by another channel (msg91_messages, ${mirror[0].sent_at} IST)`;
    return null;
}

// ── The field vocabulary — everything a template's `variables` array may name ────────────────────
async function resolveOrderFields(orderName) {
    const clean = String(orderName || '').replace(/^#/, '').trim();
    const { data: o } = await supabase.from('orders')
        .select('id, name, phone, total_price, financial_status, created_at, awb_number, courier_name, tracking_status')
        .or(`name.eq.${clean},name.eq.#${clean}`).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!o) throw new Error(`order ${clean} not found`);
    const [{ data: items }, { data: addr }] = await Promise.all([
        supabase.from('order_line_items').select('title, quantity').eq('order_id', o.id),
        supabase.from('order_shipping_addresses').select('name, first_name, phone').eq('order_id', o.id).maybeSingle(),
    ]);
    const li = (items || []).filter(i => i && i.title);
    const product = !li.length ? 'your order'
        : li.length === 1 ? `${li[0].title}${Number(li[0].quantity) > 1 ? ` x${li[0].quantity}` : ''}`
        : `${li[0].title}${Number(li[0].quantity) > 1 ? ` x${li[0].quantity}` : ''} + ${li.length - 1} more`;
    const firstName = String((addr && (addr.first_name || String(addr.name || '').split(' ')[0])) || '').trim();
    // orders.phone is often empty — the number customers actually give lives on the shipping address
    // (TE25-44254 proved it: orders.phone null, address phone real). Address wins, orders is fallback.
    const bestPhone = (addr && addr.phone) || o.phone || '';
    return {
        order: Object.assign({}, o, { phone: bestPhone }),
        fields: {
            customer_name: firstName || 'there',
            product,
            order_name: clean,
            amount: String(Math.round(Number(o.total_price) || 0)),
            phone: last10(bestPhone),
            awb: o.awb_number || '',
            courier: o.courier_name || '',
            tracking_status: o.tracking_status || '',
        },
    };
}

async function callMsg91Template(tpl, fields, phone) {
    // ⚠ WhatsApp accepts a send whose variable count differs from the registered template's
    // placeholders — and then silently never delivers it (cod_order_cancelled_unconfirmed_v1 had
    // 3 placeholders, we sent 4, the customer got nothing). Fail LOUDLY instead.
    const phMax = Math.max(0, ...[...String(tpl.body_text || '').matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])));
    if (tpl.body_text && phMax !== (tpl.variables || []).length) {
        throw new Error(`template ${tpl.template_name}: body has ${phMax} placeholders but registry maps ${(tpl.variables || []).length} variables — fix the registry row`);
    }
    const components = {};
    (tpl.variables || []).forEach((key, i) => {
        components[`body_${i + 1}`] = { type: 'text', value: String(fields[key] != null ? fields[key] : '') };
    });
    const template = {
        name: tpl.template_name,
        language: { code: tpl.language, policy: 'deterministic' },
        to_and_components: [{ to: ['91' + last10(phone)], components }],
    };
    if (tpl.namespace) template.namespace = tpl.namespace;
    const r = await axios.post('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
        { integrated_number: WA_NUMBER(), content_type: 'template', payload: { messaging_product: 'whatsapp', type: 'template', template } },
        { headers: { authkey: AUTH(), 'Content-Type': 'application/json' }, timeout: 20000, validateStatus: () => true });
    if (r.status >= 400) throw new Error(`MSG91 ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    return r.data;
}

// Render the template body with the order's real values — what the agent APPROVES before it sends.
// {{1}}..{{N}} map to the variables array positions, the same mapping the send itself uses, so the
// preview and the delivered message cannot disagree.
function renderPreview(tpl, fields) {
    const body = String(tpl.body_text || '');
    if (!body) return null;                           // template row has no body pasted — preview unavailable
    return body.replace(/\{\{(\d+)\}\}/g, (_, n) => {
        const key = (tpl.variables || [])[Number(n) - 1];
        return key != null && fields[key] != null ? String(fields[key]) : '{{' + n + '}}';
    });
}

// ── The escalation gate ──
// V1 is free. Every LATER version unlocks only after the team has TRIED AGAIN and failed: a call log
// with a no-contact outcome, made AFTER the previous version went out. That is the operator's flow
// stated verbatim — “we call, they did not pick → V1; call again, still no response → V2; third time
// → V3” — and encoding it server-side means the button cannot be rushed through the sequence.
const NO_CONTACT_OUTCOMES = ['no_answer'];
async function nextAvailable(orderId, orderName, sequenceKey) {
    const [{ data: tpls, error: te }, { data: sends }, { data: calls }] = await Promise.all([
        supabase.from('wa_template_sequences_msg91').select('*').eq('sequence_key', sequenceKey).eq('active', true).order('version'),
        supabase.from('wa_sends_msg91').select('version, status, created_at').eq('order_name', orderName).eq('sequence_key', sequenceKey),
        supabase.from('call_logs').select('outcome, called_at').eq('order_id', String(orderId)).in('outcome', NO_CONTACT_OUTCOMES),
    ]);
    if (te) throw new Error(te.message);
    const okSends = (sends || []).filter(s => !['failed', 'skipped'].includes(s.status));   // a skipped row is not a send
    const done = new Map(okSends.map(s => [s.version, s]));
    const tpl = (tpls || []).find(t => !done.has(t.version));
    if (!tpl) return { tpl: null, locked: null, tpls: tpls || [], done };
    if (tpl.version > 1 && (tpl.gate || 'call') !== 'seq') {
        const prev = done.get(tpl.version - 1);
        const prevAt = prev ? new Date(prev.created_at).getTime() : 0;
        const tried = (calls || []).some(cl => new Date(cl.called_at).getTime() > prevAt);
        if (!tried) return { tpl: null, locked: { version: tpl.version, reason: `V${tpl.version} unlocks after a no-answer call logged since V${tpl.version - 1} was sent` }, tpls: tpls || [], done };
    }
    return { tpl, locked: null, tpls: tpls || [], done };
}

// ── GET /support/wa/preview// ── GET /support/wa/preview?order=..&sequence=.. — the next version, rendered, WITHOUT sending ──
router.get('/support/wa/preview', async (req, res) => {
    try {
        const orderName = String(req.query.order || '').replace(/^#/, '').trim();
        const sequenceKey = String(req.query.sequence || '').trim();
        if (!orderName || !sequenceKey) return res.status(400).json({ success: false, error: 'order and sequence are required' });
        const { fields, order } = await resolveOrderFields(orderName);
        const { tpl, locked } = await nextAvailable(order.id, orderName, sequenceKey);
        if (locked) return res.status(423).json({ success: false, error: locked.reason });
        if (!tpl) return res.status(409).json({ success: false, error: 'sequence complete' });
        res.json({ success: true, version: tpl.version, template_name: tpl.template_name,
            phone: fields.phone, preview: renderPreview(tpl, fields),
            blocked: allowlistBlocks(orderName, order.phone) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /support/wa/state?order=TE25-xxxxx — what the popup's button(s) should show ──────────────
// Per sequence: every version with its sent-state, and which version is NEXT (null = sequence done).
router.get('/support/wa/state', async (req, res) => {
    try {
        const orderName = String(req.query.order || '').replace(/^#/, '').trim();
        if (!orderName) return res.status(400).json({ success: false, error: 'order is required' });
        const [{ data: tpls, error: te }, { data: sends, error: se }] = await Promise.all([
            supabase.from('wa_template_sequences_msg91').select('*').eq('active', true)
                .order('sequence_key').order('version'),
            supabase.from('wa_sends_msg91').select('sequence_key, version, status, created_at, sent_by, payload')
                .eq('order_name', orderName),
        ]);
        if (te) throw new Error(te.message);
        if (se) throw new Error(se.message);
        const sent = new Map((sends || []).filter(s => !['failed', 'skipped'].includes(s.status))
            .map(s => [`${s.sequence_key}|${s.version}`, s]));
        const seqs = {};
        (tpls || []).forEach(t => {
            const s = seqs[t.sequence_key] || (seqs[t.sequence_key] = { sequence_key: t.sequence_key, label: t.label, versions: [], next: null, mode: t.mode || 'manual', gate: t.gate || 'call', requires_hold: !!t.requires_hold });
            const done = sent.get(`${t.sequence_key}|${t.version}`) || null;
            // The chip is CLICKABLE: it shows the exact message that went out, rendered from the
            // fields stored AT SEND TIME — not today's values, which may have drifted since.
            const sentText = done && done.payload && done.payload.fields ? renderPreview(t, done.payload.fields) : null;
            s.versions.push({ version: t.version, template_name: t.template_name, sent_at: done ? done.created_at : null, sent_by: done ? done.sent_by : null, sent_text: sentText });
        });
        // Locks are computed per sequence: a later version opens only after a no-answer call logged
        // since the previous send. One shared call_logs read covers every sequence.
        const { data: ordRow } = await supabase.from('orders').select('id')
            .or(`name.eq.${orderName},name.eq.#${orderName}`).order('created_at', { ascending: false }).limit(1).maybeSingle();
        const { data: calls } = ordRow ? await supabase.from('call_logs')
            .select('outcome, called_at').eq('order_id', String(ordRow.id)).in('outcome', NO_CONTACT_OUTCOMES) : { data: [] };
        Object.values(seqs).forEach(s => {
            const pending = s.versions.filter(v => !v.sent_at);
            const cand = pending.length ? pending[0] : null;
            s.next = null; s.locked = null;
            if (!cand) return;                                     // every configured version sent
            if (cand.version === 1) { s.next = 1; return; }
            if (s.gate === 'seq') { s.next = cand.version; return; }   // sequential: prev sent → next open
            const prev = s.versions.find(v => v.version === cand.version - 1);
            const prevAt = prev && prev.sent_at ? new Date(prev.sent_at).getTime() : 0;
            const tried = (calls || []).some(cl => new Date(cl.called_at).getTime() > prevAt);
            if (tried) s.next = cand.version;
            else s.locked = { version: cand.version, reason: 'log a no-answer call to unlock V' + cand.version };
        });
        // Hold-gated sequences (cod_hold): buttons exist only while the order is HELD on Shopify.
        const seqList = Object.values(seqs);
        if (seqList.some(s => s.requires_hold)) {
            try {
                const holds = await require('./shopify_hold').getHoldStates([orderName]);
                const h = holds[orderName] || holds['#' + orderName] || null;
                const held = !!(h && h.status === 'held');
                seqList.forEach(s => { if (s.requires_hold && !held) s.hidden = true; });
            } catch (e) { seqList.forEach(s => { if (s.requires_hold) s.hidden = true; }); }
        }
        res.json({ success: true, configured: configured(), sequences: seqList });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /support/wa/send { order_name, sequence_key } — send the NEXT version ───────────────────
router.post('/support/wa/send', express.json(), async (req, res) => {
    try {
        if (!configured()) return res.status(400).json({ success: false, error: 'MSG91 is not configured on this server (MSG91_AUTHKEY / MSG91_WA_NUMBER).' });
        const orderName = String((req.body || {}).order_name || '').replace(/^#/, '').trim();
        const sequenceKey = String((req.body || {}).sequence_key || '').trim();
        if (!orderName || !sequenceKey) return res.status(400).json({ success: false, error: 'order_name and sequence_key are required' });

        const { fields, order } = await resolveOrderFields(orderName);
        const gate = allowlistBlocks(orderName, order.phone);
        if (gate) return res.status(403).json({ success: false, error: gate });
        if (last10(order.phone).length !== 10) return res.status(400).json({ success: false, error: 'order has no usable phone' });

        const { tpl, locked, tpls, done } = await nextAvailable(order.id, orderName, sequenceKey);
        if (locked) return res.status(423).json({ success: false, error: locked.reason });
        if (!tpl) return res.status(409).json({ success: false, error: 'sequence complete — every version already sent' });
        if ((tpl.mode || 'manual') === 'auto') return res.status(403).json({ success: false, error: 'this sequence is sent automatically by the system' });
        if (tpl.requires_hold) {
            const holds = await require('./shopify_hold').getHoldStates([orderName]).catch(() => ({}));
            const h = holds[orderName] || holds['#' + orderName] || null;
            if (!(h && h.status === 'held')) return res.status(403).json({ success: false, error: 'this message is only for orders currently held on Shopify' });
        }

        // Log-then-send; the unique key is the two-agents-one-popup turnstile.
        const ins = await supabase.from('wa_sends_msg91').insert({
            order_name: orderName, sequence_key: sequenceKey, version: tpl.version,
            template_name: tpl.template_name, phone: last10(order.phone),
            payload: { fields, variables: tpl.variables }, sent_by: (req.user && req.user.sub) || null,
        }).select('id').single();
        if (ins.error) {
            if (String(ins.error.code) === '23505') return res.status(409).json({ success: false, error: `V${tpl.version} was just sent by someone else` });
            throw new Error(ins.error.message);
        }
        try {
            const resp = await callMsg91Template(tpl, fields, order.phone);
            await supabase.from('wa_sends_msg91').update({ status: 'sent', response: resp }).eq('id', ins.data.id);
            console.log(`[WA] ${orderName} ${sequenceKey} V${tpl.version} → ${last10(order.phone)} (by ${(req.user && req.user.sub) || '?'})`);
            const remaining = tpls.filter(t => !done.has(t.version) && t.version !== tpl.version);
            res.json({ success: true, sent: tpl.version, next: remaining.length ? remaining[0].version : null });
        } catch (e) {
            // A failed call frees the slot so the button can retry the SAME version.
            await supabase.from('wa_sends_msg91').update({ status: 'failed', response: { error: e.message } }).eq('id', ins.data.id);
            res.status(502).json({ success: false, error: e.message });
        }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── AUTOMATIC SENDS (2026-08-26 plan) — every send logs to wa_sends_msg91, the UNIQUE
// (order, sequence, version) row is the double-send turnstile, and MSG91_COD_ALLOWLIST gates
// EVERYTHING until cut-over ("use the same till test is done").
//   cod_auto  V1 cod_confirmation_v1      — 3 MINUTES after Shopify orders/create (COD only; user spec
//                                           2026-08-27, replacing the instant cod_confirmation_v2). The
//                                           delay is an in-process timer armed by the webhook, with
//                                           codInitialTick (*/5 cron) as the restart-safe backstop.
//   cod_auto  V2 cod_confirm_reminder_v1  — 30 min after V1 if NO reply (CONFIRM or REJECT both count)
//   ndr_auto  V1 ndr_msg                  — 1st failed delivery attempt (shipment_journey_ecom)
//   ndr_auto  V2 ndr_final_attempt_v1     — 2nd failed attempt
//   ndr_auto  V3 order_rto_v1             — RTO initiated
// ⚠ SEEDING (the 41-customer lesson): on the NDR engine's first ever run, everything ALREADY in a
// trigger state is sealed as 'seeded' — history is never messaged; only new transitions send.
async function performAutoSend(orderName, sequenceKey, version, extraFields) {
    if (!configured()) return { skip: 'MSG91 not configured' };
    const { fields, order } = await resolveOrderFields(orderName);
    Object.assign(fields, extraFields || {});
    const gate = allowlistBlocks(orderName, order.phone);
    if (gate) return { skip: gate };
    if (last10(order.phone).length !== 10) return { skip: 'no usable phone' };
    const { data: tpl } = await supabase.from('wa_template_sequences_msg91').select('*')
        .eq('sequence_key', sequenceKey).eq('version', version).eq('active', true).maybeSingle();
    if (!tpl) return { skip: `no active template for ${sequenceKey} v${version}` };
    // Turnstile check BEFORE the insert (2026-08-30). The UNIQUE (order_name, sequence_key, version)
    // key is still the guarantee against a double send, but relying on its 23505 rejection as the
    // normal "already done" path meant every sweep re-inserted every settled row — ~1,500 guaranteed
    // failures per NDR tick, 88k Postgres errors in a week. One cheap read here keeps the log quiet;
    // the 23505 branch below now only fires for a true race between two paths.
    const { data: done } = await supabase.from('wa_sends_msg91').select('id')
        .eq('order_name', orderName).eq('sequence_key', sequenceKey).eq('version', version).limit(1);
    if (done && done.length) return { skip: 'already sent/sealed' };
    // Same template already delivered to this phone (our log or the MSG91 mirror, e.g. n8n) → record
    // a 'skipped' row so the turnstile stops every later path from retrying, and send nothing.
    const dup = await sentToPhoneRecently(order.phone, tpl.template_name);
    if (dup) {
        await supabase.from('wa_sends_msg91').insert({
            order_name: orderName, sequence_key: sequenceKey, version, template_name: tpl.template_name,
            phone: last10(order.phone), status: 'skipped', payload: { fields, auto: true, skipped: dup }, sent_by: 'auto',
            response: { skipped: dup },
        }).then(() => {}).catch(() => {});
        return { skip: dup };
    }
    const ins = await supabase.from('wa_sends_msg91').insert({
        order_name: orderName, sequence_key: sequenceKey, version,
        template_name: tpl.template_name, phone: last10(order.phone),
        payload: { fields, variables: tpl.variables, auto: true }, sent_by: 'auto',
    }).select('id').single();
    if (ins.error) {
        if (String(ins.error.code) === '23505') return { skip: 'already sent/sealed' };
        throw new Error(ins.error.message);
    }
    try {
        const resp = await callMsg91Template(tpl, fields, order.phone);
        await supabase.from('wa_sends_msg91').update({ status: 'sent', response: resp }).eq('id', ins.data.id);
        console.log(`[WA auto] ${orderName} ${sequenceKey} V${version} → ${last10(order.phone)}`);
        return { sent: true };
    } catch (e) {
        await supabase.from('wa_sends_msg91').update({ status: 'failed', response: { error: e.message } }).eq('id', ins.data.id);
        return { skip: 'send failed: ' + e.message };
    }
}

// Shopify orders/create → COD confirmation V1, THREE MINUTES later (user spec 2026-08-27; it was
// instant before). The wait is deliberate: an order cancelled or edited seconds after checkout must
// not be confirmed, and the `orders` mirror has settled by then. The timer is in-process, so a pm2
// restart inside those three minutes would lose it — codInitialTick() below is the backstop that
// picks such orders up from the `orders` table. Both land on the same UNIQUE turnstile row, so the
// two paths can never double-send.
const COD_V1_DELAY_MS = 3 * 60e3;
const _codTimers = new Map();                                       // orderName → timeout (diagnostic only)
function codV1Eligible(o, orderName) {
    if (!orderName) return 'no order name';
    if (String(o.financial_status) !== 'pending') return `not COD (financial_status=${o.financial_status || 'none'})`;
    if (o.test) return 'test order';
    if (o.cancelled_at) return 'already cancelled';
    return null;
}
async function sendCodV1(orderName, via) {
    _codTimers.delete(orderName);
    try {
        // Re-read the order at send time: a cancellation in the last three minutes wins.
        const { data: live } = await supabase.from('orders').select('cancelled_at, financial_status')
            .or(`name.eq.${orderName},name.eq.#${orderName}`).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (live && live.cancelled_at) return console.log(`[WA auto] ${orderName}: cancelled before the 3-minute mark — no confirm message`);
        if (live && live.financial_status && live.financial_status !== 'pending') return console.log(`[WA auto] ${orderName}: paid before the 3-minute mark — no confirm message`);
        const r = await performAutoSend(orderName, 'cod_auto', 1);
        if (r.skip) console.log(`[WA auto] ${orderName}: cod_auto V1 skipped (${via}) — ${r.skip}`);
        else console.log(`[WA auto] ${orderName}: cod_auto V1 sent (${via})`);
    } catch (e) { console.error(`[WA auto] ${orderName}: cod_auto V1 failed (${via}):`, e.message); }
}
async function autoCodOnCreate(o, { delayMs = COD_V1_DELAY_MS } = {}) {
    const orderName = String((o && o.name) || '').replace(/^#/, '').trim();
    const why = codV1Eligible(o || {}, orderName);
    if (why) return console.log(`[WA auto] ${orderName || '?'}: ${why} — no confirm message`);
    if (_codTimers.has(orderName)) return;                          // webhook retry — one timer per order
    const t = setTimeout(() => sendCodV1(orderName, 'timer'), delayMs);
    if (t.unref) t.unref();
    _codTimers.set(orderName, t);
    console.log(`[WA auto] ${orderName}: COD confirm V1 scheduled in ${Math.round(delayMs / 60e3)} min`);
}

// Every 5 min (same cron as the reminder): COD orders created 3–60 min ago with NO cod_auto V1 row —
// the ones whose in-process timer died with a restart, or whose webhook never arrived. The 60-min
// ceiling is the age seal (history is never messaged); the allowlist and the turnstile still gate
// every send exactly as for the timer path.
async function codInitialTick() {
    const from = new Date(Date.now() - 60 * 60e3).toISOString();
    const to = new Date(Date.now() - COD_V1_DELAY_MS).toISOString();
    const { data: orders } = await supabase.from('orders').select('name, created_at')
        .eq('financial_status', 'pending').is('cancelled_at', null).neq('test', true)
        .gte('created_at', from).lte('created_at', to).order('created_at').limit(100);
    let sent = 0;
    for (const o of (orders || [])) {
        const orderName = String(o.name || '').replace(/^#/, '').trim();
        if (!orderName || _codTimers.has(orderName)) continue;      // timer still pending → leave it
        const { data: v1 } = await supabase.from('wa_sends_msg91').select('id')
            .eq('order_name', orderName).eq('sequence_key', 'cod_auto').eq('version', 1).limit(1);
        if (v1 && v1.length) continue;
        await sendCodV1(orderName, 'backstop');
        sent++; await new Promise(rs => setTimeout(rs, 1200));
    }
    if (sent) console.log(`[WA auto] COD V1 backstop tick: ${sent} processed`);
}

// Every 5 min: V1 sent 30min–6h ago, no reply of ANY kind, no V2 yet → reminder. The 6h ceiling is
// the age seal: anything older is history and history is never messaged.
async function codReminderTick() {
    const from = new Date(Date.now() - 6 * 3600e3).toISOString();
    const to = new Date(Date.now() - 30 * 60e3).toISOString();
    const { data: v1s } = await supabase.from('wa_sends_msg91')
        .select('order_name, phone, created_at')
        .eq('sequence_key', 'cod_auto').eq('version', 1).eq('status', 'sent')
        .gte('created_at', from).lte('created_at', to).order('created_at').limit(100);
    let sent = 0;
    for (const row of (v1s || [])) {
        const { data: v2 } = await supabase.from('wa_sends_msg91').select('id')
            .eq('order_name', row.order_name).eq('sequence_key', 'cod_auto').eq('version', 2).limit(1);
        if (v2 && v2.length) continue;
        // The reply must be NEWER than the V1 send — an old reply about a previous order from the
        // same phone must not silence reminders for a new order forever.
        const { data: reply } = await supabase.from('cod_confirmations_msg91').select('id_key')
            .or(`id_key.eq.${row.order_name},data->>Shipping Phone Number.eq.${row.phone}`)
            .gte('updated_at', row.created_at).limit(1);
        if (reply && reply.length) continue;                       // they replied — no reminder
        const r = await performAutoSend(row.order_name, 'cod_auto', 2);
        if (r.sent) { sent++; await new Promise(rs => setTimeout(rs, 1200)); }
    }
    if (sent) console.log(`[WA auto] reminder tick: ${sent} sent`);
}

// NDR triggers from shipment_journey_ecom.
function ndrTargets(row) {
    const t = [];
    if ((row.ndr_count || 0) >= 1) t.push(1);
    if ((row.ndr_count || 0) >= 2) t.push(2);
    if (row.outcome === 'rto' || row.rto_at || /^RTO/i.test(String(row.status_code || ''))) t.push(3);
    return t;
}
function ndrReason(row) {
    const list = Array.isArray(row.ndr_reasons) ? row.ndr_reasons : [];
    const last = [...list].reverse().find(x => x && !/reattempt|instruction|created|client/i.test(String(x)));
    return String(last || 'Delivery could not be completed').slice(0, 120);
}
async function ndrJourneys(sinceDays, freshHours) {
    const cutOrder = new Date(Date.now() - sinceDays * 86400e3).toISOString();
    let q = supabase.from('shipment_journey_ecom')
        .select('order_name, ndr_count, ndr_reasons, outcome, status_code, rto_at')
        .gte('order_date', cutOrder).neq('outcome', 'delivered')
        .or('ndr_count.gte.1,outcome.eq.rto')
        .order('updated_at', { ascending: false }).limit(500);
    if (freshHours) q = q.gte('updated_at', new Date(Date.now() - freshHours * 3600e3).toISOString());
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
}
async function ndrSeed() {
    const rows = await ndrJourneys(90, 0);
    const seeds = [];
    rows.forEach(row => ndrTargets(row).forEach(v => seeds.push({
        order_name: row.order_name, sequence_key: 'ndr_auto', version: v,
        template_name: 'seed', phone: '', status: 'seeded', payload: { seeded: true }, sent_by: 'seed',
    })));
    for (let i = 0; i < seeds.length; i += 500) {
        await supabase.from('wa_sends_msg91').upsert(seeds.slice(i, i + 500), { onConflict: 'order_name,sequence_key,version', ignoreDuplicates: true });
    }
    console.log(`[WA auto] NDR bootstrap: sealed ${seeds.length} pre-existing trigger states — history is never messaged`);
}
async function ndrTick() {
    const { count } = await supabase.from('wa_sends_msg91').select('*', { count: 'exact', head: true }).eq('sequence_key', 'ndr_auto');
    if (!count) await ndrSeed();                                    // first ever run → seal the backlog
    const rows = await ndrJourneys(30, 48);
    // One read for the whole batch: every (order, version) already logged — sent, failed, skipped or
    // seeded — is skipped in memory, so a tick where nothing changed makes zero writes.
    const settled = new Set();
    const names = [...new Set(rows.map(r => r.order_name).filter(Boolean))];
    for (let i = 0; i < names.length; i += 200) {
        const { data } = await supabase.from('wa_sends_msg91').select('order_name, version')
            .eq('sequence_key', 'ndr_auto').in('order_name', names.slice(i, i + 200));
        (data || []).forEach(r => settled.add(r.order_name + '|' + r.version));
    }
    let sent = 0;
    for (const row of rows) {
        if (sent >= 25) break;                                      // per-tick blast cap
        for (const v of ndrTargets(row)) {
            if (settled.has(row.order_name + '|' + v)) continue;
            const extra = v === 3 ? {} : { ndr_reason: ndrReason(row) };
            const r = await performAutoSend(row.order_name, 'ndr_auto', v, extra);
            if (r.sent) { sent++; await new Promise(rs => setTimeout(rs, 1200)); }
        }
    }
    if (sent) console.log(`[WA auto] NDR tick: ${sent} sent`);
}

// ── Rejection pinning — a REJECT the webhook could not tie to an order gets tied here ─────────
// MSG91's button-reply payload sometimes carries no order number, so the webhook stores the CANCEL
// as id_key 'PHONE:<10 digits>' — an unmatched stub in the Rejected tab, invisible to every
// order-keyed check, and the parcel ships anyway (TE25-45549, 2026-08-30: REJECT 10:54, shipped
// 14:03). Every 5 min: match recent phone-only CANCELs to that phone's newest still-pending COD
// order (unfulfilled, un-cancelled, ≤7 days old) and rewrite id_key to the order name, keeping the
// original key in data. By explicit instruction rejections take NO automatic action — this changes
// WHERE the rejection shows (with its order, order-keyed checks see it), never what is done about it.
async function rejectionPinTick() {
    const cut = new Date(Date.now() - 48 * 3600e3).toISOString();
    const { data: stubs } = await supabase.from('cod_confirmations_msg91')
        .select('id_key, data, updated_at').like('id_key', 'PHONE:%')
        .eq('data->>Confirmation received', 'CANCEL').gte('updated_at', cut).limit(100);
    let pinned = 0;
    for (const row of (stubs || [])) {
        const p10 = last10(String(row.id_key).slice(6));
        if (p10.length !== 10) continue;
        const from = new Date(Date.now() - 7 * 86400e3).toISOString();
        const { data: orders } = await supabase.from('orders')
            .select('name, created_at').eq('financial_status', 'pending').is('cancelled_at', null)
            .neq('test', true).is('fulfillment_status', null).gte('created_at', from)
            .or(`phone.ilike.%${p10},phone.eq.${p10}`)
            .order('created_at', { ascending: false }).limit(2);
        if (!orders || orders.length !== 1) continue;               // none or ambiguous — leave the stub
        const orderName = String(orders[0].name || '').replace(/^#/, '').trim();
        if (!orderName) continue;
        const { data: existing } = await supabase.from('cod_confirmations_msg91')
            .select('id_key').eq('id_key', orderName).limit(1);
        if (existing && existing.length) continue;                  // order already has its own reply row
        const newData = { ...(row.data || {}), 'Order Number': orderName, original_id_key: row.id_key, pinned_by: 'rejectionPinTick' };
        const { error } = await supabase.from('cod_confirmations_msg91')
            .update({ id_key: orderName, data: newData }).eq('id_key', row.id_key);
        if (!error) { pinned++; console.log(`[WA] rejection pinned: ${row.id_key} → ${orderName}`); }
    }
    return pinned;
}

// ── The template catalog: the REAL registered bodies, synced from MSG91 ──// ── The template catalog: the REAL registered bodies, synced from MSG91 ──
// control.msg91.com/api/v5/whatsapp/get-template-client/:number returns every template with its
// registered components (the endpoint the docs hide — recovered from the docs page source; the
// api.msg91.com variants all 404). Body + footer land in msg91_template_catalog so the chat shows
// the message the customer actually received — for EVERY template ever used, n8n era included —
// instead of a placeholder or bare variables. Lazy refresh, at most every 6h, and a failure only
// logs: the chat must render from the last synced catalog even when MSG91 is down.
let catalogSyncedAt = 0;
async function refreshTemplateCatalog() {
    if (!configured() || Date.now() - catalogSyncedAt < 6 * 3600 * 1000) return;
    try {
        const { data } = await axios.get('https://control.msg91.com/api/v5/whatsapp/get-template-client/' + WA_NUMBER(),
            { headers: { authkey: AUTH() }, timeout: 15000 });
        const rows = [];
        ((data && data.data) || []).forEach(t => (t.languages || []).forEach(l => {
            let body = null, footer = null;
            try {
                const comps = typeof l.code === 'string' ? JSON.parse(l.code) : l.code;
                (comps || []).forEach(cp => {
                    if (cp.type === 'BODY') body = cp.text;
                    if (cp.type === 'FOOTER') footer = cp.text;
                });
            } catch (_) { /* one malformed template must not sink the sync */ }
            if (body) rows.push({ template_name: t.name, language: l.language, status: l.status || null,
                body_text: body, footer_text: footer, synced_at: new Date().toISOString() });
        }));
        // MSG91 can list one name+language twice (a rejected draft beside the approved revision) and
        // Postgres refuses to upsert the same key twice in one batch — keep one per key, approved wins.
        const byKey = new Map();
        rows.forEach(r => {
            const k = r.template_name + '|' + r.language;
            const prev = byKey.get(k);
            if (!prev || (r.status === 'approved' && prev.status !== 'approved')) byKey.set(k, r);
        });
        const deduped = [...byKey.values()];
        if (deduped.length) {
            const { error } = await supabase.from('msg91_template_catalog').upsert(deduped, { onConflict: 'template_name,language' });
            if (error) throw new Error(error.message);
            catalogSyncedAt = Date.now();
        }
    } catch (e) { console.error('[wa] template catalog refresh failed:', e.message); }
}

// ── GET /support/wa/chat?order=.. — the customer's whole WhatsApp thread, merged ──
// Three stores hold pieces of one conversation: msg91_messages (every outbound MSG91 ever sent — the
// n8n era included — mirrored back by the msg91-sync fn), wa_sends_msg91 (our manual sends, with the
// fields captured at send time), and cod_confirmations_msg91 (the customer's replies — the only
// inbound store; msg91_messages is outbound-only, direction is always '1'). Merged by PHONE, because
// a conversation belongs to the customer, not to one order — the reply to V1 about order A arrives
// while order B's popup is open, and hiding it there is how context gets lost.
router.get('/support/wa/chat', async (req, res) => {
    try {
        const orderName = String(req.query.order || '').replace(/^#/, '').trim();
        if (!orderName) return res.status(400).json({ success: false, error: 'order is required' });
        const { fields } = await resolveOrderFields(orderName);
        const p10 = fields.phone;
        if (!p10) return res.json({ success: true, phone: null, messages: [] });
        await refreshTemplateCatalog();
        const [{ data: outs }, { data: sends }, { data: ins }, { data: tpls }, { data: cat }] = await Promise.all([
            supabase.from('msg91_messages').select('template_name, campaign_name, content, status, sent_at, raw_content:raw_data->>content')
                .ilike('phone', '%' + p10).not('sent_at', 'is', null).order('sent_at', { ascending: false }).limit(60),
            supabase.from('wa_sends_msg91').select('order_name, sequence_key, version, template_name, status, payload, created_at')
                .eq('phone', p10).neq('status', 'failed'),
            supabase.from('cod_confirmations_msg91').select('id_key, data, updated_at')
                .eq('data->>Shipping Phone Number', p10),
            supabase.from('wa_template_sequences_msg91').select('*'),
            supabase.from('msg91_template_catalog').select('template_name, body_text, footer_text'),
        ]);
        const tplBy = new Map((tpls || []).map(t => [t.sequence_key + '|' + t.version, t]));
        // Body text by TEMPLATE NAME: registry rows first, then the synced MSG91 catalog OVERRIDES —
        // the catalog is the registered template itself, so any row of any known template renders the
        // COMPLETE message (body + footer) no matter who sent it. The variables ride in
        // raw_data.content on every MSG91 row (the sync never copied them into the content column on
        // newer rows, which is why bubbles went blank).
        const bodyByName = new Map((tpls || []).filter(t => t.body_text).map(t => [t.template_name, t.body_text]));
        (cat || []).forEach(t => { if (t.body_text) bodyByName.set(t.template_name, t.body_text + (t.footer_text ? '\n\n' + t.footer_text : '')); });
        const renderFromVars = (name, rawJson) => {
            const body = bodyByName.get(name);
            if (!body || !rawJson) return null;
            try {
                const vars = JSON.parse(rawJson);
                return body.replace(/\{\{(\d+)\}\}/g, (_, n) => {
                    const v = vars['body_' + n];
                    return v && typeof v.text === 'string' ? v.text : '';
                });
            } catch (_) { return null; }
        };
        const msgs = [];
        // ⚠ The msg91-sync mirror stores MSG91's IST wall-clock in a UTC column — every mirror
        // timestamp reads 5h30m late. Every consumer compensates (sentToPhoneRecently does); the chat
        // must too, or the SAME send renders twice: once at the true time from wa_sends_msg91 and once
        // +5:30 from the mirror, 5.5h apart — past the 5-minute dedupe window. (Seen on TE25-45549,
        // 2026-08-31: cod_confirmation_v1 at 07:47 am AND "01:17 pm".) Correct here, never in the
        // data — the stored shape is load-bearing for the other consumers.
        const MIRROR_SKEW_MS = 5.5 * 3600e3;
        (outs || []).forEach(m => {
            const raw = m.content || m.raw_content || null;
            const t = new Date(m.sent_at).getTime() - MIRROR_SKEW_MS;
            msgs.push({ at: new Date(t).toISOString(), dir: 'out', template: m.template_name || m.campaign_name || null,
                raw, text: renderFromVars(m.template_name, raw), status: m.status || null, source: 'msg91',
                _t: t });
        });
        const fieldsCache = new Map();          // per-order resolve, once — for sends predating field snapshots
        for (const s2 of (sends || [])) {
            const tpl = tplBy.get(s2.sequence_key + '|' + s2.version);
            let text = tpl && s2.payload && s2.payload.fields ? renderPreview(tpl, s2.payload.fields) : null;
            if (!text && tpl && s2.order_name) {
                // The earliest sends stored no field snapshot — render with the order's CURRENT fields
                // (name, product, order, amount don't change) rather than showing "(text not stored)".
                try {
                    if (!fieldsCache.has(s2.order_name)) fieldsCache.set(s2.order_name, (await resolveOrderFields(s2.order_name)).fields);
                    text = renderPreview(tpl, fieldsCache.get(s2.order_name));
                } catch (_) { /* unknown order — leave the bubble to the variables fallback */ }
            }
            const t = new Date(s2.created_at).getTime();
            // The sync mirror carries the same send (mirrored within minutes) — one message must show
            // ONCE, with the best text available: our send-time render wins over bare variables.
            const mirror = msgs.find(m => m.source === 'msg91' && m.template === s2.template_name && Math.abs(m._t - t) < 5 * 60000);
            if (mirror) { if (text && !mirror.text) mirror.text = text; mirror.order_name = s2.order_name; continue; }
            msgs.push({ at: s2.created_at, dir: 'out', template: s2.template_name, order_name: s2.order_name, text, source: 'dashboard' });
        }
        (ins || []).forEach(r => { const d = r.data || {};
            msgs.push({ at: d['Received At'] || r.updated_at, dir: 'in', text: d['Raw Reply'] || '', decision: d['Confirmation received'] || null, source: 'reply' }); });
        msgs.sort((a, b) => new Date(a.at) - new Date(b.at));
        res.json({ success: true, phone: p10, messages: msgs.slice(-80) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, resolveOrderFields, allowlistBlocks, allowlistBlocksFor, sentToPhoneRecently, autoCodOnCreate, codInitialTick, codReminderTick, ndrTick, rejectionPinTick, COD_V1_DELAY_MS };
