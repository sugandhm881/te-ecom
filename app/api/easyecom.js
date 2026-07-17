/**
 * EasyEcom OMS Integration
 * Auth: Uses JWT from EASYECOM_JWT (env). Auto-refreshes via
 * POST https://loadbalancer-v2-m.easyecom.io/access/token
 * when token is expired, using EASYECOM_API_KEY.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const moment = require('moment-timezone');
const config = require('../../config');
const { supabase, getOrderFromSupabase } = require('../supabase');
const { tokenRequired, requireAdmin } = require('../auth');
const { encrypt, decrypt } = require('./crypto_util');
const APP_BASE = 'https://app.easyecom.io';

const TOKEN_ENDPOINT = 'https://api.easyecom.io/access/token';
const EASYECOM_API_BASE = 'https://api.easyecom.io';

// ─── Token Cache ───────────────────────────────────────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

function seedTokenFromEnv() {
    let jwt = config.EASYECOM_JWT;
    if (!jwt) return;
    // Strip "Bearer " prefix if accidentally included in .env
    if (jwt.startsWith('Bearer ')) jwt = jwt.slice(7);
    try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
        if (payload.exp * 1000 < Date.now()) return;   // stale .env token — the DB cache / login handles it
        _tokenCache = { token: jwt, expiresAt: payload.exp * 1000 };
        console.log('[EasyEcom] JWT loaded from .env, expires:', new Date(payload.exp * 1000).toISOString());
    } catch (e) {
        console.warn('[EasyEcom] Could not parse JWT from env:', e.message);
    }
}
seedTokenFromEnv();

function invalidateToken() {
    _tokenCache = { token: null, expiresAt: 0 };
}

async function getEasyecomToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _tokenCache.token && now < _tokenCache.expiresAt - 5 * 60 * 1000) {
        return _tokenCache.token;
    }

    // Shared DB cache — ONE token serves every process (server, CLI scripts, restarts). Without this,
    // each new process seeded from the stale .env JWT and re-logged-in via email/password every time.
    if (!forceRefresh) {
        try {
            const { data } = await supabase.from('easyecom_token_cache').select('jwt_token, expires_at').eq('id', 1).maybeSingle();
            if (data && data.jwt_token && new Date(data.expires_at).getTime() > now + 5 * 60 * 1000) {
                _tokenCache = { token: data.jwt_token, expiresAt: new Date(data.expires_at).getTime() };
                return _tokenCache.token;
            }
        } catch (_) { /* fall through to login */ }
    }

    if (!config.EASYECOM_API_KEY) {
        throw new Error('EASYECOM_API_KEY missing in .env — needed to refresh expired JWT');
    }

    if (!config.EASYECOM_EMAIL || !config.EASYECOM_PASSWORD) {
        throw new Error('EASYECOM_EMAIL and EASYECOM_PASSWORD required in .env to refresh JWT');
    }

    console.log('[EasyEcom] JWT expired/invalid — refreshing via email/password...');
    const res = await axios.post(TOKEN_ENDPOINT, {
        email:        config.EASYECOM_EMAIL,
        password:     config.EASYECOM_PASSWORD,
        location_key: config.EASYECOM_WH_KEY
    }, {
        headers: {
            'x-api-key':    config.EASYECOM_API_KEY,
            'Content-Type': 'application/json'
        },
        validateStatus: () => true
    });

    if (res.status !== 200) {
        throw new Error(`EasyEcom token refresh failed (${res.status}): ${JSON.stringify(res.data)}`);
    }

    const body  = res.data || {};
    // Response: { data: { token: { jwt_token: "..." } } }
    const token = (body.data && body.data.token && body.data.token.jwt_token)
               || (body.data && body.data.token)
               || body.token || body.jwt;
    if (!token || typeof token !== 'string') throw new Error(`No token in EasyEcom refresh response: ${JSON.stringify(body).slice(0, 500)}`);

    const payload   = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    _tokenCache     = { token, expiresAt: payload.exp * 1000 };
    // Persist for every other process — the next login should be ~90 days away, not next restart.
    await supabase.from('easyecom_token_cache')
        .upsert({ id: 1, jwt_token: token, expires_at: new Date(payload.exp * 1000).toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'id' })
        .then(() => {}).catch(() => {});
    console.log('[EasyEcom] New JWT cached (memory + DB), expires:', new Date(payload.exp * 1000).toISOString());
    return token;
}

// ─── Build single order entry for EasyEcom payload ─────────────────────────
function buildOrderEntry(order, lineItems, shippingAddress) {
    const addr      = shippingAddress || {};
    const buyerName = addr.name || `${addr.first_name || ''} ${addr.last_name || ''}`.trim() || 'N/A';
    const buyerPhone = String(addr.phone || order.phone || '').replace(/\D/g, '').slice(-10);
    const isCod     = (order.financial_status || '').toLowerCase() !== 'paid';

    const orderDate = order.created_at
        ? new Date(order.created_at).toISOString().replace('T', ' ').slice(0, 19)
        : new Date().toISOString().replace('T', ' ').slice(0, 19);

    const items = (lineItems || [])
        .filter(i => i.sku)
        .map(i => ({
            sku:          i.sku,
            product_name: i.title || i.name || '',
            quantity:     i.quantity || 1,
            unit_price:   parseFloat(i.price || 0),
            discount:     parseFloat(i.total_discount || 0),
            tax:          parseFloat(i.tax_total || 0)
        }));

    return {
        store_order_id: order.name || String(order.id),
        order_date:     orderDate,
        payment_type:   isCod ? 'cod' : 'prepaid',
        cod_amount:     isCod ? parseFloat(order.total_price || 0) : 0,
        buyer_name:     buyerName,
        buyer_mobile:   buyerPhone,
        buyer_email:    order.email || '',
        address:        `${addr.address1 || ''}${addr.address2 ? ', ' + addr.address2 : ''}`,
        city:           addr.city || '',
        state:          addr.province || addr.province_code || '',
        country:        addr.country || 'India',
        pincode:        addr.zip || '',
        items
    };
}

