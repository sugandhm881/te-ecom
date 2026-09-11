// DO NOT CALL LIST (user, 2026-09-11: "make a only permission base dashboard where if i put the order that
// order should not go any call"). One row in call_block_ecom per blocked order; while it exists nothing
// dials that order — the two places a call can start both ask here first:
//   · vobiz_bridge.js placeOrderCall — every AI call: auto COD, auto NDR 1/2/3 + RTO, the 🤖 AI Call button
//   · vobiz_manual_call.js           — the 📞 human call button
// and both auto-dialler ticks skip a blocked order BEFORE claiming it, so no retry attempt is burned.
// Calls only — WhatsApp is untouched (user's choice). Page + routes gated by support-dnc (admins always).
const express = require('express');
const { supabase } = require('../supabase');
const { requirePermission } = require('../auth');

const router = express.Router();
const TABLE = 'call_block_ecom';
const norm = (n) => String(n || '').replace(/^#/, '').trim().toUpperCase();

// A read failure must never be mistaken for "not blocked" on the dial path — the caller decides what an
// error means, so these throw rather than return an empty answer.
async function blockInfo(orderName) {
    const n = norm(orderName);
    if (!n) return null;
    const { data, error } = await supabase.from(TABLE).select('order_name, note, added_by, created_at').eq('order_name', n).maybeSingle();
    if (error) throw error;
    return data || null;
}
async function blockedSet(names) {
    const list = [...new Set((names || []).map(norm).filter(Boolean))];
    const out = new Set();
    for (let i = 0; i < list.length; i += 200) {
        const { data, error } = await supabase.from(TABLE).select('order_name').in('order_name', list.slice(i, i + 200));
        if (error) throw error;
        (data || []).forEach(r => out.add(r.order_name));
    }
    return out;
}
// The one refusal every call path shows, so the person at the button knows who to ask.
const refusal = (b) => `Calls are blocked for this order (Do Not Call list${b && b.added_by ? `, added by ${b.added_by}` : ''})`;

router.use('/support/dnc', requirePermission('support-dnc'));

router.get('/support/dnc', async (req, res) => {
    try {
        const { data, error } = await supabase.from(TABLE).select('*').order('created_at', { ascending: false });
        if (error) throw error;
        const rows = data || [];
        // customer + status alongside, so the list reads without opening each order. `orders` has no
        // customer-name column — the name lives on the shipping address, as it does for the call queue.
        const names = rows.map(r => r.order_name);
        const byName = {};
        for (let i = 0; i < names.length; i += 200) {
            const chunk = names.slice(i, i + 200);
            const { data: ords, error: oe } = await supabase.from('orders')
                .select('id, name, phone, total_price, cancelled_at, fulfillment_status')
                .in('name', chunk.concat(chunk.map(n => '#' + n)));
            if (oe) throw oe;
            const ids = (ords || []).map(o => o.id);
            const { data: addrs, error: ae } = ids.length
                ? await supabase.from('order_shipping_addresses').select('order_id, name').in('order_id', ids)
                : { data: [] };
            if (ae) throw ae;
            const nameById = {}; (addrs || []).forEach(a => { nameById[String(a.order_id)] = a.name; });
            (ords || []).forEach(o => { byName[norm(o.name)] = { ...o, customer_name: nameById[String(o.id)] || null }; });
        }
        res.json({ success: true, blocks: rows.map(r => ({ ...r, order: byName[r.order_name] || null })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/support/dnc', async (req, res) => {
    try {
        const b = req.body || {};
        const n = norm(b.order_name);
        if (!n) return res.status(400).json({ success: false, error: 'Enter an order number' });
        const { data: ord } = await supabase.from('orders').select('name').in('name', [n, '#' + n]).limit(1);
        if (!ord || !ord.length) return res.status(404).json({ success: false, error: `No order ${n} found` });
        const { data: exists } = await supabase.from(TABLE).select('order_name').eq('order_name', n).maybeSingle();
        if (exists) return res.status(409).json({ success: false, error: `${n} is already on the Do Not Call list` });
        const who = (req.user && (req.user.sub || req.user.email)) || null;
        const { error } = await supabase.from(TABLE).insert({ order_name: n, note: String(b.note || '').trim().slice(0, 300) || null, added_by: who });
        if (error) throw error;
        console.log(`[DNC] ${n} added by ${who || '(unknown)'}`);
        res.json({ success: true, order_name: n });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/support/dnc/:order', async (req, res) => {
    try {
        const n = norm(req.params.order);
        const { data, error } = await supabase.from(TABLE).delete().eq('order_name', n).select('order_name');
        if (error) throw error;
        if (!data || !data.length) return res.status(404).json({ success: false, error: `${n} is not on the list` });
        console.log(`[DNC] ${n} removed by ${(req.user && (req.user.sub || req.user.email)) || '(unknown)'}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, blockInfo, blockedSet, refusal, norm };
