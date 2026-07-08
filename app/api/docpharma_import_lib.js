// Shared parser for DocPharma's order export (used by the UI upload endpoint and the CLI import script).
// Accepts CSV (comma, quoted) or TSV (tab). Header row required. Columns matched by name in any order:
//   PartnerOrderId, Customer Name, OrderDate, OrderValue, Payment Type, Order Status, Delivered Date
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// "31 May 2026, 10:06 PM" (IST) → "2026-05-31T22:06:00+05:30". Time optional. null if unparseable/empty.
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

// Parse the whole export text → deduped array of docpharma_orders rows. Throws on missing id column.
function parseDocpharmaCsv(text) {
    const raw = String(text || '').replace(/^﻿/, '');   // strip BOM
    const first = raw.split(/\r?\n/)[0] || '';
    const delim = first.includes('\t') ? '\t' : ',';
    const rows = parseDelimited(raw, delim).filter(r => r.length && r.some(c => String(c).trim()));
    if (rows.length < 2) return { records: [], delim, dataRows: 0 };

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
    if (iId < 0) throw new Error(`Could not find a PartnerOrderId column. Headers seen: ${rows[0].join(' | ')}`);

    const dedup = new Map();   // keyed by order id → guarantees no duplicate rows reach the DB
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
        });
    }
    return { records: [...dedup.values()], delim, dataRows: rows.length - 1 };
}

module.exports = { parseDate, parseDelimited, parseDocpharmaCsv };