// ─── API ROUTE: Create EasyEcom Batch ──────────────────────────────────────
// POST /api/easyecom/create-batch
// Body: { orderIds: ["5869437960411", "5869437960412", ...] }
router.post('/create-batch', tokenRequired, async (req, res) => {
    const { orderIds } = req.body;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ error: 'orderIds array is required' });
    }

    if (!config.EASYECOM_WH_KEY) {
        return res.status(400).json({ error: 'EASYECOM_WH_KEY not configured in .env' });
    }

    // 1. Get EasyEcom token
    let jwt;
    try {
        jwt = await getEasyecomToken();
    } catch (e) {
        return res.status(500).json({ error: `EasyEcom auth failed: ${e.message}` });
    }

    // 2. Fetch all order data from Supabase in parallel
    console.log(`[EasyEcom Batch] Fetching ${orderIds.length} orders from Supabase...`);
    const orderDataResults = await Promise.all(
        orderIds.map(id => getOrderFromSupabase(id))
    );

    // 3. Build batch payload
    const orderEntries = [];
    const skipped = [];

    for (let i = 0; i < orderIds.length; i++) {
        const id = orderIds[i];
        const { order, lineItems, shippingAddress } = orderDataResults[i];

        if (!order) {
            skipped.push({ id, reason: 'Order not found in Supabase' });
            continue;
        }
        if (!lineItems || lineItems.length === 0) {
            skipped.push({ id, reason: 'No line items found' });
            continue;
        }

        orderEntries.push(buildOrderEntry(order, lineItems, shippingAddress));
    }

    if (orderEntries.length === 0) {
        return res.status(400).json({ error: 'No valid orders to create batch', skipped });
    }

    const batchPayload = {
        generate_label: false,
        order_type: 'forward',
        warehouse_prefix: config.EASYECOM_WH_KEY,
        orders: orderEntries
    };

    // 4. Push to EasyEcom
    const url = `${EASYECOM_API_BASE}/Orders/create`;

    // EasyEcom auth: JWT as Bearer + api_key as x-api-key
    // Also pass JWT directly as query param — some endpoints require this
    const headers = {
        'Authorization': `Bearer ${jwt}`,
        'x-api-key': config.EASYECOM_API_KEY,
        'Content-Type': 'application/json'
    };
    const urlWithToken = `${url}?jwt=${encodeURIComponent(jwt)}`;

    console.log(`[EasyEcom Batch] Sending ${orderEntries.length} orders to ${urlWithToken.split('?')[0]}`);

    try {
        const apiRes = await axios.post(urlWithToken, batchPayload, { headers, validateStatus: () => true });
        const body = apiRes.data || {};

        console.log(`[EasyEcom Batch] Response status: ${apiRes.status}`);
        console.log(`[EasyEcom Batch] Response:`, JSON.stringify(body).slice(0, 500));

        // Log to api_logs_ecom
        await supabase.from('api_logs_ecom').insert({
            action: 'easyecom_create_batch',
            status_code: apiRes.status,
            payload: { order_count: orderEntries.length, order_ids: orderIds },
            response: body
        });

        const isSuccess = apiRes.status === 200 && (
            body.status === true ||
            body.status === 'success' ||
            body.status === 'SUCCESS' ||
            (Array.isArray(body.data) && body.data.length > 0)
        );

        if (isSuccess) {
            return res.json({
                success: true,
                message: `Batch created: ${orderEntries.length} orders sent to EasyEcom`,
                created: orderEntries.length,
                skipped,
                easyecomResponse: body
            });
        }

        return res.status(apiRes.status || 400).json({
            success: false,
            error: body.message || body.error || 'EasyEcom rejected the batch',
            created: 0,
            skipped,
            easyecomResponse: body
        });

    } catch (e) {
        console.error('[EasyEcom Batch] Error:', e.message);

        await supabase.from('api_logs_ecom').insert({
            action: 'easyecom_create_batch_error',
            status_code: 500,
            payload: { order_count: orderEntries.length, order_ids: orderIds },
            response: { error: e.message }
        });

        return res.status(500).json({ error: e.message });
    }
});

