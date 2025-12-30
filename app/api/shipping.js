const express = require('express');
const router = express.Router();
const axios = require('axios');
const path = require('path');
const pLimit = require('p-limit');
const config = require('../../config');
const { tokenRequired } = require('../auth');

// --- IMPORT DB MODELS ---
const { Shipment, AWB, APILog } = require('../../models/Schemas');

// --- CONCURRENCY ---
const limit = pLimit(5); 

// --- DATABASE LOGGING ---
async function logToMaster(action, payload, responseData, statusCode = 200) {
    const entry = {
        timestamp: new Date().toISOString(),
        action: action,
        status_code: statusCode,
        payload: payload,
        response: responseData
    };

    try {
        await APILog.create(entry);
    } catch (e) {
        console.error(`[DB Log] Failed to save log: ${e.message}`);
    }
}

// --- ASYNC DATABASE CACHE FUNCTIONS ---

// 1. Get Cache
async function getCachedShipmentId(orderId) {
    try {
        const doc = await Shipment.findOne({ _id_key: String(orderId) }).lean();
        // Check both 'value' (simple string) and 'shipmentId' (if object)
        return doc ? (doc.value || doc.shipmentId) : null;
    } catch (e) { return null; }
}

async function getCachedAwbData(shipmentId) {
    try {
        const doc = await AWB.findOne({ _id_key: String(shipmentId) }).lean();
        return doc || null;
    } catch (e) { return null; }
}

// 2. Save Shipment ID (Format: { _id_key: "orderId", value: "shipmentId" })
async function saveCachedShipmentId(orderId, shipmentId) {
    if (!orderId || !shipmentId) return;
    try {
        await Shipment.updateOne(
            { _id_key: String(orderId) },
            { $set: { value: shipmentId } },
            { upsert: true }
        );
        console.log(`[DB Saved] Order ${orderId} -> Shipment ${shipmentId}`);
    } catch (e) { console.error("DB Save Error:", e); }
}

// 3. Save AWB Data
async function saveCachedAwbData(shipmentId, data) {
    if (!shipmentId || !data) return;
    try {
        await AWB.updateOne(
            { _id_key: String(shipmentId) },
            { $set: data },
            { upsert: true }
        );
        console.log(`[DB Saved] AWB Data for ${shipmentId}`);
    } catch (e) { console.error("DB Save Error:", e); }
}

