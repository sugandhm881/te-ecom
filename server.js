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

// --- Auto-sync EasyEcom orders (last 7 days) ---
setTimeout(async () => {
    try {
        console.log('[EasyEcom Sync] Running initial sync...');
        const result = await syncEasyecomOrders(7);
        console.log(`[EasyEcom Sync] Initial sync complete: ${result.fetched} fetched, ${result.saved} saved`);
    } catch (e) {
        console.error('[EasyEcom Sync] Initial sync failed:', e.message);
    }
}, 8000);

setInterval(async () => {
    try {
        console.log('[EasyEcom Sync] Running scheduled sync...');
        await syncEasyecomOrders(7);
    } catch (e) {
        console.error('[EasyEcom Sync] Scheduled sync failed:', e.message);
    }
}, 10 * 60 * 1000); // Changed to every 10 minutes

// --- Start Server ---
app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${config.PORT}`);
});