// ─── Map a raw EasyEcom order → `b2c_order_easycom` row ────────────────────
// Handles both polling API responses and V1/V2 webhook payloads.
// Webhook sends address fields flat on the order (address_line_1, city, pin_code,
// contact_num) while the polling API nests them inside shipping_address object.
function rawToDbRow(o) {
    const items = Array.isArray(o.suborders)    ? o.suborders
                : Array.isArray(o.order_items)  ? o.order_items
                : Array.isArray(o.items)        ? o.items
                : [];

    // Webhook items use productName / suborder_quantity / selling_price
    const lineItems = items.map(i => ({
        name:  i.productName || i.product_name || i.item_name || i.name || i.title || '',
        sku:   i.sku || i.seller_sku || i.item_sku || '',
        qty:   i.suborder_quantity || i.item_quantity || i.quantity || i.qty || 1,
        price: parseFloat(i.selling_price || i.unit_price || i.price || 0)
    }));

    // Polling API nests address; webhook sends flat fields at order level
    const addr = o.shipping_address || o.shippingAddress || {};
    const shippingAddress = Object.keys(addr).length > 0 ? addr : {
        address_line_1: o.address_line_1 || '',
        address_line_2: o.address_line_2 || '',
        city:           o.city || '',
        state:          o.state || '',
        pincode:        o.pin_code || '',
        country:        o.country || 'India',
        phone:          o.contact_num || ''
    };

    const customerName = o.customer_name || o.buyer_name || o.shipping_name || addr.name
        || `${addr.first_name || ''} ${addr.last_name || ''}`.trim() || 'N/A';

    const createdRaw = o.order_date || o.created_at || o.invoice_date || o.orderDate;
    const orderDateIso = createdRaw ? new Date(createdRaw).toISOString() : null;

    const easyecomId = String(o.order_id || o.orderId || o.id || '');
    if (!easyecomId) return null;

    return {
        order_id:             easyecomId,
        // marketplace_invoice_num echoes the store_order_id (Shopify order name) we sent
        reference_code:       o.reference_code || o.marketplace_invoice_num || null,
        marketplace_order_id: o.marketplace_order_id || null,
        store_order_id:       o.store_order_id || o.marketplace_invoice_num || null,
        order_status:         o.order_status || o.status || 'New',
        order_date:           orderDateIso,
        customer_name:        customerName,
        customer_email:       o.customer_email || o.email || null,
        // webhook uses contact_num instead of customer_phone
        customer_phone:       String(o.customer_phone || o.contact_num || o.phone || addr.phone || '').replace(/\D/g, '').slice(-10) || null,
        payment_mode:         o.payment_mode || o.payment_type || null,
        // webhook uses total_amount; polling uses order_total / total_price
        order_total:          parseFloat(o.order_total || o.total_price || o.total_amount || 0) || null,
        // webhook uses collectable_amount; polling uses cod_amount
        cod_amount:           parseFloat(o.cod_amount || o.collectable_amount || 0) || null,
        awb_number:           o.awb_number || o.awb || null,
        courier_name:         o.courier_name || o.courier || null,
        shipping_city:        o.city || addr.city || null,
        shipping_state:       o.state || addr.state || addr.province || null,
        shipping_pincode:     o.pin_code || addr.pincode || addr.zip || null,
        shipping_address:     shippingAddress,
        line_items:           lineItems,
        tags:                 o.tags || null,
        raw_data:             o,
        fetched_at:           new Date().toISOString(),
        updated_at:           new Date().toISOString()
    };
}

// ─── Normalize a `b2c_order_easycom` row → dashboard format ────────────────
function dbRowToDashboard(row) {
    // Status mapping — EasyEcom statuses: "New", "Printed", "Manifested",
    // "Ready to ship", "Shipped", "Delivered", "Cancelled", "Returned", "RTO"
    const rawStatus = String(row.order_status || 'New');
    const statusLc  = rawStatus.toLowerCase();
    let status = 'New';
    if      (statusLc.includes('cancel'))      status = 'Cancelled';
    else if (statusLc.includes('rto') || statusLc.includes('return')) status = 'RTO';
    else if (statusLc.includes('deliver'))     status = 'Delivered';
    else if (statusLc.includes('out for'))     status = 'Out For Delivery';
    else if (statusLc.includes('transit'))     status = 'In Transit';
    else if (statusLc.includes('shipped') || statusLc.includes('manifest')) status = 'Shipped';
    else if (statusLc.includes('ready'))       status = 'Ready To Ship';
    else if (statusLc.includes('print') || statusLc.includes('confirm') || statusLc.includes('process')) status = 'Processing';
    else if (statusLc.includes('new'))         status = 'New';

    const dateStr = row.order_date
        ? moment(row.order_date).tz('Asia/Kolkata').format('DD-MM-YYYY')
        : '';

    const addr = row.shipping_address || {};
    const paymentType = String(row.payment_mode || '').toLowerCase();
    const paymentMethod = paymentType.includes('cod') ? 'COD' : 'Prepaid';

    const displayId = row.reference_code || row.store_order_id || row.marketplace_order_id || `#${row.order_id}`;

    return {
        platform: 'EasyEcom',
        id: displayId,
        originalId: String(row.order_id),
        easyecomOrderId: String(row.order_id),
        date: dateStr,
        name: row.customer_name || 'N/A',
        total: parseFloat(row.order_total || row.cod_amount || 0),
        status,
        rawEasyecomStatus: rawStatus,
        items: row.line_items || [],
        address: `${addr.address_line_1 || addr.address1 || ''}, ${addr.city || row.shipping_city || ''}`.replace(/^, /, '') || 'No address',
        paymentMethod,
        awb: row.awb_number || null,
        courier: row.courier_name || null,
        isRapidShyp: false,
        tags: row.tags || '',
        shipping_address: addr,
        line_items: row.line_items || []
    };
}

// Extract an array of orders from whatever shape EasyEcom returns.
// Known V2 shape: { code: 200, data: { orders: [...] }, nextUrl: "..." }
function extractOrdersFromBody(body) {
    if (!body) return [];
    if (Array.isArray(body)) return body;
    if (Array.isArray(body.orders)) return body.orders;
    if (Array.isArray(body.data)) return body.data;
    if (body.data && typeof body.data === 'object') {
        if (Array.isArray(body.data.orders))       return body.data.orders;
        if (Array.isArray(body.data.order_list))   return body.data.order_list;
        if (Array.isArray(body.data.orderList))    return body.data.orderList;
        if (Array.isArray(body.data.result))       return body.data.result;
    }
    if (Array.isArray(body.result)) return body.result;
    return [];
}

