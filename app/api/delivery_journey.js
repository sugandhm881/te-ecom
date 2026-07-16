// Delivery-journey parsers for the Delivery Performance dashboard (RTO / NDR / FASR).
// Two sources → one unified journey shape:
//   RapidShyp: full scan timeline  → count Out-for-Delivery (attempts) + failed-attempt scans (NDR)
//   DocPharma: summary fields       → reattempt_count (NDR) + current_status + delivered_at
// A journey is FINAL once delivered or RTO — the delivery attempts are locked, so no more API calls.

const axios = require('axios');
const config = require('../../config');
const { supabase } = require('../supabase');
const { fetchDocpharmaDetails } = require('./helpers');
const RS_TRACK_URL = 'https://api.rapidshyp.com/rapidshyp/apis/v1/track_order';

// ── scan phrase → event type (RapidShyp) ────────────────────────────────────
// Order matters: RTO before Delivered ("RTO Delivered" must not count as a customer delivery).
function classifyScan(desc) {
    const s = (desc || '').toLowerCase();
    if (!s) return 'other';
    // RTO — note "rto_initiated"/"rto delivered" etc. The trailing \b fails on "rto_" (underscore is a
    // word char), so match a boundary BEFORE "rto" only. Also catch courier "Returned as per…" phrasing.
    if (/\brto|return to origin|returned to|returned as per|reverse pickup|rto initiated/.test(s)) return 'rto';
    if (/out for delivery|out for del/.test(s))                          return 'attempt';
    // Actual delivery only — "not delivered"/"undelivered" phrasings must fall through to the NDR branch below.
    if (/\bdelivered\b|delivery successful|shipment delivered/.test(s) && !/not[\s_-]*delivered|undeliver/.test(s)) return 'delivered';
    // Pickup / dispatch — the shipment left the origin. Marks the Order→Dispatch TAT boundary.
    // "out for pickup" is NOT a pickup done, so it must not match here.
    if (/picked up|pickup done|pickup completed|shipment picked/.test(s)) return 'pickup';
    // Failed-attempt / NDR reasons — must be an actual FAILURE, not a normal step like
    // "Call placed to consignee". Bare "consignee"/"customer" is NOT enough on its own.
    if (/undeliver|not delivered|\bunavailable\b|not available|refus|reject|incomplete address|bad address|wrong address|address (issue|incorrect|problem)|establishment closed|premises closed|shop closed|door lock|\bndr\b|reattempt|re-?schedul|future delivery|no (client )?instruction|cod not ready|cash not ready|payment not ready|no response|not reachable|not responding|holiday|self ?collect|failed delivery|delivery failed/.test(s))
        return 'ndr';
    // Lost / untraceable — a terminal failure that is neither delivered nor RTO.
    if (/shipment lost|\blost\b|lost in transit|untraceable/.test(s)) return 'lost';
    return 'other';
}

// ── RapidShyp CANONICAL status codes → event/outcome (authoritative; from RapidShyp's code table) ──
// Every scan carries `rapidshyp_status_code`; the shipment carries `current_tracking_status_code`.
// These are exact, so prefer them over scan-text regex (which is the fallback for NA/DocPharma).
const CODE_LOST = new Set(['LST', 'RLST', 'RMSN', 'DMG', 'RDMG', 'DPO', 'RDPO']);       // lost/damaged/disposed/missing
const CODE_RTO  = new Set(['RTO_REQ', 'RTO', 'RTO_INT', 'RTO_RAD', 'RTO_OFD', 'RTO_DEL', 'RTO_UND', // forward RTO leg
    'RSCB', 'RPSH', 'ROFP', 'RPUE', 'RPCN', 'RPUC', 'RSPD', 'RINT', 'RPAD', 'RDED', 'ROFD', 'RDEL', 'RUND', 'RCAN', 'RONH', 'RMSR']); // return leg
// Note: RAD ("Reached at Destination", forward) starts with R but is NOT a return code → stays in-transit.
function codeEvent(code) {
    const c = String(code || '').toUpperCase();
    if (!c || c === 'NA') return null;   // no code → caller falls back to scan text
    if (c === 'PUC') return 'pickup';
    if (c === 'OFD') return 'attempt';   // forward Out-for-Delivery = a customer delivery attempt
    if (c === 'DEL') return 'delivered';
    if (c === 'UND') return 'ndr';       // forward Undelivered = a failed attempt
    if (CODE_LOST.has(c)) return 'lost';
    if (CODE_RTO.has(c)) return 'rto';   // any RTO/return-leg code (incl. RTO_OFD, RUND) → RTO, not a customer attempt
    return 'other';
}
// Current-status code → terminal outcome (or null if not terminal / unknown).
function codeOutcome(code) {
    const c = String(code || '').toUpperCase();
    if (c === 'DEL') return 'delivered';
    if (CODE_LOST.has(c)) return 'lost';
    if (CODE_RTO.has(c)) return 'rto';
    return null;
}

