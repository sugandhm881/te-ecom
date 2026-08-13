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
    // Field names differ between the two Kwikship endpoints, so accept both:
    //   v1 (auth)   → { status, description, location, datetime }
    //   v2 (public) → { status, description, location, status_datetime, creation_datetime,
    //                   shipper_status, shipper_remark }
    // `shipper_remark` is the ONLY human NDR reason either endpoint gives ("Consignee Unavailable");
    // v1's `description` is a courier code (`UD_EOD-11_Pending`) that means nothing to an agent, so
    // prefer the remark and keep the code as the fallback.
    const evts = (statusHistory || [])
        .map(h => ({
            desc: h.shipper_remark || h.description || h.status || '',
            at: parseKwikDate(h.status_datetime || h.datetime || h.date || h.timestamp || h.creation_datetime),
            type: classifyKwikStatus(h.status),
        }))
        .filter(e => e.type || e.desc)
        .sort((a, b) => (a.at || '').localeCompare(b.at || ''));   // chronological

    let attempts = 0, ndr_count = 0, outForDeliveryAt = null, deliveredAt = null, rtoAt = null,
        pickedUpAt = null, lostAt = null, seenOFD = false;
    const ndr_reasons = [];
    // ⚠️ EVERY out-for-delivery timestamp, not just the first. Keeping only the first hid a parcel from
    // every date window after its first trip; 20.7% of Kwikship parcels go to the door more than once.
    // THE SAME FOUR LINES EXIST IN delivery_journey.js AND IN BOTH EDGE FUNCTIONS — change them together.
    const ofdDates = [];
    for (const e of evts) {
        if (e.type === 'pickup') { if (!pickedUpAt) pickedUpAt = e.at; }
        else if (e.type === 'attempt') { attempts++; seenOFD = true; if (e.at) ofdDates.push(e.at); if (!outForDeliveryAt) outForDeliveryAt = e.at; }
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
        // Every door trip, chronological. ofd_dates[0] === out_for_delivery_at by construction.
        ofd_dates: ofdDates.length ? ofdDates.slice().sort() : (outForDeliveryAt ? [outForDeliveryAt] : null),
        last_ofd_at: ofdDates.length ? ofdDates.slice().sort().pop() : outForDeliveryAt,
        delivered_at: deliveredAt,
        rto_at: rtoAt,
        dispatched_at: pickedUpAt,
        zone: zone || null,
        status_code: currentStatus || null,   // the raw internal status (e.g. rto_in_transit) for exceptions
        first_edd: null,                       // filled from estimated_delivery_date below
        // RTO'd but the courier NEVER went out for delivery → a silent RTO (returned without any attempt).
        rto_no_attempt: rto && !seenOFD,
        // THE NEWEST SCAN IN THE TIMELINE — the only truthful "last scan". Milestones cannot stand in for
        // it: a parcel reattempted after an NDR has a NEWER out-for-delivery scan than the FIRST one
        // stored in out_for_delivery_at (TE25-41004: first OFD 10 Aug, latest OFD 11 Aug 09:17).
        last_scan_at: evts.map(e => e.at).filter(Boolean).sort().pop() || null,
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

// ── Kwikship PUBLIC tracking (v2) — no auth ──────────────────────────────────────────────────────
// GET /track/v2/public?order_code=<awb|order no>  (merchant_id is accepted but ignored)
// Why we call it in ADDITION to v1: it is the only endpoint that carries `shipper_remark`, the human
// NDR reason ("Consignee Unavailable"). v1's `description` is a courier code (`UD_EOD-11_Pending`)
// that tells an agent nothing — production rows were storing exactly that. It is NOT a replacement:
// v2 has no current status, no shipping address (so no zone) and only a masked phone, so v1 stays the
// source of identity and this supplies the reason-bearing timeline.
async function fetchKwikshipPublic(awb, tries = 2) {
    if (!awb) return { found: false };
    const base = String(config.KWIKSHIP_BASE_URL || '').replace(/\/+$/, '');
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const r = await axios.get(`${base}/track/v2/public?order_code=${encodeURIComponent(awb)}`,
                { timeout: 20000, validateStatus: () => true });
            if (r.status === 429 || r.status >= 500) { if (attempt < tries) { await _sleep(attempt * 1200); continue; } return { found: false }; }
            const d = r.data && r.data.data;
            if (r.status !== 200 || !d) return { found: false };
            const hist = Array.isArray(d.statusHistory) ? d.statusHistory : [];
            if (!hist.length) return { found: false };
            return {
                found: true,
                statusHistory: hist,
                // shipper_info.shipper_name is v1's courier_name; master_shipper_name is the parent carrier.
                courier: (d.shipper_info && (d.shipper_info.shipper_name || d.shipper_info.master_shipper_name)) || null,
                edd: parseKwikDate(d.estimated_dd),
                orderCode: (d.product_details && d.product_details.orderCode) || d.order_id || null,
            };
        } catch (e) { if (attempt < tries) { await _sleep(attempt * 1000); continue; } return { found: false, error: e.message }; }
    }
    return { found: false };
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
    // API BUDGET — v2 first, v1 only when we actually need it.
    // v2 (public, no auth) carries the whole timeline plus the NDR reason, and its newest scan IS the
    // current status. v1's unique contribution is identity: shipping address → zone, courier, EDD —
    // none of which ever change once captured. So a shipment we've already stored needs v2 ONLY, and
    // the nightly run costs the same one call per shipment it did before this change.
    // v1 is still fetched when: v2 failed, or we have no stored zone/courier yet (first sync).
    const pub = await fetchKwikshipPublic(awb);
    let known = null;
    if (pub.found) {
        const { data } = await supabase.from('shipment_journey_ecom')
            .select('zone, courier, first_edd').eq('awb', awb).maybeSingle();
        known = data || null;
    }
    const needV1 = !pub.found || !known || !known.zone || !known.courier;
    const s = needV1 ? await fetchKwikshipShipment(awb) : { found: true, statusHistory: [], status: '', courier: null, state: null, city: null, edd: null };
    if (!s.found && !pub.found) return false;

    const zone = zoneFromState(s.state, s.city) || (known && known.zone) || zoneHint || null;
    const timeline = (pub.found && pub.statusHistory.length) ? pub.statusHistory : s.statusHistory;
    if (!timeline.length) return false;
    // Current status: v1's top-level `status` when we fetched it, else the newest v2 scan — the two agree
    // (verified on live shipments), and v2's history is already sorted newest-first.
    const curStatus = s.status || (pub.found ? String(pub.statusHistory[0].status || '') : '');
    const j = parseKwikshipJourney(timeline, curStatus, s.courier || (known && known.courier) || pub.courier || courier, zone);
    const edd = s.edd || pub.edd || (known && known.first_edd) || null;
    if (edd) j.first_edd = edd;
    // Keep the timeline as evidence on a silent RTO so the claims report can show it with 0 extra calls.
    // Use the MERGED timeline/status — v1's copies are empty whenever we skipped that call.
    const raw = j.rto_no_attempt ? { status_history: timeline, status: curStatus, captured_at: new Date().toISOString() } : null;
    await saveJourney(awb, orderName, 'kwikship', j, orderDate, raw, paymentMode);
    // Feed the bucket engine too — without this the order never leaves `order_to_dispatch`.
    const lastScanAt = timeline
        .map(h => parseKwikDate(h.status_datetime || h.datetime || h.date || h.timestamp || h.creation_datetime))
        .filter(Boolean).sort().pop() || null;
    await mirrorKwikshipToOrderTracking(awb, orderName, j, j.status_code, lastScanAt);
    // If this order was re-allocated to Kwikship from another aggregator, drop the stale (non-final) old row.
    if (orderName) await supersedeStaleJourneys(orderName, awb);
    return true;
}

