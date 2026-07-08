// DocPharma partner-portal timeline. The public partner API (fetch-details) only gives the CURRENT
// status; the FULL scan timeline (ASSIGNED → MANIFESTED → PICKED_UP → … → DELIVERED / RTO_DELIVERED)
// lives on the partner-dashboard backend, behind a login bearer token:
//   GET https://partner-dashboard-backend-prod.docpharma.in/order/shipment-status?partnerOrderNo=<id>
//   Authorization: Bearer <DP_PORTAL_TOKEN>   →  data.data.shipmentStatus[] = [{date, events:[{time,label,…}]}]
// The token (put in .env as DP_PORTAL_TOKEN) is a ~10-day JWT; refresh it from the portal when it expires.
const axios = require('axios');
const { supabase } = require('../supabase');

const PORTAL_BASE = 'https://partner-dashboard-backend-prod.docpharma.in';
const PHARMACY_IDS = process.env.DP_PORTAL_PHARMACY_IDS || '28';
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const norm = n => String(n || '').replace(/^#/, '').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Auto-login: keep a valid bearer token, refreshing via /auth/login when it's near expiry ──────────
let _tok = { token: null, exp: 0 };
function decodeExp(jwt) { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64').toString()).exp || 0; } catch (_e) { return Math.floor(Date.now() / 1000) + 3600; } }

async function getPortalToken() {
    const now = Date.now() / 1000;
    if (_tok.token && _tok.exp - now > 120) return _tok.token;       // cached & not about to expire
    const email = process.env.DP_PORTAL_EMAIL, password = process.env.DP_PORTAL_PASSWORD;
    if (email && password) {
        try {
            const r = await axios.post(PORTAL_BASE + '/auth/login', { email, password }, { timeout: 12000, validateStatus: () => true });
            if (r.status === 200 || r.status === 201) {
                const d = r.data || {};
                const token = d.token || d.accessToken || d.access_token || (d.data && (d.data.token || d.data.accessToken || d.data.access_token)) || null;
                if (token) { _tok = { token, exp: decodeExp(token) }; return token; }
                console.error('[DP portal] login ok but no token in response:', JSON.stringify(d).slice(0, 160));
            } else console.error('[DP portal] login failed', r.status, JSON.stringify(r.data).slice(0, 140));
        } catch (e) { console.error('[DP portal] login error:', e.message); }
    }
    if (process.env.DP_PORTAL_TOKEN) { _tok = { token: process.env.DP_PORTAL_TOKEN, exp: decodeExp(process.env.DP_PORTAL_TOKEN) }; return _tok.token; }  // fallback: static token
    return null;
}

// "Monday 6 Apr, 2026" + "09:22 PM" (IST) → "2026-04-06T21:22:00+05:30".
function parsePortalDate(dateStr, timeStr) {
    const d = String(dateStr || '').match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})/);
    if (!d) return null;
    const mm = MONTHS[d[2].toLowerCase().slice(0, 3)]; if (!mm) return null;
    let H = 0, M = 0;
    const t = String(timeStr || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (t) { H = parseInt(t[1], 10); M = parseInt(t[2], 10); const ap = (t[3] || '').toUpperCase(); if (ap === 'PM' && H < 12) H += 12; if (ap === 'AM' && H === 12) H = 0; }
    return `${d[3]}-${mm}-${String(d[1]).padStart(2, '0')}T${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}:00+05:30`;
}

// shipmentStatus[] (newest-first) → flat scans (kept newest-first) + derived milestone timestamps.
function parseTimeline(shipmentStatus) {
    const scans = [];
    for (const day of shipmentStatus || []) {
        for (const ev of day.events || []) {
            scans.push({
                at: parsePortalDate(day.date, ev.time),
                label: String(ev.label || '').toLowerCase(),
                description: ev.description || '',
                location: ev.location || '',
                reason: ev.reason || null,
            });
        }
    }
    const firstAt = re => { const hits = scans.filter(s => re.test(s.label) && s.at).map(s => s.at).sort(); return hits[0] || null; };
    const dispatched_at = firstAt(/^picked_up$/) || firstAt(/^manifested$/) || null;
    const delivered_at = firstAt(/^delivered$/) || null;                 // forward delivery (not rto_delivered)
    const rto_at = firstAt(/^rto_delivered$/) || firstAt(/^rto_initiated$/) || null;   // RTO completion date (returned to origin)
    return { scans, dispatched_at, delivered_at, rto_at, count: scans.length };
}

