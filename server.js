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
initAutoReviewCron();

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
