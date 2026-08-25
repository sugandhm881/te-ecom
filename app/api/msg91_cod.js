// ─────────────────────────────────────────────────────────────────────────────
// COD-confirmation sender — MSG91 WhatsApp, DIRECT from this server.
//
// Replaces the n8n + Google-Sheet workflow (asked for 2026-08-24: "make it with our own system direct,
// not with any workflow"). The receiving half was already ours (the msg91-cod-webhook edge fn records
// CONFIRM/REJECT replies); this is the missing sending half. One template, two triggers:
//
//   * the orders/create webhook — fires the send the moment a COD order lands;
//   * a 15-min cron backstop — catches any order the webhook missed (the same webhook+backstop pattern
//     ShopifyHold and the order feed already use, because webhooks drop).
//
// ⚠️ DISABLED UNTIL CONFIGURED, AND THAT IS A FEATURE. n8n is still sending today; running both would
// double-message every customer. Nothing sends until ALL of these are set in .env:
//     MSG91_AUTHKEY            — MSG91 dashboard → API
//     MSG91_WA_NUMBER          — the integrated WhatsApp number (digits, e.g. 9198XXXXXXXX)
//     MSG91_COD_SEND_ENABLED   — 'true' to actually send (the deliberate final switch)
// Optional: MSG91_COD_NAMESPACE (only if MSG91 shows one), MSG91_COD_DRYRUN='true' (log, don't send).
// The TEMPLATE NAME lives in CODE (below), not in .env — it is not a secret, it is part of the message
// this feature exists to send, and a template rename is a code change reviewed like one (user, 2026-08-24).
// Turn n8n's workflow OFF in the same breath as setting MSG91_COD_SEND_ENABLED=true.
//
// ⚠️ EVERY SEND IS LOGGED FIRST (cod_confirm_sends_msg91, UNIQUE on order_name) and the log row is the
// dedupe: insert-then-send means a crash between the two can at worst LOSE one message, never send it
// twice — a customer double-messaged about the same order reads it as spam and rejects.
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');
const { supabase } = require('../supabase');

// First whitespace-delimited token only: the operator pasted the sample line comments (“← MSG91
// dashboard …”) into .env along with the values, and an authkey with a comment glued on fails auth
// with a misleading 401. Taking the first token makes both the clean and the pasted form work.
const AUTH = () => String(process.env.MSG91_AUTHKEY || '').trim().split(/\s/)[0];
const WA_NUMBER = () => String(process.env.MSG91_WA_NUMBER || '').replace(/\D/g, '');
// The approved CONFIRM/REJECT template, exactly as MSG91's own sample curl states it — name, LANGUAGE
// and namespace together. ⚠ The language code must match the template's registration EXACTLY: this one
// is en_GB, and sends with 'en' or 'en_US' were accepted with status:success and then never delivered —
// WhatsApp drops a language-mismatched template at delivery time with no error back through MSG91.
const COD_TEMPLATE_NAME = 'cod_confirmation_v1';
const COD_TEMPLATE_LANG = 'en_GB';
const COD_TEMPLATE_NAMESPACE = '76ec8535_ee9d_416e_b89d_8c2362647b62';
const TEMPLATE = () => COD_TEMPLATE_NAME;
const DRY = () => String(process.env.MSG91_COD_DRYRUN || '').toLowerCase() === 'true';
const enabled = () => String(process.env.MSG91_COD_SEND_ENABLED || '').toLowerCase() === 'true'
    && !!AUTH() && !!WA_NUMBER();

const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);

// "The Element Brightening Drops … x2" (+ " + 2 more") — what the template's product slot reads.
function productLine(items) {
    const li = (items || []).filter(i => i && (i.title || i.name));
    if (!li.length) return 'your order';
    const first = `${li[0].title || li[0].name}${Number(li[0].quantity) > 1 ? ` x${li[0].quantity}` : ''}`;
    return li.length > 1 ? `${first} + ${li.length - 1} more` : first;
}

// Only a genuine, live COD order with a reachable phone qualifies. Everything else returns the reason,
// which the log records — a skipped order must be explainable later, not just absent.
function eligibility({ financialStatus, phone, test, cancelledAt, orderName }) {
    if (!orderName) return 'no order name';
    if (test) return 'test order';
    if (cancelledAt) return 'cancelled';
    if (String(financialStatus) !== 'pending') return `not COD (financial_status=${financialStatus || 'none'})`;
    if (last10(phone).length !== 10) return 'no usable phone';
    return null;
}