// Fetch a single ≤7-day window from EasyEcom V2, paginated via nextUrl.
// Dates are encoded into the URL directly to avoid "Invalid URL" errors
// from Node 24's strict query-string parser on spaces.
async function fetchEasyecomWindow(firstUrl, headers, startDate, endDate) {
    const out = [];
    const seedUrl = `${firstUrl}?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;
    let reqUrl = seedUrl;
    let pageCount = 0;
    const MAX_PAGES = 20;

    do {
        console.log(`[EasyEcom GetOrders]   → GET ${reqUrl}`);
        let apiRes;
        try {
            apiRes = await axios.get(reqUrl, {
                headers,
                validateStatus: () => true
            });
        } catch (err) {
            console.error(`[EasyEcom GetOrders]   axios error for ${reqUrl}:`, err.message);
            throw err;
        }

        const body = apiRes.data || {};

        // EasyEcom sometimes returns 200 HTTP with an error in the body
        if (apiRes.status !== 200 || (body.code && body.code !== 200)) {
            const errMsg = body.message || body.error || '';

            // Token rejected server-side — force refresh and retry once
            if ((apiRes.status === 401 || errMsg.toLowerCase().includes('token is invalid') || errMsg.toLowerCase().includes('unauthorized')) && !headers._retried) {
                console.warn('[EasyEcom GetOrders] Token invalid — refreshing and retrying...');
                invalidateToken();
                const newJwt = await getEasyecomToken(true);
                headers['Authorization'] = `Bearer ${newJwt}`;
                headers._retried = true;
                continue; // retry this same page
            }

            console.error(`[EasyEcom GetOrders] ${moment().tz('Asia/Kolkata').format('DD-MM-YYYY hh:mm:ss A')} | ${startDate}→${endDate} error:`,
                JSON.stringify(body).slice(0, 500));
            break;
        }

        const pageOrders = extractOrdersFromBody(body);

        if (pageCount === 0) {
            console.log(`[EasyEcom GetOrders] Page 0 — ${pageOrders.length} orders. Top keys:`,
                Object.keys(body));
            if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
                console.log(`[EasyEcom GetOrders] data keys:`, Object.keys(body.data));
            }
            if (pageOrders.length === 0) {
                console.log(`[EasyEcom GetOrders] Full body:`, JSON.stringify(body).slice(0, 1000));
            }
        }

        out.push(...pageOrders);

        let nextUrl = body.nextUrl || body.next_url
               || (body.data && typeof body.data === 'object' && !Array.isArray(body.data)
                    && (body.data.nextUrl || body.data.next_url))
               || null;
        pageCount++;

        if (pageOrders.length === 0 || !nextUrl) break;

        // EasyEcom returns nextUrl as a relative path like `/orders/V2/...`
        // axios needs a fully-qualified URL, so resolve it against the base.
        if (typeof nextUrl === 'string' && nextUrl.startsWith('/')) {
            nextUrl = `${EASYECOM_API_BASE}${nextUrl}`;
        }
        reqUrl = nextUrl;
    } while (pageCount < MAX_PAGES);

    return out;
}

// ─── Core sync: Fetch EasyEcom orders → upsert into b2c_order_easycom ─────
// Called from server.js on startup + every 10 min, and from the HTTP route.
async function syncEasyecomOrders(days = 7) {
    const jwt  = await getEasyecomToken();
    const url  = `${EASYECOM_API_BASE}/orders/V2/getAllOrders`;
    const hdrs = {
        'x-api-key':     config.EASYECOM_API_KEY,
        'Authorization': `Bearer ${jwt}`,
        'Content-Type':  'application/json'
    };

    const startDate = moment().tz('Asia/Kolkata').subtract(days, 'days').startOf('day').format('YYYY-MM-DD HH:mm:ss');
    const endDate   = moment().tz('Asia/Kolkata').endOf('day').format('YYYY-MM-DD HH:mm:ss');

    console.log(`[EasyEcom Sync] ${startDate} → ${endDate}`);

    const allRaw = await fetchEasyecomWindow(url, hdrs, startDate, endDate);

    // Deduplicate by order_id
    const seen = new Set();
    const deduped = allRaw.filter(o => {
        const id = String(o.order_id || o.orderId || o.id || '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
    });

    console.log(`[EasyEcom Sync] Fetched ${deduped.length} unique orders`);

    // Upsert into b2c_order_easycom
    const rows = deduped.map(rawToDbRow).filter(Boolean);
    let savedCount = 0;
    if (rows.length > 0) {
        const BATCH = 500;
        for (let i = 0; i < rows.length; i += BATCH) {
            const chunk = rows.slice(i, i + BATCH);
            const { error } = await supabase
                .from('b2c_order_easycom')
                .upsert(chunk, { onConflict: 'order_id' });
            if (error) {
                console.error(`[EasyEcom Sync] Upsert error batch ${i}:`, error.message);
            } else {
                savedCount += chunk.length;
            }
        }
        console.log(`[EasyEcom Sync] Saved ${savedCount}/${rows.length} → b2c_order_easycom`);
    }

    await supabase.from('api_logs_ecom').insert({
        action: 'easyecom_sync',
        status_code: 200,
        payload: { days, start_date: startDate, end_date: endDate },
        response: { fetched: deduped.length, saved: savedCount }
    });

    return { fetched: deduped.length, saved: savedCount };
}

// ─── API ROUTE: Confirm a single EasyEcom order ────────────────────────────
// POST /api/easyecom/confirm-order
// Body: { orderId, height, width, length, weight }
router.post('/confirm-order', tokenRequired, async (req, res) => {
    const { orderId, height = 3, width = 3, length = 3, weight = 3 } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    let jwt;
    try {
        jwt = await getEasyecomToken();
    } catch (e) {
        return res.status(500).json({ error: `EasyEcom auth failed: ${e.message}` });
    }

    const url = `${EASYECOM_API_BASE}/orders/confirm_order`
        + `?order_id=${encodeURIComponent(orderId)}`
        + `&height=${encodeURIComponent(height)}`
        + `&width=${encodeURIComponent(width)}`
        + `&length=${encodeURIComponent(length)}`
        + `&weight=${encodeURIComponent(weight)}`;

    const headers = {
        'x-api-key':     config.EASYECOM_API_KEY,
        'Authorization': `Bearer ${jwt}`,
        'Content-Type':  'application/json'
    };

    console.log(`[EasyEcom Confirm] Confirming order ${orderId} (${length}x${width}x${height}, ${weight}kg)`);

    try {
        let apiRes = await axios.post(url, {}, { headers, validateStatus: () => true });

        // Auto-retry once after 6s if rate limited
        if (apiRes.status === 429) {
            console.warn(`[EasyEcom Confirm] Rate limited — waiting 6s then retrying...`);
            await new Promise(r => setTimeout(r, 6000));
            apiRes = await axios.post(url, {}, { headers, validateStatus: () => true });
        }

        const body = apiRes.data || {};

        console.log(`[EasyEcom Confirm] Response ${apiRes.status}:`, JSON.stringify(body).slice(0, 300));

        await supabase.from('api_logs_ecom').insert({
            action: 'easyecom_confirm_order',
            status_code: apiRes.status,
            payload: { order_id: orderId },
            response: body
        });

        if (apiRes.status === 429) {
            console.warn(`[EasyEcom Confirm] Still rate limited after retry for order ${orderId}`);
            return res.status(429).json({
                success: false,
                error: 'EasyEcom is rate limited. Please try again in a minute.',
                retryAfter: 60
            });
        }

        const isSuccess = apiRes.status === 200 && (
            body.status === true ||
            body.status === 'success' ||
            body.status === 'SUCCESS' ||
            body.success === true ||
            body.code === 200
        );

        if (isSuccess) {
            return res.json({
                success: true,
                message: `Order ${orderId} confirmed on EasyEcom`,
                orderId,
                easyecomResponse: body
            });
        }

        return res.status(apiRes.status || 400).json({
            success: false,
            error: body.message || body.error || 'EasyEcom rejected the confirmation',
            easyecomResponse: body
        });

    } catch (e) {
        console.error('[EasyEcom Confirm] Error:', e.message);
        await supabase.from('api_logs_ecom').insert({
            action: 'easyecom_confirm_order_error',
            status_code: 500,
            payload: { order_id: orderId },
            response: { error: e.message }
        });
        return res.status(500).json({ error: e.message });
    }
});

// Fetch a SINGLE order live from EasyEcom by its EasyEcom order_id (1 API call).
// Returns the raw order object (with current order_status) or null.
async function fetchEasyecomOrderById(easyecomOrderId) {
    if (!easyecomOrderId) return null;
    const jwt = await getEasyecomToken();
    const url = `${EASYECOM_API_BASE}/orders/V2/getAllOrders?order_id=${encodeURIComponent(easyecomOrderId)}`;
    const headers = { 'x-api-key': config.EASYECOM_API_KEY, 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' };
    const res = await axios.get(url, { headers, timeout: 15000, validateStatus: () => true });
    if (res.status !== 200) return null;
    const orders = extractOrdersFromBody(res.data);
    return orders[0] || null;
}

// ── Hold / Unhold an order in EasyEcom ──────────────────────────────────────
// EasyEcom's hold API is keyed by INVOICE id (not order id): PUT /orders/holdOrders
// { invoice_id, hold_reason } and PUT /orders/unholdOrders { invoice_id } — from their official
// Postman collection ("V2 > Order > Hold order"). Constraint (per their KB): an order can only be
// held BEFORE the manifest is generated; EasyEcom rejects it afterwards and we surface that message.
async function resolveInvoiceId(orderName) {
    const clean = String(orderName || '').replace('#', '').trim();
    if (!clean) return null;
    const { data } = await supabase.from('b2c_order_easycom')
        .select('order_id, raw_data').or(`reference_code.eq.${clean},order_id.eq.${/^\d+$/.test(clean) ? clean : 0}`)
        .limit(1).maybeSingle();
    return data && data.raw_data && data.raw_data.invoice_id ? { invoiceId: data.raw_data.invoice_id, eeOrderId: data.order_id } : null;
}
async function eeHoldCall(path, body) {
    const jwt = await getEasyecomToken();
    const headers = { 'x-api-key': config.EASYECOM_API_KEY, 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' };
    let r = await axios.put(`${EASYECOM_API_BASE}${path}`, body, { headers, timeout: 20000, validateStatus: () => true });
    if (r.status === 429) { await new Promise(x => setTimeout(x, 6000)); r = await axios.put(`${EASYECOM_API_BASE}${path}`, body, { headers, timeout: 20000, validateStatus: () => true }); }
    return r;
}
router.post('/hold-order', tokenRequired, async (req, res) => {
    try {
        const { orderName, reason } = req.body || {};
        if (!orderName) return res.status(400).json({ success: false, message: 'orderName is required.' });
        if (!reason || !String(reason).trim()) return res.status(400).json({ success: false, message: 'A hold reason is required.' });
        const inv = await resolveInvoiceId(orderName);
        if (!inv) return res.status(404).json({ success: false, message: 'Order not found in EasyEcom (no invoice id in the synced data yet).' });
        const r = await eeHoldCall('/orders/holdOrders', { invoice_id: inv.invoiceId, hold_reason: String(reason).trim().slice(0, 200) });
        const body = r.data || {};
        await supabase.from('api_logs_ecom').insert({ action: 'easyecom_hold_order', status_code: r.status, payload: { orderName, invoice_id: inv.invoiceId, reason }, response: body }).then(() => {}).catch(() => {});
        const ok = (r.status === 200 && (body.code === 200 || body.status === true || body.success === true || /success/i.test(String(body.message || ''))))
            || /already.{0,25}(on ?hold|hold status)/i.test(String(body.message || ''));   // held inside EasyEcom already → same end state
        if (ok) {
            // Live hold-state mark → the dashboard shows "On Hold" + Unhold instantly (EasyEcom's own
            // status only reflects after their next sync). api_logs_ecom above is the permanent history.
            const mark = { order_name: String(orderName).replace('#', '').trim(), mark_type: 'ee_hold', note: String(reason).trim().slice(0, 200), created_by: req.user && req.user.sub, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            await supabase.from('order_marks_ecom').upsert(mark, { onConflict: 'order_name,mark_type' }).then(() => {}).catch(() => {});
            return res.json({ success: true, message: `Order ${orderName} put on hold in EasyEcom.`, hold: { reason: mark.note, by: mark.created_by, at: mark.created_at } });
        }
        return res.status(502).json({ success: false, message: body.message || `EasyEcom rejected the hold (HTTP ${r.status}).` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
// ── Change an order's fulfillment warehouse (route it) ──────────────────────────────
// Panel-internal endpoint (found by capturing app.easyecom.io/Orders/UpdateVendor): POST
// /Orders/UpdateVendor { invoice_id, vendor_c_id (target warehouse), c_id (logged-in company) }.
// KEY CONSTRAINT: EasyEcom only lets you route an order while the API session is logged into the
// order's CURRENT owning location ("...can only be routed from that company. Please login to (X)
// location and try routing again."). So we mint a token scoped to the SOURCE warehouse's location
// key, then call UpdateVendor. Primary use: re-route DocPharma-rejected orders to Shifupro so we
// can fulfil them ourselves.
//
// Warehouse registry — c_id → { name, locationKey } (location keys live in .env). Only warehouses
// with a location key can be routed FROM (we must be able to log into them); any can be a target.
const EE_WAREHOUSES = [
    { cId: 257282, name: 'Shifupro Technologies Pvt. Ltd.', keyEnv: 'EASYECOM_WH_KEY' },
    { cId: 271096, name: 'DP Bangalore', keyEnv: 'EASYECOM_WH2_KEY' },
    { cId: 288922, name: 'Amazon_FBA_DEL5', keyEnv: null },
    { cId: 288927, name: 'Amazon_FBA_DEL4', keyEnv: null },
];
const eeLocationKeyFor = cId => { const w = EE_WAREHOUSES.find(w => String(w.cId) === String(cId)); return w && w.keyEnv ? config[w.keyEnv] : null; };
const eeWarehouseName = cId => { const w = EE_WAREHOUSES.find(w => String(w.cId) === String(cId)); return w ? w.name : String(cId); };
const eeDecode = t => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64').toString()); } catch (_) { return {}; } };

// Mint a FRESH token scoped to a specific location key (login as that warehouse). Not cached in the
// main _tokenCache — this is a short-lived, purpose-scoped session for one routing call.
async function mintTokenForLocation(locationKey) {
    if (!config.EASYECOM_EMAIL || !config.EASYECOM_PASSWORD) throw new Error('EASYECOM_EMAIL/PASSWORD required to mint a location token.');
    const res = await axios.post(TOKEN_ENDPOINT, { email: config.EASYECOM_EMAIL, password: config.EASYECOM_PASSWORD, location_key: locationKey },
        { headers: { 'x-api-key': config.EASYECOM_API_KEY, 'Content-Type': 'application/json' }, validateStatus: () => true, timeout: 20000 });
    if (res.status !== 200) throw new Error(`Location login failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
    const body = res.data || {};
    const token = (body.data && body.data.token && body.data.token.jwt_token) || (body.data && body.data.token) || body.token || body.jwt;
    if (!token || typeof token !== 'string') throw new Error('No token in location-login response.');
    return token;
}

