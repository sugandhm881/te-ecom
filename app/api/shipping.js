const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const pLimit = require('p-limit');
const AsyncLock = require('async-lock');
const config = require('../../config');
const { tokenRequired } = require('../auth');

// --- CONSTANTS ---
// Using path.resolve to ensure absolute paths, preventing relative path execution issues
const ORDER_CACHE_FILE = path.resolve(config.CACHE_DIR, 'order_shipment_cache.json');
const AWB_CACHE_FILE = path.resolve(config.CACHE_DIR, 'awb_assignment_cache.json');
const MASTER_LOG_FILE = path.resolve(config.CACHE_DIR, 'master_api_log.json');

// --- CONCURRENCY & LOCKING ---
const limit = pLimit(5); // Process 5 API calls at a time
const lock = new AsyncLock(); // Prevents file corruption during bulk writes

// --- JSON UTILS ---
function loadJsonFile(filepath) {
    if (!fs.existsSync(filepath)) return {};
    try {
        return fs.readJsonSync(filepath);
    } catch (e) {
        console.error(`[JSON Load Error] ${filepath}: ${e.message}`);
        return {};
    }
}

function saveJsonFile(filepath, data) {
    try {
        fs.outputJsonSync(filepath, data, { spaces: 4 });
    } catch (e) {
        console.error(`[Cache Save Failed] (${filepath}): ${e.message}`);
    }
}

// --- MASTER LOGGER ---
function logToMaster(action, payload, responseData, statusCode = 200) {
    const entry = {
        timestamp: new Date().toISOString(),
        action: action,
        status_code: statusCode,
        payload: payload,
        response: responseData
    };

    try {
        let logs = [];
        if (fs.existsSync(MASTER_LOG_FILE)) {
            try {
                logs = fs.readJsonSync(MASTER_LOG_FILE);
                if (!Array.isArray(logs)) logs = [];
            } catch (e) { logs = []; }
        }
        
        logs.push(entry);
        fs.outputJsonSync(MASTER_LOG_FILE, logs, { spaces: 4 });
    } catch (e) {
        console.error(`[Master Log] Failed to save: ${e.message}`);
    }
}

// --- THREAD-SAFE CACHE FUNCTIONS ---

// 1. Get Cache (Read is safe)
function getCachedShipmentId(orderId) {
    const cache = loadJsonFile(ORDER_CACHE_FILE);
    return cache[String(orderId)];
}

function getCachedAwbData(shipmentId) {
    const cache = loadJsonFile(AWB_CACHE_FILE);
    return cache[String(shipmentId)];
}

// 2. Save Shipment ID (Locked)
async function saveCachedShipmentId(orderId, shipmentId) {
    if (!orderId || !shipmentId) return;
    await lock.acquire('order_cache', () => {
        const cache = loadJsonFile(ORDER_CACHE_FILE);
        // Only save if new or changed
        if (cache[String(orderId)] !== shipmentId) {
            cache[String(orderId)] = shipmentId;
            saveJsonFile(ORDER_CACHE_FILE, cache);
            console.log(`[Cache Saved] Order ${orderId} -> Shipment ${shipmentId}`);
        }
    });
}

// 3. Save AWB Data (Locked)
async function saveCachedAwbData(shipmentId, responseData) {
    if (!shipmentId || !responseData) return;
    await lock.acquire('awb_cache', () => {
        const cache = loadJsonFile(AWB_CACHE_FILE);
        cache[String(shipmentId)] = responseData;
        saveJsonFile(AWB_CACHE_FILE, cache);
        console.log(`[Cache Saved] AWB Data for ${shipmentId}`);
    });
}