async function alreadyLogged(orderName) {
    const { data, error } = await supabase.from('cod_confirm_sends_msg91')
        .select('id, status').eq('order_name', orderName).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
}

// MSG91 v5 WhatsApp template send. Variable order matches the live template: name, product, order, amount.
async function callMsg91({ phone, customerName, product, orderName, amount }) {
    const template = {
        name: TEMPLATE(),
        language: { code: COD_TEMPLATE_LANG, policy: 'deterministic' },
        namespace: COD_TEMPLATE_NAMESPACE,
        to_and_components: [{
            to: ['91' + last10(phone)],
            components: {
                body_1: { type: 'text', value: customerName || 'there' },
                body_2: { type: 'text', value: product },
                body_3: { type: 'text', value: orderName },
                body_4: { type: 'text', value: String(amount) },
            },
        }],
    };
    const r = await axios.post('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
        { integrated_number: WA_NUMBER(), content_type: 'template', payload: { messaging_product: 'whatsapp', type: 'template', template } },
        { headers: { authkey: AUTH(), 'Content-Type': 'application/json' }, timeout: 20000, validateStatus: () => true });
    if (r.status >= 400) throw new Error(`MSG91 ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    return r.data;
}

// One order → at most one message, ever. Shapes accepted: a Shopify webhook payload, or a row from the
// `orders` table with its line items supplied.
// ⚠⚠ TEST ALLOWLIST — THE OPERATOR'S EXPLICIT INSTRUCTION (2026-08-24): “Test only that which I said —
// mobile number or order.” While MSG91_COD_ALLOWLIST is set in .env (comma-separated phones and/or
// order numbers), a send to ANYTHING not on it is refused — regardless of the enable flag, the dry-run
// flag, the webhook or the cron. This exists because 41 real customers were messaged during testing;
// with the allowlist set, that class of accident is structurally impossible. Remove the line from .env
// ONLY at the real cut-over, in the same breath as switching n8n off.
function allowlistBlocks(orderName, phone) {
    const raw = String(process.env.MSG91_COD_ALLOWLIST || '').trim();
    if (!raw) return null;                                   // no allowlist → normal operation
    const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
    const p10 = last10(phone);
    const ok = entries.some(e => e === orderName || e.replace(/^#/, '') === String(orderName).replace(/^#/, '') || last10(e) === p10);
    return ok ? null : `not on MSG91_COD_ALLOWLIST (test mode)`;
}

async function sendCodConfirmation({ orderName, phone, customerName, items, amount, financialStatus, test, cancelledAt }) {
    const gate = allowlistBlocks(orderName, phone);
    if (gate) return { skipped: gate };
    const skip = eligibility({ financialStatus, phone, test, cancelledAt, orderName });
    if (skip) return { skipped: skip };
    if (!enabled()) return { skipped: DRY() ? 'dry-run only (send not enabled)' : 'sender not configured/enabled' };
    const prior = await alreadyLogged(orderName);
    if (prior) return { skipped: `already ${prior.status}` };

    const payload = {
        order_name: orderName, phone: last10(phone),
        status: DRY() ? 'dry' : 'sending',
        payload: { customerName, product: productLine(items), amount: Math.round(Number(amount) || 0) },
    };
    // Log BEFORE sending — the unique index is the double-send guard (see header).
    const ins = await supabase.from('cod_confirm_sends_msg91').insert(payload).select('id').single();
    if (ins.error) {
        if (String(ins.error.code) === '23505') return { skipped: 'already logged (raced)' };
        throw new Error(ins.error.message);
    }
    if (DRY()) { console.log(`[MSG91-COD] DRY: would send to ${payload.phone} for ${orderName}`); return { dry: true }; }
    try {
        const resp = await callMsg91({ phone, customerName, product: payload.payload.product, orderName, amount: payload.payload.amount });
        await supabase.from('cod_confirm_sends_msg91').update({ status: 'sent', response: resp }).eq('id', ins.data.id);
        console.log(`[MSG91-COD] sent → ${payload.phone} for ${orderName}`);
        return { sent: true };
    } catch (e) {
        await supabase.from('cod_confirm_sends_msg91').update({ status: 'failed', response: { error: e.message } }).eq('id', ins.data.id);
        console.error(`[MSG91-COD] send FAILED for ${orderName}:`, e.message);
        return { failed: e.message };
    }
}

// Webhook shape → sender shape.
async function sendForWebhookOrder(o) {
    const sa = o.shipping_address || {};
    return sendCodConfirmation({
        orderName: o.name || String(o.order_number || o.id),
        phone: sa.phone || (o.customer && o.customer.phone) || o.phone,
        customerName: (sa.first_name || (o.customer && o.customer.first_name) || '').trim() || null,
        items: o.line_items, amount: o.total_price,
        financialStatus: o.financial_status, test: !!o.test, cancelledAt: o.cancelled_at,
    });
}

// Cron backstop: any live COD order from the last 24h the webhook missed. The 24h lookback is also the
// safety on FIRST enable — it cannot blast history, only the last day.
async function backstopCodConfirmations({ hours = 24, cap = 50 } = {}) {
    if (!enabled() && !DRY()) return { skipped: 'not enabled' };
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    // ⚠⚠ THE BACKSTOP MAY ONLY SEND RECENT ORDERS — EVER. On 2026-08-24 the enable flag was on when
    // the server started, and this cron treated every COD order of the previous 24h as “missed”: 41
    // real customers, already messaged by n8n, were double-messaged in minutes. The 24h lookback was
    // meant as the blast limiter and it WAS the blast. The rule now: an un-logged order older than
    // BACKSTOP_SEND_WINDOW_MS is SEALED (status 'seeded', nothing sent) — a webhook miss is caught in
    // minutes, so anything older is not a miss, it is history, and history is never messaged. This
    // holds regardless of flag flips, restarts or downtime, not just on the first run.
    const BACKSTOP_SEND_WINDOW_MS = 2 * 60 * 60 * 1000;
    const { data: orders, error } = await supabase.from('orders')
        .select('id, name, phone, total_price, financial_status, created_at, cancelled_at, test')
        .eq('financial_status', 'pending').is('cancelled_at', null)
        .gte('created_at', since).order('created_at', { ascending: true }).limit(500);
    if (error) throw new Error(error.message);
    const names = (orders || []).map(o => o.name);
    if (!names.length) return { checked: 0, sent: 0 };
    // One query for the whole batch, not one per order.
    const { data: logged } = await supabase.from('cod_confirm_sends_msg91')
        .select('order_name').in('order_name', names);
    const done = new Set((logged || []).map(r => r.order_name));
    const cutoff = Date.now() - BACKSTOP_SEND_WINDOW_MS;
    const stale = orders.filter(o => !done.has(o.name) && new Date(o.created_at).getTime() < cutoff);
    if (stale.length) {
        const seedRows = stale.map(o => ({ order_name: o.name, phone: last10(o.phone), status: 'seeded',
            payload: { reason: 'older than the backstop send window — sealed, never messaged by this system' } }));
        await supabase.from('cod_confirm_sends_msg91').insert(seedRows);
        seedRows.forEach(r => done.add(r.order_name));
        console.log(`[MSG91-COD] sealed ${seedRows.length} order(s) older than ${BACKSTOP_SEND_WINDOW_MS / 3600000}h — nothing sent for them`);
    }
    let sent = 0, skipped = 0, failed = 0;
    for (const o of orders) {
        if (done.has(o.name)) continue;
        if (sent >= cap) break;                          // gentle: the next run continues
        const { data: items } = await supabase.from('order_line_items')
            .select('title, quantity').eq('order_id', o.id);
        const r = await sendCodConfirmation({
            orderName: o.name, phone: o.phone, customerName: null, items: items || [],
            amount: o.total_price, financialStatus: o.financial_status, test: o.test, cancelledAt: o.cancelled_at,
        });
        if (r.sent || r.dry) sent++; else if (r.failed) failed++; else skipped++;
        await new Promise(x => setTimeout(x, 400));      // MSG91-friendly pacing
    }
    if (sent || failed) console.log(`[MSG91-COD] backstop: sent ${sent}, skipped ${skipped}, failed ${failed}`);
    return { checked: orders.length, sent, skipped, failed };
}

module.exports = { sendCodConfirmation, sendForWebhookOrder, backstopCodConfirmations, productLine, eligibility, enabled };