// --- HELPER: Scan Shipments List ---
function scanShipments(sList, idsToCheck) {
    if (!sList || !Array.isArray(sList)) return null;
    for (const s of sList) {
        const oid = String(s.order_id || s.orderId || '');
        const sid = String(s.seller_order_id || '');
        if (idsToCheck.includes(oid) || idsToCheck.includes(sid)) {
            return s.shipment_id || s.shipmentId;
        }
    }
    return null;
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- ROBUST SHIPMENT ID FINDER ---
async function findShipmentIdRobust(config, orderId) {
    // 1. Check DB Cache
    const cachedId = await getCachedShipmentId(orderId);
    if (cachedId) return cachedId;

    if (!orderId) return null;

    const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
    
    const inputId = String(orderId);
    let idsToCheck = [inputId, inputId.replace('#', '')];

    // 2. Check Shopify
    try {
        const shopifyUrl = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2024-07/orders/${orderId}.json`;
        const shHeaders = { 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN };
        const shRes = await axios.get(shopifyUrl, { headers: shHeaders });
        
        if (shRes.status === 200) {
            const o = shRes.data.order || {};
            if (o.id) idsToCheck.push(String(o.id));
            if (o.name) {
                idsToCheck.push(String(o.name).replace('#', ''));
                idsToCheck.push(String(o.name));
            }
        }
    } catch (e) { /* pass */ }

    idsToCheck = [...new Set(idsToCheck.filter(i => i))];
    const shipmentsUrl = "https://api.rapidshyp.com/rapidshyp/apis/v1/shipments";
    const trackUrl = "https://api.rapidshyp.com/rapidshyp/apis/v1/track_order";

    for (let attempt = 0; attempt < 3; attempt++) {
        // A. Try 'shipments' endpoint
        try {
            const filterVal = idsToCheck.length > 1 ? idsToCheck[1] : idsToCheck[0];
            const sRes = await axios.post(shipmentsUrl, { filter: { order_id: filterVal } }, { headers });
            
            if (sRes.status === 200) {
                const dataList = sRes.data.data || [];
                const sid = scanShipments(dataList, idsToCheck);
                if (sid) {
                    await saveCachedShipmentId(orderId, sid);
                    return sid;
                }
            }
        } catch (e) { /* pass */ }

        // B. Try 'track_order' endpoint
        for (const tid of idsToCheck) {
            try {
                for (const key of ['order_id', 'seller_order_id']) {
                    const payload = {};
                    payload[key] = tid;
                    
                    const res = await axios.post(trackUrl, payload, { headers });
                    if (res.status === 200) {
                        const rec = res.data.records || [];
                        if (rec.length > 0 && rec[0].shipment_details) {
                            const details = rec[0].shipment_details[0];
                            const sid = details.shipment_id;
                            if (sid) {
                                await saveCachedShipmentId(orderId, sid);
                                return sid;
                            }
                        }
                    }
                }
            } catch (e) { /* pass */ }
        }

        if (attempt < 2) await sleep(1500);
    }
    return null;
}

// =============================================================================
// SINGLE ORDER ROUTES (Updated to use Await)
// =============================================================================

router.post('/get-shipment-status', tokenRequired, async (req, res) => {
    const { orderId } = req.body;
    
    const shipmentId = await findShipmentIdRobust(config, orderId);
    const awbData = shipmentId ? await getCachedAwbData(shipmentId) : null;

    const responsePayload = {
        shipmentId: shipmentId,
        awbAssigned: !!awbData,
        awbData: awbData
    };

    return res.json(responsePayload);
});

router.post('/approve-order', tokenRequired, async (req, res) => {
    const data = req.body;
    const shopifyNumericId = data.orderId;
    const storeName = "The Element";

    if (!shopifyNumericId) return res.status(400).json({ error: 'Order ID is required.' });

    const cachedId = await getCachedShipmentId(shopifyNumericId);
    if (cachedId) {
        return res.json({ success: true, message: 'Cached.', shipmentId: cachedId });
    }

    try {
        try {
            const shopifyUrl = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2024-07/orders/${shopifyNumericId}.json`;
            const shopifyHeaders = { 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN };
            await axios.get(shopifyUrl, { headers: shopifyHeaders });
        } catch (e) {}

        const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
        const approveUrl = "https://api.rapidshyp.com/rapidshyp/apis/v1/approve_orders";
        const payload = { "order_id": [String(shopifyNumericId)], "store_name": storeName };

        const response = await axios.post(approveUrl, payload, { headers, validateStatus: () => true });
        const rj = response.data || {};

        await logToMaster("approve_order", payload, rj, response.status);

        let shipmentId = "";
        let isSuccess = false;
        
        if (response.status === 200) {
            const msg = (rj.message || rj.remark || "").toLowerCase();
            if (rj.status === true || rj.status === 'success') {
                isSuccess = true;
                if (rj.order_list && Array.isArray(rj.order_list) && rj.order_list.length > 0) {
                    const orderItem = rj.order_list[0];
                    if (orderItem.shipment && Array.isArray(orderItem.shipment) && orderItem.shipment.length > 0) {
                        shipmentId = orderItem.shipment[0].shipment_id;
                    }
                }
                if (!shipmentId && rj.shipment_id) shipmentId = rj.shipment_id;
            } 
            else if (msg.includes('already approved')) {
                isSuccess = true;
                shipmentId = await findShipmentIdRobust(config, shopifyNumericId);
            }
        }

        if (isSuccess) {
            if (shipmentId) await saveCachedShipmentId(shopifyNumericId, shipmentId);
            return res.json({ success: true, message: 'Approved.', shipmentId: shipmentId });
        }

        return res.status(response.status).json({ error: `Failed: ${rj.message || rj.remark || "Unknown"}` });

    } catch (e) {
        await logToMaster("approve_order_error", data, { error: String(e) }, 500);
        return res.status(500).json({ error: e.message });
    }
});

