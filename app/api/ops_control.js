// Ops Control — action-oriented delivery operations (separate from the Delivery Performance analytics).
// Phase 1: NDR Action Queue — orders currently in NDR, aged by days-since-first-attempt, with the
// customer's phone + order value pulled from Shopify, so ops can call BEFORE the courier auto-RTOs it.
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const avgOf = a => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : 0);
const hoursBetween = (a, b) => { if (!a || !b) return null; const t1 = new Date(a).getTime(), t2 = new Date(b).getTime(); if (isNaN(t1) || isNaN(t2) || t2 < t1) return null; return (t2 - t1) / 3600000; };
const daysBetween = (a, b) => { const h = hoursBetween(a, b); return h == null ? null : h / 24; };

// GET /api/ops-control/ndr-queue?days=45
router.get('/ops-control/ndr-queue', async (req, res) => {
    try {
        const days = parseInt(req.query.days || '45', 10) || 45;
        const since = new Date(Date.now() - days * 86400000).toISOString();

        // 1. Journey rows still in NDR (reached delivery, failed ≥1 attempt, not yet resolved).
        const rows = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase
                .from('shipment_journey_ecom')
                .select('order_name, awb, courier, zone, payment_mode, ndr_count, ndr_reasons, out_for_delivery_at, order_date, order_type')
                .eq('outcome', 'ndr_pending')
                .gte('order_date', since)
                .range(off, off + 999);
            if (error) throw new Error(error.message);
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }

        // 2. Enrich with the real customer phone + order value from Shopify (names carry a '#').
        const names = [...new Set(rows.map(r => r.order_name).filter(Boolean))];
        const emap = {};
        for (let i = 0; i < names.length; i += 300) {
            const batch = names.slice(i, i + 300);
            const { data } = await supabase
                .from('enriched_orders_ecom')
                .select('name, phone, email, total_price')
                .in('name', batch.flatMap(n => ['#' + n, n]));
            (data || []).forEach(e => { emap[String(e.name).replace('#', '')] = e; });
        }

        const now = Date.now();
        const list = rows.map(r => {
            const e = emap[r.order_name] || {};
            const daysInNdr = r.out_for_delivery_at
                ? Math.round((now - new Date(r.out_for_delivery_at).getTime()) / 86400000 * 10) / 10 : null;
            return {
                order: r.order_name, awb: r.awb, courier: r.courier || '—', zone: r.zone || '—',
                payment: r.payment_mode || null, type: r.order_type || null,
                ndrs: r.ndr_count || 0, reasons: (r.ndr_reasons || []).slice(0, 3),
                phone: e.phone || null, email: e.email || null,
                value: e.total_price != null ? Math.round(Number(e.total_price)) : null,
                daysInNdr,
            };
        }).sort((a, b) => (b.daysInNdr || 0) - (a.daysInNdr || 0));   // most urgent (oldest) first

        const recoverable = list.reduce((s, r) => s + (r.value || 0), 0);
        const aged = list.filter(r => (r.daysInNdr || 0) >= 3).length;
        const avgDays = list.length ? Math.round(list.reduce((s, r) => s + (r.daysInNdr || 0), 0) / list.length * 10) / 10 : 0;
        const codValue = list.filter(r => /cod/i.test(r.payment || '')).reduce((s, r) => s + (r.value || 0), 0);

        res.json({
            success: true,
            summary: { total: list.length, aged, recoverable: Math.round(recoverable), codValue: Math.round(codValue), avgDays },
            list,
        });
    } catch (e) {
        console.error('[OpsControl NDR] error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Phase 2: Courier Scorecard (+ silent-RTO accountability) ────────────────────────────────────
// GET /api/ops-control/courier-scorecard?days=90
router.get('/ops-control/courier-scorecard', async (req, res) => {
    try {
        const days = parseInt(req.query.days || '90', 10) || 90;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const rows = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.from('shipment_journey_ecom')
                .select('courier, outcome, ndr_count, rto_no_attempt, dispatched_at, order_date, delivered_at')
                .gte('order_date', since).range(off, off + 999);
            if (error) throw new Error(error.message);
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        const m = {};
        rows.forEach(r => {
            const c = r.courier || 'Unknown';
            const x = m[c] || (m[c] = { shipped: 0, rto: 0, delivered: 0, ndr: 0, ndrRec: 0, silent: 0, otd: [], dtd: [] });
            const resolved = r.outcome === 'rto' || r.outcome === 'delivered';
            if (resolved) { x.shipped++; if (r.outcome === 'rto') x.rto++; else x.delivered++; }
            if ((r.ndr_count || 0) > 0) { x.ndr++; if (r.outcome === 'delivered') x.ndrRec++; }
            if (r.outcome === 'rto' && r.rto_no_attempt) x.silent++;
            const o = hoursBetween(r.order_date, r.dispatched_at); if (o != null) x.otd.push(o);
            const d = daysBetween(r.dispatched_at, r.delivered_at); if (d != null) x.dtd.push(d);
        });
        const list = Object.entries(m).filter(([, x]) => x.shipped >= 20).map(([c, x]) => ({
            courier: c, shipped: x.shipped, rto: x.rto, delivered: x.delivered,
            rtoPct: pct(x.rto, x.shipped), ndrRecovery: pct(x.ndrRec, x.ndr),
            silent: x.silent, silentPct: pct(x.silent, x.rto),
            otdAvg: avgOf(x.otd), dtdAvg: avgOf(x.dtd),
        })).sort((a, b) => b.shipped - a.shipped);
        res.json({ success: true, days, list });
    } catch (e) { console.error('[OpsControl Courier]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── Phase 3: Cost & Hotspots (segments, top RTO cities) ─────────────────────────────────────────
// GET /api/ops-control/hotspots?days=90
router.get('/ops-control/hotspots', async (req, res) => {
    try {
        const days = parseInt(req.query.days || '90', 10) || 90;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const rows = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.from('shipment_journey_ecom')
                .select('outcome, payment_mode, order_type, zone')
                .gte('order_date', since).range(off, off + 999);
            if (error) throw new Error(error.message);
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        const grp = keyFn => {
            const g = {};
            rows.forEach(r => {
                if (r.outcome !== 'rto' && r.outcome !== 'delivered') return;
                const k = keyFn(r); if (k == null) return;
                (g[k] = g[k] || { resolved: 0, rto: 0 }); g[k].resolved++; if (r.outcome === 'rto') g[k].rto++;
            });
            return Object.entries(g).map(([key, v]) => ({ key, resolved: v.resolved, rto: v.rto, rtoPct: pct(v.rto, v.resolved) }));
        };
        const byPayment = grp(r => /cod/i.test(r.payment_mode || '') ? 'COD' : (r.payment_mode ? 'Prepaid' : null));
        const byType = grp(r => r.order_type || null);
        const byZone = grp(r => r.zone || null).sort((a, b) => a.key.localeCompare(b.key));
        const rtoCount = rows.filter(r => r.outcome === 'rto').length;

        const { data: cityRows } = await supabase.from('journey_city_rto').select('city, state, resolved, rto').gte('resolved', 30);
        const topCities = (cityRows || []).filter(c => c.city).map(c => ({ city: c.city, state: c.state, resolved: c.resolved, rto: c.rto, rtoPct: pct(c.rto, c.resolved) }))
            .sort((a, b) => b.rtoPct - a.rtoPct).slice(0, 15);

        res.json({ success: true, days, rtoCount, byPayment, byType, byZone, topCities });
    } catch (e) { console.error('[OpsControl Hotspots]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── Phase 4: Pre-dispatch RTO Risk flag ─────────────────────────────────────────────────────────
// GET /api/ops-control/risk — scores not-yet-shipped orders so ops verifies the risky ones first.
router.get('/ops-control/risk', async (req, res) => {
    try {
        // 1. Historical RTO rate per city (from the view).
        const { data: cityRows } = await supabase.from('journey_city_rto').select('city, resolved, rto');
        const cityRto = {};
        (cityRows || []).forEach(c => { if (c.city && c.resolved >= 15) cityRto[c.city] = pct(c.rto, c.resolved); });

        // 2. Not-yet-dispatched, non-cancelled orders in the pipeline (recent).
        const PIPELINE = ['Open', 'Confirmed', 'Printed', 'Ready to dispatch', 'Assigned', 'On Hold'];
        const since = new Date(Date.now() - 20 * 86400000).toISOString();
        const orders = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.from('b2c_order_easycom')
                .select('reference_code, order_status, payment_mode, order_total, shipping_city, shipping_state, order_date, raw_data')
                .ilike('reference_code', 'TE%').in('order_status', PIPELINE).gte('order_date', since)
                .range(off, off + 999);
            if (error) throw new Error(error.message);
            orders.push(...(data || []));
            if (!data || data.length < 1000) break;
        }

        // 3. New vs Repeat from the Shopify tag.
        const names = [...new Set(orders.map(o => o.reference_code))];
        const repeat = new Set();
        for (let i = 0; i < names.length; i += 300) {
            const batch = names.slice(i, i + 300);
            const { data } = await supabase.from('enriched_orders_ecom').select('name, tags').in('name', batch.flatMap(n => ['#' + n, n]));
            (data || []).forEach(e => { if (/(^|,)\s*repeat\s*(,|$)/i.test(e.tags || '')) repeat.add(String(e.name).replace('#', '')); });
        }

        // 4. Score each order.
        const scored = orders.map(o => {
            const city = String(o.shipping_city || (o.raw_data && o.raw_data.city) || '').trim().toUpperCase();
            const isCOD = /cod/i.test(o.payment_mode || '');
            const isNew = !repeat.has(o.reference_code);
            const cr = cityRto[city] != null ? cityRto[city] : null;
            let score = 0; const reasons = [];
            if (isCOD) { score += 40; reasons.push('COD'); }
            if (isNew) { score += 20; reasons.push('First-time buyer'); }
            if (cr != null) {
                if (cr >= 30) { score += 30; reasons.push(`High-RTO city ${cr}%`); }
                else if (cr >= 20) { score += 20; reasons.push(`Elevated-RTO city ${cr}%`); }
                else if (cr >= 12) { score += 10; reasons.push(`City RTO ${cr}%`); }
            }
            const band = score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';
            return {
                order: o.reference_code, status: o.order_status, payment: o.payment_mode || null,
                value: o.order_total != null ? Math.round(Number(o.order_total)) : null,
                city: o.shipping_city || (o.raw_data && o.raw_data.city) || '—', state: o.shipping_state || (o.raw_data && o.raw_data.state) || '—',
                type: isNew ? 'new' : 'repeat', cityRto: cr, score, band, reasons,
            };
        }).filter(o => o.band !== 'Low').sort((a, b) => b.score - a.score);

        const highValue = scored.filter(o => o.band === 'High').reduce((s, o) => s + (o.value || 0), 0);
        res.json({
            success: true,
            summary: { flagged: scored.length, high: scored.filter(o => o.band === 'High').length, atRiskValue: Math.round(highValue) },
            list: scored,
        });
    } catch (e) { console.error('[OpsControl Risk]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── Exceptions & Claims ─────────────────────────────────────────────────────────────────────────
// Problem shipments split by the action they need:
//   • redispatch/refund  → PREPAID orders that RTO'd or were lost (customer paid, didn't receive)
//   • claim (courier)    → Lost / Damaged / Disposed / Missing / Silent-RTO (courier fault → owes ₹)
//   • monitor            → Misrouted (still moving, watch it)
// Days a shipment settled (or is stuck) past its FIRST promised EDD (null if no EDD on record).
function slaDelayDays(r) {
    if (!r.first_edd) return null;
    const end = r.delivered_at ? new Date(r.delivered_at).getTime()
              : r.rto_at ? new Date(r.rto_at).getTime()
              : Date.now();   // still undelivered → measured to now
    const t = new Date(r.first_edd).getTime();
    if (isNaN(t)) return null;
    return Math.round((end - t) / 86400000 * 10) / 10;
}
function classifyException(r, sla) {
    const sc = (r.status_code || '').toUpperCase();
    const prepaid = r.payment_mode && !/cod/i.test(r.payment_mode);
    if (r.outcome === 'lost') {
        const type = ['DMG', 'RDMG'].includes(sc) ? 'Damaged' : ['DPO', 'RDPO'].includes(sc) ? 'Disposed' : sc === 'RMSN' ? 'Missing' : 'Lost';
        return { type, action: 'claim' };
    }
    if (['MSR', 'RMSR'].includes(sc) && r.outcome !== 'delivered' && r.outcome !== 'rto') return { type: 'Misrouted', action: 'monitor' };
    if (r.outcome === 'rto') {
        if (r.rto_no_attempt) return { type: 'Silent RTO', action: 'claim' };
        if (prepaid) return { type: 'Prepaid RTO', action: 'redispatch' };
    }
    // RapidShyp delivery-guarantee: delivered (or stuck) >5 days past the first EDD → claimable, even if it eventually arrived.
    if (sla != null && sla > 5 && (r.outcome === 'delivered' || r.outcome === 'in_transit')) return { type: 'Delayed >5d', action: 'claim' };
    return null;
}

// GET /api/ops-control/exceptions?days=90
router.get('/ops-control/exceptions', async (req, res) => {
    try {
        const days = parseInt(req.query.days || '90', 10) || 90;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const rows = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.from('shipment_journey_ecom')
                .select('order_name, awb, courier, zone, payment_mode, outcome, rto_no_attempt, status_code, rto_at, delivered_at, first_edd, order_date, ndr_reasons')
                .gte('order_date', since).range(off, off + 999);
            if (error) throw new Error(error.message);
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        const flagged = [];
        rows.forEach(r => { const sla = slaDelayDays(r); const ex = classifyException(r, sla); if (ex) flagged.push({ r, ex, sla }); });

        // enrich with order value + phone
        const names = [...new Set(flagged.map(f => f.r.order_name).filter(Boolean))];
        const emap = {};
        for (let i = 0; i < names.length; i += 300) {
            const batch = names.slice(i, i + 300);
            const { data } = await supabase.from('enriched_orders_ecom').select('name, phone, total_price').in('name', batch.flatMap(n => ['#' + n, n]));
            (data || []).forEach(e => { emap[String(e.name).replace('#', '')] = e; });
        }

        const list = flagged.map(({ r, ex, sla }) => {
            const e = emap[r.order_name] || {};
            return {
                order: r.order_name, awb: r.awb, courier: r.courier || '—', zone: r.zone || '—',
                payment: r.payment_mode || null, type: ex.type, action: ex.action,
                value: e.total_price != null ? Math.round(Number(e.total_price)) : null, phone: e.phone || null,
                rto_at: r.rto_at ? String(r.rto_at).slice(0, 10) : null, reasons: (r.ndr_reasons || []).slice(0, 2),
                slaDelay: (sla != null && sla > 5) ? Math.round(sla) : null,   // days past first EDD (claimable) — null until EDD captured
            };
        }).sort((a, b) => (b.value || 0) - (a.value || 0));

        const sum = (pred, val) => list.filter(pred).reduce((s, r) => s + (val ? (r.value || 0) : 1), 0);
        const byType = {};
        list.forEach(r => { byType[r.type] = (byType[r.type] || 0) + 1; });
        res.json({
            success: true,
            summary: {
                claimCount: sum(r => r.action === 'claim', 0), claimValue: sum(r => r.action === 'claim', 1),
                redispatchCount: sum(r => r.action === 'redispatch', 0), redispatchValue: sum(r => r.action === 'redispatch', 1),
                monitorCount: sum(r => r.action === 'monitor', 0),
                slaBreachCount: sum(r => r.slaDelay != null, 0), slaBreachValue: sum(r => r.slaDelay != null, 1),
                byType,
            },
            list,
        });
    } catch (e) { console.error('[OpsControl Exceptions]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── Prepaid loss/misroute predictor ─────────────────────────────────────────────────────────────
// Scores in-transit PREPAID orders by their chance of never reaching the customer (courier lost it /
// returned without attempting), so ops can redispatch a fresh one proactively.
//   Risk% = base(courier·zone historical failure rate) + transit-stuck penalty + prior-NDR penalty
// GET /api/ops-control/prepaid-risk
router.get('/ops-control/prepaid-risk', async (req, res) => {
    try {
        // 1. Historical failure base rates (failure = lost OR silent-RTO) by courier and by zone.
        const since = new Date(Date.now() - 120 * 86400000).toISOString();
        const hist = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.from('shipment_journey_ecom')
                .select('courier, zone, outcome, rto_no_attempt')
                .gte('order_date', since).range(off, off + 999);
            if (error) throw new Error(error.message);
            hist.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        const isFail = r => r.outcome === 'lost' || (r.outcome === 'rto' && r.rto_no_attempt);
        const isResolved = r => ['delivered', 'rto', 'lost'].includes(r.outcome);
        const cAgg = {}, zAgg = {}; let gShip = 0, gFail = 0;
        hist.forEach(r => { if (!isResolved(r)) return;
            const c = r.courier || 'Unknown', z = r.zone || 'NA';
            (cAgg[c] = cAgg[c] || { s: 0, f: 0 }); (zAgg[z] = zAgg[z] || { s: 0, f: 0 });
            cAgg[c].s++; zAgg[z].s++; gShip++; if (isFail(r)) { cAgg[c].f++; zAgg[z].f++; gFail++; }
        });
        const gRate = gShip ? (gFail / gShip) * 100 : 5;
        const cRate = c => (cAgg[c] && cAgg[c].s >= 25) ? (cAgg[c].f / cAgg[c].s) * 100 : gRate;
        const zRate = z => (zAgg[z] && zAgg[z].s >= 25) ? (zAgg[z].f / zAgg[z].s) * 100 : gRate;

        // 2. In-transit / NDR-pending PREPAID orders (still could be lost).
        const days = parseInt(req.query.days || '60', 10) || 60;
        const recent = new Date(Date.now() - days * 86400000).toISOString();
        const live = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.from('shipment_journey_ecom')
                .select('order_name, awb, courier, zone, dispatched_at, order_date, ndr_count, outcome, payment_mode')
                .in('outcome', ['in_transit', 'ndr_pending']).gte('order_date', recent).range(off, off + 999);
            if (error) throw new Error(error.message);
            live.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        const prepaid = live.filter(r => r.payment_mode && !/cod/i.test(r.payment_mode));

        const now = Date.now();
        const scored = prepaid.map(r => {
            const cr = Math.round(cRate(r.courier || 'Unknown') * 10) / 10;
            const zr = Math.round(zRate(r.zone || 'NA') * 10) / 10;
            let risk = 0.6 * cr + 0.4 * zr; const reasons = [];
            if (cr >= 10) reasons.push(`${r.courier} fails ${cr}%`);
            if (zr >= 15) reasons.push(`Zone ${r.zone} ${zr}%`);
            const ref = r.dispatched_at || r.order_date;
            const daysT = ref ? Math.round((now - new Date(ref).getTime()) / 86400000) : null;
            if (daysT != null) {
                if (daysT > 12) { risk += 40; reasons.push(`${daysT}d in transit`); }
                else if (daysT > 8) { risk += 25; reasons.push(`${daysT}d in transit`); }
                else if (daysT > 5) { risk += 12; reasons.push(`${daysT}d in transit`); }
            }
            if ((r.ndr_count || 0) > 0) { risk += 10; reasons.push('had a failed attempt'); }
            risk = Math.min(95, Math.round(risk));
            const band = risk >= 40 ? 'High' : risk >= 20 ? 'Medium' : 'Low';
            return { order: r.order_name, awb: r.awb, courier: r.courier || '—', zone: r.zone || '—', state: r.outcome, daysInTransit: daysT, risk, band, reasons };
        }).filter(o => o.band !== 'Low').sort((a, b) => b.risk - a.risk);

        // 3. enrich with value + phone
        const names = [...new Set(scored.map(o => o.order))];
        const emap = {};
        for (let i = 0; i < names.length; i += 300) {
            const batch = names.slice(i, i + 300);
            const { data } = await supabase.from('enriched_orders_ecom').select('name, phone, total_price').in('name', batch.flatMap(n => ['#' + n, n]));
            (data || []).forEach(e => { emap[String(e.name).replace('#', '')] = e; });
        }
        scored.forEach(o => { const e = emap[o.order] || {}; o.value = e.total_price != null ? Math.round(Number(e.total_price)) : null; o.phone = e.phone || null; });

        const high = scored.filter(o => o.band === 'High');
        res.json({
            success: true,
            summary: {
                flagged: scored.length, high: high.length,
                atRiskValue: high.reduce((s, o) => s + (o.value || 0), 0),
                prepaidInTransit: prepaid.length,
            },
            list: scored,
        });
    } catch (e) { console.error('[OpsControl PrepaidRisk]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
