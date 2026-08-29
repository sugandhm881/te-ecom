// ─────────────────────────────────────────────────────────────────────────────
// Admin → Zone Mapping — KwikShip's serviceability sheet (pincode RANGE ➜ delivery zone).
//
// WHY THIS EXISTS
// Every row in `shipment_journey_ecom` carries a `zone` (A–E) that the TAT, RTO%, freight and
// Last-Mile dashboards slice by. Until now that zone was a GUESS: `zoneFromState()` in
// delivery_journey.js maps a destination STATE to a zone, so every pincode in Maharashtra got 'C'
// regardless of whether it was Mumbai metro or a village 400 km inland. KwikShip bills by their own
// pincode-level zone table, so the guess and the invoice disagreed.
//
// ⚠️ READ THE COLUMN NAMES CAREFULLY — THEY LIE. The sheet has `Pin_code_From` and `Pin_code_To`,
// which look like a range. They are not. `Pin_code_From` is the **PICKUP** pincode and is the SAME
// value on every row (122101 = the Gurgaon warehouse; it is also the number in the report's
// filename, `Pincode_Serviceability_Report_122101_….csv`). `Pin_code_To` is the **DESTINATION**.
// The file is one row per serviceable destination — ~30,600 of them.
//
// Reading it as a From..To band is actively destructive and was caught only in preview: it turns
// each row into a huge overlapping span (122101..802157 = 680k pincodes) that would zone shipments
// at random, AND a "From > To" sanity check silently drops every destination numerically BELOW the
// pickup — all of Delhi (110xxx), Faridabad (121xxx) and Gurgaon itself (122001-122100), i.e.
// precisely the zone A/B core. Lookup is therefore an EXACT match on `Pin_code_To`.
//
// `zone_mapping_with_pincode` mirrors the 75 sheet headers EXACTLY (quoted, case-sensitive) so the
// CSV imports straight into Supabase with no column mapping. Only Pin_code_To / Zone drive the
// shipment mapping; Pin_code_From and the ~70 courier columns are stored as-is for reference.
//
// SCOPE — deliberately KwikShip-only:
//   • source='kwikship'  → zone comes from this sheet, falling back to zoneFromState() when the
//                          pincode falls in no range (never blank — an empty zone would add a hole
//                          to every zone chart).
//   • source='rapidshyp' / 'docpharma' → completely untouched, still state-derived.
//
// THE LOOKUP RULE LIVES IN THE DB, NOT HERE. `zone_for_pincode(pin)` resolves one pincode and
// `remap_kwikship_zones()` does the bulk pass. The Node sync and the webhook edge function BOTH call
// the same function rather than re-implementing it — these two have silently drifted apart three
// times before, so there is deliberately no second copy of the rule to fall out of step.
//
// Routes (ALL admin-only — the router gates itself):
//   POST /api/zone-mapping/upload   { filename, contentBase64, dryRun, replace }
//   GET  /api/zone-mapping/summary  → ranges, pincodes covered, zone spread, KwikShip coverage
//   GET  /api/zone-mapping/lookup   ?pincode=110001
//   POST /api/zone-mapping/remap    → re-derive zone on every KwikShip journey row
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const ExcelJS = require('exceljs');
const router = express.Router();
const { supabase } = require('../supabase');
const { tokenRequired, requireAdmin } = require('../auth');

// Self-contained gate: reference data that rewrites zones on 1,000+ live shipments is admin-only no
// matter where this router ends up mounted.
//
// ⚠️⚠️ THE PATH ARGUMENT IS LOAD-BEARING — do not drop it to `router.use(tokenRequired, requireAdmin)`.
// This router is mounted at bare `/api`, and a router-level `use()` with no path runs for EVERY
// request that reaches the router, not just this router's own routes. Without the `/zone-mapping`
// scope it therefore gated everything mounted AFTER it in server.js — DocPharma Recon, RapidShyp
// Recon, the DocPharma invoice/ledger/overview/inventory pages and the Teams bot endpoint all
// returned 403 to any non-admin who legitimately held the permission. Verified: a user with
// `docpharma-recon` got 200 on a route mounted before this line and 403 on one mounted after.
router.use('/zone-mapping', tokenRequired, requireAdmin);

