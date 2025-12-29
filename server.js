const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs'); // <--- ADDED THIS IMPORT
const config = require('./config');

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
// Note: Some files export an object { router, ... }, so we extract .router
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

// --- NEW ROUTE: COD Confirmation Data ---
app.get('/api/cod-confirmations', (req, res) => {
    // Looks for 'COD_Confirmation.json' in the root project directory
    const filePath = path.join(__dirname, 'COD_Confirmation.json');
    
    if (fs.existsSync(filePath)) {
        // Read the file freshly every time
        const data = fs.readFileSync(filePath, 'utf8');
        try {
            res.json(JSON.parse(data));
        } catch (e) {
            console.error("Error parsing COD JSON:", e);
            res.json([]); // Return empty if JSON is corrupt
        }
    } else {
        res.json([]); // Return empty if file doesn't exist yet
    }
});
// ----------------------------------------

// --- Serve Frontend ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'app/templates/index.html'));
});

// --- Start Server ---
app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${config.PORT}`);
});