// Fetch one order's full timeline from the portal. Throws on 401 (token expired) so callers can stop.
async function fetchDocpharmaTimeline(orderNo, maxRetries = 2) {
    if (!orderNo) return null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const token = await getPortalToken();
        if (!token) return null;
        try {
            const r = await axios.get(PORTAL_BASE + '/order/shipment-status', {
                params: { partnerOrderNo: norm(orderNo) },
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                timeout: 12000, validateStatus: () => true,
            });
            if (r.status === 401) { _tok = { token: null, exp: 0 }; if (attempt < maxRetries) { await sleep(300); continue; } return null; }  // stale token → re-login & retry
            if (r.status === 429 || r.status >= 500) { if (attempt < maxRetries) { await sleep(1500 * (attempt + 1)); continue; } return null; }
            if (r.status !== 200) return null;
            const ss = r.data && r.data.data && r.data.data.shipmentStatus;
            if (!Array.isArray(ss)) return null;
            return parseTimeline(ss);
        } catch (e) {
            if (attempt >= maxRetries) return null;
            await sleep(1000 * (attempt + 1));
        }
    }
    return null;
}

// Fetch + store the timeline (scans + dispatch/rto/delivered) onto the docpharma_orders row.
async function syncDocpharmaTimeline(orderNo) {
    const tl = await fetchDocpharmaTimeline(orderNo);
    if (!tl) return null;
    const upd = { scans: tl.scans, dispatched_at: tl.dispatched_at, rto_at: tl.rto_at, timeline_synced_at: new Date().toISOString() };
    if (tl.delivered_at) upd.delivered_date = tl.delivered_at;         // portal delivered time is precise
    // Latest scan = current stage. If it's LOST, the order is lost (portal status can still read rto/shipped).
    const latest = tl.scans && tl.scans[0] && String(tl.scans[0].label || '').toLowerCase();
    if (latest === 'lost') upd.order_status = 'lost';
    const { error } = await supabase.from('docpharma_orders').update(upd).eq('partner_order_id', norm(orderNo));
    if (error) { console.error('[DP portal] update', orderNo, error.message); return null; }
    return tl.count;
}

// ─── Portal ingestion — pull DocPharma's latest orders (they don't webhook us) ───────────────────────
const FINAL = new Set(['delivered', 'rto', 'rejected', 'cancelled', 'lost']);
const numOf = id => { const m = String(id || '').match(/(\d+)\s*$/); return m ? parseInt(m[1], 10) : 0; };

async function fetchLatestDocpharmaOrders({ pages = 3, limit = 100 } = {}) {
    const out = [];
    for (let page = 1; page <= pages; page++) {
        const token = await getPortalToken(); if (!token) break;
        const r = await axios.get(PORTAL_BASE + '/order/getOrders', {
            params: { page, limit, pharmacy_ids: PHARMACY_IDS },
            headers: { Authorization: 'Bearer ' + token }, timeout: 15000, validateStatus: () => true,
        });
        if (r.status === 401) { _tok = { token: null, exp: 0 }; continue; }
        if (r.status !== 200) break;
        const os = (r.data && r.data.data && r.data.data.orders) || [];
        out.push(...os);
        if (os.length < limit) break;
    }
    return out;
}