const TABLE = 'zone_mapping_with_pincode';
const COL_FROM = 'Pin_code_From', COL_TO = 'Pin_code_To', COL_ZONE = 'Zone';

// exceljs hands back Dates, formula results and rich text depending on the cell — flatten all of it.
function cellText(cell) {
    let v = cell ? cell.value : null;
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
        if (v.text) v = v.text;
        else if (v.result !== undefined) v = v.result;
        else if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join('');
        else if (v.hyperlink) v = v.text || v.hyperlink;
        else return '';
    }
    return String(v).trim();
}

// Headers are matched case- and separator-insensitively ("Pin_code_From" == "pin code from"), so a
// re-exported sheet with cosmetic header changes still lands in the right columns.
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Indian pincodes are exactly 6 digits and never start with 0.
const VALID_PIN = /^[1-9][0-9]{5}$/;
function cleanPin(raw) {
    const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
    return VALID_PIN.test(digits) ? digits : null;
}

// The table's live column list, so the uploader never carries a stale hardcoded copy.
let _cols = null, _colsAt = 0;
async function tableColumns() {
    if (_cols && Date.now() - _colsAt < 10 * 60 * 1000) return _cols;
    const { data, error } = await supabase.rpc('zone_mapping_columns');
    if (error) throw new Error(`Could not read the table schema: ${error.message}`);
    _cols = data || [];
    _colsAt = Date.now();
    return _cols;
}

async function loadSheet(buffer, filename) {
    const wb = new ExcelJS.Workbook();
    if (/\.csv$/i.test(filename || '')) {
        const { Readable } = require('stream');
        await wb.csv.read(Readable.from(buffer.toString('utf8')));
    } else {
        await wb.xlsx.load(buffer);   // .xls (BIFF) is NOT supported — the caller is told to re-save
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('That file has no sheets.');
    return ws;
}

// Find the header row by looking for the three columns we act on. Serviceability exports sometimes
// carry a title/legend row or two before the real header.
function findHeader(ws) {
    const maxCol = Math.min(ws.columnCount || 100, 200);
    const want = [norm(COL_FROM), norm(COL_TO), norm(COL_ZONE)];
    for (let i = 1; i <= Math.min(ws.rowCount, 40); i++) {
        const row = ws.getRow(i);
        const headers = [];
        for (let c = 1; c <= maxCol; c++) headers.push(cellText(row.getCell(c)));
        const keys = headers.map(norm);
        if (want.every(w => keys.includes(w))) return { headerRow: i, headers, keys };
    }
    return null;
}

// Read every data row into a plain object keyed by the TABLE's column names.
// A sheet header that matches no table column is reported, not silently dropped.
function parseRows(ws, headerRow, headers, keys, columns) {
    const byNorm = new Map(columns.map(c => [norm(c), c]));
    const colFor = keys.map(k => byNorm.get(k) || null);      // sheet column index → table column
    const unknown = headers.filter((h, i) => h && !colFor[i]);

    const iFrom = keys.indexOf(norm(COL_FROM));
    const iTo = keys.indexOf(norm(COL_TO));
    const iZone = keys.indexOf(norm(COL_ZONE));

    const rows = [];
    let badPin = 0, missingZone = 0, dupDest = 0;
    const origins = new Set();
    const seenDest = new Map();
    const conflicts = [];

    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        // ⚠️ `Pin_code_From` is the PICKUP pincode (constant, e.g. 122101 = Gurgaon) and
        // `Pin_code_To` is the DESTINATION. This is NOT a From..To range — an earlier reading of it
        // as one skipped every destination numerically below the pickup (all of Delhi 110xxx,
        // Faridabad 121xxx and Gurgaon itself), which is precisely the A/B zone core.
        const from = cleanPin(cellText(row.getCell(iFrom + 1)));
        const dest = cleanPin(cellText(row.getCell(iTo + 1)));
        const zone = cellText(row.getCell(iZone + 1)).replace(/^zone[\s\-_:]*/i, '').trim();

        if (!dest) {
            if (cellText(row.getCell(iTo + 1))) badPin++;
            continue;   // blank rows and the footer land here
        }
        if (!zone) { missingZone++; continue; }
        if (from) origins.add(from);

        const prev = seenDest.get(dest);
        if (prev !== undefined) {
            // Same destination listed twice: harmless if it agrees, worth surfacing if it doesn't.
            if (prev !== zone && conflicts.length < 50) conflicts.push({ pincode: dest, zones: [prev, zone] });
            dupDest++;
            continue;   // first occurrence wins, matching zone_for_pincode()'s `order by id`
        }
        seenDest.set(dest, zone);

        const out = { [COL_FROM]: from ? Number(from) : null, [COL_TO]: Number(dest), [COL_ZONE]: zone.length <= 2 ? zone.toUpperCase() : zone };
        for (let c = 0; c < colFor.length; c++) {
            const col = colFor[c];
            if (!col || col === COL_FROM || col === COL_TO || col === COL_ZONE) continue;
            const v = cellText(row.getCell(c + 1));
            if (v !== '') out[col] = v;
        }
        rows.push(out);
    }
    return { rows, badPin, missingZone, dupDest, conflicts, unknown, origins: [...origins] };
}

