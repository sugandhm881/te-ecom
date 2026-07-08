// Backfill the FULL scan timeline (from the partner-portal shipment-status API) onto docpharma_orders.
// Fills scans[] + dispatched_at + rto_at (+ precise delivered_date). Throttled & resumable
// (rows with timeline_synced_at set are skipped). Needs a fresh DP_PORTAL_TOKEN in .env.
// Usage: node docpharma_timeline_backfill.js
require('dotenv').config();
const { supabase } = require('./app/supabase');
const { syncDocpharmaTimeline } = require('./app/api/docpharma_portal');

const DELAY = 600;   // ms between portal calls
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    if (!process.env.DP_PORTAL_TOKEN) { console.error('✗ DP_PORTAL_TOKEN missing in .env'); process.exit(1); }
    console.log('[DP Timeline] loading orders needing a timeline (delivered/rto/shipped, not yet synced)…');
    const todo = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('docpharma_orders')
            .select('partner_order_id')
            .in('order_status', ['delivered', 'rto', 'shipped'])
            .is('timeline_synced_at', null)
            .order('order_date', { ascending: false })
            .range(off, off + 999);
        if (error) { console.error('[DP Timeline]', error.message); break; }
        todo.push(...(data || []).map(r => r.partner_order_id));
        if (!data || data.length < 1000) break;
    }
    console.log(`[DP Timeline] ${todo.length} orders to fetch (throttle ${DELAY}ms, ~${Math.round(todo.length * (DELAY + 500) / 60000)} min)…`);

    let ok = 0, empty = 0, err = 0, scans = 0;
    for (let i = 0; i < todo.length; i++) {
        try {
            const n = await syncDocpharmaTimeline(todo[i]);
            if (n != null) { ok++; scans += n; } else empty++;
        } catch (e) {
            if (/401/.test(e.message)) { console.error(`\n✗ STOPPED — ${e.message}\n  Refresh DP_PORTAL_TOKEN in .env (from the portal) and re-run; it resumes where it left off.`); break; }
            err++;
        }
        if ((i + 1) % 50 === 0) console.log(`[DP Timeline] ${i + 1}/${todo.length} · ${ok} synced (${scans} scans) · ${empty} empty · ${err} err`);
        await sleep(DELAY);
    }
    console.log(`[DP Timeline] DONE — ${ok} timelines synced (${scans} scans), ${empty} empty, ${err} errors.`);
    try { await supabase.from('docpharma_recon_log').insert({ event_type: 'status_update', source: 'api', message: `Timeline backfill: ${ok} orders (${scans} scans), ${empty} empty, ${err} err` }); } catch (_e) {}
    process.exit(0);
})();
