const express = require('express');
const router = express.Router();
const config = require('../../config');
const { Order } = require('../../models/Schemas'); // Import DB Model

router.post('/rapidshyp', async (req, res) => {
    console.log("\n--- [Webhook Received] ---");
    const data = req.body;

    if (!data || !data.records) {
        console.log("[Webhook Error] Invalid payload.");
        return res.status(400).json({ error: 'Invalid payload' });
    }

    let updatedCount = 0;

    try {
        for (const record of data.records) {
            const orderId = record.seller_order_id; // Usually something like "#1001" or "1001"
            const shipment = (record.shipment_details || [{}])[0];
            const status = shipment.shipment_status;
            const awb = shipment.awb;

            if (!orderId || !status) continue;

            // Normalize ID for searching: Remove #
            const cleanId = String(orderId).replace('#', '');

            // Construct Query: Find order where name matches "1001" or "#1001"
            const query = {
                $or: [
                    { name: cleanId },
                    { name: `#${cleanId}` },
                    { id: parseInt(cleanId) } // sometimes it matches the numeric ID
                ]
            };

            const updateFields = {
                rapidshyp_webhook_status: status
            };
            if (awb) updateFields.awb = awb;

            const result = await Order.updateOne(query, { $set: updateFields });
            
            if (result.modifiedCount > 0) {
                console.log(`[Webhook] Updated Order ${orderId} to ${status}`);
                updatedCount++;
            }
        }

        console.log(`[Webhook] Processed. Updated ${updatedCount} orders in DB.`);

    } catch (e) {
        console.error(`[Webhook Critical] ${e.message}`);
    }

    res.json({ status: 'success' });
});

module.exports = router;