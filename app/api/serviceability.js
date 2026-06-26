/**
 * RapidShyp Pincode Serviceability + EDD
 *
 * Wraps RapidShyp's serviceability API (note: their path is misspelled
 * `serviceabilty_check` — verified live; the "correct" spelling 404s).
 * Both forward and return checks use the same endpoint, toggled by `is_return`.
 *
 * Routes:
 *   POST /api/serviceability/check      → full courier list for the checker page
 *   POST /api/serviceability/edd-batch  → cached EDD summary per {pincode, weight}
 *                                         for the Orders Dashboard EDD column
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const pLimit = require('p-limit').default || require('p-limit');
const config = require('../../config');
const { tokenRequired } = require('../auth');
const { supabase } = require('../supabase');

const RS_BASE = (config.RAPIDSHYP_API_URL || 'https://api.rapidshyp.com/rapidshyp/apis/v1/').replace(/\/+$/, '');
const SRV_URL = `${RS_BASE}/serviceabilty_check`; // RapidShyp's actual (misspelled) path
const RS_HDR = () => ({ 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' });
const DEFAULT_PICKUP = String(config.PICKUP_PINCODE || '122101');

// Weight buckets keep the cache small: round up to the next 0.5 kg.
function bucketWeight(w) {
    const n = Number(w);
    const kg = !isNaN(n) && n > 0 ? n : 0.5;
    return Math.max(0.5, Math.ceil(kg * 2) / 2);
}

// "27-06-2026" → Date (local midnight) | null
function parseEdd(s) {
    const m = String(s || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) return null;
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

// Whole days from local today to the given Date (can be 0/negative).
function daysFromToday(d) {
    if (!d) return null;
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return Math.round((d.getTime() - t.getTime()) / 86400000);
}

// Collapse a courier list into the summary the dashboard needs.
// We store transit *days* (relative) so a cached row stays valid across dates;
// absolute EDD dates are recomputed from today on read.
function summarize(resp) {
    const list = (resp && resp.serviceable_courier_list) || [];
    const ok = resp && resp.status === true && Array.isArray(list) && list.length > 0;
    if (!ok) {
        return { serviceable: false, courier_count: 0, fastest_days: null, slowest_days: null, earliest_cutoff: null, cheapest_freight: null };
    }
    const days = list.map(c => daysFromToday(parseEdd(c.edd))).filter(n => n !== null);
    const freights = list
        .map(c => (typeof c.total_freight === 'number' ? c.total_freight : parseFloat(c.total_freight)))
        .filter(n => !isNaN(n));
    const cutoffs = list.map(c => c.cutoff_time).filter(Boolean).sort(); // "HH:MM" sorts lexically
    return {
        serviceable: true,
        courier_count: list.length,
        fastest_days: days.length ? Math.min(...days) : null,
        slowest_days: days.length ? Math.max(...days) : null,
        earliest_cutoff: cutoffs.length ? cutoffs[0] : null,
        cheapest_freight: freights.length ? Math.min(...freights) : null
    };
}

// Raw RapidShyp call. Returns { status, data } (never throws for HTTP errors).
// `retries` adds resilience for the interactive check when the token is busy
// (RapidShyp throttles per-token, so a burst can transiently stall a request).
async function rsServiceability({ pickup, delivery, weight, cod, value, isReturn }, opts = {}) {
    const { timeout = 12000, retries = 0 } = opts;
    const body = {
        Pickup_pincode: String(pickup),
        Delivery_pincode: String(delivery),
        weight: Number(weight) || 0.5,
        cod: !!cod,
        total_order_value: Number(value) || 0,
        is_return: !!isReturn
    };
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await axios.post(SRV_URL, body, { headers: RS_HDR(), timeout, validateStatus: () => true });
            return { status: res.status, data: res.data, request: body };
        } catch (e) {
            lastErr = e;
            if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        }
    }
    throw lastErr;
}

// ─── POST /check — full result for the checker page ────────────────────────
router.post('/check', tokenRequired, async (req, res) => {
    const { pickup_pincode, delivery_pincode, weight, cod, total_order_value, is_return } = req.body || {};
    const pickup = String(pickup_pincode || DEFAULT_PICKUP).trim();
    const delivery = String(delivery_pincode || '').trim();

    if (!/^\d{6}$/.test(pickup) || !/^\d{6}$/.test(delivery)) {
        return res.status(400).json({ error: 'Valid 6-digit pickup and delivery pincodes are required.' });
    }

    try {
        const { status, data, request } = await rsServiceability(
            { pickup, delivery, weight, cod, value: total_order_value, isReturn: is_return },
            { timeout: 12000, retries: 2 } // resilient to transient token-busy stalls
        );
        return res.json({ request, response: data, status });
    } catch (e) {
        console.error('[Serviceability] check error:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

// ─── POST /edd-batch — cached EDD summaries for many pincodes ───────────────
// Body: { items: [{ pincode, weight }], pickup?, cod? }
// Returns: { pickup, results: { "<pincode>-<weightBucket>": summary, ... } }
const CACHE_TABLE = 'serviceability_edd_ecom';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // transit times rarely change
// Keep the burst small so dashboard loads don't saturate RapidShyp's per-token
// rate limit (which also feeds the RS tracking sync). Cache makes this near-zero once warm.
const MAX_MISSES_PER_REQUEST = 12;            // cap live API calls per batch
const limit = pLimit(2);

router.post('/edd-batch', tokenRequired, async (req, res) => {
    const { items, pickup: pickupRaw, cod } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items array is required' });

    const pickup = String(pickupRaw || DEFAULT_PICKUP).trim();

    // Build the unique set of (pincode, weightBucket) keys we need.
    const wanted = new Map(); // mapKey -> { pincode, weight, cacheKey }
    for (const it of items) {
        const pin = String((it && it.pincode) || '').replace(/\D/g, '').slice(0, 6);
        if (!/^\d{6}$/.test(pin)) continue;
        const wb = bucketWeight(it && it.weight);
        const mapKey = `${pin}-${wb}`;
        if (!wanted.has(mapKey)) {
            wanted.set(mapKey, { pincode: pin, weight: wb, cacheKey: `${pickup}-${pin}-${wb}` });
        }
    }

    const results = {};
    const need = [];

    // 1. Read cache in one query (degrade gracefully if the table is missing).
    const cacheKeys = Array.from(wanted.values()).map(v => v.cacheKey);
    let cacheRows = [];
    if (cacheKeys.length) {
        const { data, error } = await supabase
            .from(CACHE_TABLE)
            .select('*')
            .in('cache_key', cacheKeys);
        if (error) {
            console.warn(`[Serviceability] cache read failed (table missing?): ${error.message}`);
        } else {
            cacheRows = data || [];
        }
    }
    const cacheByKey = {};
    cacheRows.forEach(r => { cacheByKey[r.cache_key] = r; });

    const freshCutoff = Date.now() - CACHE_TTL_MS;
    for (const [mapKey, v] of wanted) {
        const row = cacheByKey[v.cacheKey];
        const fresh = row && row.checked_at && new Date(row.checked_at).getTime() > freshCutoff;
        if (fresh) {
            results[mapKey] = {
                serviceable: row.serviceable,
                courier_count: row.courier_count,
                fastest_days: row.fastest_days,
                slowest_days: row.slowest_days,
                earliest_cutoff: row.earliest_cutoff,
                cheapest_freight: row.cheapest_freight != null ? Number(row.cheapest_freight) : null,
                cached: true
            };
        } else {
            need.push(v);
        }
    }

    // 2. Fetch cache-misses live (capped), then upsert.
    const toFetch = need.slice(0, MAX_MISSES_PER_REQUEST);
    const upserts = [];
    await Promise.all(toFetch.map(v => limit(async () => {
        try {
            const { data } = await rsServiceability({
                pickup, delivery: v.pincode, weight: v.weight, cod: !!cod, value: 0, isReturn: false
            });
            const s = summarize(data);
            results[`${v.pincode}-${v.weight}`] = { ...s, cached: false };
            upserts.push({
                cache_key: v.cacheKey,
                pickup_pincode: pickup,
                delivery_pincode: v.pincode,
                weight: v.weight,
                serviceable: s.serviceable,
                courier_count: s.courier_count,
                fastest_days: s.fastest_days,
                slowest_days: s.slowest_days,
                earliest_cutoff: s.earliest_cutoff,
                cheapest_freight: s.cheapest_freight,
                checked_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        } catch (e) {
            results[`${v.pincode}-${v.weight}`] = { serviceable: null, error: true, cached: false };
        }
    })));

    if (upserts.length) {
        const { error } = await supabase.from(CACHE_TABLE).upsert(upserts, { onConflict: 'cache_key' });
        if (error) console.warn(`[Serviceability] cache write failed: ${error.message}`);
    }

    // Pincodes we skipped (over the per-request cap) are simply absent → client shows "…"
    return res.json({ pickup, results, pending: Math.max(0, need.length - toFetch.length) });
});

module.exports = router;
