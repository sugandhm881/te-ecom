// Kwikship (GoKwik) delivery-journey sync — writes into shipment_journey_ecom with source='kwikship',
// the SAME shared table used for RapidShyp + DocPharma (so the Delivery Performance / SLA / claims
// dashboards treat Kwikship as just another platform).
//
// Kwikship is PULL-only (no webhook), like DocPharma. But unlike DocPharma it exposes a real scan
// timeline via GET /api/v1/shipments/:awb → status_history[], so Kwikship rows get FULL attempts /
// NDR / silent-RTO detection (richer than DocPharma's summary fields).
//
// Trigger: nightly 2:00 AM IST cron (server.js). Scope: ONLY Kwikship-allocated orders — identified by
// EasyEcom's own authoritative field raw_data->>'courier_aggregator_name' = 'GoKwik Outbound' (RapidShyp
// orders read 'RapidShyp- Outbound'; the two ship from the SAME warehouse so `location` can't tell them
// apart — it's a generated column keyed on warehouseId). Skips shipments already final → one API call
// per non-final Kwikship shipment, zero wasted calls. RapidShyp's API returns "not found" for GoKwik
// AWBs, so the RapidShyp/DocPharma journey cron never writes a conflicting row for these.
//
// Auth: gk-app-id + gk-app-secret headers (config.KWIKSHIP_APP_ID / _APP_SECRET).

const axios = require('axios');
const config = require('../../config');
const { supabase } = require('../supabase');
const { saveJourney, zoneFromState, supersedeStaleJourneys } = require('./delivery_journey');

// ── Kwikship internal status → journey event type ───────────────────────────
// Statuses are the documented "internal statuses" (Public API, Shipment Status Groups). Order matters:
// RTO before delivered ("rto_delivered" must not count as a customer delivery).
function classifyKwikStatus(status) {
    const s = String(status || '').toLowerCase().trim();
    if (!s) return 'other';
    // RTO — every rto_* sub-status (rto_initiated / rto_in_transit / rto_delivered / rto_ndr / …).
    if (/^rto|return_delivered|return_pickup|return_transit/.test(s)) return 'rto';
    // Out for delivery = a customer delivery attempt in progress.
    if (s === 'out_for_delivery') return 'attempt';
    // Actual delivery only ("delivered" / "return_delivered" already caught above as rto).
    if (s === 'delivered') return 'delivered';
    // Pickup / dispatch — shipment left origin (Order→Dispatch TAT boundary).
    if (s === 'pickup_completed' || s === 'picked_up') return 'pickup';
    // Failed delivery attempt / NDR — undelivered + the numbered NDR attempts.
    if (s === 'undelivered' || /^ndr_attempt/.test(s)) return 'ndr';
    // Terminal loss — neither delivered nor RTO.
    if (s === 'lost' || s === 'damaged' || s === 'destroyed') return 'lost';
    return 'other';
}

// Terminal outcome from the shipment's CURRENT status (authoritative), or null if not terminal.
function kwikOutcome(status) {
    const s = String(status || '').toLowerCase().trim();
    if (s === 'delivered') return 'delivered';
    if (/^rto|return_delivered/.test(s)) return 'rto';
    if (s === 'lost' || s === 'damaged' || s === 'destroyed') return 'lost';
    return null;
}

// Kwikship datetimes are ISO-8601 (e.g. "2026-04-20T15:45:30.000Z") → normalize to ISO (or null).
function parseKwikDate(v) {
    if (!v) return null;
    const d = new Date(String(v).trim());
    return isNaN(d.getTime()) ? null : d.toISOString();
}

