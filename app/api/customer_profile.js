/**
 * Customer Profile (Customer Support) — one page per customer: who they are, everything they have
 * bought, their delivery track record, their Shopify store credit, and their blacklist state.
 * Replaces the old phone-only "Blacklist Numbers" view.
 *
 * IDENTITY — the single most important decision here:
 *   • Keyed on the **last 10 digits** of the phone. Numbers are stored inconsistently (+91 / 0 / bare),
 *     so anything else silently splits one person into several.
 *   • Sourced from the Shopify `orders` mirror, NOT `b2c_order_easycom`. EasyEcom writes the
 *     placeholder 9999999999 when it has no phone — 4,364 orders across 880 different emails share it,
 *     so keying on EasyEcom's phone would fuse 880 strangers into one profile. Shopify's copy has a
 *     phone on 98.4% of orders and zero placeholders.
 *   • `orders.name` carries a leading '#' while `shipment_journey_ecom.order_name` does not — joining
 *     without stripping it returns 0 rows (verified: 17,575 vs 0).
 *
 * STORE CREDIT is real money in Shopify. Reads/writes go through the GraphQL Admin API (2025-01,
 * scopes already granted: read_store_credit_accounts, read/write_store_credit_account_transactions).
 * An account does not exist until the first credit, so "no account" is the normal empty state, not an
 * error. Every movement is mirrored into `store_credit_log_ecom` because Shopify records the
 * transaction but not which of our staff made it, or why.
 */
const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { supabase } = require('../supabase');
const { requirePermission } = require('../auth');

const GQL_URL = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2025-01/graphql.json`;
const GQL_HDR = { 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
const CREDIT_PERM = requirePermission('support-store-credit');

async function gql(query, variables) {
    const r = await axios.post(GQL_URL, { query, variables }, { headers: GQL_HDR, timeout: 25000, validateStatus: () => true });
    if (r.status >= 400) throw new Error(`Shopify ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    if (r.data && r.data.errors) throw new Error('Shopify: ' + JSON.stringify(r.data.errors).slice(0, 200));
    return r.data.data;
}

// Last 10 digits — the ONLY safe phone identity in this data set.
const p10 = v => String(v || '').replace(/\D/g, '').slice(-10);
const em = v => String(v || '').trim().toLowerCase();
const num = v => Number(v) || 0;
const money = v => Math.round(num(v) * 100) / 100;
// EasyEcom's "no phone" filler. Never treat it as an identity.
const PLACEHOLDER_PHONES = new Set(['9999999999', '0000000000', '1111111111', '1234567890']);

