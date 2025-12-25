const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const AsyncLock = require('async-lock');
const config = require('../../config');

const lock = new AsyncLock();

router.post('/rapidshyp', async (req, res) => {
    console.log("\n--- [Webhook Received] ---");
    const data = req.body;

    if (!data || !data.records) {
        console.log("[Webhook Error] Invalid payload.");
        return res.status(400).json({ error: 'Invalid payload' });
    }

    let updatedCount = 0;
    
    // We lock the whole file update process to prevent race conditions
    await lock.acquire('master_file', async () => {
        try {
            if (!fs.existsSync(config.MASTER_DATA_FILE)) {
                console.log("Master file missing.");
                return;
            }

            const allOrders = await fs.readJson(config.MASTER_DATA_FILE);
            let fileChanged = false;

            for (const record of data.records) {
                const orderId = record.seller_order_id;
                const shipment = (record.shipment_details || [{}])[0];
                const status = shipment.shipment_status;
                const awb = shipment.awb;

                if (!orderId || !status) continue;

                // Find Order
                const order = allOrders.find(o => {
                    const name = o.name || '';
                    return name === orderId || name.replace('#', '') === orderId || '#' + orderId === name;
                });

                if (order) {
                    console.log(`[Webhook] Updating ${order.name} to ${status}`);
                    order.rapidshyp_webhook_status = status;
                    if (awb && !order.awb) order.awb = awb;
                    fileChanged = true;
                    updatedCount++;
                }
            }

            if (fileChanged) {
                // Atomic Write
                const tempFile = config.MASTER_DATA_FILE + '.tmp';
                await fs.writeJson(tempFile, allOrders, { spaces: 4 });
                await fs.move(tempFile, config.MASTER_DATA_FILE, { overwrite: true });
                console.log(`[Webhook] Saved ${updatedCount} updates.`);
            }
        } catch (e) {
            console.error(`[Webhook Critical] ${e.message}`);
        }
    });

    res.json({ status: 'success' });
});

module.exports = router;