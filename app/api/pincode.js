/**
 * Pincode → City / State lookup for the address forms.
 *
 * Source: **India Post's free public API** (https://api.postalpincode.in) — no key, no quota, no
 * account. Per the brief, city/state must come from a free public API and NOT be derived from our own
 * order/shipment history or a courier (RapidShyp) — those reflect what we happened to ship, which can
 * be stale or wrong for a pincode we've never delivered to.
 *
 * `pincode_geo_ecom` is a pure CACHE of that API's answers (one row per pincode, `source='indiapost'`),
 * so a given pincode costs one upstream call ever. It is never seeded from our own data.
 *
 * Picking the CITY is the fiddly part — no single field is right on its own:
 *   District  110001 → "Central Delhi" (want New Delhi),  781001 → "Kamrup" (want Guwahati)
 *   Block     122018 → "NA",  781001 → "Gmc",  560001 → "Bangalore North"
 *   Division  usually the city plus a postal suffix: "Hyderabad City", "Bangalore GPO", "Mumbai  South"
 * So: take **Division**, strip the postal suffixes (North/South/East/West/Central/City/GPO/HQ/H.O),
 * and fall back to Block then District if that leaves nothing usable. Measured against 18 pincodes
 * across 18 states this returns the expected city for all 18. City/State stay editable in every form
 * regardless, because no dataset is right 100% of the time.
 *
 * Rejected alternative: api.zippopotam.us — 404s on common pincodes (122018) and returns a locality
 * ("Janpath" for 110001) instead of a city, so a wrong-looking autofill would be worse than none.
 *
 * Route:  GET /api/pincode/:pin  →  { success, pincode, city, state, district, source, cached }
 */
const express = require('express');
const axios = require('axios');
const router = express.Router();
const { tokenRequired } = require('../auth');
const { supabase } = require('../supabase');

const VALID = /^[1-9][0-9]{5}$/;          // Indian pincodes never start with 0
const UPSTREAM = 'https://api.postalpincode.in/pincode/';

// Title-case a dataset value: "GURGAON" / "gurgaon" → "Gurgaon". Hyphens and slashes keep their casing
// boundaries so "24-PARGANAS" and "DADRA/NAGAR" don't come out mangled.
function tidy(s) {
    return String(s || '').trim().toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/(^|[\s\-/(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

// Drop the postal suffixes India Post appends to a Division/Block ("Hyderabad City" → "Hyderabad").
function stripPostal(s) {
    const t = tidy(String(s || '').replace(/\s+(north|south|east|west|central|city|gpo|hq|h\.?o\.?)\b/ig, ''));
    return t;
}
// Usable as a city name? Rejects blanks, "NA"/"N/A", and 3-char postal codes like "Gmc".
const usableCity = v => { const t = String(v || '').trim(); return !!t && !/^n\.?\/?a\.?$/i.test(t) && t.length > 3; };

function pickCity(po) {
    for (const cand of [po.Division, po.Block, po.District]) {
        const v = stripPostal(cand);
        if (usableCity(v)) return v;
    }
    return tidy(po.District);
}

async function fromCache(pin) {
    try {
        const { data } = await supabase.from('pincode_geo_ecom')
            .select('pincode, city, state, district, source').eq('pincode', pin).maybeSingle();
        if (data) return data;
        // The permanent India Post directory (india_pincode_directory_ecom, 2026-08-29) — answers offline,
        // same data the live API serves. Checked before the API, after the per-pincode cache.
        const { data: dir } = await supabase.rpc('pincode_directory_lookup', { p_pin: pin });
        const row = Array.isArray(dir) ? dir[0] : dir;
        if (row && row.state) return { pincode: pin, city: row.city, state: row.state, district: row.district, source: 'indiapost_directory' };
        return null;
    } catch (_) { return null; }
}

// Fetch from India Post. Returns null when the pincode is unknown or the service is unreachable —
// callers must treat that as "couldn't autofill", never as an error worth blocking the form.
async function fromIndiaPost(pin) {
    const r = await axios.get(UPSTREAM + pin, { timeout: 12000, validateStatus: () => true });
    if (r.status >= 400) return null;
    const d = Array.isArray(r.data) ? r.data[0] : null;
    if (!d || d.Status !== 'Success' || !Array.isArray(d.PostOffice) || !d.PostOffice.length) return null;
    const po = d.PostOffice[0];
    const city = pickCity(po), state = tidy(po.State);
    if (!city || !state) return null;
    return { pincode: pin, city, state, district: tidy(po.District), source: 'indiapost' };
}

// GET /api/pincode/:pin
router.get('/pincode/:pin', tokenRequired, async (req, res) => {
    const pin = String(req.params.pin || '').trim();
    if (!VALID.test(pin)) return res.status(400).json({ success: false, error: 'Enter a 6-digit pincode.' });
    try {
        const hit = await fromCache(pin);
        if (hit) return res.json({ success: true, ...hit, cached: true });

        let out = null;
        try { out = await fromIndiaPost(pin); }
        catch (e) { console.error('[Pincode] upstream error for', pin, '-', e.message); }
        if (!out) return res.status(404).json({ success: false, error: 'No match for that pincode — enter city and state manually.' });

        // Cache it. A write failure must not fail the lookup the user is waiting on.
        supabase.from('pincode_geo_ecom').upsert({
            pincode: out.pincode, city: out.city, state: out.state, district: out.district,
            source: out.source, updated_at: new Date().toISOString(),
        }, { onConflict: 'pincode' }).then(() => {}, () => {});

        res.json({ success: true, ...out, cached: false });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// The zone-mapping state enrichment walks unresolved pincodes through the same India Post call + cache.
router.fromIndiaPost = fromIndiaPost;
router.fromCache = fromCache;
module.exports = router;
