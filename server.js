const express = require('express');
const cors = require('cors');
const path = require('path');
// const fs = require('fs'); // <--- You can remove this now if no other files are used
const config = require('./config');

const app = express();
const connectDB = require('./db');
// 1. UPDATE IMPORTS (Added CODConfirmation)
const { Order, Shipment, RapidShyp, AWB, APILog, CODConfirmation } = require('./models/Schemas');

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

// --- Register Routes ---
app.use('/api', authRoutes);
app.use('/api', ordersRoutes);
app.use('/api', adsetRoutes);
app.use('/api', adRoutes);
app.use('/api', shippingRoutes);
app.use('/api', excelRoutes);
app.use('/api', pdfRoutes);
app.use('/api/webhook', webhookRoutes);

// --- UPDATED ROUTE: COD Confirmation Data (FROM DB) ---
app.get('/api/cod-confirmations', async (req, res) => {
    try {
        // Fetch all COD confirmations from MongoDB
        const data = await CODConfirmation.find().lean();
        res.json(data);
    } catch (e) {
        console.error("Database Error fetching COD data:", e);
        res.status(500).json([]); 
    }
});
// ----------------------------------------

// --- Serve Frontend ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'app/templates/index.html'));
});

// --- Start Server ---
// 2. CONNECT TO DATABASE
connectDB(); 

app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${config.PORT}`);
});