// Courier delivery zone (A–E), computed from the DESTINATION relative to origin Gurgaon/NCR.
// RapidShyp's track_order doesn't return a zone, so we derive the standard A-E model from state/city:
//   A = same city (Gurgaon) · B = NCR / same state · C = metro states · D = rest of India
//   E = J&K / Ladakh / Himachal / North-East / islands (special/remote). Approximate but consistent.
const ZONE_E_STATES = new Set(['jammu & kashmir', 'jammu and kashmir', 'j&k', 'ladakh', 'himachal pradesh',
    'assam', 'meghalaya', 'manipur', 'mizoram', 'nagaland', 'tripura', 'arunachal pradesh', 'sikkim',
    'andaman & nicobar islands', 'andaman and nicobar islands', 'lakshadweep', 'kerala']);
const ZONE_B_STATES = new Set(['haryana', 'delhi', 'new delhi', 'nct of delhi', 'chandigarh']);
const ZONE_C_STATES = new Set(['maharashtra', 'karnataka', 'tamil nadu', 'telangana', 'west bengal', 'gujarat']);
function zoneFromState(state, city) {
    const s = String(state || '').trim().toLowerCase();
    const c = String(city || '').trim().toLowerCase();
    if (!s && !c) return null;
    if (c === 'gurgaon' || c === 'gurugram') return 'A';
    if (ZONE_E_STATES.has(s)) return 'E';
    if (ZONE_B_STATES.has(s)) return 'B';
    if (ZONE_C_STATES.has(s)) return 'C';
    return s ? 'D' : null;   // known destination but not special/near/metro → rest of India
}

// RapidShyp scan_datetime is "dd-MM-yyyy HH:mm:ss" → ISO (or null)
function parseScanDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    const m = s.match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})/);
    // RapidShyp scan times are IST wall-clock (no zone) → stamp +05:30 so it's stored as the correct
    // UTC instant. Without this, "20:07" IST was saved as 20:07 UTC (+5:30 too late), inflating TAT.
    if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

// Build a journey from a RapidShyp shipment's scan list + current status.
// statusCode = ship.current_tracking_status_code (authoritative current code); each scan carries
// rapidshyp_status_code. Codes are exact → used first; scan-text regex is the fallback.
function parseRapidshypJourney(scans, currentStatus, courier, zone, statusCode, edd) {
    const status = (currentStatus || '').toLowerCase();
    const evts = (scans || [])
        .map(s => {
            const desc = s.scan || s.status_desc || s.status || s.activity || '';
            const byCode = codeEvent(s.rapidshyp_status_code);   // canonical code first…
            return { desc, at: parseScanDate(s.scan_datetime || s.date || s.timestamp || s.event_time), type: byCode || classifyScan(desc) }; // …text fallback
        })
        .filter(e => e.desc)
        .sort((a, b) => (a.at || '').localeCompare(b.at || '')); // chronological

    let attempts = 0, ndr_count = 0, outForDeliveryAt = null, deliveredAt = null, rtoAt = null, pickedUpAt = null, lostAt = null, seenOFD = false;
    const ndr_reasons = [];
    for (const e of evts) {
        if (e.type === 'pickup') { if (!pickedUpAt) pickedUpAt = e.at; }
        else if (e.type === 'attempt') { attempts++; seenOFD = true; if (!outForDeliveryAt) outForDeliveryAt = e.at; }
        else if (e.type === 'ndr') {
            // Only a FAILED DELIVERY ATTEMPT (an NDR after the shipment went Out for Delivery) counts.
            // A "Bad/Incomplete Address" logged at pickup is a pre-dispatch flag, not a delivery attempt.
            if (seenOFD) { ndr_count++; if (e.desc) ndr_reasons.push(e.desc); }
        }
        else if (e.type === 'delivered' && !deliveredAt) deliveredAt = e.at;
        else if (e.type === 'rto' && !rtoAt) rtoAt = e.at;
        else if (e.type === 'lost' && !lostAt) lostAt = e.at;
    }
    // Authoritative current-status code wins; else fall back to scan-derived flags + text.
    const codeOut   = codeOutcome(statusCode);
    // "delivered" must be an ACTUAL delivery. \bdelivered\b matches "DELIVERED" but NOT "OUT_FOR_DELIVERY"
    // or "UNDELIVERED" (the old /deliver/ test froze every shipment caught mid-OFD as delivered+is_final —
    // 344 rows). "NOT delivered" phrasings are excluded explicitly.
    const delivered = codeOut === 'delivered' || !!deliveredAt || (/\bdelivered\b/.test(status) && !/not[\s_-]*delivered|rto/.test(status));
    // Match a boundary BEFORE "rto" only — "rto_initiated"/"rto_in_transit"/"rto_delivered" all count as RTO.
    const rto       = codeOut === 'rto' || !!rtoAt || /\brto|return/.test(status);
    const lost      = codeOut === 'lost' || !!lostAt || /\blost\b/.test(status);   // terminal loss (LST/DMG/DPO codes)
    const reached_delivery = seenOFD || delivered || /out[\s_]for[\s_]delivery/.test(status);
    const outcome   = delivered ? 'delivered' : rto ? 'rto' : lost ? 'lost' : (ndr_count > 0 ? 'ndr_pending' : 'in_transit');

    return {
        courier: courier || null,
        outcome,
        attempts: attempts || (delivered ? 1 : 0),
        ndr_count,
        reached_delivery,
        first_attempt_success: delivered && ndr_count === 0,   // 0 failed attempts before delivery
        ndr_reasons: [...new Set(ndr_reasons)].slice(0, 10),
        out_for_delivery_at: outForDeliveryAt,
        delivered_at: deliveredAt,
        rto_at: rtoAt,
        dispatched_at: pickedUpAt,          // Order→Dispatch TAT boundary (first pickup scan)
        zone: zone || null,                 // RapidShyp delivery zone (from shipment_details)
        status_code: statusCode || null,    // canonical current code (LST/DMG/MSR/RTO_… ) for exceptions
        first_edd: parseScanDate(edd) || null,  // original promised EDD (preserved once by DB trigger)
        // RTO'd but the courier NEVER went Out for Delivery (no OFD scan) → a "silent RTO" returned
        // without ever attempting delivery. Flagged for the "RTO without attempt" report.
        rto_no_attempt: rto && !seenOFD,
        is_final: delivered || rto || lost,
    };
}

