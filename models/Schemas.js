const mongoose = require('mongoose');

// 1. Master Order Data Schema
const OrderSchema = new mongoose.Schema({}, { strict: false, collection: 'orders' });

// 2. Shipment Cache Schema
const ShipmentSchema = new mongoose.Schema({}, { strict: false, collection: 'shipments' });

// 3. RapidShyp Cache Schema
const RapidShypSchema = new mongoose.Schema({}, { strict: false, collection: 'rapidshyp_logs' });

// 4. AWB Assignment Schema
const AWBSchema = new mongoose.Schema({}, { strict: false, collection: 'awb_assignments' });

// 5. API Log Schema
const APILogSchema = new mongoose.Schema({}, { strict: false, collection: 'api_logs' });

// 6. COD Confirmation Schema (NEW)
const CODSchema = new mongoose.Schema({}, { strict: false, collection: 'cod_confirmations' });

// Export the models
module.exports = {
    Order: mongoose.model('Order', OrderSchema),
    Shipment: mongoose.model('Shipment', ShipmentSchema),
    RapidShyp: mongoose.model('RapidShyp', RapidShypSchema),
    AWB: mongoose.model('AWB', AWBSchema),
    APILog: mongoose.model('APILog', APILogSchema),
    CODConfirmation: mongoose.model('CODConfirmation', CODSchema) // <--- Added this
};