// Build a unified journey from a Kwikship shipment's status_history + current status.
// statusHistory = [{ status, description, location, datetime }, …] (any order); currentStatus =
// the shipment's top-level `status` (the actual internal status, not the filter group name).
function parseKwikshipJourney(statusHistory, currentStatus, courier, zone) {
    const status = String(currentStatus || '').toLowerCase().trim();
    const evts = (statusHistory || [])
        .map(h => ({
            desc: h.description || h.status || '',
            at: parseKwikDate(h.datetime || h.date || h.timestamp),
            type: classifyKwikStatus(h.status),
        }))
        .filter(e => e.type || e.desc)
        .sort((a, b) => (a.at || '').localeCompare(b.at || ''));   // chronological

    let attempts = 0, ndr_count = 0, outForDeliveryAt = null, deliveredAt = null, rtoAt = null,
        pickedUpAt = null, lostAt = null, seenOFD = false;
    const ndr_reasons = [];
    for (const e of evts) {
        if (e.type === 'pickup') { if (!pickedUpAt) pickedUpAt = e.at; }
        else if (e.type === 'attempt') { attempts++; seenOFD = true; if (!outForDeliveryAt) outForDeliveryAt = e.at; }
        else if (e.type === 'ndr') {
            // Only a failed attempt AFTER the shipment went out for delivery counts as an NDR.
            if (seenOFD) { ndr_count++; if (e.desc) ndr_reasons.push(e.desc); }
        }
        else if (e.type === 'delivered' && !deliveredAt) deliveredAt = e.at;
        else if (e.type === 'rto' && !rtoAt) rtoAt = e.at;
        else if (e.type === 'lost' && !lostAt) lostAt = e.at;
    }

    // Authoritative current-status wins; else fall back to timeline-derived flags.
    const codeOut  = kwikOutcome(status);
    const delivered = codeOut === 'delivered' || !!deliveredAt;
    const rto       = codeOut === 'rto' || !!rtoAt || /^rto|return/.test(status);
    const lost      = codeOut === 'lost' || !!lostAt;
    const reached_delivery = seenOFD || delivered || status === 'out_for_delivery';
    const outcome   = delivered ? 'delivered' : rto ? 'rto' : lost ? 'lost' : (ndr_count > 0 ? 'ndr_pending' : 'in_transit');

    return {
        courier: courier || null,
        outcome,
        attempts: attempts || (delivered ? 1 : 0),
        ndr_count,
        reached_delivery,
        first_attempt_success: delivered && ndr_count === 0,
        ndr_reasons: [...new Set(ndr_reasons)].slice(0, 10),
        out_for_delivery_at: outForDeliveryAt,
        delivered_at: deliveredAt,
        rto_at: rtoAt,
        dispatched_at: pickedUpAt,
        zone: zone || null,
        status_code: currentStatus || null,   // the raw internal status (e.g. rto_in_transit) for exceptions
        first_edd: null,                       // filled from estimated_delivery_date below
        // RTO'd but the courier NEVER went out for delivery → a silent RTO (returned without any attempt).
        rto_no_attempt: rto && !seenOFD,
        is_final: delivered || rto || lost,
    };
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

function kwikHeaders() {
    return {
        'gk-app-id': config.KWIKSHIP_APP_ID || '',
        'gk-app-secret': config.KWIKSHIP_APP_SECRET || '',
        'Content-Type': 'application/json',
    };
}

// Fetch one shipment's detail (status_history + address) by AWB. Retries on 429/5xx.
// Returns { found, status, courier, statusHistory, state, city, edd } | { found:false }.
async function fetchKwikshipShipment(awb, tries = 3) {
    if (!awb) return { found: false };
    const base = String(config.KWIKSHIP_BASE_URL || '').replace(/\/+$/, '');
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const r = await axios.get(`${base}/api/v1/shipments/${encodeURIComponent(awb)}`,
                { headers: kwikHeaders(), timeout: 25000, validateStatus: () => true });
            if (r.status === 429 || r.status >= 500) { if (attempt < tries) { await _sleep(attempt * 1500); continue; } return { found: false }; }
            if (r.status === 404) return { found: false, notFound: true };
            const d = r.data && r.data.data;
            if (!r.data || r.data.success === false || !d) return { found: false };
            const addr = d.shipping_address || {};
            return {
                found: true,
                status: d.status || '',
                courier: d.courier_name || null,
                statusHistory: Array.isArray(d.status_history) ? d.status_history : [],
                state: addr.state || null,
                city: addr.city || null,
                edd: parseKwikDate(d.estimated_delivery_date),
            };
        } catch (e) { if (attempt < tries) { await _sleep(attempt * 1200); continue; } return { found: false, error: e.message }; }
    }
    return { found: false };
}