router.post('/assign-awb', tokenRequired, async (req, res) => {
    const data = req.body;
    let shipmentId = data.shipmentId;
    const orderId = data.orderId;
    const courierCode = data.courierCode;
    const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };

    if (!shipmentId && orderId) {
        shipmentId = await findShipmentIdRobust(config, orderId);
    }

    if (!shipmentId) {
        return res.status(400).json({ error: 'Shipment ID not found.' });
    }

    // 1. CHECK DB CACHE
    const cachedAwb = await getCachedAwbData(shipmentId);
    if (cachedAwb) {
        return res.json(cachedAwb);
    }

    try {
        const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/assign_awb";
        const payload = { "shipment_id": shipmentId };
        if (courierCode) payload["courier_code"] = courierCode;
        if (!payload["courier_code"]) payload["courier_code"] = "";

        const response = await axios.post(url, payload, { headers, validateStatus: () => true });
        const rj = response.data || {};

        await logToMaster("assign_awb", payload, rj, response.status);

        if (response.status === 200) {
            if (rj.status === 'SUCCESS' || rj.awb) {
                if (orderId) await saveCachedShipmentId(orderId, shipmentId);
                
                const successData = {
                    'success': true,
                    'awb': rj.awb,
                    'courier': rj.courier_name,
                    'courier_code': rj.courier_code,
                    'shipment_id': rj.shipment_id,
                    'label': rj.label
                };
                await saveCachedAwbData(shipmentId, successData);
                return res.json(successData);
            } else {
                return res.status(400).json({ error: `Error: ${rj.remarks}` });
            }
        }
        
        return res.status(response.status).json({ error: `API Error: ${JSON.stringify(rj)}` });

    } catch (e) {
        await logToMaster("assign_awb_error", data, { error: String(e) }, 500);
        return res.status(500).json({ error: e.message });
    }
});

router.post('/cancel-order', tokenRequired, async (req, res) => {
    const data = req.body;
    const orderId = data.orderId;

    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    try {
        const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/cancel_order";
        const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
        const payload = { "order_id": String(orderId), "store_name": "The Element" };

        const response = await axios.post(url, payload, { headers, validateStatus: () => true });
        const rj = response.data || {};

        await logToMaster("cancel_order", payload, rj, response.status);

        if (response.status === 200 && rj.status === true) {
            return res.json({
                success: true,
                remarks: rj.remarks || 'Order canceled successfully.'
            });
        }

        return res.status(response.status).json({ error: rj.remarks || 'Cancel failed' });

    } catch (e) {
        await logToMaster("cancel_order_error", data, { error: String(e) }, 500);
        return res.status(500).json({ error: e.message });
    }
});

router.post('/generate-label', tokenRequired, async (req, res) => {
    const data = req.body;
    const shipmentId = data.shipmentId;

    if (!shipmentId) return res.status(400).json({ error: 'Shipment ID required.' });

    const cached = await getCachedAwbData(shipmentId);
    if (cached && cached.label) {
        return res.json({ success: true, labelUrl: cached.label });
    }

    try {
        const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/generate_label";
        const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
        const payload = { "shipmentId": [String(shipmentId)] };

        const response = await axios.post(url, payload, { headers, validateStatus: () => true });
        const rj = response.data || {};

        await logToMaster("generate_label", payload, rj, response.status);

        let labelUrl = null;

        if (rj.label_url) {
            labelUrl = rj.label_url;
        } else if (rj.labelData && rj.labelData.length > 0) {
            labelUrl = rj.labelData[0].labelURL;
        }

        if (labelUrl) {
            if (cached) {
                cached.label = labelUrl;
                await saveCachedAwbData(shipmentId, cached);
            } else {
                await saveCachedAwbData(shipmentId, { label: labelUrl });
            }
            return res.json({ success: true, labelUrl: labelUrl });
        }

        return res.status(400).json({ error: 'Label URL missing in response.' });

    } catch (e) {
        await logToMaster("generate_label_error", data, { error: String(e) }, 500);
        return res.status(500).json({ error: e.message });
    }
});