// --- HELPER: Scan Shipments List (Exact Python Port) ---
function scanShipments(sList, idsToCheck) {
    if (!sList || !Array.isArray(sList)) return null;
    
    for (const s of sList) {
        const oid = String(s.order_id || s.orderId || '');
        const sid = String(s.seller_order_id || '');
        
        // Check if either ID matches our list of IDs
        if (idsToCheck.includes(oid) || idsToCheck.includes(sid)) {
            return s.shipment_id || s.shipmentId;
        }
    }
    return null;
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- ROBUST SHIPMENT ID FINDER (Exact Python Logic) ---
async function findShipmentIdRobust(config, orderId) {
    // 1. Check Cache
    const cachedId = getCachedShipmentId(orderId);
    if (cachedId) return cachedId;

    if (!orderId) return null;

    const headers = {
        'rapidshyp-token': config.RAPIDSHYP_API_KEY,
        'Content-Type': 'application/json'
    };
    
    const inputId = String(orderId);
    let idsToCheck = [inputId, inputId.replace('#', '')];

    // 2. Check Shopify for variations (Python parity)
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

    // Deduplicate and filter empty
    idsToCheck = [...new Set(idsToCheck.filter(i => i))];

    const shipmentsUrl = "https://api.rapidshyp.com/rapidshyp/apis/v1/shipments";
    const trackUrl = "https://api.rapidshyp.com/rapidshyp/apis/v1/track_order";

    // 3. Retry Loop (3 Attempts)
    for (let attempt = 0; attempt < 3; attempt++) {
        
        // A. Try 'shipments' endpoint (The part that was missing!)
        // This is crucial because 'track_order' often fails for newly approved orders
        try {
            const filterVal = idsToCheck.length > 1 ? idsToCheck[1] : idsToCheck[0];
            // Note: Axios post body is 2nd argument
            const sRes = await axios.post(shipmentsUrl, { filter: { order_id: filterVal } }, { headers });
            
            if (sRes.status === 200) {
                const dataList = sRes.data.data || [];
                const sid = scanShipments(dataList, idsToCheck);
                if (sid) {
                    await saveCachedShipmentId(orderId, sid); // Async Lock Save
                    return sid;
                }
            }
        } catch (e) { /* pass */ }

        // B. Try 'track_order' endpoint for every ID variant
        for (const tid of idsToCheck) {
            try {
                // Try both order_id and seller_order_id keys
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
                                await saveCachedShipmentId(orderId, sid); // Async Lock Save
                                return sid;
                            }
                        }
                    }
                }
            } catch (e) { /* pass */ }
        }

        // Sleep if not last attempt
        if (attempt < 2) await sleep(1500);
    }
    return null;
}

// =============================================================================
// SINGLE ORDER ROUTES
// =============================================================================

