// ─────────────────────────────────────────────────────────────────────────────
// SARVAM'S OWN BILLED USAGE — captured by a bookmarklet, not a scraper.
//
// User, 2026-09-08: "is possible through without extension, max safest option".
//
// WHY THIS SHAPE. Sarvam has no usage API — every plausible path on api.sarvam.ai 404s — and the
// console (indus.sarvam.ai) sits behind Cloudflare with a Google-OIDC session that expires in ~12
// hours. Three ways to get the number, and this is the one that costs the least trust:
//
//   · Headless browser on the VPS — fully automatic, but it puts a logged-in Google session on the
//     server and fights Cloudflare's bot protection for the rest of its life.
//   · Browser extension — safe in practice, but installing one grants a broad, permanent capability.
//   · A BOOKMARKLET — nothing installed, nothing granted, no background execution. It runs once when
//     the user clicks it on the usage page, in that tab, and is gone. ← this.
//
// THE KEY PROPERTY: no credential ever reaches this server. The bookmarklet runs on Sarvam's own
// origin, so the browser attaches the session cookies itself; the script never reads them and could
// not if it tried (`sarvam_identity_session` is httpOnly). Only aggregate rupees and counts arrive
// here. If this database leaked tomorrow, an attacker would have our cost figures — not our account.
//
// text/plain ON PURPOSE. The post is cross-origin, and text/plain is a CORS "simple request", so the
// browser sends it without a preflight the Sarvam origin would never answer. The body is still JSON;
// we parse it ourselves.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');

const KEY = () => String(process.env.SARVAM_USAGE_INGEST_KEY || '').trim();