router.get('/get-shipping-label', tokenRequired, async (req, res) => {
    const awb = req.query.awb;
    if (!awb) return res.status(400).json({ error: 'AWB required.' });

    try {
        const headers = { "rapidshyp-token": config.RAPIDSHYP_API_KEY, "Content-Type": "application/json" };
        const trackUrl = "https://api.rapidshyp.com/rapidshyp/apis/v1/track_order";
        const trackRes = await axios.post(trackUrl, { awb: awb }, { headers, validateStatus: () => true });

        let labelUrl = null;
        let shipmentId = null;

        if (trackRes.status === 200) {
            const data = trackRes.data;
            if (data.records) {
                const details = data.records[0].shipment_details || [];
                if (details.length > 0) {
                    labelUrl = details[0].label_url || details[0].labelURL;
                    shipmentId = details[0].shipment_id;
                }
            }
        }

        if (!labelUrl && shipmentId) {
            const genUrl = "https://api.rapidshyp.com/rapidshyp/apis/v1/generate_label";
            const payload = { "shipmentId": [shipmentId] };
            const genRes = await axios.post(genUrl, payload, { headers, validateStatus: () => true });
            const genJson = genRes.data || {};

            await logToMaster("get_shipping_label_fallback", payload, genJson, genRes.status);

            if (genRes.status === 200) {
                if (genJson.label_url) labelUrl = genJson.label_url;
                else if (genJson.labelData) labelUrl = genJson.labelData[0].labelURL;
            }
        }

        if (labelUrl) return res.json({ success: true, url: labelUrl });
        return res.status(404).json({ error: 'Label not found.' });

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.get('/get-shipping-invoice', tokenRequired, async (req, res) => {
    const awb = req.query.awb;
    if (!awb) return res.status(400).json({ error: 'AWB required.' });

    try {
        const headers = { "rapidshyp-token": config.RAPIDSHYP_API_KEY, "Content-Type": "application/json" };
        const trackUrl = "https://api.rapidshyp.com/rapidshyp/apis/v1/track_order";
        const response = await axios.post(trackUrl, { awb: awb }, { headers, validateStatus: () => true });

        let invoiceUrl = null;
        let labelUrlFallback = null;

        if (response.status === 200) {
            const data = response.data;
            if (data.records) {
                const details = data.records[0].shipment_details || [];
                if (details.length > 0) {
                    invoiceUrl = details[0].invoice_url || details[0].invoiceURL;
                    labelUrlFallback = details[0].label_url || details[0].labelURL;
                }
            }
        }

        if (!invoiceUrl) invoiceUrl = labelUrlFallback;
        if (invoiceUrl) return res.json({ success: true, url: invoiceUrl });
        return res.status(404).json({ error: 'Invoice not found.' });

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/schedule-pickup', tokenRequired, async (req, res) => {
    const data = req.body;
    const orderId = data.orderId;
    let shipmentId = data.shipmentId;

    if (!shipmentId && orderId) {
        shipmentId = await findShipmentIdRobust(config, orderId);
    }
    if (!shipmentId) return res.status(400).json({ error: 'shipmentId not found' });

    const cachedAwb = await getCachedAwbData(shipmentId);
    if (!cachedAwb || !cachedAwb.awb) {
        return res.status(400).json({ error: 'AWB not found. Assign AWB first.' });
    }

    try {
        const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/schedule_pickup";
        const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
        const payload = { "shipment_id": shipmentId, "awb": cachedAwb.awb };

        const response = await axios.post(url, payload, { headers, validateStatus: () => true });
        const rj = response.data || {};
        
        await logToMaster("schedule_pickup", payload, rj, response.status);

        if (response.status === 200 && rj.status === "SUCCESS") {
            const updatedData = { 
                ...cachedAwb, 
                pickupScheduled: true, 
                pickupToken: rj.pickup_token 
            };
            await saveCachedAwbData(shipmentId, updatedData);

            return res.json({
                success: true,
                shipmentId: rj.shipmentId,
                awb: rj.awb,
                remarks: rj.remarks
            });
        }
        return res.status(response.status).json({ error: rj.remarks || 'Pickup scheduling failed' });

    } catch (e) {
        await logToMaster("schedule_pickup_error", data, { error: String(e) }, 500);
        return res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// BULK OPERATIONS
// =============================================================================

router.post('/bulk-approve', tokenRequired, async (req, res) => {
    const { orderIds } = req.body;
    if (!orderIds || !Array.isArray(orderIds)) return res.status(400).json({ error: 'Invalid orderIds array' });

    const results = { success: [], failed: [] };

    const tasks = orderIds.map(id => limit(async () => {
        const idStr = String(id);
        try {
            const cachedId = await getCachedShipmentId(idStr);
            if (cachedId) {
                results.success.push({ id: idStr, shipmentId: cachedId, msg: 'Cached' });
                return;
            }

            const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
            const payload = { "order_id": [idStr], "store_name": "The Element" };
            
            const apiRes = await axios.post("https://api.rapidshyp.com/rapidshyp/apis/v1/approve_orders", payload, { headers, validateStatus: () => true });
            const rj = apiRes.data || {};
            
            await logToMaster("bulk_approve_attempt", payload, rj, apiRes.status);

            let shipmentId = null;
            let isApproved = false;

            if (apiRes.status === 200) {
                 const msg = (rj.remark || rj.message || "").toLowerCase();
                 
                 if (rj.status === 'success' || rj.status === true) {
                    isApproved = true;
                    if (rj.order_list && Array.isArray(rj.order_list) && rj.order_list.length > 0) {
                        const item = rj.order_list[0];
                        if (item.shipment && Array.isArray(item.shipment) && item.shipment.length > 0) {
                            shipmentId = item.shipment[0].shipment_id;
                        } else if (item.shipment_id) {
                            shipmentId = item.shipment_id;
                        }
                    }
                 }
                 else if (msg.includes('already approved')) {
                    isApproved = true;
                    shipmentId = await findShipmentIdRobust(config, idStr);
                 }
            }

            if (shipmentId) {
                await saveCachedShipmentId(idStr, shipmentId);
                results.success.push({ id: idStr, shipmentId });
            } else if (isApproved) {
                results.failed.push({ id: idStr, error: 'Approved, but shipment ID retrieval failed.' });
            } else {
                results.failed.push({ id: idStr, error: rj.remark || rj.message || 'Unknown error' });
            }

        } catch (e) {
            results.failed.push({ id: idStr, error: e.message });
        }
    }));

    await Promise.all(tasks);
    res.json(results);
});

router.post('/bulk-assign-awb', tokenRequired, async (req, res) => {
    const { orderIds } = req.body;
    if (!orderIds || !Array.isArray(orderIds)) return res.status(400).json({ error: 'Invalid orderIds' });

    const results = { success: [], failed: [] };

    const tasks = orderIds.map(oid => limit(async () => {
        const oidStr = String(oid);
        try {
            let shipmentId = await getCachedShipmentId(oidStr);
            
            if (!shipmentId) shipmentId = await findShipmentIdRobust(config, oidStr);
            
            if (!shipmentId) {
                results.failed.push({ id: oidStr, error: 'Shipment ID not found (Approve first)' });
                return;
            }

            const cachedAwb = await getCachedAwbData(shipmentId);
            if (cachedAwb && cachedAwb.awb) {
                results.success.push({ id: oidStr, awb: cachedAwb.awb, msg: 'Already Assigned' });
                return;
            }

            const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY };
            const payload = { "shipment_id": shipmentId, "courier_code": "" }; 
            
            const apiRes = await axios.post("https://api.rapidshyp.com/rapidshyp/apis/v1/assign_awb", payload, { headers, validateStatus: () => true });
            const rj = apiRes.data || {};
            
            await logToMaster("bulk_assign_awb", payload, rj, apiRes.status);

            if (apiRes.status === 200 && (rj.status === 'SUCCESS' || rj.awb)) {
                 const dataToCache = {
                    success: true,
                    awb: rj.awb,
                    courier: rj.courier_name,
                    courier_code: rj.courier_code,
                    shipment_id: shipmentId,
                    label: rj.label
                 };
                 
                 await saveCachedAwbData(shipmentId, dataToCache);
                 results.success.push({ id: oidStr, awb: rj.awb });
            } else {
                results.failed.push({ id: oidStr, error: rj.remarks || rj.message || 'Assign failed' });
            }
        } catch (e) {
            results.failed.push({ id: oidStr, error: e.message });
        }
    }));

    await Promise.all(tasks);
    res.json(results);
});

router.post('/bulk-generate-labels', tokenRequired, async (req, res) => {
    const { shipmentIds } = req.body; 
    if (!shipmentIds || !Array.isArray(shipmentIds)) return res.status(400).json({ error: 'Invalid shipmentIds' });

    const results = { success: [], failed: [] };

    const tasks = shipmentIds.map(sid => limit(async () => {
        try {
            const cached = await getCachedAwbData(sid);
            if (cached && cached.label) {
                results.success.push({ shipmentId: sid, label: cached.label });
                return;
            }

            const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY };
            const payload = { shipmentId: [sid] };
            const apiRes = await axios.post("https://api.rapidshyp.com/rapidshyp/apis/v1/generate_label", payload, { headers });
            const rj = apiRes.data || {};
            
            await logToMaster("bulk_generate_label", payload, rj, apiRes.status);
            
            const url = rj.label_url || rj.labelData?.[0]?.labelURL;
            
            if (url) {
                const data = cached || {};
                data.label = url;
                await saveCachedAwbData(sid, data);
                results.success.push({ shipmentId: sid, label: url });
            } else {
                results.failed.push({ shipmentId: sid, error: 'No URL returned' });
            }
        } catch (e) {
            results.failed.push({ shipmentId: sid, error: e.message });
        }
    }));

    await Promise.all(tasks);
    res.json(results);
});

module.exports = router;