// Resolve an order's invoice_id AND current warehouse c_id from the synced EasyEcom row.
async function resolveInvoiceAndWarehouse(orderName) {
    const clean = String(orderName || '').replace('#', '').trim();
    if (!clean) return null;
    const { data } = await supabase.from('b2c_order_easycom')
        .select('order_id, raw_data').or(`reference_code.eq.${clean},order_id.eq.${/^\d+$/.test(clean) ? clean : 0}`)
        .limit(1).maybeSingle();
    if (!data || !data.raw_data) return null;
    const rd = data.raw_data;
    return { invoiceId: rd.invoice_id || null, currentCid: rd.warehouse_id || rd.warehouseId || null, eeOrderId: data.order_id };
}

// Our company c_id (the panel session's company) — used as the UpdateVendor `c_id` param.
async function ourCompanyCid() { try { return eeDecode(await getEasyecomToken()).company_id || 257282; } catch (_) { return 257282; } }

// Record a successful warehouse route as a mark (same pattern as ee_hold) so the Orders dashboard can
// show "Moved: <from> → <to>" and disable the Move button. note = "<from> → <to>".
async function markWarehouseRouted(orderName, fromCid, toCid, by) {
    await supabase.from('order_marks_ecom').upsert({
        order_name: String(orderName).replace('#', '').trim(), mark_type: 'warehouse_routed',
        note: `${eeWarehouseName(fromCid)} → ${eeWarehouseName(toCid)}`, awb: null,
        created_by: by || null, created_at: new Date().toISOString(),
    }, { onConflict: 'order_name,mark_type' }).then(() => {}).catch(() => {});
}

