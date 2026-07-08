// Import DocPharma's order export into the docpharma_orders table.
// Usage:  node docpharma_import.js [path-to-file]      (default: ./docpharma_export.csv)
// Accepts CSV (comma, quoted fields) OR TSV (tab). Expected columns (any order, header row required):
//   PartnerOrderId, Customer Name, OrderDate, OrderValue, Payment Type, Order Status, Delivered Date
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { supabase } = require('./app/supabase');

const FILE = process.argv[2] || path.join(__dirname, 'docpharma_export.csv');
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// "31 May 2026, 10:06 PM" (IST) → "2026-05-31T22:06:00+05:30". Time optional. Returns null if unparseable.
function parseDate(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})\s*(AM|PM))?/i);
    if (!m) { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); }
    const [, dd, mon, yyyy, hh, mi, ap] = m;
    const mm = MONTHS[mon.toLowerCase().slice(0, 3)]; if (!mm) return null;
    let H = hh ? parseInt(hh, 10) : 0;
    if (ap) { const up = ap.toUpperCase(); if (up === 'PM' && H < 12) H += 12; if (up === 'AM' && H === 12) H = 0; }
    return `${yyyy}-${mm}-${String(dd).padStart(2, '0')}T${String(H).padStart(2, '0')}:${mi || '00'}:00+05:30`;
}

// Quote-aware delimited parser (handles commas inside "quoted" fields).
function parseDelimited(text, delim) {
    const rows = []; let field = '', row = [], inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
        } else if (c === '"') inQ = true;
        else if (c === delim) { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
        else if (c === '\r') { /* skip */ }
        else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

(async () => {
    if (!fs.existsSync(FILE)) { console.error(`[DP Import] file not found: ${FILE}\nSave DocPharma's export as CSV there (or pass a path).`); process.exit(1); }
    const raw = fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '');   // strip BOM
    const first = raw.split(/\r?\n/)[0] || '';
    const delim = first.includes('\t') ? '\t' : ',';
    const rows = parseDelimited(raw, delim).filter(r => r.length && r.some(c => String(c).trim()));
    if (rows.length < 2) { console.error('[DP Import] no data rows.'); process.exit(1); }

    // Map columns by normalized header name (tolerant of order/spacing).
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const header = rows[0].map(norm);
    const col = (...aliases) => { for (const a of aliases) { const i = header.indexOf(a); if (i >= 0) return i; } return -1; };
    const iId = col('partnerorderid', 'orderid', 'partnerorderno');
    const iName = col('customername', 'name');
    const iDate = col('orderdate', 'date');
    const iValue = col('ordervalue', 'value', 'amount');
    const iPay = col('paymenttype', 'payment', 'paymentmode');
    const iStatus = col('orderstatus', 'status');
    const iDel = col('delivereddate', 'deliverydate');
    if (iId < 0) { console.error(`[DP Import] could not find PartnerOrderId column. Headers: ${rows[0].join(' | ')}`); process.exit(1); }
    console.log(`[DP Import] ${FILE}\n[DP Import] delimiter=${delim === '\t' ? 'TAB' : 'comma'} · ${rows.length - 1} data rows · mapped id=${iId} status=${iStatus} value=${iValue}`);

    const dedup = new Map();
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const id = String(row[iId] || '').replace(/^#/, '').trim();
        if (!id) continue;
        dedup.set(id, {
            partner_order_id: id,
            customer_name: iName >= 0 ? (row[iName] || '').trim() || null : null,
            order_date: iDate >= 0 ? parseDate(row[iDate]) : null,
            order_value: iValue >= 0 ? (parseFloat(String(row[iValue]).replace(/[^0-9.]/g, '')) || null) : null,
            payment_type: iPay >= 0 ? (row[iPay] || '').trim() || null : null,
            order_status: iStatus >= 0 ? (row[iStatus] || '').trim().toLowerCase() || null : null,
            delivered_date: iDel >= 0 ? parseDate(row[iDel]) : null,
            imported_at: new Date().toISOString(),
        });
    }
    const records = [...dedup.values()];
    console.log(`[DP Import] ${records.length} unique orders → upserting…`);

    let saved = 0;
    for (let i = 0; i < records.length; i += 500) {
        const chunk = records.slice(i, i + 500);
        const { error } = await supabase.from('docpharma_orders').upsert(chunk, { onConflict: 'partner_order_id' });
        if (error) { console.error(`[DP Import] batch ${i}: ${error.message}`); }
        else { saved += chunk.length; process.stdout.write(`\r[DP Import] saved ${saved}/${records.length}`); }
    }
    console.log(`\n[DP Import] DONE — ${saved} DocPharma orders imported.`);

    // Quick status distribution for a sanity check.
    const dist = {}; records.forEach(r => { const s = r.order_status || '(blank)'; dist[s] = (dist[s] || 0) + 1; });
    console.log('[DP Import] status distribution:', JSON.stringify(dist));
    await supabase.from('docpharma_recon_log').insert({ event_type: 'status_update', source: 'ui', message: `DocPharma export imported: ${saved} orders (${path.basename(FILE)})` }).then(() => {}).catch(() => {});
    process.exit(0);
})();
