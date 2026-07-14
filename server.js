const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { supabase } = require('./app/supabase');

const app = express();

// Middleware
// CORS restricted to the app's own origin(s). Same-origin dashboard calls send no Origin header and are
// unaffected; this blocks other websites from calling the API from a victim's browser. Override via CORS_ORIGINS.
const CORS_ALLOW = (process.env.CORS_ORIGINS || config.DASHBOARD_URL || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .concat(['http://localhost:5002', 'http://127.0.0.1:5002']);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || CORS_ALLOW.includes(origin)), credentials: true }));
app.use(express.json());
app.enable('trust proxy');

// Security headers — clickjacking + MIME-sniffing protection (defense against XSS impact).
// CSP is defense-in-depth for the (now-escaped) XSS: even if a payload slips through, connect-src 'self'
// blocks exfiltration via fetch/XHR/beacon, and object-src/base-uri/frame-ancestors/form-action are locked
// down. script/style keep only 'unsafe-inline' for the SPA's inline handlers; 'unsafe-eval' and the CDN
// sources were removed once Tailwind was pre-built and Chart.js self-hosted (no external scripts remain).
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "form-action 'self'",
].join('; ');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', CSP);
    next();
});

// Static Files
app.use('/static', express.static(path.join(__dirname, 'app/static')));
app.use('/templates', express.static(path.join(__dirname, 'app/templates')));

// --- Import Routes ---
const authRoutes = require('./app/api/auth_routes');
const ordersRoutes = require('./app/api/orders');
const adsetRoutes = require('./app/api/adset_performance').router;
const adRoutes = require('./app/api/ad_performance');
const shippingRoutes = require('./app/api/shipping');
const excelRoutes = require('./app/api/excel_report');
const pdfRoutes = require('./app/api/pdf_generator').router;
const webhookRoutes = require('./app/api/webhook_handler');
const easyecomRoutes = require('./app/api/easyecom');
const { syncEasyecomOrders } = require('./app/api/easyecom');
const amazonReviewRoutes = require('./app/api/amazon_review');
const { router: amazonAutoReviewRoutes, initAutoReviewCron } = require('./app/api/amazon_auto_review');
const { router: fulfillmentOpsRoutes, syncLast7Days, syncMTD, syncStatusesToShopify } = require('./app/api/fulfillment_ops');
const serviceabilityRoutes = require('./app/api/serviceability');
const { sendWarehouseOpsReport, sendDocpharmaRejectedReport, initDpSlackTrigger, sendEasyecomHoldReport, syncRsCacheEasyecom } = require('./app/api/warehouse_slack_report');
const deliveryReportsRoutes = require('./app/api/delivery_reports');
const opsControlRoutes = require('./app/api/ops_control');
const { router: amazonFbaRoutes, initFbaLocationCron } = require('./app/api/amazon_fba');
const docpharmaReconRoutes = require('./app/api/docpharma_recon');
const docpharmaInvoiceRoutes = require('./app/api/docpharma_invoices');
const docpharmaLedgerRoutes = require('./app/api/docpharma_ledger');
const docpharmaOverviewRoutes = require('./app/api/docpharma_overview');
const docpharmaInventoryRoutes = require('./app/api/docpharma_inventory');
const { ingestRecentDocpharmaOrders } = require('./app/api/docpharma_portal');
const { backfillJourneys } = require('./app/api/delivery_journey');
const cron = require('node-cron');

// --- Register Routes ---
app.use('/api', authRoutes);
app.use('/api/admin', require('./app/api/users'));

// --- Require a valid JWT for ALL data APIs below. Public: login/signup (handled above) + external webhooks. ---
const { tokenRequired: _apiAuth, requirePermission } = require('./app/auth');
const PUBLIC_API = [/^\/login$/, /^\/signup$/, /^\/webhook(\/|$)/];
app.use('/api', (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (PUBLIC_API.some(rx => rx.test(req.path))) return next();
    return _apiAuth(req, res, next);
});