const CHUNK = 500;

// ── POST /zone-mapping/upload ────────────────────────────────────────────────────────────────────
// dryRun:true  → parse + report only, writes nothing (the preview step).
// replace:true → wipe the table first, so a fresh sheet fully supersedes the previous one.
router.post('/zone-mapping/upload', async (req, res) => {
    const { filename, contentBase64, dryRun, replace } = req.body || {};
    try {
        if (!contentBase64) return res.status(400).json({ success: false, error: 'No file was uploaded.' });
        if (/\.xls$/i.test(filename || '')) {
            return res.status(400).json({ success: false, error: 'Old .xls files are not supported. Open it in Excel and "Save As" → .xlsx (or .csv), then upload again.' });
        }
        const columns = await tableColumns();
        const ws = await loadSheet(Buffer.from(contentBase64, 'base64'), filename);

        const found = findHeader(ws);
        if (!found) {
            return res.status(400).json({
                success: false,
                error: `Could not find the header row. The sheet must name "${COL_FROM}", "${COL_TO}" and "${COL_ZONE}" columns.`,
            });
        }

        const { rows, badPin, missingZone, dupDest, conflicts, unknown, origins } =
            parseRows(ws, found.headerRow, found.headers, found.keys, columns);
        if (!rows.length) {
            return res.status(400).json({ success: false, error: 'No usable rows — every line was missing a valid 6-digit destination pincode or a zone.' });
        }

        const zoneSpread = {};
        rows.forEach(r => { zoneSpread[r[COL_ZONE]] = (zoneSpread[r[COL_ZONE]] || 0) + 1; });

        const summary = {
            filename: filename || null,
            headerRow: found.headerRow,
            destinations: rows.length,
            badPin, missingZone, dupDest,
            conflicts: conflicts.length,
            conflictSample: conflicts.slice(0, 10),
            origins,
            unknownColumns: unknown,
            matchedColumns: found.headers.filter(Boolean).length - unknown.length,
            zones: Object.entries(zoneSpread).map(([zone, count]) => ({ zone, count })).sort((a, b) => b.count - a.count),
            sample: rows.slice(0, 15).map(r => ({
                from: r[COL_FROM], dest: r[COL_TO], zone: r[COL_ZONE],
                fields: Object.keys(r).length,
            })),
        };

        if (dryRun) return res.json({ success: true, dryRun: true, summary });

        if (replace) {
            // `gt('id', 0)` is the PostgREST way to say "every row" — a bare delete() is rejected.
            const { error: delErr } = await supabase.from(TABLE).delete().gt('id', 0);
            if (delErr) throw new Error(`Could not clear the existing sheet: ${delErr.message}`);
        }

        let written = 0;
        for (let i = 0; i < rows.length; i += CHUNK) {
            const batch = rows.slice(i, i + CHUNK);
            const { error } = await supabase.from(TABLE).insert(batch);
            if (error) throw new Error(`Row ${i + 1}–${i + batch.length}: ${error.message}`);
            written += batch.length;
        }

        // Apply it straight away — an upload that doesn't move the shipments is a half-done job.
        const { data: remap, error: remapErr } = await supabase.rpc('remap_kwikship_zones');
        if (remapErr) console.error('[ZoneMapping] remap after upload failed:', remapErr.message);
        // Zone drives the rate, so freight has to be re-costed whenever a zone moves. ⚠️ Through the
        // wrapper, never the RPC directly: the RPC nulls any weight we supplied, so the backfill has to
        // follow it or shipments KwikShip never weighed go straight back to unpriced.
        const { data: charges, error: chargeErr } = await require('./kwikship_sync').applyKwikshipCharges();
        if (chargeErr) console.error('[ZoneMapping] charge recalc after upload failed:', chargeErr.message);
        // Zone & State: a ONE-TIME lookup per sheet (no cron, by instruction). First copy every cached India
        // Post / order-address answer onto the new rows, then walk whatever is still unresolved through
        // India Post in the background — a replaced sheet is usually the same ~30k pincodes, so most rows
        // are answered from cache in one statement and the API is only asked about genuinely new ones.
        supabase.rpc('zone_mapping_fill_all').then(() => enrichZoneStates({ limit: 31000 })).catch(e => console.warn('[ZoneMapping] state lookup after upload:', e.message));

        console.log(`[ZoneMapping] ${(req.user && req.user.sub) || 'admin'} uploaded ${filename || 'sheet'} — ${written} destination pincodes; remap: ${JSON.stringify(remap || (remapErr && remapErr.message))}; charges: ${JSON.stringify(charges || (chargeErr && chargeErr.message))}`);
        res.json({
            success: true, written, summary,
            remap: remap || null, remapError: remapErr ? remapErr.message : null,
            charges: charges || null, chargeError: chargeErr ? chargeErr.message : null,
        });
    } catch (e) {
        console.error('[ZoneMapping] upload error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── GET /zone-mapping/summary ────────────────────────────────────────────────────────────────────
router.get('/zone-mapping/summary', async (_req, res) => {
    try {
        const { data, error } = await supabase.rpc('zone_mapping_stats');
        if (error) throw new Error(error.message);
        res.json({ success: true, ...(data || {}) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── GET /zone-mapping/lookup?pincode=110001 ──────────────────────────────────────────────────────
// Spot-check a pincode: which zone a KwikShip shipment there gets, and which range decided it.
router.get('/zone-mapping/lookup', async (req, res) => {
    const pin = cleanPin(req.query.pincode);
    if (!pin) return res.status(400).json({ success: false, error: 'Enter a 6-digit pincode.' });
    try {
        const { data: zone, error } = await supabase.rpc('zone_for_pincode', { p_pin: pin });
        if (error) throw new Error(error.message);

        // The sheet row behind the answer, so the admin can see the courier flags for that destination.
        let row = null;
        if (zone) {
            const { data } = await supabase.from(TABLE).select('*')
                .eq(COL_TO, Number(pin)).order('id').limit(1);
            row = (data && data[0]) || null;
        }
        res.json({ success: true, pincode: pin, found: !!zone, zone: zone || null, row });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── POST /zone-mapping/remap ─────────────────────────────────────────────────────────────────────
// Re-run the mapping over every KwikShip journey row. Safe to run repeatedly; pincodes in no range
// keep their state-derived zone.
// ── Zone & State tab (2026-08-29) — browse / filter the sheet by STATE, download as Excel ─────────
// The sheet has no state/city column; `state` / `city` / `district` come from ONE source — India Post's
// free API via pincode_geo_ecom (user: "don't guess anything") — filled by zone_mapping_fill_state() and the
// trigger on pincode_geo_ecom; enrichZoneStates() walks the unanswered pincodes. See migration 20260829_zone_mapping_state.
const PAGE_MAX = 500;
function pinFilters(q, query) {
    const state = String(query.state || '').trim(), zone = String(query.zone || '').trim().toUpperCase(), search = String(query.q || '').replace(/\D/g, '');
    const place = String(query.place || '').trim().replace(/[,%()]/g, '');   // city OR district contains
    if (place) q = q.or(`city.ilike.%${place}%,district.ilike.%${place}%`);
    if (state === '(not an India Post pincode)') q = q.eq('state_source', 'not_in_directory');
    else if (state === '(unknown)') q = q.is('state', null).is('state_source', null);
    else if (state) q = q.eq('state', state);
    if (zone) q = q.eq('Zone', zone);
    if (search) q = q.gte('Pin_code_To', Number(search.padEnd(6, '0'))).lte('Pin_code_To', Number(search.padEnd(6, '9')));   // prefix search on a numeric column
    return q;
}
router.get('/zone-mapping/states', async (_req, res) => {
    try {
        const [{ data: states, error }, { data: zones }] = await Promise.all([
            supabase.rpc('zone_mapping_states'),
            supabase.from('zone_mapping_with_pincode').select('Zone').limit(1),   // cheap existence check
        ]);
        if (error) throw new Error(error.message);
        const tot = (states || []).reduce((a, s) => a + Number(s.pincodes), 0);
        const src = { indiapost: 0, orders: 0, nearest: 0, prefix: 0, not_in_directory: 0 };
        (states || []).forEach(s => { src.indiapost += Number(s.indiapost); src.orders += Number(s.orders); src.nearest += Number(s.nearest || 0); src.prefix += Number(s.prefix); src.not_in_directory += Number(s.not_in_directory || 0); });
        res.json({ success: true, states: states || [], total: tot, sources: src, enrich: enrichStatus(), hasSheet: !!(zones && zones.length) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.get('/zone-mapping/pincodes', async (req, res) => {
    try {
        const page = Math.max(0, parseInt(req.query.page, 10) || 0), size = Math.min(PAGE_MAX, Math.max(50, parseInt(req.query.size, 10) || 200));
        let q = supabase.from('zone_mapping_with_pincode').select('"Pin_code_To", "Zone", state, city, district, state_source', { count: 'exact' });
        q = pinFilters(q, req.query).order('Pin_code_To').range(page * size, page * size + size - 1);
        const { data, error, count } = await q;
        if (error) throw new Error(error.message);
        res.json({ success: true, rows: (data || []).map(r => ({ pincode: r.Pin_code_To, zone: r.Zone, state: r.state, city: r.city, district: r.district, state_source: r.state_source })), total: count || 0, page, size });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
// Excel — SERVER-SIDE over the full filtered set, never the rendered page (the PG-recon lesson).
router.get('/zone-mapping/pincodes.xlsx', async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const rows = [];
        for (let page = 0; ; page++) {
            let q = supabase.from('zone_mapping_with_pincode').select('"Pin_code_From", "Pin_code_To", "Zone", state, city, district, state_source');
            const { data, error } = await pinFilters(q, req.query).order('Pin_code_To').range(page * 1000, page * 1000 + 999);
            if (error) throw new Error(error.message);
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        const wb = new ExcelJS.Workbook(); wb.creator = 'Pravidhi';
        const ws = wb.addWorksheet('Zone & State');
        const state = String(req.query.state || '').trim(), zone = String(req.query.zone || '').trim().toUpperCase();
        ws.addRow([`KwikShip zone mapping — ${state || 'all states'}${zone ? ' · zone ' + zone : ''}${req.query.place ? ' · ' + String(req.query.place).replace(/[^\w .-]/g, '') : ''} · ${rows.length.toLocaleString('en-IN')} pincodes · exported ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`]);
        ws.mergeCells('A1:G1'); ws.getCell('A1').font = { bold: true, size: 12 };
        const hdr = ws.addRow(['Pincode', 'City', 'District', 'State', 'Zone', 'Source', 'Pickup pincode']);
        hdr.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } }; });
        rows.forEach(r => ws.addRow([Number(r.Pin_code_To), r.city || '', r.district || '', r.state || '', r.Zone || '', ({ indiapost: 'India Post', orders: 'our orders (customer-typed)', nearest: 'nearest real pincode', prefix: 'postal prefix', not_in_directory: 'not an India Post pincode' })[r.state_source] || 'resolving', r.Pin_code_From == null ? '' : Number(r.Pin_code_From)]));
        ws.columns = [{ width: 12 }, { width: 24 }, { width: 24 }, { width: 28 }, { width: 8 }, { width: 12 }, { width: 16 }];
        ws.views = [{ state: 'frozen', ySplit: 2 }]; ws.autoFilter = { from: 'A2', to: 'G2' };
        const fname = `zone-state-${(state || 'all').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}${zone ? '-' + zone : ''}-${new Date().toISOString().slice(0, 10)}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        await wb.xlsx.write(res); res.end();
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
// India Post enrichment — walks pincodes whose state is not yet exact (prefix / unknown) through the
// free API, caching each answer in pincode_geo_ecom; the DB trigger then stamps the zone row. Runs in
// the background (one job at a time), paced ~3/s; the nightly cron continues where it left off.
let _enrich = { running: false, done: 0, ok: 0, failed: 0, total: 0, startedAt: null, finishedAt: null, error: null };
function enrichStatus() { return { ..._enrich }; }
// Measured 2026-08-29: a one-off burst of 16 parallel calls is fine, but a SUSTAINED 10-worker run
// failed 805 of 1,000 (throttling); 4 workers with a 150 ms pace and one retry (~5/s, the whole sheet in
// ~1.7 h) is the rate it actually sustains. Sequential calls answer in ~500 ms each.
async function enrichZoneStates({ limit = 5000, concurrency = 4, paceMs = 150 } = {}) {
    if (_enrich.running) return enrichStatus();
    const pincodeApi = require('./pincode');
    _enrich = { running: true, done: 0, ok: 0, failed: 0, total: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null };
    (async () => {
        try {
            // PostgREST caps any single response at 1,000 rows — page the candidate list (the first run
            // silently did 1,000 of 31,000 and reported itself finished).
            const all = [];
            for (let page = 0; all.length < limit; page++) {
                const { data, error } = await supabase.from('zone_mapping_with_pincode').select('"Pin_code_To"')
                    .or('state_source.is.null,state_source.in.(orders,nearest,prefix)').order('Pin_code_To').range(page * 1000, page * 1000 + 999);
                if (error) throw new Error(error.message);
                all.push(...(data || []));
                if (!data || data.length < 1000) break;
            }
            const pins = [...new Set(all.slice(0, limit).map(r => String(r.Pin_code_To).padStart(6, '0')))];
            _enrich.total = pins.length;
            let i = 0;
            const worker = async () => {
                while (i < pins.length && _enrich.running) {
                    const pin = pins[i++];
                    try {
                        let hit = await pincodeApi.fromCache(pin) || await pincodeApi.fromIndiaPost(pin);
                        if (!hit) { await new Promise(r => setTimeout(r, 1500)); hit = await pincodeApi.fromIndiaPost(pin); }   // one retry — a throttled miss is not a missing pincode
                        if (hit && hit.state) {
                            await supabase.from('pincode_geo_ecom').upsert({ pincode: hit.pincode, city: hit.city, state: hit.state, district: hit.district, source: hit.source || 'indiapost', updated_at: new Date().toISOString() }, { onConflict: 'pincode' });
                            _enrich.ok++;
                        } else _enrich.failed++;
                    } catch (_) { _enrich.failed++; }
                    _enrich.done++;
                    await new Promise(r => setTimeout(r, paceMs));
                }
            };
            await Promise.all(Array.from({ length: concurrency }, worker));
            await supabase.rpc('zone_mapping_fill_all');   // re-run the whole ladder: a new India Post answer outranks nearest/prefix
        } catch (e) { _enrich.error = e.message; }
        finally { _enrich.running = false; _enrich.finishedAt = new Date().toISOString(); console.log(`[ZoneStates] enrichment: ${_enrich.ok} resolved, ${_enrich.failed} failed of ${_enrich.total}`); }
    })();
    return enrichStatus();
}
router.post('/zone-mapping/enrich-states', async (req, res) => {
    res.json({ success: true, ...enrichZoneStates({ limit: Math.min(31000, parseInt((req.body || {}).limit, 10) || 5000) }) });
});
router.get('/zone-mapping/enrich-states', (_req, res) => res.json({ success: true, ...enrichStatus() }));
// India Post directory (data.gov.in CSV) — permanent table; see pincode_directory.js.
router.get('/zone-mapping/pincode-directory', async (_req, res) => {
    try { res.json({ success: true, ...(await require('./pincode_directory').status()) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/zone-mapping/pincode-directory/upload', async (req, res) => {
    const { contentBase64, replace } = req.body || {};
    if (!contentBase64) return res.status(400).json({ success: false, error: 'No file was uploaded.' });
    try {
        const text = Buffer.from(String(contentBase64), 'base64').toString('utf8');
        const r = await require('./pincode_directory').importDirectory(text, { replace: !!replace });
        console.log(`[PincodeDirectory] ${(req.user && req.user.sub) || 'admin'} imported ${r.written} post offices (replace=${!!replace}); zone rows filled: ${r.filled}`);
        res.json({ success: true, ...r });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
router.post('/zone-mapping/fill-states', async (_req, res) => {
    const { data, error } = await supabase.rpc('zone_mapping_fill_all');
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, updated: data });
});

router.post('/zone-mapping/remap', async (req, res) => {
    try {
        const { data, error } = await supabase.rpc('remap_kwikship_zones');
        if (error) throw new Error(error.message);
        // Always re-cost after re-zoning: the rate is a function of the zone, so leaving freight behind
        // would put the two out of step until the next upload. ⚠️ Wrapper, not the raw RPC — see above.
        const { data: charges, error: chargeErr } = await require('./kwikship_sync').applyKwikshipCharges();
        if (chargeErr) console.error('[ZoneMapping] charge recalc failed:', chargeErr.message);
        console.log(`[ZoneMapping] manual remap by ${(req.user && req.user.sub) || 'admin'}: ${JSON.stringify(data)}; charges: ${JSON.stringify(charges || (chargeErr && chargeErr.message))}`);
        res.json({ success: true, ...(data || {}), charges: charges || null, chargeError: chargeErr ? chargeErr.message : null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Shared lookup used by the KwikShip sync path ─────────────────────────────────────────────────
// Returns the mapped zone for a pincode, or null when it falls in no range (caller falls back to
// zoneFromState). Cached in-process: the nightly sync asks for hundreds of pincodes in a row and the
// sheet only changes on an upload.
const _zoneCache = new Map();
let _zoneCacheAt = 0;
const ZONE_CACHE_TTL = 30 * 60 * 1000;

async function zoneForPincode(pincode) {
    const pin = cleanPin(pincode);
    if (!pin) return null;
    if (Date.now() - _zoneCacheAt > ZONE_CACHE_TTL) { _zoneCache.clear(); _zoneCacheAt = Date.now(); }
    if (_zoneCache.has(pin)) return _zoneCache.get(pin);
    try {
        const { data, error } = await supabase.rpc('zone_for_pincode', { p_pin: pin });
        if (error) return null;
        const zone = data || null;
        _zoneCache.set(pin, zone);
        return zone;
    } catch (_) { return null; }   // a lookup failure must never break a shipment sync
}

module.exports = router;
module.exports.zoneForPincode = zoneForPincode;
module.exports.cleanPin = cleanPin;
module.exports.enrichZoneStates = enrichZoneStates;