router.post('/get-shipment-status', tokenRequired, async (req, res) => {
    const { orderId } = req.body;
    
    const shipmentId = await findShipmentIdRobust(config, orderId);
    const awbData = shipmentId ? getCachedAwbData(shipmentId) : null;

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

    const cachedId = getCachedShipmentId(shopifyNumericId);
    if (cachedId) {
        return res.json({ success: true, message: 'Cached.', shipmentId: cachedId });
    }

    try {
        // Wake up Shopify
        try {
            const shopifyUrl = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2024-07/orders/${shopifyNumericId}.json`;
            const shopifyHeaders = { 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN };
            await axios.get(shopifyUrl, { headers: shopifyHeaders });
        } catch (e) {}

        const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
        const approveUrl = "https://api.rapidshyp.com/rapidshyp/apis/v1/approve_orders";
        const payload = { "order_id": [String(shopifyNumericId)], "store_name": storeName };

        const response = await axios.post(approveUrl, payload, { headers, validateStatus: () => true });
        const respJson = response.data || {};

        logToMaster("approve_order", payload, respJson, response.status);

        let shipmentId = "";
        let isSuccess = false;
        
        if (response.status === 200) {
            if (respJson.status === true || respJson.status === 'success') {
                isSuccess = true;
                const dataList = respJson.data || respJson.order_list || [];
                if (dataList.length > 0) {
                    if (dataList[0].shipment) {
                        const shipments = dataList[0].shipment;
                        if (shipments) shipmentId = shipments[0].shipment_id;
                    } else {
                        shipmentId = dataList[0].shipment_id;
                    }
                }
            } else {
                const msg = (respJson.message || '').toLowerCase();
                const rem = (respJson.remark || '').toLowerCase();
                if (msg.includes('already approved') || rem.includes('already approved')) {
                    isSuccess = true;
                    shipmentId = await findShipmentIdRobust(config, shopifyNumericId);
                }
            }
        }

        if (isSuccess) {
            if (shipmentId) await saveCachedShipmentId(shopifyNumericId, shipmentId);
            return res.json({ success: true, message: 'Approved.', shipmentId: shipmentId });
        }

        return res.status(response.status).json({ error: `Failed: ${respJson.message || JSON.stringify(respJson)}` });

    } catch (e) {
        logToMaster("approve_order_error", data, { error: String(e) }, 500);
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

    // 1. CHECK AWB CACHE
    const cachedAwb = getCachedAwbData(shipmentId);
    if (cachedAwb) {
        return res.json(cachedAwb);
    }

    try {
        const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/assign_awb";
        const payload = { "shipment_id": shipmentId };
        if (courierCode) payload["courier_code"] = courierCode;
        if (!payload["courier_code"]) payload["courier_code"] = "";

        const response = await axios.post(url, payload, { headers, validateStatus: () => true });
        const respJson = response.data || {};

        logToMaster("assign_awb", payload, respJson, response.status);

        if (response.status === 200) {
            if (respJson.status === 'SUCCESS' || respJson.awb) {
                if (orderId) await saveCachedShipmentId(orderId, shipmentId);
                
                const successData = {
                    'success': true,
                    'awb': respJson.awb,
                    'courier': respJson.courier_name,
                    'courier_code': respJson.courier_code,
                    'shipment_id': respJson.shipment_id,
                    'label': respJson.label
                };
                await saveCachedAwbData(shipmentId, successData);
                return res.json(successData);
            } else {
                return res.status(400).json({ error: `Error: ${respJson.remarks}` });
            }
        }
        
        return res.status(response.status).json({ error: `API Error: ${JSON.stringify(respJson)}` });

    } catch (e) {
        logToMaster("assign_awb_error", data, { error: String(e) }, 500);
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
        const payload = { "orderId": String(orderId), "storeName": "The Element" };

        const response = await axios.post(url, payload, { headers, validateStatus: () => true });
        const respJson = response.data || {};

        logToMaster("cancel_order", payload, respJson, response.status);

        if (response.status === 200 && respJson.status === true) {
            return res.json({
                success: true,
                remarks: respJson.remarks || 'Order canceled successfully.'
            });
        }

        return res.status(response.status).json({ error: respJson.remarks || 'Cancel failed' });

    } catch (e) {
        logToMaster("cancel_order_error", data, { error: String(e) }, 500);
        return res.status(500).json({ error: e.message });
    }
});

router.post('/generate-label', tokenRequired, async (req, res) => {
    const data = req.body;
    const shipmentId = data.shipmentId;

    if (!shipmentId) return res.status(400).json({ error: 'Shipment ID required.' });

    // Check AWB Cache first
    const cached = getCachedAwbData(shipmentId);
    if (cached && cached.label) {
        return res.json({ success: true, labelUrl: cached.label });
    }

    try {
        const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/generate_label";
        const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
        const payload = { "shipmentId": [String(shipmentId)] };

        const response = await axios.post(url, payload, { headers, validateStatus: () => true });
        const resData = response.data || {};

        logToMaster("generate_label", payload, resData, response.status);

        let labelUrl = null;

        // 1. Check Root Level 'label_url'
        if (resData.label_url) {
            labelUrl = resData.label_url;
        }
        // 2. Check 'labelData' List
        else if (resData.labelData && resData.labelData.length > 0) {
            labelUrl = resData.labelData[0].labelURL;
        }

        if (labelUrl) {
            // Update cache
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
        logToMaster("generate_label_error", data, { error: String(e) }, 500);
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

            logToMaster("get_shipping_label_fallback", payload, genJson, genRes.status);

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

    if (!shipmentId) {
        return res.status(400).json({ error: 'shipmentId not found' });
    }

    const cachedAwb = getCachedAwbData(shipmentId);

    if (!cachedAwb || !cachedAwb.awb) {
        return res.status(400).json({ error: 'AWB not found in cache. Assign AWB before scheduling pickup.' });
    }

    const awb = cachedAwb.awb;

    try {
        const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/schedule_pickup";
        const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
        const payload = { "shipment_id": shipmentId, "awb": awb };

        const response = await axios.post(url, payload, { headers, validateStatus: () => true });
        const respJson = response.data || {};

        logToMaster("schedule_pickup", payload, respJson, response.status);

        if (response.status === 200 && respJson.status === "SUCCESS") {
            return res.json({
                success: true,
                shipmentId: respJson.shipmentId,
                orderId: respJson.orderId,
                awb: respJson.awb,
                courierCode: respJson.courierCode,
                courierName: respJson.courierName,
                routingCode: respJson.routingCode,
                rtoRoutingCode: respJson.rtoRoutingCode,
                remarks: respJson.remarks
            });
        }

        return res.status(response.status).json({ error: respJson.remarks || 'Pickup scheduling failed' });

    } catch (e) {
        logToMaster("schedule_pickup_error", data, { error: String(e) }, 500);
        return res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// BULK OPERATIONS (THREAD-SAFE & ROBUST)
// =============================================================================

// 1. BULK APPROVE (Saves to order_shipment_cache.json)
router.post('/bulk-approve', tokenRequired, async (req, res) => {
    const { orderIds } = req.body;
    if (!orderIds || !Array.isArray(orderIds)) return res.status(400).json({ error: 'Invalid orderIds array' });

    const results = { success: [], failed: [] };

    // Create array of promises
    const tasks = orderIds.map(id => limit(async () => {
        try {
            // 1. Check Cache
            const cachedId = getCachedShipmentId(id);
            if (cachedId) {
                results.success.push({ id, shipmentId: cachedId, msg: 'Cached' });
                return;
            }

            // 2. Call API
            const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY, 'Content-Type': 'application/json' };
            const payload = { "order_id": [String(id)], "store_name": "The Element" };
            const apiRes = await axios.post("https://api.rapidshyp.com/rapidshyp/apis/v1/approve_orders", payload, { headers, validateStatus: () => true });
            
            let shipmentId = null;
            const rj = apiRes.data || {};
            
            if (apiRes.status === 200 && (rj.status === true || rj.status === 'success')) {
                 shipmentId = rj.data?.[0]?.shipment?.[0]?.shipment_id || rj.order_list?.[0]?.shipment_id;
            } else if (JSON.stringify(rj).toLowerCase().includes('already approved')) {
                 shipmentId = await findShipmentIdRobust(config, id);
            }

            if (shipmentId) {
                await saveCachedShipmentId(id, shipmentId); // ✅ Thread-safe Lock
                results.success.push({ id, shipmentId });
            } else {
                results.failed.push({ id, error: rj.message || 'Unknown error' });
            }

        } catch (e) {
            results.failed.push({ id, error: e.message });
        }
    }));

    await Promise.all(tasks);
    res.json(results);
});

// 2. BULK ASSIGN AWB (Saves to awb_assignment_cache.json)
router.post('/bulk-assign-awb', tokenRequired, async (req, res) => {
    const { orderIds } = req.body;
    if (!orderIds || !Array.isArray(orderIds)) return res.status(400).json({ error: 'Invalid orderIds' });

    const results = { success: [], failed: [] };

    const tasks = orderIds.map(oid => limit(async () => {
        try {
            // Resolve Shipment ID
            let shipmentId = getCachedShipmentId(oid);
            if (!shipmentId) shipmentId = await findShipmentIdRobust(config, oid);
            
            if (!shipmentId) {
                results.failed.push({ id: oid, error: 'Shipment ID not found (Approve first)' });
                return;
            }

            // Check Cache
            const cachedAwb = getCachedAwbData(shipmentId);
            if (cachedAwb && cachedAwb.awb) {
                results.success.push({ id: oid, awb: cachedAwb.awb, msg: 'Already Assigned' });
                return;
            }

            // Call API
            const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY };
            const payload = { "shipment_id": shipmentId, "courier_code": "" }; // Auto
            
            const apiRes = await axios.post("https://api.rapidshyp.com/rapidshyp/apis/v1/assign_awb", payload, { headers, validateStatus: () => true });
            const rj = apiRes.data || {};

            if (apiRes.status === 200 && (rj.status === 'SUCCESS' || rj.awb)) {
                const dataToCache = {
                    success: true,
                    awb: rj.awb,
                    courier: rj.courier_name,
                    courier_code: rj.courier_code,
                    shipment_id: shipmentId,
                    label: rj.label
                };
                
                // Thread-safe saves
                await saveCachedAwbData(shipmentId, dataToCache);
                await saveCachedShipmentId(oid, shipmentId);
                
                results.success.push({ id: oid, awb: rj.awb });
            } else {
                results.failed.push({ id: oid, error: rj.remarks || rj.message || 'Assign failed' });
            }
        } catch (e) {
            results.failed.push({ id: oid, error: e.message });
        }
    }));

    await Promise.all(tasks);
    res.json(results);
});

// 3. BULK GENERATE LABELS
router.post('/bulk-generate-labels', tokenRequired, async (req, res) => {
    const { shipmentIds } = req.body; 
    if (!shipmentIds || !Array.isArray(shipmentIds)) return res.status(400).json({ error: 'Invalid shipmentIds' });

    const results = { success: [], failed: [] };

    const tasks = shipmentIds.map(sid => limit(async () => {
        try {
            const cached = getCachedAwbData(sid);
            if (cached && cached.label) {
                results.success.push({ shipmentId: sid, label: cached.label });
                return;
            }

            const headers = { 'rapidshyp-token': config.RAPIDSHYP_API_KEY };
            const apiRes = await axios.post("https://api.rapidshyp.com/rapidshyp/apis/v1/generate_label", { shipmentId: [sid] }, { headers });
            
            const url = apiRes.data.label_url || apiRes.data.labelData?.[0]?.labelURL;
            
            if (url) {
                const data = cached || {};
                data.label = url;
                await saveCachedAwbData(sid, data); // Async Lock Save
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