// Resolve + save ONE Kwikship order's journey. zoneHint = destination-derived zone from EasyEcom
// address (used when the Kwikship detail response has no state/city). Returns true if saved.
async function updateKwikshipJourney(awb, orderName, courier, orderDate, paymentMode, zoneHint) {
    const s = await fetchKwikshipShipment(awb);
    if (!s.found) return false;
    const zone = zoneFromState(s.state, s.city) || zoneHint || null;
    const j = parseKwikshipJourney(s.statusHistory, s.status, s.courier || courier, zone);
    if (s.edd) j.first_edd = s.edd;
    // Keep the timeline as evidence on a silent RTO so the claims report can show it with 0 extra calls.
    const raw = j.rto_no_attempt ? { status_history: s.statusHistory, status: s.status, captured_at: new Date().toISOString() } : null;
    await saveJourney(awb, orderName, 'kwikship', j, orderDate, raw, paymentMode);
    // If this order was re-allocated to Kwikship from another aggregator, drop the stale (non-final) old row.
    if (orderName) await supersedeStaleJourneys(orderName, awb);
    return true;
}

// Nightly sync: refresh journeys for Kwikship-allocated orders (location = 'kwikship') that are NOT
// yet final. One Kwikship API call per non-final shipment; finals are skipped (locked). Gentle pool.
async function syncKwikship({ days = 30, concurrency = 3, sleepMs = 300 } = {}) {
    if (!config.KWIKSHIP_APP_ID || !config.KWIKSHIP_APP_SECRET) {
        console.warn('[Kwikship] skipped — KWIKSHIP_APP_ID / KWIKSHIP_APP_SECRET not set in .env');
        return { skipped: true, reason: 'no-credentials' };
    }
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Kwikship-allocated, shipped orders in the window (paginated; Supabase caps a select at 1000).
    // Marker = EasyEcom's raw_data->>'courier_aggregator_name' = 'GoKwik Outbound' (authoritative; matches
    // the Kwikship API 1:1 — verified GoKwik AWBs resolve 200, RapidShyp AWBs 404).
    const list = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
            .from('b2c_order_easycom')
            .select('reference_code, awb_number, order_date, courier_name, payment_mode, shipping_state, shipping_city')
            .ilike('raw_data->>courier_aggregator_name', '%gokwik%')   // Kwikship / GoKwik allocation marker
            .gte('order_date', since)
            .not('awb_number', 'is', null)
            .order('order_date', { ascending: false })
            .range(offset, offset + PAGE - 1);
        if (error) { console.error('[Kwikship] read error:', error.message); break; }
        list.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }

    // Skip AWBs already finalized in the journey table (delivered / RTO → never re-fetched).
    const awbs = [...new Set(list.map(o => o.awb_number).filter(Boolean))];
    const finalSet = new Set();
    for (let i = 0; i < awbs.length; i += 200) {
        const { data } = await supabase.from('shipment_journey_ecom').select('awb').eq('is_final', true).in('awb', awbs.slice(i, i + 200));
        (data || []).forEach(r => finalSet.add(r.awb));
    }
    const todo = list.filter(o => !finalSet.has(o.awb_number));
    console.log(`[Kwikship] ${list.length} Kwikship orders (last ${days}d) · ${finalSet.size} already final · ${todo.length} to fetch (concurrency ${concurrency})…`);
    if (!todo.length) return { processed: 0, updated: 0, total: list.length };

    let updated = 0, none = 0, done = 0, idx = 0;
    const worker = async () => {
        while (idx < todo.length) {
            const o = todo[idx++];
            try {
                const ok = await updateKwikshipJourney(o.awb_number, o.reference_code, o.courier_name, o.order_date, o.payment_mode, zoneFromState(o.shipping_state, o.shipping_city));
                if (ok) updated++; else none++;
            } catch (e) { none++; console.error('[Kwikship] sync error', o.awb_number, e.message); }
            if (++done % 50 === 0) console.log(`[Kwikship] ${done}/${todo.length} (updated ${updated} · no-data ${none})`);
            await _sleep(sleepMs);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    console.log(`[Kwikship] DONE — updated ${updated} · no-data ${none} (of ${todo.length})`);
    return { processed: todo.length, updated, none, total: list.length };
}

module.exports = { classifyKwikStatus, kwikOutcome, parseKwikDate, parseKwikshipJourney, fetchKwikshipShipment, updateKwikshipJourney, syncKwikship };

// CLI: node app/api/kwikship_sync.js sync [days] [concurrency]
if (require.main === module && process.argv[2] === 'sync') {
    const days = parseInt(process.argv[3] || '30', 10) || 30;
    const conc = parseInt(process.argv[4] || '3', 10) || 3;
    syncKwikship({ days, concurrency: conc }).then(r => { console.log(JSON.stringify(r)); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
}