// Portal order → docpharma_orders row (portal is the source of truth for DocPharma).
function portalOrderToRow(o) {
    const st = String(o.current_status || '').toLowerCase();
    const status = FINAL.has(st) ? st : 'shipped';     // assigned/delivery_assigned/shipped/in-transit → shipped
    return {
        partner_order_id: norm(o.partner_order_no),
        customer_name: o.customer_name || null,
        order_date: o.created_at || null,
        order_value: o.total_amount != null ? Math.round(Number(o.total_amount)) : null,
        payment_type: o.payment_mode_order || null,
        order_status: status,
        delivered_date: o.delivered_at || null,
        awb: o.fh_order_id || o.erp_order_id || null,
        dest_city: o.delivery_city || null, dest_state: o.delivery_state || null, dest_pincode: o.delivery_zipcode || null,
        reason: (o.reason || o.display_reason || '').trim() || null,
        dp_synced_at: new Date().toISOString(),
    };
}

// Poll the latest orders, upsert them, and (throttled) pull the scan timeline for new/non-final ones.
let _ingesting = false;
async function ingestRecentDocpharmaOrders({ pages = 3, limit = 100, timelineDelay = 500 } = {}) {
    if (_ingesting) { console.log('[DP portal] ingest already running — skipping this trigger'); return { skipped: true }; }
    _ingesting = true;
    try { return await _ingest({ pages, limit, timelineDelay }); }
    finally { _ingesting = false; }
}
async function _ingest({ pages, limit, timelineDelay }) {
    const orders = await fetchLatestDocpharmaOrders({ pages, limit });
    if (!orders.length) return { fetched: 0, upserted: 0, timelines: 0 };
    const rows = orders.map(portalOrderToRow).filter(r => r.partner_order_id);

    // which already exist (+ whether already timeline-synced) → so we only fetch timelines that are worth it
    const ids = rows.map(r => r.partner_order_id);
    const existing = {};
    for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabase.from('docpharma_orders').select('partner_order_id, timeline_synced_at, order_status').in('partner_order_id', ids.slice(i, i + 300));
        (data || []).forEach(d => { existing[d.partner_order_id] = d; });
    }
    for (let i = 0; i < rows.length; i += 200) await supabase.from('docpharma_orders').upsert(rows.slice(i, i + 200), { onConflict: 'partner_order_id' });

    let tl = 0;
    for (const r of rows) {
        const ex = existing[r.partner_order_id];
        const needTimeline = !ex || !ex.timeline_synced_at || !FINAL.has(String(ex.order_status || '').toLowerCase());  // new, never-synced, or still moving
        if (!needTimeline) continue;
        const n = await syncDocpharmaTimeline(r.partner_order_id);
        if (n != null) tl++;
        await sleep(timelineDelay);
    }
    console.log(`[DP portal] ingest — ${rows.length} orders upserted, ${tl} timelines synced (max order ${Math.max(0, ...ids.map(numOf))})`);
    return { fetched: rows.length, upserted: rows.length, timelines: tl };
}

// Refresh ONE order in docpharma_orders straight from the portal (order fields + timeline). Portal-sourced,
// so it never conflicts with the ingest. Used by the webhook + the dashboard's manual refresh.
async function syncDocpharmaOrderFromPortal(orderNo) {
    const token = await getPortalToken(); if (!token || !orderNo) return null;
    const r = await axios.get(PORTAL_BASE + '/order/getOrders', {
        params: { page: 1, limit: 5, pharmacy_ids: PHARMACY_IDS, search_term: norm(orderNo) },
        headers: { Authorization: 'Bearer ' + token }, timeout: 12000, validateStatus: () => true,
    });
    if (r.status === 401) { _tok = { token: null, exp: 0 }; return null; }
    const list = (r.status === 200 && r.data && r.data.data && r.data.data.orders) || [];
    const o = list.find(x => norm(x.partner_order_no) === norm(orderNo));
    if (!o) return null;
    const row = portalOrderToRow(o);
    await supabase.from('docpharma_orders').upsert(row, { onConflict: 'partner_order_id' });
    await syncDocpharmaTimeline(orderNo);
    return row.order_status;
}

module.exports = { fetchDocpharmaTimeline, syncDocpharmaTimeline, syncDocpharmaOrderFromPortal, parseTimeline, parsePortalDate, getPortalToken, fetchLatestDocpharmaOrders, ingestRecentDocpharmaOrders, PORTAL_BASE };