// Shared UpdateVendor caller (cookie replay). Returns { status, raw, data, ok, expired }.
// SUCCESS = literal "0"; business error = {"code":400,"message":...}; expired = 302/HTML/Unauthenticated.
async function callUpdateVendor(cookie, invoiceId, vendorCid, cId, eeOrderId) {
    const body = `invoice_id=${encodeURIComponent(invoiceId)}&vendor_c_id=${encodeURIComponent(vendorCid)}&c_id=${encodeURIComponent(cId)}`;
    const r = await axios.post(`${APP_BASE}/Orders/UpdateVendor`, body, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36',
            'Origin': APP_BASE, 'Referer': `${APP_BASE}/V2/Orders/Details/${eeOrderId || ''}`, 'Cookie': cookie,
        }, timeout: 25000, maxRedirects: 0, validateStatus: () => true,
    });
    const raw = typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data);
    const data = (typeof r.data === 'object') ? r.data : (() => { try { return JSON.parse(raw); } catch (_) { return {}; } })();
    const expired = r.status === 302 || r.status === 401 || /unauthenticated|<!doctype|<html|sign ?in|please log ?in/i.test(raw);
    const ok = r.status === 200 && !expired && (raw.trim() === '0' || data.code === 200 || data.status === true || data.success === true) && data.code !== 400;
    return { status: r.status, raw, data, ok, expired };
}

