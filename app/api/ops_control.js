// Ops Control — action-oriented delivery operations (separate from the Delivery Performance analytics).
// Phase 1: NDR Action Queue — orders currently in NDR, aged by days-since-first-attempt, with the
// customer's phone + order value pulled from Shopify, so ops can call BEFORE the courier auto-RTOs it.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const config = require('../../config');
const { supabase } = require('../supabase');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const avgOf = a => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : 0);
const hoursBetween = (a, b) => { if (!a || !b) return null; const t1 = new Date(a).getTime(), t2 = new Date(b).getTime(); if (isNaN(t1) || isNaN(t2) || t2 < t1) return null; return (t2 - t1) / 3600000; };
const daysBetween = (a, b) => { const h = hoursBetween(a, b); return h == null ? null : h / 24; };

// ── Response cache — these analytics endpoints re-scan the journey table, so cache the JSON per-URL
// for a few minutes. Skips the mutable /actions endpoints; ?fresh=1 recomputes (used by the Refresh button).
const _opsRespCache = new Map();
const OPS_CACHE_TTL = 5 * 60 * 1000;
router.use((req, res, next) => {
    // Scope STRICTLY to /ops-control paths. This router is mounted at /api, so an unscoped use()
    // runs for EVERY /api request that falls through to later routers — it silently cached all
    // /support/*, /fba/*, /docpharma* GETs for 5 minutes (the "DB changed but dashboard shows old
    // data" bug). Never widen this guard.
    if (!req.path.startsWith('/ops-control')) return next();
    if (req.method !== 'GET' || /\/actions?(\/|$)/.test(req.path)) return next();
    const key = req.originalUrl.replace(/([?&])fresh=1(&|$)/, '$1').replace(/[?&]$/, '');
    if (!req.query.fresh) {
        const hit = _opsRespCache.get(key);
        if (hit && Date.now() - hit.t < OPS_CACHE_TTL) { res.set('X-Ops-Cache', 'hit'); return res.json(hit.v); }
    }
    const orig = res.json.bind(res);
    res.json = (body) => { if (body && body.success) _opsRespCache.set(key, { t: Date.now(), v: body }); return orig(body); };
    next();
});

