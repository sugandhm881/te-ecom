#!/usr/bin/env node
// Import India Post's "All India Pincode Directory" CSV (data.gov.in) into india_pincode_directory_ecom
// and fill the Zone & State rows from it. ONE-TIME per download; re-running upserts (no duplicates).
//
//   node tools/import_pincode_directory.js "C:\path\to\pincode_directory.csv" [--replace]
//
// Header (any order, case-insensitive): circlename, regionname, divisionname, officename, pincode,
// officetype, delivery, district, statename, latitude, longitude.  --replace empties the table first.
'use strict';
const fs = require('fs');
require('../app/secrets').load({ quiet: true });
const { importDirectory } = require('../app/api/pincode_directory');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('usage: node tools/import_pincode_directory.js <csv> [--replace]'); process.exit(1); }
(async () => {
    const t0 = Date.now();
    const r = await importDirectory(fs.readFileSync(file, 'utf8'), { replace: process.argv.includes('--replace'), onProgress: n => { if (n % 20000 === 0) console.log(`  ${n.toLocaleString('en-IN')} rows…`); } });
    console.log(`imported ${r.written.toLocaleString('en-IN')} post offices (${r.skipped} skipped: bad pincode / duplicate) in ${Math.round((Date.now() - t0) / 1000)} s`);
    console.log(`Zone & State rows filled from the directory: ${r.filled}`);
    console.log(`coverage now: ${r.coverage.indiapost.toLocaleString('en-IN')} of ${r.coverage.total.toLocaleString('en-IN')} pincodes verified by India Post · ${r.coverage.orders} from orders · ${r.coverage.resolving} resolving`);
    process.exit(0);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