// ── Mirror the journey into `order_tracking` — this is what puts Kwikship INTO the bucket engine ──
// The `order_buckets` view (Undelivered / Delivered / RTO / age buckets, the Support console, the hold
// rules) is built ONLY from `order_tracking` + `rapidshyp_tracking_ecom` + `orders.tracking_status`.
// Kwikship wrote to NONE of them — only to `shipment_journey_ecom` — so every Kwikship order sat in
// `order_to_dispatch` for life: 528 of 532 at the time of the fix, including 26 that were sitting on a
// live NDR and never appeared on the Undelivered list (reported on TE25-40300 / 47607613040881,
// "Consignee Unavailable" since 07 Aug). RapidShyp and DocPharma both write `order_tracking`; Kwikship
// simply never joined. Writing the same row is the whole fix — no view change, and every consumer of
// the view becomes correct at once.
//
// `order_tracking.order_id` is UNIQUE (one row per order), so this must never clobber another platform's
// row: we write only when there is no row, or the existing row is already ours (same source or same AWB).
const KS_TRACKING_STATUS = {
    // 'new' means "manifest uploaded" — NOT dispatched. The view decides dispatch by excluding a list of
    // pre-pickup statuses, and 'new' is not on it, so left raw it would fake a dispatch and push the order
    // out of order_to_dispatch. The pickup states are spelled the way that list spells them.
    new: 'manifested', out_for_pickup: 'out for pickup', pickup_completed: 'pickup completed',
};
// OUTCOME decides the status text, NOT the raw code. The view matches on the text — `rto` via the regex
// `(^| )rto( |$)`, `undelivered` via an exact list — and several Kwikship codes carry neither word while
// still being that outcome: `reached_at_seller_city` IS an RTO leg, and an NDR shipment often still reads
// `out_for_delivery`. Trusting the raw code put 3 RTOs and 1 NDR into an age bucket instead of rto /
// undelivered (measured on the first 116 backfilled rows). The parser has already resolved the outcome
// from the whole timeline, so use it; the code only refines the non-terminal in_transit case.
const KS_OUTCOME_STATUS = { delivered: 'delivered', rto: 'rto', ndr_pending: 'undelivered', lost: 'lost' };
function ksTrackingStatus(outcome, statusCode) {
    const byOutcome = KS_OUTCOME_STATUS[String(outcome || '')];
    if (byOutcome) return byOutcome;
    const code = String(statusCode || '').toLowerCase().trim();
    return KS_TRACKING_STATUS[code] || code || null;
}
async function mirrorKwikshipToOrderTracking(awb, orderName, j, statusCode, lastScanAt) {
    const name = String(orderName || '').replace('#', '').trim();
    if (!name) return false;
    try {
        const { data: o } = await supabase.from('orders').select('id, name')
            .in('name', [name, '#' + name]).limit(1).maybeSingle();
        if (!o) return false;
        const { data: ex } = await supabase.from('order_tracking')
            .select('order_id, source, awb_number').eq('order_id', o.id).maybeSingle();
        if (ex && ex.source !== 'kwikship' && String(ex.awb_number || '') !== String(awb)) return false;
        const status = ksTrackingStatus(j.outcome, statusCode || j.status_code);
        if (!status) return false;
        const { error } = await supabase.from('order_tracking').upsert({
            order_id: String(o.id), order_name: name, awb_number: awb, source: 'kwikship',
            courier_name: j.courier || null, tracking_status: status,
            // The view derives dispatch from MIN(status_updated_at) over non-pre-pickup rows. With one row
            // per order that IS this value, so it must be the real dispatch moment, not the latest scan —
            // otherwise `dispatch_at` (shown in the console, and read by the hold rules) would drift
            // forward with every new scan.
            status_updated_at: j.dispatched_at || j.out_for_delivery_at || null,
            delivered_date: j.delivered_at || null,
            edd: j.first_edd || null,
            // ⚠️ `last_tracked_at` must be the newest COURIER EVENT, not the sync time — the Call Queue's
            // "Last scan" column reads it. It was `now()`, and because `status_updated_at` holds the
            // DISPATCH moment (above), every Kwikship row reported its pickup time as the last scan:
            // 724 of 724 rows had status_updated_at === dispatched_at. Prefer the true newest scan from
            // the timeline when the caller has it; otherwise the newest milestone we know, which is still
            // a real event rather than the clock.
            last_tracked_at: lastScanAt
                || [j.delivered_at, j.rto_at, j.out_for_delivery_at, j.dispatched_at].filter(Boolean).sort().pop()
                || new Date().toISOString(),
            updated_at: new Date().toISOString(),
        }, { onConflict: 'order_id' });
        if (error) { console.error('[Kwikship→tracking]', awb, error.message); return false; }
        return true;
    } catch (e) { console.error('[Kwikship→tracking]', awb, e.message); return false; }
}