// DocPharma dates come as "YYYY-MM-DD HH:MM:SS" IST wall-clock (no zone) → stamp +05:30 so the stored
// UTC instant is correct. Falls back to parseScanDate for other shapes.
function parseDpDate(v) {
    if (!v) return null;
    const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+05:30`;
    return parseScanDate(v);
}

// Build a journey from a DocPharma order payload (no scan timeline — summary fields).
function parseDocpharmaJourney(dp) {
    const so = (dp && dp.suborders && dp.suborders[0]) || {};
    const ld = so.logistic_details || {};
    const status = (ld.current_status || so.status || '').toLowerCase();
    const reattempts = parseInt(ld.reattempt_count || 0, 10) || 0;
    const reason = ld.reason || so.display_reason || null;
    const dispatched = ld.dispatch_date || ld.manifest_date || ld.pickup_date || ld.shipped_at || so.dispatched_at || null;
    const zone = ld.zone || ld.zone_name || ld.delivery_zone || so.zone || null;

    // "delivered" must be an ACTUAL delivery. \bdelivered\b matches "DELIVERED" but NOT "out_for_delivery"
    // or "delivery_assigned" — those contain "deliver" but are NOT delivered (the old /deliver/ test wrongly
    // marked them delivered and is_final-locked them). RTO is excluded (RTO_DELIVERED → rto, not delivered).
    const delivered = /\bdelivered\b/.test(status) && !/rto/.test(status);
    // Boundary BEFORE "rto" only — DocPharma sends "RTO_RECEIVED"/"RTO_INITIATED" where the trailing \b fails.
    const rto       = /\brto|return/.test(status);
    const lost      = /\blost\b|untraceable/.test(status);
    // Out-for-delivery is an attempt in progress, NOT terminal → stays in-transit unless a re-attempt was logged.
    const reached_delivery = delivered || rto || reattempts > 0;
    const outcome   = delivered ? 'delivered' : rto ? 'rto' : lost ? 'lost' : reached_delivery ? 'ndr_pending' : 'in_transit';

    return {
        courier: ld.delivery_partner_name || ld.service_name || null,
        outcome,
        attempts: reached_delivery ? reattempts + 1 : 0,      // first attempt + re-attempts
        ndr_count: reattempts,                                 // each re-attempt = a failed attempt
        reached_delivery,
        first_attempt_success: delivered && reattempts === 0,
        // Only attach a reason on an actual NDR/RTO — DocPharma leaves a canned "reason" on in-transit rows.
        ndr_reasons: (reason && (rto || reattempts > 0)) ? [reason] : [],
        out_for_delivery_at: null,
        delivered_at: so.delivered_at || null,
        rto_at: null,
        dispatched_at: dispatched,
        first_edd: parseDpDate(so.eta || (dp && dp.eta)),   // DocPharma promise date (Promised EDD)
        zone,
        // RTO with zero re-attempts → returned without a delivery attempt. DocPharma has no scan
        // timeline, so this is best-effort (reattempt_count only; no scan-log evidence available).
        rto_no_attempt: rto && reattempts === 0,
        is_final: delivered || rto || lost,
    };
}

// Upsert a parsed journey into the DB. paymentMode is optional — only written when provided, so a
// webhook update never wipes the EasyEcom-sourced payment_mode.
async function saveJourney(awb, orderName, source, journey, orderDate, raw, paymentMode) {
    const row = {
        awb, order_name: orderName || null, source,
        courier: journey.courier, outcome: journey.outcome,
        attempts: journey.attempts, ndr_count: journey.ndr_count,
        reached_delivery: journey.reached_delivery,
        first_attempt_success: journey.first_attempt_success,
        ndr_reasons: journey.ndr_reasons,
        out_for_delivery_at: journey.out_for_delivery_at,
        delivered_at: journey.delivered_at, rto_at: journey.rto_at,
        rto_no_attempt: !!journey.rto_no_attempt,   // RTO'd with no delivery attempt (silent RTO)
        is_final: journey.is_final, order_date: orderDate || null,
        raw: raw || null, updated_at: new Date().toISOString(),
    };
    if (paymentMode) row.payment_mode = paymentMode;
    if (journey.status_code) row.status_code = journey.status_code;
    if (journey.first_edd) row.first_edd = journey.first_edd;   // trigger keeps the earliest value
    if (journey.dispatched_at) row.dispatched_at = journey.dispatched_at;  // conditional — don't wipe on partial webhook
    if (journey.zone) row.zone = journey.zone;
    const { error } = await supabase.from('shipment_journey_ecom').upsert(row, { onConflict: 'awb' });
    if (error) console.error('[Journey] save error:', error.message);
    return !error;
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch a RapidShyp shipment's scan timeline. Retries on rate-limit/timeout (bursts get throttled).
// Returns { found, scans, status, courier }.
async function fetchRsShipment(awb, tries = 3) {
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const r = await axios.post(RS_TRACK_URL, { awb },
                { headers: { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' }, timeout: 25000, validateStatus: () => true });
            if (r.status === 429 || r.status >= 500) { if (attempt < tries) { await _sleep(attempt * 1500); continue; } return { found: false }; }
            const rec = r.data && r.data.records && r.data.records[0];
            if (!rec) return { found: false };
            const sd = rec.shipment_details;
            const ship = Array.isArray(sd) && sd.length ? sd[0] : (sd || rec) || {};
            const scans = ship.track_scans || ship.tracking_history || ship.tracking_events || rec.track_scans || [];
            const zone = ship.zone || ship.zone_name || ship.delivery_zone || rec.zone || null;
            // Prefer the specific child courier ("Ekart Brands", "Delhivery Enterprise") over the parent.
            return { found: true, scans, status: ship.shipment_status || '', statusCode: ship.current_tracking_status_code || '', courier: ship.child_courier_name || ship.courier_name || null, zone, eddRaw: ship.edd || ship.current_courier_edd || null };
        } catch (e) { if (attempt < tries) { await _sleep(attempt * 1200); continue; } return { found: false, error: e.message }; }
    }
    return { found: false };
}

const RS_DETAILS_URL = 'https://api.rapidshyp.com/rapidshyp/apis/v1/shipment_details';

// Coerce a RapidShyp numeric field: keep 0, but null out undefined/''/non-numeric.
function _num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isNaN(n) ? null : n; }

// Fetch a shipment's freight breakdown + invoice value + promised EDD by AWB (shipment_details API).
// track_order does NOT carry freight, so this is the only source for shipping cost. Cancelled shipments
// return an empty final_freights ({}) → freight fields come back null. Returns { found, ... } | { found:false }.
async function fetchRsShipmentDetails(awb, tries = 3) {
    if (!awb) return { found: false, definitive: true };
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const r = await axios.get(`${RS_DETAILS_URL}?awb=${encodeURIComponent(awb)}`,
                { headers: { 'rapidshyp-token': config.RAPIDSHYP_API_KEY }, timeout: 25000, validateStatus: () => true });
            // 429/5xx = transient → retry, then give up as NON-definitive (nightly cron retries it).
            if (r.status === 429 || r.status >= 500) { if (attempt < tries) { await _sleep(attempt * 1500); continue; } return { found: false, definitive: false }; }
            const sd = r.data && r.data.shipment_details;
            // API answered but has no priceable details (cancelled/unknown AWB) → definitive empty.
            if (!sd) return { found: false, definitive: true };
            const ff = sd.final_freights || {};
            return {
                found: true,
                freight_total:   _num(ff.total_freight),
                freight_forward: _num(ff.total_freight_forward),
                freight_rto:     _num(ff.total_rto_freight),
                cod_charges:     _num(ff.total_cod_charges),
                shipment_value:  _num(sd.total_shipment_value),
                applied_weight:  _num(sd.applied_weight),
                edd:             parseScanDate(sd.current_courier_edd),
                status:          sd.shipment_status || '',
            };
        } catch (e) { if (attempt < tries) { await _sleep(attempt * 1200); continue; } return { found: false, definitive: false, error: e.message }; }
    }
    return { found: false, definitive: false };
}

// Fetch + persist freight/value/EDD for one shipment (by AWB). Stamps charges_fetched_at so the
// backfill/cron skips it next time. opts.backfillEdd → also write first_edd when it's missing (the DB
// trigger keeps the earliest, so this never clobbers an existing promise date). Returns the detail | null.
async function syncRsCharges(awb, opts = {}) {
    if (!awb) return null;
    const d = await fetchRsShipmentDetails(awb);
    if (!d.found) {
        // Definitive empty (cancelled/unknown AWB, no freight) → stamp so the backfill/cron skips it
        // next time. Transient failures (network/429/5xx) stay unstamped and get retried later.
        if (d.definitive) await supabase.from('shipment_journey_ecom').update({ charges_fetched_at: new Date().toISOString() }).eq('awb', awb);
        return null;
    }
    const upd = {
        freight_total: d.freight_total, freight_forward: d.freight_forward,
        freight_rto: d.freight_rto, cod_charges: d.cod_charges,
        shipment_value: d.shipment_value, applied_weight: d.applied_weight,
        charges_fetched_at: new Date().toISOString(),
    };
    if (opts.backfillEdd && d.edd) upd.first_edd = d.edd;
    const { error } = await supabase.from('shipment_journey_ecom').update(upd).eq('awb', awb);
    if (error) { console.error('[Charges] update error', awb, error.message); return null; }
    return d;
}

// Process up to `limit` FINAL RapidShyp shipments that still need a charges fetch (charges_fetched_at
// NULL). Runs a small concurrency pool with pacing so RapidShyp isn't throttled. Only final shipments
// are fetched — freight is stable once delivered/RTO'd, and that's all the reports need.
// Returns { processed, updated }.
async function syncChargesBatch(limit = 500, concurrency = 4) {
    const { data, error } = await supabase.from('shipment_journey_ecom')
        .select('awb, first_edd')
        .eq('source', 'rapidshyp').eq('is_final', true)
        .is('charges_fetched_at', null).not('awb', 'is', null)
        .limit(limit);
    if (error) { console.error('[Charges] batch select error:', error.message); return { processed: 0, updated: 0 }; }
    const rows = data || [];
    let updated = 0, i = 0;
    async function worker() {
        while (i < rows.length) {
            const row = rows[i++];
            const d = await syncRsCharges(row.awb, { backfillEdd: !row.first_edd });
            if (d) updated++;
            await _sleep(250);   // gentle pacing between calls
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
    return { processed: rows.length, updated };
}

// One-time full backfill of freight/value/EDD across ALL final RapidShyp shipments, in priority order:
// silent-RTO first (feature #2), then delivered (feature #5 needs their EDD), then the rest. Pages until
// each pass drains. An attempted-AWB set guards against an infinite loop if a page is all transient fails.
async function backfillCharges({ concurrency = 4, pageSize = 500, sleepMs = 200 } = {}) {
    const passes = [
        { label: 'silent-RTO', apply: q => q.eq('outcome', 'rto').eq('rto_no_attempt', true) },
        { label: 'delivered', apply: q => q.eq('outcome', 'delivered') },
        { label: 'remaining', apply: q => q },
    ];
    const attempted = new Set();
    let grand = 0;
    for (const pass of passes) {
        let passTotal = 0;
        for (;;) {
            let q = supabase.from('shipment_journey_ecom')
                .select('awb, first_edd')
                .eq('source', 'rapidshyp').eq('is_final', true)
                .is('charges_fetched_at', null).not('awb', 'is', null);
            q = pass.apply(q);
            const { data, error } = await q.limit(pageSize);
            if (error) { console.error('[Charges backfill] select error:', error.message); break; }
            const all = data || [];
            const rows = all.filter(r => !attempted.has(r.awb));   // skip transient-failed rows seen this run
            if (!rows.length) break;
            rows.forEach(r => attempted.add(r.awb));
            let i = 0, updated = 0;
            async function worker() {
                while (i < rows.length) {
                    const row = rows[i++];
                    const d = await syncRsCharges(row.awb, { backfillEdd: !row.first_edd });
                    if (d) updated++;
                    await _sleep(sleepMs);
                }
            }
            await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
            passTotal += updated; grand += updated;
            console.log(`[Charges backfill] ${pass.label}: +${updated}/${rows.length} (pass ${passTotal}, grand ${grand})`);
        }
        console.log(`[Charges backfill] ${pass.label} pass complete — ${passTotal} priced.`);
    }
    console.log(`[Charges backfill] DONE — ${grand} shipments priced.`);
    return grand;
}

// Resolve + save one order's journey: try RapidShyp (by AWB) first, fall back to DocPharma (by order
// name). Returns 'rapidshyp' | 'docpharma' | null. This is the single finalize/refresh path used by
// the backfill and the webhook finalizer.
async function updateJourneyForOrder(orderName, awb, courier, orderDate, paymentMode, zoneHint) {
    if (awb) {
        const rs = await fetchRsShipment(awb);
        if (rs.found) {
            const j = parseRapidshypJourney(rs.scans, rs.status, rs.courier || courier, rs.zone, rs.statusCode, rs.eddRaw);
            if (!j.zone && zoneHint) j.zone = zoneHint;   // RapidShyp has no zone → use destination-derived one
            // For a "RTO without attempt" shipment, keep the scan log as evidence so the report can show
            // it with ZERO API calls at download time.
            const raw = j.rto_no_attempt ? { scans: rs.scans, status: rs.status, status_code: rs.statusCode, captured_at: new Date().toISOString() } : null;
            await saveJourney(awb, orderName, 'rapidshyp', j, orderDate, raw, paymentMode);
            return 'rapidshyp';
        }
    }
    if (orderName) {
        const dp = await fetchDocpharmaDetails(String(orderName).replace('#', '').trim());
        if (dp) {
            const ld = (dp.suborders && dp.suborders[0] && dp.suborders[0].logistic_details) || {};
            const j = parseDocpharmaJourney(dp);
            if (!j.zone && zoneHint) j.zone = zoneHint;
            await saveJourney(awb || ld.tracking_number || orderName, orderName, 'docpharma', j, orderDate, null, paymentMode);
            return 'docpharma';
        }
    }
    return null;
}

// One-time / periodic backfill: build journeys for ALL shipped orders in the window (paginated).
// Skips shipments already FINAL (delivered/rto → never re-fetched). Concurrent workers + per-call
// retry so it covers a full month in ~30 min instead of hours.
async function backfillJourneys(days = 30, opts = {}) {
    const CONC = opts.concurrency || 4;
    const sleepMs = opts.sleepMs || 200; // per-worker spacing (raise to be gentler on the APIs)
    const since = new Date(Date.now() - days * 86400000).toISOString();
    // Optional upper bound — process ONLY orders older than this many days, so a 90-day run can do
    // just the 30–90 day window and never re-touch the already-backfilled recent 30 days.
    const until = opts.olderThanDays ? new Date(Date.now() - opts.olderThanDays * 86400000).toISOString() : null;

    // Paginate ALL orders in the window (Supabase caps a select at 1000 rows).
    const list = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        let q = supabase
            .from('b2c_order_easycom')
            .select('reference_code, awb_number, order_date, courier_name, payment_mode, shipping_state, shipping_city')
            .gte('order_date', since)
            .not('awb_number', 'is', null)
            .ilike('reference_code', 'TE%');   // BRAND (Shopify) orders ONLY — exclude Amazon (403-…) /
                                               // Flipkart (OD…) marketplace orders, which never ship via
                                               // RapidShyp/DocPharma and just waste API calls + rate-limit DP.
        if (until) q = q.lt('order_date', until);
        const { data, error } = await q.order('order_date', { ascending: false }).range(offset, offset + PAGE - 1);
        if (error) { console.error('[Journey Backfill] read error:', error.message); break; }
        list.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    if (until) console.log(`[Journey Backfill] window: ${days}d → ${opts.olderThanDays}d (skipping the recent ${opts.olderThanDays} days)`);

    // Skip AWBs already finalized in the journey table.
    const awbs = [...new Set(list.map(o => o.awb_number).filter(Boolean))];
    const finalSet = new Set();
    for (let i = 0; i < awbs.length; i += 200) {
        const { data } = await supabase.from('shipment_journey_ecom').select('awb').eq('is_final', true).in('awb', awbs.slice(i, i + 200));
        (data || []).forEach(r => finalSet.add(r.awb));
    }
    const todo = list.filter(o => !finalSet.has(o.awb_number));
    console.log(`[Journey Backfill] ${list.length} shipped orders (last ${days}d) · ${finalSet.size} already final · ${todo.length} to process (concurrency ${CONC})…`);

    let rs = 0, dp = 0, none = 0, done = 0, idx = 0;
    const worker = async () => {
        while (idx < todo.length) {
            const o = todo[idx++];
            const src = await updateJourneyForOrder(o.reference_code, o.awb_number, o.courier_name, o.order_date, o.payment_mode, zoneFromState(o.shipping_state, o.shipping_city));
            if (src === 'rapidshyp') rs++; else if (src === 'docpharma') dp++; else none++;
            if (++done % 100 === 0) console.log(`[Journey Backfill] ${done}/${todo.length} (RS ${rs} · DP ${dp} · none ${none})`);
            await _sleep(sleepMs);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));
    console.log(`[Journey Backfill] DONE — ${rs} RapidShyp · ${dp} DocPharma · ${none} no-data (of ${todo.length})`);
}

// One-time TAT/Zone backfill — re-fetches ONLY journey rows still missing dispatched_at (the new
// field) so historical finalized shipments get Order→Dispatch / Dispatch→Delivery + zone populated.
// Resumable (each pass shrinks the missing set), gentle by default (concurrency 2). Unlike the normal
// backfill it DOES re-touch final rows — that's the whole point — but only the ones lacking the field.
async function backfillTatZone(days = 90, opts = {}) {
    const CONC = opts.concurrency || 2;
    const sleepMs = opts.sleepMs || 450;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const todo = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
            .from('shipment_journey_ecom')
            .select('awb, order_name, courier, order_date, payment_mode')
            // Rows missing dispatch time (need TAT) OR any non-final row (may have silently resolved to
            // RTO/lost — re-check with the current parser). Covers both the TAT fill and the corrective.
            .or('dispatched_at.is.null,is_final.eq.false')
            .gte('order_date', since)
            .not('awb', 'is', null)
            .order('is_final', { ascending: true })       // non-final (stuck) rows FIRST — they're the
            .order('order_date', { ascending: true })      // most likely to have silently resolved to RTO
            .range(offset, offset + PAGE - 1);
        if (error) { console.error('[TAT Backfill] read error:', error.message); break; }
        todo.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    console.log(`[TAT Backfill] ${todo.length} journeys missing dispatched_at (last ${days}d) — refreshing (concurrency ${CONC})…`);

    let done = 0, idx = 0, ok = 0;
    const worker = async () => {
        while (idx < todo.length) {
            const o = todo[idx++];
            const src = await updateJourneyForOrder(o.order_name, o.awb, o.courier, o.order_date, o.payment_mode);
            if (src) ok++;
            if (++done % 100 === 0) console.log(`[TAT Backfill] ${done}/${todo.length} (${ok} refreshed)`);
            await _sleep(sleepMs);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));
    console.log(`[TAT Backfill] DONE — ${ok} refreshed of ${todo.length}`);
}

// Corrective re-check of shipments still marked in_transit — re-fetches each with the current parser.
// Use after a parser fix (e.g. the RTO_INITIATED classification bug) to reclassify stuck rows. These
// are non-final by definition, so re-fetching is legitimate; a shipment that's really resolved becomes
// final and won't be touched again. Gentle (concurrency 2) so it respects the API.
async function reprocessInTransit(days = 120, opts = {}) {
    const CONC = opts.concurrency || 2;
    const sleepMs = opts.sleepMs || 400;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const todo = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
            .from('shipment_journey_ecom')
            .select('awb, order_name, courier, order_date, payment_mode')
            .eq('outcome', 'in_transit')
            .gte('order_date', since)
            .not('awb', 'is', null)
            .order('order_date', { ascending: false })
            .range(offset, offset + PAGE - 1);
        if (error) { console.error('[Fix InTransit] read error:', error.message); break; }
        todo.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    console.log(`[Fix InTransit] ${todo.length} in-transit journeys (last ${days}d) — re-checking with current parser…`);

    let done = 0, idx = 0, ok = 0;
    const worker = async () => {
        while (idx < todo.length) {
            const o = todo[idx++];
            const src = await updateJourneyForOrder(o.order_name, o.awb, o.courier, o.order_date, o.payment_mode);
            if (src) ok++;
            if (++done % 100 === 0) console.log(`[Fix InTransit] ${done}/${todo.length} (${ok} refreshed)`);
            await _sleep(sleepMs);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));
    console.log(`[Fix InTransit] DONE — re-checked ${todo.length} (${ok} refreshed)`);
}

// Corrective re-check of FINAL rows with the code-based parser. The old text parser missed attempts/NDR
// on couriers that report underscore/coded statuses (e.g. Ekart "out_for_delivery"/"undelivered_attempted"),
// so some RTO/delivered rows have wrong attempts/ndr_count (→ mislabeled "silent RTO" or "first-attempt").
// opts.outcome limits scope (e.g. 'rto'). Gentle; oldest-first.
async function reprocessFinal(days = 95, opts = {}) {
    const CONC = opts.concurrency || 2;
    const sleepMs = opts.sleepMs || 400;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const onlyOutcome = opts.outcome || null;
    const onlySource = opts.source || null;

    const todo = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        let q = supabase
            .from('shipment_journey_ecom')
            .select('awb, order_name, courier, order_date, payment_mode')
            .eq('is_final', true)
            .gte('order_date', since)
            .not('awb', 'is', null);
        if (onlyOutcome) q = q.eq('outcome', onlyOutcome);
        if (onlySource) q = q.eq('source', onlySource);
        // Newest-first — recent orders are the ones being actively reviewed, so correct them first.
        const { data, error } = await q.order('order_date', { ascending: false }).range(offset, offset + PAGE - 1);
        if (error) { console.error('[Reprocess Final] read error:', error.message); break; }
        todo.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    console.log(`[Reprocess Final] ${todo.length} final rows${onlyOutcome ? ' (' + onlyOutcome + ')' : ''} (last ${days}d) — re-checking with code-based parser…`);

    let done = 0, idx = 0, ok = 0;
    const worker = async () => {
        while (idx < todo.length) {
            const o = todo[idx++];
            const src = await updateJourneyForOrder(o.order_name, o.awb, o.courier, o.order_date, o.payment_mode);
            if (src) ok++;
            if (++done % 100 === 0) console.log(`[Reprocess Final] ${done}/${todo.length}`);
            await _sleep(sleepMs);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));
    console.log(`[Reprocess Final] DONE — ${ok}/${todo.length}`);
}

// Re-fetch DocPharma + re-classify rows that may have been mis-finalized by the old /deliver/ bug (which
// marked "out_for_delivery"/"delivery_assigned" as delivered). Default target: delivered rows with NO
// delivered_at (the reliable signature — genuine DP deliveries carry a delivered_at). Ignores is_final so
// stuck rows actually get re-checked. Returns { processed, changed, changes }.
async function reprocessDocpharma({ concurrency = 4, onlyBadDelivered = true } = {}) {
    let q = supabase.from('shipment_journey_ecom')
        .select('awb, order_name, order_date, payment_mode, outcome, delivered_at')
        .eq('source', 'docpharma');
    q = onlyBadDelivered ? q.eq('outcome', 'delivered').is('delivered_at', null) : q;
    const { data, error } = await q.limit(5000);
    if (error) { console.error('[DP reprocess] select error:', error.message); return { processed: 0, changed: 0 }; }
    const rows = data || [];
    console.log(`[DP reprocess] ${rows.length} DocPharma rows to re-check (concurrency ${concurrency})…`);
    let changed = 0, i = 0; const changes = {};
    const worker = async () => {
        while (i < rows.length) {
            const row = rows[i++];
            try {
                const dp = await fetchDocpharmaDetails(String(row.order_name).replace('#', '').trim());
                if (dp) {
                    const j = parseDocpharmaJourney(dp);
                    await saveJourney(row.awb, row.order_name, 'docpharma', j, row.order_date, null, row.payment_mode);
                    if (j.outcome !== row.outcome) { changed++; const k = `${row.outcome}→${j.outcome}`; changes[k] = (changes[k] || 0) + 1; }
                }
            } catch (_e) { /* skip */ }
            await _sleep(200);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
    console.log(`[DP reprocess] DONE — processed ${rows.length}, changed ${changed}`, JSON.stringify(changes));
    return { processed: rows.length, changed, changes };
}

module.exports = { classifyScan, parseScanDate, parseDpDate, parseRapidshypJourney, parseDocpharmaJourney, saveJourney, fetchRsShipment, fetchRsShipmentDetails, syncRsCharges, syncChargesBatch, backfillCharges, updateJourneyForOrder, backfillJourneys, backfillTatZone, reprocessInTransit, reprocessFinal, reprocessDocpharma };

// CLI: node app/api/delivery_journey.js backfill [days] [concurrency] [olderThanDays]
//   `backfill 90 2 30` → gentle 30–90 day window only (skips the already-done recent 30 days)
//   `tat-backfill [days] [concurrency]` → one-time TAT/zone fill for rows missing dispatched_at
if (require.main === module && process.argv[2] === 'backfill') {
    const days = parseInt(process.argv[3] || '30', 10) || 30;
    const conc = parseInt(process.argv[4] || '4', 10) || 4;
    const olderThanDays = process.argv[5] ? parseInt(process.argv[5], 10) : 0;
    const sleepMs = conc <= 2 ? 450 : 200; // gentler pacing when low-concurrency
    backfillJourneys(days, { concurrency: conc, sleepMs, olderThanDays }).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
}
// `charges-backfill [concurrency] [pageSize]` — one-time price of all final RapidShyp shipments
// (silent-RTO → delivered → rest) via the shipment_details API. Safe to re-run; skips priced rows.
if (require.main === module && process.argv[2] === 'charges-backfill') {
    const conc = parseInt(process.argv[3] || '4', 10) || 4;
    const pageSize = parseInt(process.argv[4] || '500', 10) || 500;
    backfillCharges({ concurrency: conc, pageSize }).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
}
if (require.main === module && process.argv[2] === 'tat-backfill') {
    const days = parseInt(process.argv[3] || '90', 10) || 90;
    const conc = parseInt(process.argv[4] || '2', 10) || 2;
    backfillTatZone(days, { concurrency: conc }).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
}
if (require.main === module && process.argv[2] === 'fix-intransit') {
    const days = parseInt(process.argv[3] || '120', 10) || 120;
    const conc = parseInt(process.argv[4] || '2', 10) || 2;
    reprocessInTransit(days, { concurrency: conc }).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
}
// `reprocess-final [days] [concurrency] [outcome]` — re-check FINAL rows with the code-based parser to
// fix attempts/ndr_count (silent-RTO / FASR). Pass an outcome (e.g. rto) to limit scope.
if (require.main === module && process.argv[2] === 'reprocess-final') {
    const days = parseInt(process.argv[3] || '95', 10) || 95;
    const conc = parseInt(process.argv[4] || '2', 10) || 2;
    const outcome = process.argv[5] || null;
    const src = process.argv[6] || null;   // e.g. rapidshyp — only these carry scan codes
    reprocessFinal(days, { concurrency: conc, outcome, source: src }).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
}
// `fix-docpharma [concurrency] [all]` — re-fetch + re-classify DocPharma rows mis-marked delivered by the
// old /deliver/ bug (default: delivered with no delivered_at). Pass "all" to re-check every DP row.
if (require.main === module && process.argv[2] === 'fix-docpharma') {
    const conc = parseInt(process.argv[3] || '4', 10) || 4;
    const onlyBadDelivered = process.argv[4] !== 'all';
    reprocessDocpharma({ concurrency: conc, onlyBadDelivered }).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
}
