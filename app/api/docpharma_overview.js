// DocPharma Overview — operational + value funnel by ORDER-DATE cohort.
// Answers: how many orders handed over, how many dispatched/served, COD vs prepaid value, delivery/RTO health.
// Read-only: aggregates docpharma_orders (all statuses) by order_date; no writes, no schema changes.
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');

const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
const istMonth = ts => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7) : null;
const TERMINAL = ['delivered', 'rto', 'lost', 'rejected', 'cancelled'];   // everything else = still open / in-transit

async function rateCard() {
    const { data } = await supabase.from('docpharma_rate_card').select('flat_service_charge, rto_charge, cod_collection_charge')
        .eq('is_active', true).order('effective_from', { ascending: false }).limit(1).maybeSingle();
    return data || { flat_service_charge: 0, rto_charge: 0, cod_collection_charge: 0 };
}

// GET /api/docpharma-overview?from=YYYY-MM-DD&to=YYYY-MM-DD  (order_date cohort)
router.get('/docpharma-overview', async (req, res) => {
    try {
        const rc = await rateCard();
        const flat = num(rc.flat_service_charge), rtoC = num(rc.rto_charge), codC = num(rc.cod_collection_charge);
        const fromStr = req.query.from || '', toStr = req.query.to || '';
        const build = off => {
            let b = supabase.from('docpharma_orders').select('order_status, payment_type, order_value, order_date')
                .order('order_date', { ascending: true }).range(off, off + 999);
            if (fromStr) b = b.gte('order_date', `${fromStr}T00:00:00.000+05:30`);
            if (toStr) b = b.lte('order_date', `${toStr}T23:59:59.999+05:30`);
            return b;
        };

        const byStatusPay = {};                                    // "status|pay" -> {orders,value}
        const months = {};                                         // month -> trend accumulators
        for (let off = 0; ; off += 1000) {
            const { data, error } = await build(off);
            if (error) throw new Error(error.message);
            (data || []).forEach(o => {
                const st = (o.order_status || '').toLowerCase();
                const pay = /cod/i.test(o.payment_type || '') ? 'cod' : 'prepaid';
                const val = Math.round(num(o.order_value));
                const k = st + '|' + pay; const c = byStatusPay[k] || (byStatusPay[k] = { orders: 0, value: 0 });
                c.orders++; c.value += val;
                const mk = istMonth(o.order_date) || 'unknown';
                const m = months[mk] || (months[mk] = { delivered: 0, rto: 0, lost: 0, inTransit: 0, dispatched: 0, orders: 0 });
                m.orders++;
                if (st === 'delivered') { m.delivered++; m.dispatched++; }
                else if (st === 'rto') { m.rto++; m.dispatched++; }
                else if (st === 'lost') { m.lost++; m.dispatched++; }
                else if (st === 'rejected' || st === 'cancelled') { /* never dispatched */ }
                else { m.inTransit++; m.dispatched++; }            // shipped / open
            });
            if (!data || data.length < 1000) break;
        }

        const sp = (st, pay) => byStatusPay[st + '|' + pay] || { orders: 0, value: 0 };
        const stTot = st => ({ orders: sp(st, 'cod').orders + sp(st, 'prepaid').orders, value: sp(st, 'cod').value + sp(st, 'prepaid').value });
        const delivered = stTot('delivered'), rto = stTot('rto'), lost = stTot('lost'), rejected = stTot('rejected'), cancelled = stTot('cancelled');
        const handedOver = { orders: 0, value: 0 }, inTransit = { orders: 0, value: 0 };
        Object.entries(byStatusPay).forEach(([k, v]) => {
            handedOver.orders += v.orders; handedOver.value += v.value;
            if (!TERMINAL.includes(k.split('|')[0])) { inTransit.orders += v.orders; inTransit.value += v.value; }
        });
        const dispatched = { orders: delivered.orders + rto.orders + lost.orders + inTransit.orders, value: delivered.value + rto.value + lost.value + inTransit.value };

        // COD vs Prepaid
        const cod = { orders: 0, value: 0, delivered: 0 }, prepaid = { orders: 0, value: 0, delivered: 0 };
        Object.entries(byStatusPay).forEach(([k, v]) => { const [st, pay] = k.split('|'); const t = pay === 'cod' ? cod : prepaid; t.orders += v.orders; t.value += v.value; if (st === 'delivered') t.delivered += v.value; });

        // Efficiency
        const closed = delivered.orders + rto.orders + lost.orders;
        const totalCharges = (delivered.orders + rto.orders) * flat + sp('delivered', 'cod').orders * codC + rto.orders * rtoC;
        const efficiency = {
            deliveryRate: closed ? delivered.orders / closed : 0,
            rtoRate: closed ? rto.orders / closed : 0,
            rejectionRate: handedOver.orders ? (rejected.orders + cancelled.orders) / handedOver.orders : 0,
            avgOrderValue: handedOver.orders ? Math.round(handedOver.value / handedOver.orders) : 0,
            chargePerDelivered: delivered.orders ? Math.round(totalCharges / delivered.orders) : 0,
            chargePctOfDeliveredGmv: delivered.value ? totalCharges / delivered.value : 0,
            totalCharges: Math.round(totalCharges),
        };

        // Monthly delivery-rate trend (order-date cohort). Flag cohorts still largely in transit.
        const trend = Object.keys(months).filter(m => m !== 'unknown').sort().map(mk => {
            const m = months[mk]; const cl = m.delivered + m.rto + m.lost;
            return { month: mk, orders: m.orders, dispatched: m.dispatched, delivered: m.delivered, rto: m.rto, lost: m.lost, inTransit: m.inTransit,
                deliveryRate: cl ? m.delivered / cl : 0, incomplete: m.dispatched > 0 && (m.inTransit / m.dispatched) > 0.1 };
        });

        // COD realization: delivered COD value vs what DocPharma has actually remitted.
        const { data: pays } = await supabase.from('docpharma_payments').select('amount, direction');
        let received = 0; (pays || []).forEach(p => { received += ((p.direction || 'received') === 'received' ? 1 : -1) * num(p.amount); });

        res.json({
            success: true, rateCard: rc, range: { from: fromStr || null, to: toStr || null },
            funnel: { handedOver, dispatched, delivered, rto, lost, rejected, cancelled, inTransit },
            split: { cod, prepaid },
            valueFlow: { gmvHanded: handedOver.value, deliveredGmv: delivered.value, rtoValue: rto.value, lostValue: lost.value, inTransitValue: inTransit.value },
            efficiency, trend,
            codRealization: { codDeliveredValue: sp('delivered', 'cod').value, received: Math.round(received) },
        });
    } catch (e) { console.error('[DP Overview]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