// ── RATE WATCH — is the courier charging us more than it did? ───────────────────────────────────
// GET /api/ops-control/rate-watch?dim=zone|state|city|courier&days=30&min=10
//
// Compares the last `days` against the IMMEDIATELY PRECEDING `days` (same length, so seasonality and
// volume growth cancel out) and reports, per group, how the average shipping charge moved.
//
// ⚠️ RAPIDSHYP ONLY, BY DATA NOT BY CHOICE. `freight_total` is written by the RapidShyp shipment-details
// fetch; measured over 180 days it covers 95.1% of RapidShyp rows and **0 of 1,796 DocPharma and 0 of 974
// Kwikship**. Rows without a charge are EXCLUDED rather than counted as ₹0 — averaging in zeros would
// invent a rate cut every time KwikShip volume grew. The response says which couriers it could see so
// the UI can state the scope instead of implying it covers everything.
//
// ⚠️ AVERAGE CHARGE MOVES FOR TWO DIFFERENT REASONS and they must not be confused: the courier changed
// its rate card, or WE shipped heavier parcels. `applied_weight` is in GRAMS (median 80g, max 1030g), so
// avg weight is returned alongside every row — a +10% charge with +10% weight is a mix change, not a
// price rise. ₹/kg is also returned, but it is a weak normaliser here because courier pricing is
// slab-based (everything under 500g pays the same), which is exactly why avg charge stays the headline.
const RW_DIM = {
    zone:    r => r.zone || null,
    state:   r => (r.dest_state || '').trim() || null,
    city:    r => (r.dest_city || '').trim() || null,
    courier: r => (r.courier || '').trim() || null,
};
router.get('/ops-control/rate-watch', async (req, res) => {
    try {
        const dim = RW_DIM[req.query.dim] ? req.query.dim : 'zone';
        const days = Math.min(365, Math.max(1, parseInt(req.query.days || '30', 10) || 30));
        const minN = Math.max(1, parseInt(req.query.min || '10', 10) || 10);
        const now = Date.now();
        const DAY = 86400000;

        // ⚠️⚠️ THE CURRENT WINDOW MUST NOT END TODAY — FREIGHT ARRIVES ~7 DAYS LATE.
        // RapidShyp bills after the shipment settles, so `freight_total` backfills days afterwards.
        // Measured 2026-08-12: coverage was 0–7% for the previous six days, 24% at day 6, 43% at day 7,
        // 70% at day 8 and ≥87% from day 9 back. Ending "current" at today therefore compared 58 charged
        // shipments against 922 — and worse, the few that HAVE settled early are a biased sample (the
        // quickest deliveries), so even the AVERAGE would have been wrong, not just the volume.
        // So: find the most recent day whose coverage is mature and end the current window THERE, with the
        // previous window the same length immediately before it. Detected from the data, never hardcoded —
        // the courier's billing lag can change and a magic "7" would rot silently.
        const SCAN_DAYS = 30, MATURE = 0.7;
        const scanFrom = new Date(now - SCAN_DAYS * DAY);
        const oldestNeeded = new Date(Math.min(now - (2 * days + SCAN_DAYS) * DAY, scanFrom.getTime()));

        const rows = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.from('shipment_journey_ecom')
                .select('order_date, source, courier, zone, dest_state, dest_city, freight_total, applied_weight, outcome')
                .gte('order_date', oldestNeeded.toISOString())
                .range(off, off + 999);
            if (error) throw new Error(error.message);
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }

        // Per-day freight coverage over the scan window → the newest mature day.
        const dayKeyOf = d => new Date(d).toISOString().slice(0, 10);
        const cov = {};
        for (const r of rows) {
            const t = new Date(r.order_date).getTime();
            if (isNaN(t) || t < scanFrom.getTime()) continue;
            const k = dayKeyOf(r.order_date);
            (cov[k] = cov[k] || { n: 0, f: 0 }).n++;
            if (Number(r.freight_total) > 0) cov[k].f++;
        }
        const matureDays = Object.entries(cov).filter(([, v]) => v.n >= 5 && v.f / v.n >= MATURE).map(([k]) => k).sort();
        // End of the newest mature day (UTC). Falls back to "now" only if nothing is mature at all, in
        // which case `lagDays` tells the UI the comparison is not trustworthy yet.
        const settledThrough = matureDays.length ? new Date(matureDays[matureDays.length - 1] + 'T23:59:59.999Z') : new Date(now);
        const lagDays = Math.max(0, Math.round((now - settledThrough.getTime()) / DAY));

        const curTo = settledThrough;
        const curFrom = new Date(curTo.getTime() - days * DAY);
        const prevFrom = new Date(curTo.getTime() - 2 * days * DAY);

        const keyOf = RW_DIM[dim];
        const g = {};
        const seenCouriers = new Set();
        let curTotal = 0, prevTotal = 0, curN = 0, prevN = 0, curWt = 0, prevWt = 0;
        for (const r of rows) {
            const f = Number(r.freight_total) || 0;
            if (f <= 0) continue;                                   // no charge recorded → not a data point
            const ts = new Date(r.order_date).getTime();
            // Only the two comparison windows. The scan reached further back (to detect the billing lag)
            // and further forward (unsettled days) than either window uses — those rows must not be counted.
            if (isNaN(ts) || ts < prevFrom.getTime() || ts > curTo.getTime()) continue;
            const k = keyOf(r); if (!k) continue;
            const isCur = ts >= curFrom.getTime();
            const w = Number(r.applied_weight) || 0;
            if (r.source) seenCouriers.add(r.source);
            const b = (g[k] = g[k] || { cur: 0, prev: 0, curSpend: 0, prevSpend: 0, curWt: 0, prevWt: 0, curWtN: 0, prevWtN: 0, curRto: 0, prevRto: 0 });
            if (isCur) { b.cur++; b.curSpend += f; curN++; curTotal += f; if (w > 0) { b.curWt += w; b.curWtN++; curWt += w; } if (r.outcome === 'rto') b.curRto++; }
            else       { b.prev++; b.prevSpend += f; prevN++; prevTotal += f; if (w > 0) { b.prevWt += w; b.prevWtN++; prevWt += w; } if (r.outcome === 'rto') b.prevRto++; }
        }

        const r2 = n => Math.round(n * 100) / 100;
        const groups = Object.entries(g).map(([key, v]) => {
            const curAvg = v.cur ? v.curSpend / v.cur : 0;
            const prevAvg = v.prev ? v.prevSpend / v.prev : 0;
            const curKg = v.curWt ? v.curSpend / (v.curWt / 1000) : 0;      // applied_weight is GRAMS
            const prevKg = v.prevWt ? v.prevSpend / (v.prevWt / 1000) : 0;
            const curW = v.curWtN ? v.curWt / v.curWtN : 0;
            const prevW = v.prevWtN ? v.prevWt / v.prevWtN : 0;
            return {
                key, cur: v.cur, prev: v.prev,
                curAvg: r2(curAvg), prevAvg: r2(prevAvg),
                deltaAvg: r2(curAvg - prevAvg),
                deltaPct: prevAvg > 0 ? r2(((curAvg - prevAvg) / prevAvg) * 100) : null,
                curSpend: Math.round(v.curSpend), prevSpend: Math.round(v.prevSpend),
                curKg: r2(curKg), prevKg: r2(prevKg),
                kgDeltaPct: prevKg > 0 ? r2(((curKg - prevKg) / prevKg) * 100) : null,
                curWeight: Math.round(curW), prevWeight: Math.round(prevW),
                weightDeltaPct: prevW > 0 ? r2(((curW - prevW) / prevW) * 100) : null,
                // What the rate change is COSTING (or saving) right now: the per-shipment move applied to
                // this period's volume. A +₹2 move on 1,500 shipments is ₹3,000 — the number worth acting on,
                // which a percentage alone never shows.
                impact: Math.round((curAvg - prevAvg) * v.cur),
                rtoPct: pct(v.curRto, v.cur),
                // Enough evidence on BOTH sides to be worth reading.
                thin: v.cur < minN || v.prev < minN,
            };
        }).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));

        const solid = groups.filter(x => !x.thin);
        const curAvgAll = curN ? curTotal / curN : 0, prevAvgAll = prevN ? prevTotal / prevN : 0;
        res.json({
            success: true, dim, days, min: minN,
            range: { current: { from: curFrom.toISOString(), to: curTo.toISOString() },
                     previous: { from: prevFrom.toISOString(), to: curFrom.toISOString() } },
            // The UI states the real window and why it stops short of today, so nobody reads this as
            // "up to this morning" and wonders where the last week went.
            settlement: { settledThrough: curTo.toISOString(), lagDays, matureThreshold: MATURE,
                note: lagDays > 0
                    ? `Shipping charges arrive about ${lagDays} day${lagDays === 1 ? '' : 's'} after dispatch, so both periods end ${curTo.toISOString().slice(0, 10)} — the newest date with complete billing.`
                    : 'Charges are up to date.' },
            totals: {
                curN, prevN, curSpend: Math.round(curTotal), prevSpend: Math.round(prevTotal),
                curAvg: r2(curAvgAll), prevAvg: r2(prevAvgAll),
                deltaPct: prevAvgAll > 0 ? r2(((curAvgAll - prevAvgAll) / prevAvgAll) * 100) : null,
                curWeight: curN ? Math.round(curWt / curN) : 0, prevWeight: prevN ? Math.round(prevWt / prevN) : 0,
                // Total ₹ the rate move added/saved across every group with evidence on both sides.
                impact: solid.reduce((a, x) => a + x.impact, 0),
                inflated: solid.filter(x => x.deltaPct > 0).length,
                deflated: solid.filter(x => x.deltaPct < 0).length,
            },
            // Scope is stated, never implied — freight exists for RapidShyp only today.
            coverage: { sources: [...seenCouriers].sort(), note: 'Shipping charges are only recorded for RapidShyp shipments; KwikShip and DocPharma record none, so they are excluded rather than counted as ₹0.' },
            groups,
        });
    } catch (e) { console.error('[OpsControl RateWatch]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

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
        const agedVals = list.filter(r => r.daysInNdr != null);   // exclude unknown-age rows so the average isn't diluted by 0s
        const avgDays = agedVals.length ? Math.round(agedVals.reduce((s, r) => s + r.daysInNdr, 0) / agedVals.length * 10) / 10 : 0;
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
        // Aggregated in SQL (see public.ops_courier_scorecard) instead of scanning the whole journey table.
        const { data, error } = await supabase.rpc('ops_courier_scorecard', { p_days: days });
        if (error) throw new Error(error.message);
        const list = (data || []).map(r => ({
            courier: r.courier, shipped: Number(r.shipped), rto: Number(r.rto), delivered: Number(r.delivered),
            rtoPct: Number(r.rto_pct), ndrRecovery: Number(r.ndr_recovery),
            silent: Number(r.silent), silentPct: Number(r.silent_pct),
            otdAvg: Number(r.otd_avg), dtdAvg: Number(r.dtd_avg),
        }));
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
// ── NDR Action (RapidShyp) ──────────────────────────────────────────────────────────────────────────
// POST /api/ndr-action  { awb, action: 'RE_ATTEMPT'|'RETURN', phone?, address1?, address2?, order? }
// Fires RapidShyp's NDR-action API for a pending NDR: reattempt (with updated phone/address) or return.
// Gated to ops-control OR delivery-perf users (see _VIEW_PERMS). The taken action is logged to
// ops_actions_ecom so the NDR queue reflects it.
router.post('/ndr-action', async (req, res) => {
    try {
        const b = req.body || {};
        const awb = String(b.awb || '').trim();
        const wantReattempt = /^re.?attempt$/i.test(String(b.action || ''));
        const wantReturn = /^return$/i.test(String(b.action || ''));
        if (!awb) return res.status(400).json({ success: false, message: 'AWB is required.' });
        if (!wantReattempt && !wantReturn) return res.status(400).json({ success: false, message: 'action must be RE_ATTEMPT or RETURN.' });
        const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
        const address1 = String(b.address1 || '').trim();
        if (wantReattempt) {
            if (!/^\d{10}$/.test(phone)) return res.status(400).json({ success: false, message: 'A valid 10-digit phone is required for a reattempt.' });
            if (!address1) return res.status(400).json({ success: false, message: 'address1 is required for a reattempt.' });
        }
        if (!config.RAPIDSHYP_API_KEY) return res.status(500).json({ success: false, message: 'RapidShyp API key not configured.' });

        const fire = (actionValue) => axios.post('https://api.rapidshyp.com/rapidshyp/apis/v1/ndr/action',
            wantReattempt
                ? { awb, action: actionValue, phone, address1, address2: String(b.address2 || '').trim() }
                : { awb, action: actionValue },
            { headers: { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });

        // RapidShyp's docs are self-contradictory on the reattempt value (curl example "REATTEMPT",
        // parameter table "RE_ATTEMPT"). Try the curl spelling first; on an invalid-action style
        // rejection (and ONLY then — never after a success/other failure), retry the other spelling.
        let r = await fire(wantReturn ? 'RETURN' : 'REATTEMPT');
        const invalidAction = resp => resp.status < 500 && /invalid.{0,20}action|action.{0,20}invalid|action.{0,20}not.{0,10}(valid|allowed|supported)/i.test(JSON.stringify(resp.data || {}));
        if (wantReattempt && invalidAction(r)) r = await fire('RE_ATTEMPT');

        const ok = r.status < 400 && !(r.data && (r.data.success === false || r.data.status === false));
        if (ok) {
            // Reflect in the NDR queue (best-effort log; the queue's Hide-handled uses this).
            if (b.order) {
                await supabase.from('ops_actions_ecom').upsert(
                    { order_name: String(b.order).trim(), tab: 'ndr', status: wantReturn ? 'return_requested' : 'reattempt_requested', updated_by: req.user && req.user.sub, updated_at: new Date().toISOString() },
                    { onConflict: 'order_name,tab' }).then(() => {}).catch(() => {});
            }
            return res.json({ success: true, message: wantReturn ? 'Return requested with RapidShyp.' : 'Reattempt requested with RapidShyp.', rapidshyp: r.data });
        }
        const msg = (r.data && (r.data.msg || r.data.message || JSON.stringify(r.data).slice(0, 200))) || `HTTP ${r.status}`;
        return res.status(502).json({ success: false, message: `RapidShyp rejected the action: ${msg}` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/ops-control/risk — scores not-yet-shipped orders so ops verifies the risky ones first.
// Scoring lives in cod_risk.js (shared with the Orders-dashboard badges) and now also weighs the
// customer's OWN history — past RTOs by the same phone/email are the strongest predictor.
router.get('/ops-control/risk', async (req, res) => {
    try {
        const { computeRiskList } = require('./cod_risk');
        const scored = (await computeRiskList())
            .filter(o => o.band !== 'Low')
            .sort((a, b) => (b.block ? 1 : 0) - (a.block ? 1 : 0) || b.score - a.score);   // non-serviceable first

        const highValue = scored.filter(o => o.band === 'High').reduce((s, o) => s + (o.value || 0), 0);
        res.json({
            success: true,
            summary: {
                flagged: scored.length, high: scored.filter(o => o.band === 'High').length,
                unserviceable: scored.filter(o => o.block).length, atRiskValue: Math.round(highValue),
            },
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
                eddCoverage: pct(rows.filter(r => r.first_edd).length, rows.length),   // % of shipments with an EDD on record (SLA-breach detection coverage)
                byType,
            },
            list,
        });
    } catch (e) { console.error('[OpsControl Exceptions]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── Prepaid loss/misroute predictor ─────────────────────────────────────────────────────────────
// Scores in-transit PREPAID orders by their chance of never reaching the customer (courier lost it /
// returned without attempting), so ops can redispatch a fresh one proactively.
//   Risk% = strongest of { lateness-vs-EDD curve, extreme-transit net, courier·zone prior },
//           then proportional bumps for an unresolved failed attempt / misroute.
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
                .select('order_name, awb, courier, zone, dispatched_at, order_date, out_for_delivery_at, first_edd, status_code, ndr_count, outcome, payment_mode, dest_state, dest_city, dest_pincode')
                .in('outcome', ['in_transit', 'ndr_pending']).gte('order_date', recent).range(off, off + 999);
            if (error) throw new Error(error.message);
            live.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        const prepaid = live.filter(r => r.payment_mode && !/cod/i.test(r.payment_mode));

        // Typical door-to-door transit budget per zone (fallback when the courier gave no EDD).
        const ZONE_BUDGET = { A: 3, B: 4, C: 6, D: 8, E: 10 };
        const now = Date.now();
        const daysSince = t => t ? (now - new Date(t).getTime()) / 86400000 : null;

        const scored = prepaid.map(r => {
            const cf = Math.round(cRate(r.courier || 'Unknown') * 10) / 10;   // courier historical fail %
            const zf = Math.round(zRate(r.zone || 'NA') * 10) / 10;          // zone historical fail %
            const reasons = [];
            const transitAge = daysSince(r.dispatched_at || r.order_date);
            const budget = ZONE_BUDGET[r.zone] || 7;

            // ── Overdue: take the WORSE of (a) days past the courier's EDD and (b) days over the zone's
            //    transit budget. Couriers keep pushing the EDD forward to mask delays, so a badly-stuck
            //    parcel can show ~0 past its (extended) EDD — the immovable zone budget catches those. ──
            const cands = [];
            if (r.first_edd != null) cands.push(daysSince(r.first_edd));
            if (transitAge != null) cands.push(transitAge - budget);
            const od = cands.length ? Math.max(0, ...cands) : 0;

            // Lateness is the dominant signal — a saturating curve so extreme overdue approaches ~90%.
            //   od: 2→31, 4→52, 6→67, 8→76, 11→84, 15→90
            const lateRisk = od > 0 ? 95 * (1 - Math.exp(-od / 5)) : 0;
            // Absolute safety net for truly extreme transits (in case EDD/budget is missing or wrong).
            const absRisk = transitAge >= 20 ? 88 : 0;
            // Historical prior (courier × zone), damped — acts as a floor, never the driver.
            const prior = 0.55 * cf + 0.35 * zf;

            // Strongest evidence wins (don't dilute a strong signal by averaging).
            let risk = Math.max(prior, lateRisk, absRisk);
            // A failed attempt still unresolved → proportional push toward redispatch.
            if ((r.ndr_count || 0) > 0) { risk += (100 - risk) * 0.30; reasons.push('failed attempt unresolved'); }
            // Misrouted by the courier → high chance of loss/delay.
            if (/MSR|RMSR/i.test(r.status_code || '')) { risk += (100 - risk) * 0.35; reasons.push('misrouted'); }
            risk = Math.min(96, Math.round(risk));

            // Human-readable "why"
            if (od >= 1) reasons.unshift(`${Math.round(transitAge)}d in transit · ${Math.round(od)}d overdue`);
            else if (transitAge != null && transitAge >= 6) reasons.unshift(`${Math.round(transitAge)}d in transit`);
            if (cf >= 12) reasons.push(`${r.courier} fails ${cf}%`);
            if (zf >= 15) reasons.push(`Zone ${r.zone} ${zf}%`);

            const band = risk >= 55 ? 'High' : risk >= 30 ? 'Medium' : 'Low';
            return { order: r.order_name, awb: r.awb, courier: r.courier || '—', zone: r.zone || '—', state: r.outcome,
                     dest_state: r.dest_state || null, dest_city: r.dest_city || null, dest_pincode: r.dest_pincode || null,
                     daysInTransit: transitAge != null ? Math.round(transitAge) : null, risk, band, reasons };
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

// ── Row action state — mark items handled so worked rows drop off & the team can coordinate ──────
// GET /api/ops-control/actions[?tab=ndr]  → current action state for merging into the tab lists.
router.get('/ops-control/actions', async (req, res) => {
    try {
        let q = supabase.from('ops_actions_ecom').select('order_name, tab, status, note, snooze_until, updated_at');
        if (req.query.tab) q = q.eq('tab', String(req.query.tab));
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        res.json({ success: true, actions: data || [] });
    } catch (e) { console.error('[OpsControl Actions GET]', e.message); res.status(500).json({ success: false, error: e.message }); }
});
// POST /api/ops-control/action  { order_name, tab, status, note?, snooze_until? }   (status:'clear' removes it)
router.post('/ops-control/action', async (req, res) => {
    try {
        const { order_name, tab, status, note, snooze_until } = req.body || {};
        const on = String(order_name || '').replace('#', '').trim();
        if (!on || !tab) return res.status(400).json({ success: false, error: 'order_name and tab are required' });
        if (!status || status === 'clear') {
            const { error } = await supabase.from('ops_actions_ecom').delete().eq('order_name', on).eq('tab', String(tab));
            if (error) throw new Error(error.message);
            return res.json({ success: true, cleared: true });
        }
        const row = { order_name: on, tab: String(tab), status: String(status), note: note || null,
                      snooze_until: snooze_until || null, updated_at: new Date().toISOString() };
        const { error } = await supabase.from('ops_actions_ecom').upsert(row, { onConflict: 'order_name,tab' });
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { console.error('[OpsControl Action POST]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