// Raw body, because the bookmarklet sends text/plain to dodge the CORS preflight.
// CORS, so the bookmarklet can READ the answer. Without it the post has to run as `no-cors`, which
// resolves successfully even on a 401 or a 404 — the click would cheerfully report "sent" while
// nothing was stored. text/plain keeps it a CORS *simple* request either way, so no preflight is
// needed; this header only makes the reply legible. The key is what actually guards the endpoint.
router.options('/support/sarvam-usage', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*').set('Access-Control-Allow-Headers', 'Content-Type').sendStatus(204);
});
router.post('/support/sarvam-usage', express.text({ type: '*/*', limit: '256kb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
        if (!KEY()) return res.status(503).json({ success: false, error: 'ingest key not configured' });
        let body = {};
        try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
        catch (_) { return res.status(400).json({ success: false, error: 'body must be JSON' }); }

        // The key rides in the body rather than a header: a custom header would force the preflight
        // that text/plain exists to avoid.
        if (String(body.key || '') !== KEY()) return res.status(401).json({ success: false, error: 'bad key' });

        // A WEEK IN ONE CLICK (user, 2026-09-08: "how do I avoid manual click … it should update in a
        // few times"). No browser will auto-run a script on a third-party page without an extension —
        // that is the rule that makes a bookmarklet safe, not a gap to route around. So instead of
        // clicking more often, one click now carries several days: Sarvam's summary is per-RANGE, not
        // per-day, so the bookmarklet asks day by day and posts them together. A weekly click keeps the
        // figures complete, and a missed week costs nothing because each day is re-fetchable.
        // COMPACT FORM, for a six-month backfill (user, 2026-09-08: "update that as last 6 month when
        // click"). 180 days of full summary JSON is ~100 KB, and the payload travels in a URL fragment
        // — long enough to be refused. So the bookmarklet may send the trimmed shape instead:
        //     { d: '2026-09-08', t: 159.08, g: [['bulbul:v3', 141.888], …] }
        // ~120 bytes a day, so half a year fits in about 20 KB. Nothing is lost that the statement
        // reads: the per-model split is what the breakdown shows, and the raw blob was never used.
        if (Array.isArray(body.d) && body.d.length) {
            const rows = body.d
                .filter(x => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(x.d || '')))
                .map(x => ({
                    day: x.d,
                    total_cost: Number(x.t) || null,
                    balance: body.balance != null ? Number(body.balance) : null,
                    groups: (x.g || []).map(([model, total_cost]) => ({ model, total_cost })),
                    raw: null,
                    captured_at: new Date().toISOString(),
                }));
            if (!rows.length) return res.status(400).json({ success: false, error: 'no valid days' });
            // Chunked: Supabase refuses very large upserts, and half a year is 180 rows.
            for (let k = 0; k < rows.length; k += 100) {
                const { error: e3 } = await supabase.from('sarvam_usage_ecom').upsert(rows.slice(k, k + 100), { onConflict: 'day' });
                if (e3) return res.status(500).json({ success: false, error: e3.message });
            }
            const sum = Math.round(rows.reduce((a, r) => a + (r.total_cost || 0), 0) * 100) / 100;
            console.log(`[SarvamUsage] ${rows.length} days backfilled · ₹${sum}`);
            return res.json({ success: true, days: rows.length, day: rows[0].day, total_cost: sum });
        }

        if (Array.isArray(body.days) && body.days.length) {
            const rows = body.days
                .filter(d => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(d.date || '').slice(0, 10)))
                .map(d => ({
                    day: String(d.date).slice(0, 10),
                    total_cost: Number((d.usage || {}).total_cost ?? (d.usage || {}).subtotal ?? 0) || null,
                    balance: body.balance != null ? Number(body.balance) : null,
                    groups: (d.usage || {}).groups || null,
                    raw: d.usage || null,
                    captured_at: new Date().toISOString(),
                }));
            if (!rows.length) return res.status(400).json({ success: false, error: 'no valid days' });
            const { error: e2 } = await supabase.from('sarvam_usage_ecom').upsert(rows, { onConflict: 'day' });
            if (e2) return res.status(500).json({ success: false, error: e2.message });
            const sum = Math.round(rows.reduce((a, r) => a + (r.total_cost || 0), 0) * 100) / 100;
            console.log(`[SarvamUsage] ${rows.length} days captured · ₹${sum} · balance ₹${rows[0].balance}`);
            return res.json({ success: true, days: rows.length, day: rows[0].day, total_cost: sum });
        }

        const day = String(body.date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ success: false, error: 'date (YYYY-MM-DD) required' });

        const usage = body.usage || {};
        const row = {
            day,
            total_cost: Number(usage.total_cost ?? usage.subtotal ?? 0) || null,
            balance: body.balance != null ? Number(body.balance) : null,
            groups: usage.groups || null,
            raw: usage,
            captured_at: new Date().toISOString(),
        };
        // Re-posting the same day overwrites it — the console's figure for a day keeps moving until
        // the day is over, so the last capture is the right one.
        const { error } = await supabase.from('sarvam_usage_ecom').upsert(row, { onConflict: 'day' });
        if (error) return res.status(500).json({ success: false, error: error.message });

        console.log(`[SarvamUsage] ${day}: ₹${row.total_cost} billed · balance ₹${row.balance}`);
        res.json({ success: true, day, total_cost: row.total_cost });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// What Sarvam billed across a range, for the statement to sit beside its own measurement.
async function sarvamBilled(from, to) {
    try {
        const { data } = await supabase.from('sarvam_usage_ecom')
            .select('day, total_cost, balance, groups').gte('day', from).lte('day', to).order('day');
        const rows = data || [];
        if (!rows.length) return { ok: false, total: 0, days: 0 };
        const total = rows.reduce((a, r) => a + (Number(r.total_cost) || 0), 0);
        // Per-model totals summed across the range — bulbul / saaras / saarika each priced differently.
        const byModel = {};
        for (const r of rows) for (const g of (r.groups || [])) {
            const k = g.model || '?';
            byModel[k] = Math.round(((byModel[k] || 0) + (Number(g.total_cost) || 0)) * 100) / 100;
        }
        return { ok: true, total: Math.round(total * 100) / 100, days: rows.length, byModel,
            balance: Number(rows[rows.length - 1].balance) || null };
    } catch (e) { return { ok: false, total: 0, days: 0 }; }
}

module.exports = { router, sarvamBilled };