// GET /api/easyecom/warehouses — the warehouse list.
router.get('/warehouses', tokenRequired, (req, res) => {
    res.json({ success: true, warehouses: EE_WAREHOUSES.map(w => ({ cId: w.cId, name: w.name })) });
});

// ── EasyEcom panel-session cookie (admin) ────────────────────────────────────────────
// Warehouse routing (/Orders/UpdateVendor) is a legacy PHP feature that ONLY accepts the
// interactive panel session — the API JWT is refused with "please login to <location>". So the
// admin pastes their EasyEcom browser session cookie (laravel_session + PHPSESSID from DevTools);
// we store it AES-GCM encrypted and replay it for the routing call. It expires with the browser
// session (~a few hours/days), after which the admin re-pastes it. c_id is our company from the JWT.
async function getPanelCookie() {
    const { data } = await supabase.from('easyecom_panel_session').select('cookie_enc, updated_at, updated_by').eq('id', 1).maybeSingle();
    return data ? { cookie: decrypt(data.cookie_enc), updatedAt: data.updated_at, updatedBy: data.updated_by } : null;
}
router.get('/session', tokenRequired, requireAdmin, async (req, res) => {
    const s = await getPanelCookie();
    res.json({ success: true, hasSession: !!(s && s.cookie), updatedAt: s && s.updatedAt, updatedBy: s && s.updatedBy });
});
router.post('/session', tokenRequired, requireAdmin, async (req, res) => {
    try {
        let cookie = String((req.body || {}).cookie || '').trim();
        if (!cookie) return res.status(400).json({ success: false, message: 'Paste your EasyEcom session cookie.' });
        // Accept either a full document.cookie string or a copied Cookie header; must contain the session cookie.
        if (!/laravel_session=/.test(cookie)) return res.status(400).json({ success: false, message: 'That doesn\'t look like an EasyEcom session — it must include laravel_session=…' });
        const { error } = await supabase.from('easyecom_panel_session').upsert({ id: 1, cookie_enc: encrypt(cookie), updated_by: req.user && req.user.sub, updated_at: new Date().toISOString() }, { onConflict: 'id' });
        if (error) throw new Error(error.message);
        res.json({ success: true, message: 'EasyEcom session saved.' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/easyecom/change-warehouse  { orderName, targetCid } — via the stored panel session cookie.
router.post('/change-warehouse', tokenRequired, async (req, res) => {
    try {
        const { orderName, targetCid } = req.body || {};
        if (!orderName || !targetCid) return res.status(400).json({ success: false, message: 'orderName and a target warehouse are required.' });
        if (!EE_WAREHOUSES.some(w => String(w.cId) === String(targetCid))) return res.status(400).json({ success: false, message: 'Unknown target warehouse.' });
        const sess = await getPanelCookie();
        if (!sess || !sess.cookie) return res.status(400).json({ success: false, message: 'No EasyEcom session saved yet. Click "Update EasyEcom session" and paste your panel cookie first.', needSession: true });
        const info = await resolveInvoiceAndWarehouse(orderName);
        if (!info || !info.invoiceId) return res.status(404).json({ success: false, message: 'Order not found in EasyEcom (no invoice id synced yet).' });
        const cId = await ourCompanyCid();
        const out = await callUpdateVendor(sess.cookie, info.invoiceId, targetCid, cId, info.eeOrderId);
        await supabase.from('api_logs_ecom').insert({ action: 'easyecom_change_warehouse', status_code: out.status, payload: { orderName, invoice_id: info.invoiceId, to: targetCid, c_id: cId }, response: (out.data && Object.keys(out.data).length) ? out.data : out.raw.slice(0, 300) }).then(() => {}).catch(() => {});
        if (out.expired) return res.status(401).json({ success: false, needSession: true, message: 'Your saved EasyEcom session has expired. Click "Update session" and paste a fresh cookie from the panel.' });
        if (out.ok) { await markWarehouseRouted(orderName, info.currentCid, targetCid, req.user && req.user.sub); return res.json({ success: true, message: `Order ${orderName} routed to ${eeWarehouseName(targetCid)}.`, to: eeWarehouseName(targetCid), response: out.data }); }
        return res.status(422).json({ success: false, message: String(out.data.message || '') || `EasyEcom rejected the warehouse change (code ${out.data.code || out.status}).`, response: out.data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/easyecom/session/check — live validity ping (non-destructive: invoice_id=0).
router.get('/session/check', tokenRequired, async (req, res) => {
    try {
        const sess = await getPanelCookie();
        if (!sess || !sess.cookie) return res.json({ success: true, hasSession: false, valid: false });
        const out = await callUpdateVendor(sess.cookie, 0, 257282, await ourCompanyCid(), 0);
        // Authenticated (session alive) → we reach business validation ("Invalid Company ID"), NOT an auth wall.
        res.json({ success: true, hasSession: true, valid: !out.expired, updatedAt: sess.updatedAt });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Keep the panel session warm — a light authenticated ping extends the rolling session so the cookie
// rarely needs re-pasting. Returns 'alive' | 'expired' | 'none'. Called by a cron.
async function pingPanelSession() {
    const sess = await getPanelCookie();
    if (!sess || !sess.cookie) return 'none';
    try {
        const out = await callUpdateVendor(sess.cookie, 0, 257282, await ourCompanyCid(), 0);
        if (out.expired) { console.warn('[EE Session] panel session EXPIRED — admin must re-paste the cookie.'); return 'expired'; }
        return 'alive';
    } catch (e) { console.warn('[EE Session] keep-alive ping failed:', e.message); return 'error'; }
}

// Auto-route DocPharma-rejected orders to Shifupro (MWH). For each order name: resolve invoice + current
// warehouse; skip if already on Shifupro or has an AWB (EasyEcom blocks routing once a shipment exists);
// otherwise cookie-route to Shifupro. Returns [{ order, result }] for logging/reporting.
const SHIFUPRO_CID = 257282;
async function autoRouteRejectedToShifupro(orderNames) {
    const results = [];
    const sess = await getPanelCookie();
    if (!sess || !sess.cookie) { console.warn('[EE AutoRoute] no panel session saved — cannot auto-route.'); return orderNames.map(o => ({ order: o, result: 'no-session' })); }
    const cId = await ourCompanyCid();
    for (const name of orderNames) {
        try {
            const info = await resolveInvoiceAndWarehouse(name);
            if (!info || !info.invoiceId) { results.push({ order: name, result: 'not-synced' }); continue; }
            if (String(info.currentCid) === String(SHIFUPRO_CID)) { results.push({ order: name, result: 'already-shifupro' }); continue; }
            const out = await callUpdateVendor(sess.cookie, info.invoiceId, SHIFUPRO_CID, cId, info.eeOrderId);
            await supabase.from('api_logs_ecom').insert({ action: 'easyecom_autoroute_warehouse', status_code: out.status, payload: { order: name, invoice_id: info.invoiceId, to: SHIFUPRO_CID }, response: (out.data && Object.keys(out.data).length) ? out.data : out.raw.slice(0, 200) }).then(() => {}).catch(() => {});
            if (out.expired) { results.push({ order: name, result: 'session-expired' }); }
            else if (out.ok) { await markWarehouseRouted(name, info.currentCid, SHIFUPRO_CID, 'auto-route'); results.push({ order: name, result: 'routed' }); }
            else { results.push({ order: name, result: (out.data.message || 'rejected').slice(0, 80) }); }   // e.g. "shipment already assigned"
        } catch (e) { results.push({ order: name, result: 'error:' + e.message.slice(0, 60) }); }
        await new Promise(r => setTimeout(r, 1500));   // deliberately slow — one order at a time, never bursts
    }
    const routed = results.filter(r => r.result === 'routed').length;
    if (routed) console.log(`[EE AutoRoute] routed ${routed}/${orderNames.length} rejected order(s) → Shifupro`);
    return results;
}

router.post('/unhold-order', tokenRequired, async (req, res) => {
    try {
        const { orderName } = req.body || {};
        if (!orderName) return res.status(400).json({ success: false, message: 'orderName is required.' });
        const inv = await resolveInvoiceId(orderName);
        if (!inv) return res.status(404).json({ success: false, message: 'Order not found in EasyEcom (no invoice id in the synced data yet).' });
        const r = await eeHoldCall('/orders/unholdOrders', { invoice_id: inv.invoiceId });
        const body = r.data || {};
        await supabase.from('api_logs_ecom').insert({ action: 'easyecom_unhold_order', status_code: r.status, payload: { orderName, invoice_id: inv.invoiceId }, response: body }).then(() => {}).catch(() => {});
        const ok = r.status === 200 && (body.code === 200 || body.status === true || body.success === true || /success/i.test(String(body.message || '')));
        // "Already in Unhold status" (released directly inside EasyEcom) → the desired end state is
        // already true, so treat it as success and clear our stale mark instead of erroring.
        const alreadyUnheld = /already.{0,25}unhold|not.{0,15}on ?hold/i.test(String(body.message || ''));
        if (ok || alreadyUnheld) {
            // Clear the live hold-state mark (the unhold event itself is preserved in api_logs_ecom).
            await supabase.from('order_marks_ecom').delete().eq('order_name', String(orderName).replace('#', '').trim()).eq('mark_type', 'ee_hold').then(() => {}).catch(() => {});
            return res.json({ success: true, message: alreadyUnheld ? `Order ${orderName} was already released in EasyEcom — dashboard updated.` : `Order ${orderName} released from hold — it returns to its previous status.` });
        }
        return res.status(502).json({ success: false, message: body.message || `EasyEcom rejected the unhold (HTTP ${r.status}).` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
module.exports.getEasyecomToken = getEasyecomToken;
module.exports.syncEasyecomOrders = syncEasyecomOrders;
module.exports.dbRowToDashboard = dbRowToDashboard;
module.exports.rawToDbRow = rawToDbRow;
module.exports.fetchEasyecomOrderById = fetchEasyecomOrderById;
module.exports.autoRouteRejectedToShifupro = autoRouteRejectedToShifupro;
module.exports.pingPanelSession = pingPanelSession;