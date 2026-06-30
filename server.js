const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { supabase } = require('./app/supabase');
const { fetchSheetData } = require('./cod_confirmation');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.enable('trust proxy');

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
const cron = require('node-cron');

// --- Register Routes ---
app.use('/api', authRoutes);
app.use('/api', ordersRoutes);
app.use('/api', adsetRoutes);
app.use('/api', adRoutes);
app.use('/api', shippingRoutes);
app.use('/api', excelRoutes);
app.use('/api', pdfRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/easyecom', easyecomRoutes);
app.use('/api/amazon', amazonReviewRoutes);
app.use('/api/amazon', amazonAutoReviewRoutes);
app.use('/api/fulfillment-ops', fulfillmentOpsRoutes);
app.use('/api/serviceability', serviceabilityRoutes);
initAutoReviewCron();

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
// Runs twice daily: 8:30 AM IST (data up to today−2) and 5:30 PM IST (data up to today−1).
cron.schedule('30 8 * * *', async () => {
    console.log('[WH Report] 8:30 AM IST — sending warehouse ops report (last 30d, −2)…');
    await sendWarehouseOpsReport(2).catch(e => console.error('[WH Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

cron.schedule('30 17 * * *', async () => {
    console.log('[WH Report] 5:30 PM IST — sending warehouse ops report (last 30d, −1)…');
    await sendWarehouseOpsReport(1).catch(e => console.error('[WH Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// DocPharma-rejected → dp-to-mwh-orders — separate report, MTD. Runs HOURLY from 8 AM to 7 PM IST
// (first run 08:00, last run 19:00). The Slack "rejected" word + CLI `dp` still trigger it manually.
cron.schedule('0 8-19 * * *', async () => {
    const hr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    console.log(`[DP Report] ${hr}:00 IST — sending DocPharma-rejected (MTD) report…`);
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

// --- COD Confirmation Data (FROM SUPABASE) ---
app.get('/api/cod-confirmations', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('cod_confirmations_ecom')
            .select('id_key, data');

        if (error) {
            console.error("Supabase Error fetching COD data:", error.message);
            return res.status(500).json([]);
        }

        // Return the data field from each row (contains original sheet columns)
        const result = (data || []).map(row => row.data || {});
        res.json(result);
    } catch (e) {
        console.error("Error fetching COD data:", e.message);
        res.status(500).json([]);
    }
});

// --- Serve Frontend ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'app/templates/index.html'));
});

// --- Auto-sync COD confirmations from Google Sheets ---
setTimeout(async () => {
    try {
        console.log('[COD Sync] Running initial Google Sheets sync...');
        await fetchSheetData();
        console.log('[COD Sync] Initial sync complete.');
    } catch (e) {
        console.error('[COD Sync] Initial sync failed:', e.message);
    }
}, 5000);

setInterval(async () => {
    try {
        console.log('[COD Sync] Running scheduled Google Sheets sync...');
        await fetchSheetData();
    } catch (e) {
        console.error('[COD Sync] Scheduled sync failed:', e.message);
    }
}, 5 * 60 * 1000); // every 5 minutes

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