// Fetch every order for a phone/email, paginating past Supabase's 1000-row response cap.
async function ordersFor({ phone, email }) {
    const ph = p10(phone), mail = em(email);
    const out = [];
    const cols = 'id, name, email, phone, created_at, total_price, subtotal_price, total_discounts, total_shipping, '
        + 'financial_status, fulfillment_status, tracking_status, courier_name, awb_number, cancelled_at, source_name, location_name';
    const pull = async (col, val) => {
        for (let from = 0; ; from += 1000) {
            const { data, error } = await supabase.from('orders').select(cols)
                .ilike(col, val).order('id', { ascending: true }).range(from, from + 999);
            if (error) throw new Error(error.message);
            out.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
    };
    // Phone is matched by suffix so +91/0/bare all land together.
    if (ph && !PLACEHOLDER_PHONES.has(ph)) await pull('phone', '%' + ph);
    if (mail) await pull('email', mail);
    // De-dupe: an order found by both keys must appear once.
    const dedupe = rows => { const seen = new Set(); return rows.filter(o => (seen.has(o.id) ? false : (seen.add(o.id), true))); };

    // IDENTITY CLOSURE. One person legitimately has several phones and emails, linked through the orders
    // they share. Expanding a single hop was NOT enough — starting from different identifiers converged
    // on different answers for the same customer (6 vs 18 vs 19 orders), which makes the page untrustworthy.
    // So keep pulling on every newly discovered identifier until nothing new appears; the result is then
    // the same whichever identifier you arrived by.
    // Bounded three ways: MAX_ROUNDS iterations, placeholder phones excluded, and the whole expansion is
    // abandoned if it balloons past MAX_MERGE orders — that is the signature of a shared/dummy address,
    // and one profile wrongly showing 880 strangers is far worse than a slightly short history.
    const MAX_MERGE = 400, MAX_ROUNDS = 6;
    const donePhones = new Set([ph].filter(Boolean));
    const doneEmails = new Set([mail].filter(Boolean));
    let stable = dedupe(out);
    for (let round = 0; round < MAX_ROUNDS; round++) {
        const nextPhones = [...new Set(stable.map(o => p10(o.phone)))]
            .filter(p => p && p.length === 10 && !PLACEHOLDER_PHONES.has(p) && !donePhones.has(p));
        const nextEmails = [...new Set(stable.map(o => em(o.email)))].filter(e => e && !doneEmails.has(e));
        if (!nextPhones.length && !nextEmails.length) break;          // converged
        for (const p of nextPhones) { donePhones.add(p); await pull('phone', '%' + p); }
        for (const e of nextEmails) { doneEmails.add(e); await pull('email', e); }
        const merged = dedupe(out);
        if (merged.length > MAX_MERGE) {
            console.warn(`[CustomerProfile] identity closure abandoned for ${ph || mail}: ${merged.length} orders — shared identifier, keeping ${stable.length}`);
            break;                                                    // keep the last trustworthy set
        }
        stable = merged;
    }
    return stable.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// Line items for a set of order names → top products. Shopify's copy carries the product NAME and
// price; EasyEcom's line_items has the sku but an empty name and price 0, so it can't be used here.
async function itemsFor(orderNames) {
    if (!orderNames.length) return [];
    const rows = [];
    for (let i = 0; i < orderNames.length; i += 200) {
        const { data } = await supabase.from('enriched_orders_ecom')
            .select('name, line_items').in('name', orderNames.slice(i, i + 200));
        rows.push(...(data || []));
    }
    return rows;
}

// Delivery outcomes from our own journey table (attempts, NDR, RTO reason) — richer than Shopify's
// tracking_status. NOTE the '#' strip on the order name.
async function journeysFor(orderNames) {
    if (!orderNames.length) return [];
    const bare = orderNames.map(n => String(n).replace(/^#/, ''));
    const rows = [];
    for (let i = 0; i < bare.length; i += 200) {
        const { data } = await supabase.from('shipment_journey_ecom')
            .select('order_name, awb, source, courier, outcome, attempts, ndr_count, rto_no_attempt, order_date, delivered_at, rto_at, dest_city, dest_state, dest_pincode, payment_mode, shipment_value')
            .in('order_name', bare.slice(i, i + 200));
        rows.push(...(data || []));
    }
    return rows;
}

// ── GET /customer/search?q= — phone / email / name / order number ────────────────────────────────
router.get('/customer/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 3) return res.json({ success: true, results: [] });
        const digits = q.replace(/\D/g, '');
        const cols = 'name, email, phone, created_at, total_price';
        const runs = [];
        if (digits.length >= 4) runs.push(supabase.from('orders').select(cols).ilike('phone', '%' + digits.slice(-10)).limit(200));
        if (q.includes('@') || /[a-z]/i.test(q)) runs.push(supabase.from('orders').select(cols).ilike('email', '%' + q + '%').limit(200));
        if (/^#?TE/i.test(q)) runs.push(supabase.from('orders').select(cols).ilike('name', '%' + q.replace(/^#/, '') + '%').limit(50));
        const got = (await Promise.all(runs)).flatMap(r => r.data || []);
        // Collapse orders → one row per person, keyed the same way the profile is.
        const by = new Map();
        for (const o of got) {
            const key = p10(o.phone) && !PLACEHOLDER_PHONES.has(p10(o.phone)) ? 'p:' + p10(o.phone) : 'e:' + em(o.email);
            if (!key || key === 'e:') continue;
            const cur = by.get(key) || { phone: o.phone || null, email: o.email || null, orders: 0, value: 0, last_order: null };
            cur.orders++; cur.value += num(o.total_price);
            if (!cur.last_order || new Date(o.created_at) > new Date(cur.last_order)) cur.last_order = o.created_at;
            if (!cur.email && o.email) cur.email = o.email;
            if (!cur.phone && o.phone) cur.phone = o.phone;
            by.set(key, cur);
        }
        const results = [...by.values()].map(c => ({ ...c, value: money(c.value) }))
            .sort((a, b) => new Date(b.last_order) - new Date(a.last_order)).slice(0, 40);
        res.json({ success: true, results });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /customer/profile?phone=&email= — the whole picture ──────────────────────────────────────
router.get('/customer/profile', async (req, res) => {
    try {
        const phone = String(req.query.phone || '').trim();
        const email = String(req.query.email || '').trim();
        if (!phone && !email) return res.status(400).json({ success: false, error: 'phone or email required' });

        const orders = await ordersFor({ phone, email });
        if (!orders.length) return res.json({ success: true, found: false, orders: [], identity: { phone, email } });

        const names = orders.map(o => o.name).filter(Boolean);
        const [items, journeys, ee] = await Promise.all([
            itemsFor(names),
            journeysFor(names),
            (async () => {
                const bare = names.map(n => String(n).replace(/^#/, ''));
                const rows = [];
                for (let i = 0; i < bare.length; i += 200) {
                    const { data } = await supabase.from('b2c_order_easycom')
                        .select('reference_code, order_status, customer_name, customer_type')
                        .in('reference_code', bare.slice(i, i + 200));
                    rows.push(...(data || []));
                }
                return rows;
            })(),
        ]);

        const jByName = new Map(journeys.map(j => [j.order_name, j]));
        const iByName = new Map(items.map(i => [i.name, i.line_items]));
        const eByRef = new Map(ee.map(e => [e.reference_code, e]));

        // Identity. Two things this has to get right:
        //  • NAME — the Shopify `orders` mirror has no customer-name column at all, and EasyEcom's
        //    customer_name is frequently a placeholder ("DUMMY", "TEST", "."). Junk is filtered out here
        //    so it never renders as a person's name; the real name comes from the Shopify customer
        //    record, which the store-credit lookup already returns.
        //  • PHONES/EMAILS — a profile legitimately merges several (one person, two numbers, matched via
        //    a shared email). Showing only the newest made the header contradict what was searched, so
        //    every identifier that went into the merge is returned and displayed.
        const latest = orders[0];
        const JUNK_NAME = /^(dummy|test|testing|n\.?\/?a|na|none|guest|customer|xxx+|\.+|-+)$/i;
        const realName = ee.map(e => e.customer_name).find(n => n && !JUNK_NAME.test(String(n).trim())) || null;
        const phones = [...new Set(orders.map(o => p10(o.phone)).filter(p => p && !PLACEHOLDER_PHONES.has(p)))];
        const emails = [...new Set(orders.map(o => em(o.email)).filter(Boolean))];
        const identity = {
            name: realName,
            phone: orders.map(o => o.phone).find(Boolean) || phone || null,
            email: orders.map(o => o.email).find(Boolean) || email || null,
            phones, emails,
            searched: { phone: p10(phone) || null, email: em(email) || null },
            customer_type: ee.map(e => e.customer_type).find(v => v && v !== 'Regular') || 'Regular',
            first_order: orders[orders.length - 1].created_at,
            last_order: latest.created_at,
        };

        // Per-order rows, enriched with what actually happened to the parcel.
        const rows = orders.map(o => {
            const bare = String(o.name).replace(/^#/, '');
            const j = jByName.get(bare) || null;
            const li = iByName.get(o.name) || [];
            return {
                name: o.name, created_at: o.created_at,
                total: money(o.total_price), discounts: money(o.total_discounts), shipping: money(o.total_shipping),
                financial_status: o.financial_status, fulfillment_status: o.fulfillment_status,
                cancelled: !!o.cancelled_at,
                payment: j && j.payment_mode ? j.payment_mode : (o.financial_status === 'paid' ? 'Prepaid' : 'COD'),
                tracking_status: o.tracking_status, courier: (j && j.courier) || o.courier_name || null,
                awb: (j && j.awb) || o.awb_number || null, source: j ? j.source : null,
                outcome: j ? j.outcome : null, attempts: j ? j.attempts : null, ndr_count: j ? j.ndr_count : null,
                silent_rto: !!(j && j.rto_no_attempt),
                delivered_at: j ? j.delivered_at : null, rto_at: j ? j.rto_at : null,
                city: j ? j.dest_city : null, state: j ? j.dest_state : null, pincode: j ? j.dest_pincode : null,
                ee_status: (eByRef.get(bare) || {}).order_status || null,
                items: (Array.isArray(li) ? li : []).map(x => ({
                    sku: x.sku || null, title: x.title || x.name || null,
                    qty: num(x.quantity), price: money(x.price),
                })),
            };
        });

        // Top products across their whole history — by units, with spend and last-bought date.
        const prod = new Map();
        rows.forEach(r => r.items.forEach(it => {
            const key = it.sku || it.title; if (!key) return;
            const cur = prod.get(key) || { sku: it.sku, title: it.title, units: 0, spend: 0, orders: 0, last: null };
            cur.units += it.qty; cur.spend += it.qty * it.price; cur.orders++;
            if (!cur.last || new Date(r.created_at) > new Date(cur.last)) cur.last = r.created_at;
            if (!cur.title && it.title) cur.title = it.title;
            prod.set(key, cur);
        }));
        const topProducts = [...prod.values()].map(p => ({ ...p, spend: money(p.spend) }))
            .sort((a, b) => b.units - a.units || b.spend - a.spend);

        // Delivery track record — the numbers that decide whether to trust a COD order.
        const delivered = rows.filter(r => r.outcome === 'delivered' || r.tracking_status === 'delivered').length;
        const rto = rows.filter(r => r.outcome === 'rto' || r.tracking_status === 'rto').length;
        const cancelled = rows.filter(r => r.cancelled || r.tracking_status === 'cancelled').length;
        const inFlight = rows.filter(r => !['delivered', 'rto', 'cancelled'].includes(r.tracking_status || '') && !r.cancelled).length;
        const cod = rows.filter(r => String(r.payment).toUpperCase().includes('COD')).length;
        const settled = delivered + rto;
        const stats = {
            orders: rows.length,
            lifetime_value: money(rows.reduce((s, r) => s + r.total, 0)),
            delivered_value: money(rows.filter(r => r.outcome === 'delivered' || r.tracking_status === 'delivered').reduce((s, r) => s + r.total, 0)),
            avg_order_value: rows.length ? money(rows.reduce((s, r) => s + r.total, 0) / rows.length) : 0,
            delivered, rto, cancelled, in_flight: inFlight,
            cod, prepaid: rows.length - cod,
            // Over SETTLED orders only — counting in-flight parcels would understate a good customer.
            rto_rate: settled ? Math.round((rto / settled) * 1000) / 10 : null,
            silent_rto: rows.filter(r => r.silent_rto).length,
            total_ndr: rows.reduce((s, r) => s + num(r.ndr_count), 0),
            units: topProducts.reduce((s, p) => s + p.units, 0),
            first_order: identity.first_order, last_order: identity.last_order,
            days_since_last: Math.floor((Date.now() - new Date(identity.last_order)) / 86400000),
        };

        res.json({ success: true, found: true, identity, stats, orders: rows, topProducts });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Shopify customer lookup (needed for store credit, which is keyed on the Shopify customer id) ──
async function findShopifyCustomer({ phone, email }) {
    const terms = [];
    if (email) terms.push(`email:${JSON.stringify(em(email))}`);
    const ph = p10(phone);
    if (ph) terms.push(`phone:*${ph}`);
    if (!terms.length) return null;
    const d = await gql(`query($q:String!){ customers(first:5, query:$q){ edges { node {
        id displayName firstName lastName email phone numberOfOrders
        amountSpent { amount currencyCode }
        storeCreditAccounts(first:5){ edges { node { id balance { amount currencyCode } } } }
    } } } }`, { q: terms.join(' OR ') });
    const edges = (((d || {}).customers || {}).edges || []);
    if (!edges.length) return null;
    // Prefer an exact email match, else the first hit.
    const wanted = em(email);
    const pick = edges.find(e => em(e.node.email) === wanted && wanted) || edges[0];
    return pick.node;
}

// ── GET /customer/store-credit?phone=&email= ─────────────────────────────────────────────────────
router.get('/customer/store-credit', async (req, res) => {
    try {
        const cust = await findShopifyCustomer({ phone: req.query.phone, email: req.query.email });
        if (!cust) return res.json({ success: true, found: false, balance: 0, accounts: [], log: [] });
        const accounts = (((cust.storeCreditAccounts || {}).edges) || []).map(e => ({
            id: e.node.id, amount: money(e.node.balance.amount), currency: e.node.balance.currencyCode,
        }));
        const balance = money(accounts.reduce((s, a) => s + a.amount, 0));
        const { data: log } = await supabase.from('store_credit_log_ecom')
            .select('id, direction, amount, currency, reason, balance_after, actor, created_at')
            .eq('shopify_customer_id', cust.id).order('created_at', { ascending: false }).limit(100);
        // Shopify's own transaction list — includes redemptions at checkout, which never pass through us.
        let transactions = [];
        if (accounts.length) {
            try {
                const t = await gql(`query($id:ID!){ storeCreditAccount(id:$id){ transactions(first:50, reverse:true){ edges { node {
                    __typename createdAt amount { amount currencyCode } balanceAfterTransaction { amount currencyCode }
                    ... on StoreCreditAccountDebitRevertTransaction { __typename }
                } } } } }`, { id: accounts[0].id });
                transactions = ((((t || {}).storeCreditAccount || {}).transactions || {}).edges || []).map(e => ({
                    type: /Debit/i.test(e.node.__typename) ? 'debit' : 'credit',
                    at: e.node.createdAt, amount: money(e.node.amount.amount),
                    balance_after: e.node.balanceAfterTransaction ? money(e.node.balanceAfterTransaction.amount) : null,
                }));
            } catch (_) { /* balance still renders without the ledger */ }
        }
        res.json({
            success: true, found: true,
            customer: { id: cust.id, name: cust.displayName, email: cust.email, phone: cust.phone, orders: cust.numberOfOrders, spent: money(((cust.amountSpent) || {}).amount) },
            balance, currency: (accounts[0] || {}).currency || 'INR', accounts, transactions, log: log || [],
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /customer/store-credit — issue or deduct. PERMISSION-GATED (support-store-credit). ──────
// No cap, per the brief. A reason is mandatory: Shopify stores the money movement but not who did it
// or why, so `store_credit_log_ecom` is the only accountability record that will exist.
router.post('/customer/store-credit', CREDIT_PERM, async (req, res) => {
    try {
        const b = req.body || {};
        const direction = b.direction === 'debit' ? 'debit' : 'credit';
        const amount = Number(b.amount);
        const reason = String(b.reason || '').trim();
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'Enter an amount greater than 0.' });
        if (!reason) return res.status(400).json({ success: false, error: 'A reason is required — it is the only record of why this was issued.' });

        const cust = await findShopifyCustomer({ phone: b.phone, email: b.email });
        if (!cust) return res.status(404).json({ success: false, error: 'No matching Shopify customer — store credit can only be issued to a Shopify customer record.' });

        const currency = ((((cust.storeCreditAccounts || {}).edges || [])[0] || {}).node || {}).balance?.currencyCode || 'INR';
        const amt = { amount: String(amount), currencyCode: currency };

        let out, txId = null, balanceAfter = null, accountId = null;
        if (direction === 'credit') {
            out = await gql(`mutation($id:ID!,$in:StoreCreditAccountCreditInput!){ storeCreditAccountCredit(id:$id, creditInput:$in){
                storeCreditAccountTransaction { id createdAt account { id balance { amount currencyCode } } }
                userErrors { field message } } }`, { id: cust.id, in: { creditAmount: amt } });
            const r = out.storeCreditAccountCredit;
            if (r.userErrors && r.userErrors.length) return res.status(400).json({ success: false, error: r.userErrors.map(e => e.message).join('; ') });
            txId = r.storeCreditAccountTransaction.id;
            accountId = r.storeCreditAccountTransaction.account.id;
            balanceAfter = money(r.storeCreditAccountTransaction.account.balance.amount);
        } else {
            // Debit needs the ACCOUNT id, not the customer id — and the account only exists once credited.
            const accId = ((((cust.storeCreditAccounts || {}).edges || [])[0] || {}).node || {}).id;
            if (!accId) return res.status(400).json({ success: false, error: 'This customer has no store-credit account yet, so there is nothing to deduct.' });
            out = await gql(`mutation($id:ID!,$in:StoreCreditAccountDebitInput!){ storeCreditAccountDebit(id:$id, debitInput:$in){
                storeCreditAccountTransaction { id createdAt account { id balance { amount currencyCode } } }
                userErrors { field message } } }`, { id: accId, in: { debitAmount: amt } });
            const r = out.storeCreditAccountDebit;
            if (r.userErrors && r.userErrors.length) return res.status(400).json({ success: false, error: r.userErrors.map(e => e.message).join('; ') });
            txId = r.storeCreditAccountTransaction.id;
            accountId = r.storeCreditAccountTransaction.account.id;
            balanceAfter = money(r.storeCreditAccountTransaction.account.balance.amount);
        }

        await supabase.from('store_credit_log_ecom').insert({
            shopify_customer_id: cust.id, customer_name: cust.displayName, customer_email: cust.email,
            customer_phone: cust.phone || b.phone || null,
            direction, amount, currency, reason, balance_after: balanceAfter,
            shopify_account_id: accountId, shopify_tx_id: txId,
            actor: (req.user && (req.user.name || req.user.sub)) || 'portal',
        });
        console.log(`[StoreCredit] ${direction} ${currency} ${amount} → ${cust.displayName} by ${(req.user || {}).sub} — ${reason}`);
        res.json({ success: true, direction, amount, currency, balance: balanceAfter });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Blacklist — now by phone AND/OR email AND/OR Shopify customer id ─────────────────────────────
router.get('/customer/blacklist', async (req, res) => {
    try {
        const [act, hist] = await Promise.all([
            supabase.from('blocked_numbers_ecom').select('*').eq('active', true).order('created_at', { ascending: false }),
            supabase.from('blocked_numbers_ecom').select('*').eq('active', false).order('unblocked_at', { ascending: false }).limit(200),
        ]);
        res.json({ success: true, active: act.data || [], history: hist.data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Is THIS customer blocked, by any of their identifiers?
router.get('/customer/blacklist/check', async (req, res) => {
    try {
        const ph = p10(req.query.phone), mail = em(req.query.email), cid = String(req.query.customerId || '').trim();
        const { data } = await supabase.from('blocked_numbers_ecom').select('*').eq('active', true);
        const hit = (data || []).find(b =>
            (ph && p10(b.phone) === ph) || (mail && em(b.email) === mail) || (cid && b.shopify_customer_id === cid));
        res.json({ success: true, blocked: !!hit, block: hit || null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/customer/blacklist', async (req, res) => {
    try {
        const b = req.body || {};
        const phone = String(b.phone || '').replace(/\D/g, '').slice(-10) || null;
        const email = em(b.email) || null;
        const cid = String(b.shopify_customer_id || '').trim() || null;
        const reason = String(b.reason || '').trim();
        if (!phone && !email && !cid) return res.status(400).json({ success: false, error: 'Give at least one of phone, email or Shopify customer id.' });
        if (!reason) return res.status(400).json({ success: false, error: 'A reason is required.' });
        // Already blocked on any identifier? Report it rather than stacking duplicate rows.
        const { data: existing } = await supabase.from('blocked_numbers_ecom').select('*').eq('active', true);
        const dup = (existing || []).find(x =>
            (phone && p10(x.phone) === phone) || (email && em(x.email) === email) || (cid && x.shopify_customer_id === cid));
        if (dup) return res.status(409).json({ success: false, error: 'This customer is already blacklisted.' });
        const { error } = await supabase.from('blocked_numbers_ecom').insert({
            phone, email, shopify_customer_id: cid, customer_name: String(b.customer_name || '').trim() || null,
            reason, added_by: req.user.sub, active: true,
        });
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Soft-release: the row stays as history (who blocked, who released, when).
router.post('/customer/blacklist/:id/unblock', async (req, res) => {
    try {
        const { error } = await supabase.from('blocked_numbers_ecom')
            .update({ active: false, unblocked_by: req.user.sub, unblocked_at: new Date().toISOString() })
            .eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