// Server-side per-dashboard authorization for view-specific API groups (UI hiding alone is not enough).
// Admins ('*') pass everything. SHARED endpoints (orders, easyecom, serviceability/EDD, reports, ad/adset)
// are intentionally NOT gated here — multiple dashboards consume them, so gating would break legit access.
const _VIEW_PERMS = [
    [/^\/docpharma/i, 'docpharma-recon'],
    [/^\/fba\//i, 'amazon-fba'],
    [/^\/ops-control/i, 'ops-control'],
    [/^\/delivery-performance/i, 'delivery-perf'],
];
app.use('/api', (req, res, next) => {
    const perms = (req.user && req.user.permissions) || [];
    if (perms.includes('*')) return next();
    for (const [rx, need] of _VIEW_PERMS) {
        if (rx.test(req.path)) return perms.includes(need) ? next() : res.status(403).json({ message: 'You do not have access to this section.' });
    }
    next();
});
app.use('/api', ordersRoutes);
app.use('/api', adsetRoutes);
app.use('/api', adRoutes);
app.use('/api', shippingRoutes);
app.use('/api', excelRoutes);
app.use('/api', pdfRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/easyecom', easyecomRoutes);
app.use('/api/amazon', requirePermission('amazon-review'), amazonReviewRoutes);
app.use('/api/amazon', requirePermission('amazon-review'), amazonAutoReviewRoutes);
app.use('/api/fulfillment-ops', requirePermission('fulfillment-ops'), fulfillmentOpsRoutes);
app.use('/api/serviceability', serviceabilityRoutes);
app.use('/api', deliveryReportsRoutes);
app.use('/api', opsControlRoutes);
app.use('/api', amazonFbaRoutes);
app.use('/api', require('./app/api/teams').router);
app.use('/api', docpharmaReconRoutes);
app.use('/api', docpharmaInvoiceRoutes);
app.use('/api', docpharmaLedgerRoutes);
app.use('/api', docpharmaOverviewRoutes);
app.use('/api', docpharmaInventoryRoutes);
initAutoReviewCron();
initFbaLocationCron();

// Delivery-journey gap-fill — every 6h, refresh non-final shipments (webhooks handle real-time;
// this catches any misses). Skips shipments already delivered/RTO (is_final) → minimal API.
cron.schedule('45 */6 * * *', async () => {
    console.log('[Journey] 6-hr gap-fill — refreshing non-final shipment journeys…');
    await backfillJourneys(30).catch(e => console.error('[Journey] gap-fill error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// DocPharma portal INGESTION — DocPharma doesn't webhook us (webhook_url is null), so every 3h we pull
// their latest orders from the partner portal (auto-login) → upsert docpharma_orders + fetch timelines.
// This is what actually captures NEW DocPharma orders. Also runs ~40s after startup.
cron.schedule('40 */3 * * *', async () => {
    console.log('[DP portal] 3-hr ingest — pulling DocPharma latest orders…');
    await ingestRecentDocpharmaOrders().catch(e => console.error('[DP portal] ingest error:', e.message));
}, { timezone: 'Asia/Kolkata' });
setTimeout(() => { ingestRecentDocpharmaOrders().catch(e => console.error('[DP portal] startup ingest error:', e.message)); }, 40000);

// New/Repeat classification — re-tag journey rows from Shopify's "Repeat" order tag. Pure SQL (0 API),
// via the refresh_journey_order_type() DB function. Daily at 2:30 AM IST + once shortly after startup.
cron.schedule('30 2 * * *', async () => {
    console.log('[OrderType] Daily refresh — tagging journeys new/repeat from Shopify tags…');
    const { error } = await supabase.rpc('refresh_journey_order_type');
    if (error) console.error('[OrderType] refresh error:', error.message);
    // Sync destination state/city/pincode from the Shopify address (powers the State filter + Kerala→Zone E).
    const { error: e2 } = await supabase.rpc('refresh_journey_dest');
    if (e2) console.error('[JourneyDest] refresh error:', e2.message);
}, { timezone: 'Asia/Kolkata' });
setTimeout(() => {
    supabase.rpc('refresh_journey_order_type').then(({ error }) => {
        if (error) console.error('[OrderType] startup refresh error:', error.message);
        else console.log('[OrderType] startup new/repeat refresh done');
    });
    supabase.rpc('refresh_journey_dest').then(({ error }) => {
        if (error) console.error('[JourneyDest] startup refresh error:', error.message);
        else console.log('[JourneyDest] startup dest state/city refresh done');
    });
}, 60000);

// RS Sync — every 2 hours: last 7 days orders (skips 4 PM slot — MTD runs then)
cron.schedule('0 */2 * * *', async () => {
    const istHour = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
    if (String(istHour) === '16') { console.log('[RS Sync] 2-hr skipping 4 PM slot — MTD cron will handle it'); return; }
    console.log('[RS Sync] 2-hr trigger — syncing last 7 days…');
    await syncLast7Days().catch(e => console.error('[RS Sync] 2-hr error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// RS Sync — daily at 4 PM IST: full MTD sweep
cron.schedule('0 16 * * *', async () => {
    console.log('[RS Sync] Daily 4 PM IST — syncing MTD…');
    await syncMTD().catch(e => console.error('[RS Sync] daily error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// Status Sync → Shopify — DISABLED pending review (was pushing stale/incorrect statuses).
// Re-enable only after verifying with a dry-run: `node app/api/fulfillment_ops.js status-sync 7 dry`
// cron.schedule('30 */6 * * *', async () => {
//     console.log('[StatusSync] 6-hr trigger — pushing RapidShyp/DocPharma statuses to Shopify…');
//     await syncStatusesToShopify(30).catch(e => console.error('[StatusSync] error:', e.message));
// }, { timezone: 'Asia/Kolkata' });

// Warehouse Ops Slack report — Confirmed + Ready for Pickup + Unfulfillable, last 30 days, old→new.
// 8:30 AM IST → −2 window; 5:30 PM and 8:00 PM IST → −1 window (posted twice in the evening).
cron.schedule('30 8 * * *', async () => {
    console.log('[WH Report] 8:30 AM IST — sending warehouse ops report (last 30d, −2)…');
    await sendWarehouseOpsReport(2).catch(e => console.error('[WH Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

cron.schedule('30 17 * * *', async () => {
    console.log('[WH Report] 5:30 PM IST — sending warehouse ops report (last 30d, −1)…');
    await sendWarehouseOpsReport(1).catch(e => console.error('[WH Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

cron.schedule('0 20 * * *', async () => {
    // 8 PM is the day's final warehouse report — refresh the RapidShyp cache for ALL recent EasyEcom
    // AWBs FIRST so every order's status is latest, then build the report (which also live-verifies
    // its final pending set). Forced refresh (maxAgeHours 0) so nothing is skipped as "fresh".
    console.log('[WH Report] 8:00 PM IST — full RapidShyp refresh, then warehouse report (−1)…');
    await syncRsCacheEasyecom(30, { force: true }).catch(e => console.error('[RS-EC Sync] 8PM error:', e.message));
    await sendWarehouseOpsReport(1).catch(e => console.error('[WH Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// DocPharma-rejected → dp-to-mwh-orders — separate report, last 30 days. Runs HOURLY from 8 AM to
// 7 PM IST (first run 08:00, last run 19:00). The Slack "rejected" word + CLI `dp` still trigger it.
cron.schedule('0 8-19 * * *', async () => {
    const hr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    console.log(`[DP Report] ${hr}:00 IST — sending DocPharma-rejected (last 30 days) report…`);
    await sendDocpharmaRejectedReport().catch(e => console.error('[DP Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// EasyEcom On-Hold report — daily at 11 AM IST. Reads the synced b2c_order_easycom table
// only (NO EasyEcom API calls) and posts on-hold orders to its Slack channel.
cron.schedule('0 11 * * *', async () => {
    console.log('[Hold Report] 11 AM IST — sending EasyEcom On-Hold report…');
    await sendEasyecomHoldReport().catch(e => console.error('[Hold Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// RapidShyp cache sync for EasyEcom-shipped orders — every 3 hours + once at startup. Keeps the
// rapidshyp_tracking_ecom cache fresh so the warehouse report & ops dashboard read status from the
// DB (the report only live-verifies its final pending set at post time, not every order).
cron.schedule('20 */3 * * *', async () => {
    console.log('[RS-EC Sync] 3-hr trigger — refreshing RapidShyp cache for EasyEcom orders…');
    await syncRsCacheEasyecom().catch(e => console.error('[RS-EC Sync] error:', e.message));
}, { timezone: 'Asia/Kolkata' });
setTimeout(() => { syncRsCacheEasyecom().catch(e => console.error('[RS-EC Sync] startup error:', e.message)); }, 15000);

// Slack trigger — typing "rejected" in #dp-to-mwh-orders runs the MTD DocPharma report.
initDpSlackTrigger();

// Teams keyword listener (Graph) — the Teams-native replacement for the Slack inbound triggers:
// "rejected" in the DP channel runs the DocPharma check; "yes"/"no" in the Amazon channel
// approves/cancels the pending review send. No-op unless TEAMS_REFRESH_TOKEN + channel IDs are set.
require('./app/api/teams_listener').initTeamsListener();

// --- COD Confirmation Data (FROM SUPABASE) ---
// Page past Supabase's 1000-row select cap so ALL confirmations are returned (the old table has ~17k).
async function fetchAllCod(table) {
    const PAGE = 1000;
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
            .from(table)
            .select('id_key, data')
            .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < PAGE) break;
    }
    return rows;
}

app.get('/api/cod-confirmations', async (req, res) => {
    try {
        // Merge historical (cod_confirmations_ecom — frozen sheet data) with live MSG91 webhook
        // confirmations (cod_confirmations_msg91). A webhook confirmation supersedes the old sheet
        // row for the same order.
        const [oldRows, newRows] = await Promise.all([
            fetchAllCod('cod_confirmations_ecom').catch(e => { console.error('COD old fetch:', e.message); return []; }),
            fetchAllCod('cod_confirmations_msg91').catch(e => { console.error('COD new fetch:', e.message); return []; }),
        ]);

        // Dedup by normalized order key (strip leading '#', uppercase) so the same order isn't
        // returned twice; insert old first, then new (new overwrites).
        const norm = (k) => String(k || '').replace(/^#/, '').toUpperCase().trim();
        const byOrder = new Map();
        for (const r of oldRows) byOrder.set(norm(r.id_key), r.data || {});
        for (const r of newRows) byOrder.set(norm(r.id_key), r.data || {});
        res.json(Array.from(byOrder.values()));
    } catch (e) {
        console.error("Error fetching COD data:", e.message);
        res.status(500).json([]);
    }
});

// --- Serve Frontend ---
app.get('/', (req, res) => {
    // Never cache the app shell — otherwise browsers/phones keep showing an old index.html after a deploy.
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'app/templates/index.html'));
});


// --- EasyEcom Sync Strategy (250 API calls/month limit) ---
// PRIMARY: Webhook receives real-time order updates (0 API calls).
// STARTUP:  One sync on server start, but only if last sync was 6+ hours ago
//           to avoid burning calls on frequent restarts.
// NO automatic polling — every API call counts.

setTimeout(async () => {
    try {
        // Check when last sync ran via api_logs_ecom
        const { data: lastLog } = await supabase
            .from('api_logs_ecom')
            .select('created_at')
            .eq('action', 'easyecom_sync')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
        const lastSyncTime = lastLog ? new Date(lastLog.created_at).getTime() : 0;

        if (lastSyncTime > sixHoursAgo) {
            console.log(`[EasyEcom Sync] Skipping startup sync — last ran ${Math.round((Date.now() - lastSyncTime) / 60000)} min ago (saving API call)`);
            return;
        }

        console.log('[EasyEcom Sync] Running startup sync (1 of ~250 monthly API calls)...');
        const result = await syncEasyecomOrders(3); // only last 3 days on startup
        console.log(`[EasyEcom Sync] Startup sync complete: ${result.fetched} fetched, ${result.saved} saved`);
    } catch (e) {
        console.error('[EasyEcom Sync] Startup sync failed:', e.message);
    }
}, 8000);

// --- Start Server ---
app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${config.PORT}`);
});
