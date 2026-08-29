// India Post "All India Pincode Directory" — the permanent, offline copy of India Post's pincode data
// (data.gov.in CSV, ~160k post offices). One import feeds Zone & State (zone_mapping_fill_from_directory)
// and the Pincode→City/State autofill (pincode.js reads it before calling the live API).
//
// Two ways in, one parser: `node tools/import_pincode_directory.js <csv>` (first load, 25 MB) and the
// admin upload on Zone Mapping → Zone & State (refreshes). Upsert on (pincode, officename) — re-importing
// the same file changes nothing; `replace` empties the table first so a newer directory supersedes fully.
'use strict';
const { supabase } = require('../supabase');

const WANT = ['circlename', 'regionname', 'divisionname', 'officename', 'pincode', 'officetype', 'delivery', 'district', 'statename', 'latitude', 'longitude'];
const REQUIRED = ['officename', 'pincode', 'district', 'statename'];
const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF).
function parseCsv(text) {
    const rows = []; let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
        else if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some(v => v !== '')) rows.push(row); row = []; }
        else field += c;
    }
    if (field !== '' || row.length) { row.push(field); if (row.some(v => v !== '')) rows.push(row); }
    return rows;
}

// Parse + validate header; returns { rows, idx } or throws with the missing columns named.
function parseDirectoryCsv(text) {
    const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
    if (!rows.length) throw new Error('The file is empty.');
    const header = rows.shift().map(norm);
    const idx = {}; WANT.forEach(w => { idx[w] = header.indexOf(w); });
    const missing = REQUIRED.filter(w => idx[w] < 0);
    if (missing.length) throw new Error(`CSV is missing columns: ${missing.join(', ')} — found: ${header.join(', ')}`);
    return { rows, idx };
}

// Import into the table. onProgress(written) is optional. Returns { written, skipped, filled, coverage }.
async function importDirectory(text, { replace = false, onProgress } = {}) {
    const { rows, idx } = parseDirectoryCsv(text);
    if (replace) { const { error } = await supabase.from('india_pincode_directory_ecom').delete().neq('id', 0); if (error) throw new Error('clear failed: ' + error.message); }
    const get = (r, k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '') || null;
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const seen = new Set(); let written = 0, skipped = 0; const batch = [];
    const flush = async () => {
        if (!batch.length) return;
        const { error } = await supabase.from('india_pincode_directory_ecom').upsert(batch.splice(0), { onConflict: 'pincode,officename' });
        if (error) throw new Error('upsert failed: ' + error.message);
    };
    for (const r of rows) {
        const pin = String(get(r, 'pincode') || '').replace(/\D/g, ''), office = get(r, 'officename');
        if (!/^[1-9]\d{5}$/.test(pin) || !office) { skipped++; continue; }
        const key = pin + '|' + office; if (seen.has(key)) { skipped++; continue; } seen.add(key);
        batch.push({ circlename: get(r, 'circlename'), regionname: get(r, 'regionname'), divisionname: get(r, 'divisionname'), officename: office, pincode: pin,
            officetype: get(r, 'officetype'), delivery: get(r, 'delivery'), district: get(r, 'district'), statename: get(r, 'statename'),
            latitude: num(get(r, 'latitude')), longitude: num(get(r, 'longitude')) });
        written++;
        if (batch.length >= 1000) { await flush(); if (onProgress) onProgress(written); }
    }
    await flush();
    const { data: filled, error } = await supabase.rpc('zone_mapping_fill_all');   // the whole ladder: directory > orders > nearest > prefix
    if (error) throw new Error('zone fill failed: ' + error.message);
    return { written, skipped, filled: filled || 0, coverage: await coverage() };
}

async function status() {
    const [{ count }, { data: last }, cov] = await Promise.all([
        supabase.from('india_pincode_directory_ecom').select('*', { count: 'exact', head: true }),
        supabase.from('india_pincode_directory_ecom').select('imported_at').order('imported_at', { ascending: false }).limit(1).maybeSingle(),
        coverage(),
    ]);
    const { data: pins } = await supabase.rpc('pincode_directory_count');
    return { offices: count || 0, pincodes: (pins && pins[0] && Number(pins[0].pincodes)) || Number(pins) || 0, last_import: last ? last.imported_at : null, coverage: cov };
}
async function coverage() {
    const { data: st } = await supabase.rpc('zone_mapping_states');
    const sum = k => (st || []).reduce((a, s) => a + Number(s[k] || 0), 0);
    const tot = sum('pincodes'), ok = sum('indiapost'), orders = sum('orders'), nearest = sum('nearest'), prefix = sum('prefix');
    return { total: tot, indiapost: ok, orders, nearest, prefix, resolving: Math.max(0, tot - ok - orders - nearest - prefix - sum('not_in_directory')) };
}

module.exports = { parseCsv, parseDirectoryCsv, importDirectory, status, coverage, WANT };