// ── One-off backfill: replace courier-CODE NDR reasons with the human remark ─────────────────────
// Rows synced before the v2 timeline landed stored v1's `description` — "UD_EOD-11_Pending" — which
// tells an agent nothing. This re-reads ONLY the public v2 endpoint (no auth, no credentials) for the
// handful of rows that actually carry such a code, and rewrites `ndr_reasons` alone.
//
// Deliberately light: it selects only rows whose reasons look like courier codes (28 of 271 today, the
// rest have no NDR at all), so it is a few dozen calls, not a full re-sync. Nothing else on the row is
// touched — outcome/attempts/ndr_count are already correct and must not move.
// ── Self-heal: make `order_tracking` agree with the journey for FINAL shipments ──────────────────
// The safety net for the whole Kwikship path. `shipment_journey_ecom` is the truth (the Live Tracking
// modal reads it); `order_tracking` is what every dashboard surface actually reads via `order_buckets`.
// Anything that writes one without the other silently splits them, and once `is_final` is set the nightly
// sync stops fetching that AWB, so the split never heals on its own.
//
// This compares the two and rewrites ONLY the rows that disagree. No courier API calls — it works purely
// from journey rows we already store, so it is safe to run on every sync and cheap enough to leave in.
// Pass a list of AWBs, or omit to sweep every final Kwikship shipment.
async function reconcileKwikshipTracking(awbList = null) {
    const journeys = [];
    if (Array.isArray(awbList)) {
        for (let i = 0; i < awbList.length; i += 200) {
            const { data } = await supabase.from('shipment_journey_ecom')
                .select('awb, order_name, courier, outcome, status_code, dispatched_at, out_for_delivery_at, delivered_at, rto_at, first_edd, last_scan_at')
                .eq('source', 'kwikship').in('awb', awbList.slice(i, i + 200));
            journeys.push(...(data || []));
        }
    } else {
        for (let f = 0; ; f += 1000) {                       // Supabase caps a select at 1000 rows
            const { data, error } = await supabase.from('shipment_journey_ecom')
                .select('awb, order_name, courier, outcome, status_code, dispatched_at, out_for_delivery_at, delivered_at, rto_at, first_edd, last_scan_at')
                .eq('source', 'kwikship').eq('is_final', true).order('awb', { ascending: true }).range(f, f + 999);
            if (error) { console.error('[Kwikship reconcile] select:', error.message); break; }
            journeys.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
    }
    if (!journeys.length) return { checked: 0, repaired: 0 };

    // Current bucket-engine status for those AWBs, in batches (the `in` filter is also 1000-capped).
    const seen = new Map();
    const keys = journeys.map(j => j.awb);
    for (let i = 0; i < keys.length; i += 200) {
        const { data } = await supabase.from('order_tracking').select('awb_number, tracking_status').in('awb_number', keys.slice(i, i + 200));
        (data || []).forEach(r => seen.set(String(r.awb_number), String(r.tracking_status || '')));
    }

    let repaired = 0, drift = [];
    for (const j of journeys) {
        const want = ksTrackingStatus(j.outcome, j.status_code);
        if (!want) continue;
        const have = seen.get(String(j.awb));
        if (have === undefined) continue;                    // no tracking row yet — the backfill owns that case
        if (String(have).toLowerCase() === want.toLowerCase()) continue;
        if (await mirrorKwikshipToOrderTracking(j.awb, j.order_name, j, j.status_code, j.last_scan_at)) {
            repaired++;
            if (drift.length < 10) drift.push(`${j.order_name || j.awb} ${have} → ${want}`);
        }
    }
    if (repaired) console.warn(`[Kwikship reconcile] repaired ${repaired} row(s) where order_tracking disagreed with the journey — e.g. ${drift.join(' · ')}`);
    return { checked: journeys.length, repaired };
}

// ── One-off backfill: give every EXISTING Kwikship journey its `order_tracking` row ─────────────
// The mirror above only fires on the next sync/webhook for a shipment, and a FINAL shipment (delivered /
// RTO) may never be touched again — so without this the historical rows stay stuck in order_to_dispatch
// forever. Pure DB work: reads journeys, writes tracking rows. ZERO API calls.
async function backfillKwikshipOrderTracking({ dry = false } = {}) {
    const rows = [];
    for (let f = 0; ; f += 1000) {
        const { data, error } = await supabase.from('shipment_journey_ecom')
            .select('awb, order_name, courier, outcome, status_code, dispatched_at, out_for_delivery_at, delivered_at, first_edd')
            .eq('source', 'kwikship').order('awb', { ascending: true }).range(f, f + 999);
        if (error) { console.error('[Kwikship OT] select:', error.message); break; }
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    console.log(`[Kwikship OT] ${rows.length} Kwikship journey row(s)${dry ? ' — DRY RUN' : ''}`);
    let wrote = 0, skipped = 0;
    for (const r of rows) {
        if (dry) { if (ksTrackingStatus(r.outcome, r.status_code)) wrote++; else skipped++; continue; }
        const ok = await mirrorKwikshipToOrderTracking(r.awb, r.order_name, r, r.status_code);
        if (ok) wrote++; else skipped++;
    }
    console.log(`[Kwikship OT] ${dry ? 'would write' : 'wrote'} ${wrote}, skipped ${skipped}`);
    return { total: rows.length, wrote, skipped };
}

const CODE_RE = /^UD[_-]|_(Pending|Dispatched|Delivered)$/i;
async function backfillKwikshipNdrReasons({ concurrency = 3, sleepMs = 400, dry = false } = {}) {
    const rows = [];
    for (let f = 0; ; f += 1000) {
        const { data, error } = await supabase.from('shipment_journey_ecom')
            .select('awb, ndr_reasons').eq('source', 'kwikship').gt('ndr_count', 0)
            .order('awb', { ascending: true }).range(f, f + 999);
        if (error) { console.error('[Kwikship BF] select:', error.message); break; }
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    const need = rows.filter(r => Array.isArray(r.ndr_reasons) && r.ndr_reasons.some(x => CODE_RE.test(String(x))));
    console.log(`[Kwikship BF] ${need.length} row(s) carry courier-code reasons (of ${rows.length} with NDRs)${dry ? ' — DRY RUN' : ''}`);
    let i = 0, updated = 0, unchanged = 0, missed = 0;
    const worker = async () => {
        while (i < need.length) {
            const r = need[i++];
            try {
                const pub = await fetchKwikshipPublic(r.awb);
                if (!pub.found) { missed++; continue; }
                // Same rule the parser uses: only a failed attempt AFTER an OFD counts as an NDR.
                const evts = pub.statusHistory
                    .map(h => ({ type: classifyKwikStatus(h.status), desc: h.shipper_remark || h.description || '', at: parseKwikDate(h.status_datetime || h.creation_datetime) }))
                    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
                let seenOFD = false; const reasons = [];
                for (const e of evts) {
                    if (e.type === 'attempt') seenOFD = true;
                    else if (e.type === 'ndr' && seenOFD && e.desc) reasons.push(e.desc);
                }
                const next = [...new Set(reasons)].slice(0, 10);
                if (!next.length || JSON.stringify(next) === JSON.stringify(r.ndr_reasons)) { unchanged++; continue; }
                if (!dry) {
                    const { error } = await supabase.from('shipment_journey_ecom').update({ ndr_reasons: next }).eq('awb', r.awb);
                    if (error) { console.error(`[Kwikship BF] ${r.awb}:`, error.message); missed++; continue; }
                }
                updated++;
                console.log(`[Kwikship BF] ${r.awb}: ${JSON.stringify(r.ndr_reasons)} -> ${JSON.stringify(next)}`);
            } catch (e) { missed++; }
            await _sleep(sleepMs);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, need.length || 1) }, worker));
    console.log(`[Kwikship BF] done — ${updated} updated, ${unchanged} already fine, ${missed} unavailable`);
    return { candidates: need.length, updated, unchanged, missed };
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

    // …but "skip" must mean "make no API call", NOT "ignore". Finalizing an AWB used to remove it from this
    // cron's sight forever, so ANY divergence that existed at that moment became permanent — which is exactly
    // how 239 shipments (183 delivered, 56 RTO) came to read `in_transit` / `undelivered` in every dashboard
    // while their journey said delivered: the webhook recorded the delivery, set is_final, and never wrote
    // `order_tracking`. Reconciling here closes that hole for good and for ANY cause (edge-function drift, a
    // failed write, a race) — it is pure DB work against rows we already have, and costs ZERO courier calls.
    await reconcileKwikshipTracking([...finalSet]);
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

module.exports = { classifyKwikStatus, kwikOutcome, parseKwikDate, parseKwikshipJourney, fetchKwikshipShipment, fetchKwikshipPublic, updateKwikshipJourney, syncKwikship, backfillKwikshipNdrReasons, mirrorKwikshipToOrderTracking, backfillKwikshipOrderTracking, reconcileKwikshipTracking };

// CLI: node app/api/kwikship_sync.js sync [days] [concurrency]
if (require.main === module && process.argv[2] === 'sync') {
    const days = parseInt(process.argv[3] || '30', 10) || 30;
    const conc = parseInt(process.argv[4] || '3', 10) || 3;
    syncKwikship({ days, concurrency: conc }).then(r => { console.log(JSON.stringify(r)); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
}
