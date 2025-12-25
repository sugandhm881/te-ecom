const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs-extra');
const moment = require('moment-timezone');
const config = require('../../config');

// --- Global Cache ---
let lwaTokenCache = { token: null, expiresAt: 0 };
const TZ_INDIA = 'Asia/Kolkata';

// --- Axios Instances ---
const rapidshypSession = axios.create({ timeout: 10000 });

// --- UTILS ---
function log(message) {
    const timestamp = moment().tz(TZ_INDIA).format("[YYYY-MM-DD HH:mm:ss]");
    console.log(`${timestamp} ${message}`);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- DOCPHARMA FUNCTIONS ---
async function fetchDocpharmaDetails(partnerOrderNo) {
    const url = "https://partner-api.docpharma.in/fetch-details";
    if (!config.DOCPHARMA_API_KEY || !partnerOrderNo) return null;

    const cleanId = String(partnerOrderNo).replace('#', '');

    try {
        const response = await axios.post(url, { partner_order_no: cleanId }, {
            headers: { 'x-api-key': config.DOCPHARMA_API_KEY, 'Content-Type': 'application/json' },
            timeout: 3000
        });
        if (response.status === 200) return response.data;
    } catch (e) {
        console.error(`[DocPharma] Error fetching ${cleanId}: ${e.message}`);
    }
    return null;
}

function extractDocpharmaStatusString(docData) {
    if (!docData) return null;
    try {
        const suborders = docData.suborders || [];
        if (suborders.length > 0) {
            const logisticDetails = suborders[0].logistic_details || {};
            if (logisticDetails.current_status) return String(logisticDetails.current_status).toUpperCase();
            if (suborders[0].status) return String(suborders[0].status).toUpperCase();
        }
    } catch (e) {}
    
    if (docData.status) return String(docData.status).toUpperCase();
    return null;
}

// --- AMAZON SP-API SIGNING ---
async function getLwaAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (lwaTokenCache.token && lwaTokenCache.expiresAt > now) return lwaTokenCache.token;

    try {
        const response = await axios.post('https://api.amazon.com/auth/o2/token', {
            grant_type: 'refresh_token',
            refresh_token: config.REFRESH_TOKEN,
            client_id: config.LWA_CLIENT_ID,
            client_secret: config.LWA_CLIENT_SECRET
        });
        lwaTokenCache.token = response.data.access_token;
        lwaTokenCache.expiresAt = now + (response.data.expires_in || 3600) - 300;
        return lwaTokenCache.token;
    } catch (e) {
        console.error("LWA token error:", e.response ? e.response.data : e.message);
        throw new Error("Failed to retrieve LWA access token.");
    }
}

function signRequest(config, options, accessToken) {
    const method = options.method;
    const pathUrl = options.path;
    const queryParams = options.queryParams || {};
    
    // Dates
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, ''); // YYYYMMDDTHHmmSSZ
    const dateStamp = amzDate.substr(0, 8); // YYYYMMDD

    // Canonical Headers
    const host = config.BASE_URL.replace('https://', '');
    const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-access-token;x-amz-date';

    // Canonical Query String (Sorted)
    const sortedKeys = Object.keys(queryParams).sort();
    const canonicalQuerystring = sortedKeys.map(key => 
        `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`
    ).join('&');

    // Canonical Request
    const payloadHash = crypto.createHash('sha256').update('').digest('hex');
    const canonicalRequest = `${method}\n${pathUrl}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    // String to Sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${config.AWS_REGION}/execute-api/aws4_request`;
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

    // Signing Key Calculation
    const kSecret = 'AWS4' + config.AWS_SECRET_KEY;
    const kDate = crypto.createHmac('sha256', kSecret).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(config.AWS_REGION).digest();
    const kService = crypto.createHmac('sha256', kRegion).update('execute-api').digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();

    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
        'x-amz-access-token': accessToken,
        'x-amz-date': amzDate,
        'Authorization': `${algorithm} Credential=${config.AWS_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    };
}

async function makeSignedApiRequest(options, maxRetries = 5) {
    const accessToken = await getLwaAccessToken();
    const headers = signRequest(config, options, accessToken);
    const url = `${config.BASE_URL}${options.path}`;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await axios({
                method: options.method,
                url: url,
                headers: headers,
                params: options.queryParams
            });
            return response.data;
        } catch (e) {
            if (e.response && e.response.status === 429) {
                const delay = (Math.pow(2, attempt) + Math.random()) * 1000;
                console.log(`[RATE LIMIT] Amazon API busy. Retrying in ${(delay/1000).toFixed(2)}s...`);
                await sleep(delay);
                continue;
            }
            console.error(`Amazon SP-API request failed attempt ${attempt + 1}: ${e.message}`);
            if (attempt >= maxRetries - 1) throw e;
            await sleep((Math.pow(2, attempt) + Math.random()) * 1000);
        }
    }
}

// --- CACHING UTILS ---
function loadCache(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return fs.readJsonSync(filePath);
        }
    } catch (e) { }
    return {};
}

function saveCache(filePath, data) {
    try {
        fs.outputJsonSync(filePath, data, { spaces: 2 });
    } catch (e) { console.error("Error saving cache:", e); }
}

// --- SHOPIFY FUNCTIONS ---
async function getAllShopifyOrdersPaginated(params) {
    let allOrders = [];
    let url = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2024-07/orders.json`;
    let pageNum = 1;

    while (url) {
        try {
            const res = await axios.get(url, {
                headers: { 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN },
                params: params
            });
            
            const orders = res.data.orders || [];
            allOrders = allOrders.concat(orders);
            console.log(`[Shopify] Fetched page ${pageNum} (${orders.length} orders)...`);

            const linkHeader = res.headers['link'];
            url = null;
            if (linkHeader) {
                const matches = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                if (matches) {
                    url = matches[1];
                    params = {}; 
                    pageNum++;
                }
            }
        } catch (e) {
            console.error(`Shopify API Error page ${pageNum}: ${e.message}`);
            break;
        }
    }
    console.log(`[Shopify] Total fetched: ${allOrders.length}`);
    return allOrders;
}

// --- RAPIDSHYP FUNCTIONS ---
async function getRawRapidshypStatus(awb, cache) {
    const now = Date.now() / 1000;
    if (cache[awb]) {
        const entry = cache[awb];
        const cachedStatus = (entry.raw_status || entry.status || '').toUpperCase();
        const lastChecked = entry.timestamp || 0;
        
        if (['DELIVERED', 'RTO', 'RTO_DELIVERED'].some(s => cachedStatus.includes(s)) || (now - lastChecked) < 3600) {
            return entry.raw_status;
        }
    }

    const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/track_order";
    const headers = { "rapidshyp-token": config.RAPIDSHYP_API_KEY, "Content-Type": "application/json" };

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await rapidshypSession.post(url, { awb }, { headers });
            const data = res.data;
            
            if (data.success && data.records) {
                const shipment = data.records[0].shipment_details ? data.records[0].shipment_details[0] : {};
                const rawStatus = shipment.shipment_status || shipment.current_tracking_status_desc || shipment.current_tracking_status || 'Status Not Available';
                
                cache[awb] = { raw_status: rawStatus, timestamp: now };
                return rawStatus;
            }
        } catch (e) {
            if (e.response && e.response.status === 400) return null; 
            if (attempt >= 2) break;
            await sleep(1000 * (attempt + 1));
        }
    }
    return "API Error or Timeout";
}

async function getRapidshypTimeline(awb) {
    const url = "https://api.rapidshyp.com/rapidshyp/apis/v1/track_order";
    const headers = { "rapidshyp-token": config.RAPIDSHYP_API_KEY, "Content-Type": "application/json" };
    
    try {
        const res = await rapidshypSession.post(url, { awb }, { headers });
        if (res.data.success && res.data.records) {
            const shipment = res.data.records[0].shipment_details ? res.data.records[0].shipment_details[0] : {};
            const history = shipment.tracking_history || [];
            return history.map(ev => ({
                status: ev.status_desc || ev.status || '',
                timestamp: ev.date || ev.timestamp || ev.event_time || '',
                location: ev.location || ev.city || ''
            }));
        }
    } catch (e) { }
    return [];
}

// --- MISSING FUNCTIONS ADDED BELOW ---

// 1. Get Facebook Ads
async function getFacebookAds(since, until) {
    const url = `https://graph.facebook.com/v18.0/act_${config.FACEBOOK_AD_ACCOUNT_ID}/insights`;
    const params = {
        'level': 'ad',
        'fields': 'ad_id,ad_name,adset_id,adset_name,spend,campaign_name',
        'time_range': JSON.stringify({ since, until }),
        'limit': 1000,
        'access_token': config.FACEBOOK_ACCESS_TOKEN
    };
    try {
        const r = await axios.get(url, { params });
        const data = r.data.data || [];
        return data.map(ad => ({ ...ad, spend: parseFloat(ad.spend || 0) }));
    } catch (e) {
        console.error(`FB Adset API Error: ${e.message}`);
        return [];
    }
}

// 2. Attribution Logic
function getOrderSourceTerm(order) {
    const noteAttrs = {};
    (order.note_attributes || []).forEach(attr => noteAttrs[attr.name] = attr.value);
    
    if (noteAttrs.utm_content && !isNaN(noteAttrs.utm_content)) return ['facebook_ad', noteAttrs.utm_content];
    
    const utmTerm = noteAttrs.utm_term;
    const utmSource = noteAttrs.utm_source;

    if (utmTerm) return [utmSource || 'unknown_utm', utmTerm];
    if (utmSource) return [utmSource, utmSource];

    const sourceName = order.source_name;
    if (sourceName && !['shopify_draft_order', 'pos', 'other'].includes(sourceName)) return [sourceName, sourceName];

    const refSite = order.referring_site;
    if (refSite) {
        try {
            const domain = new URL(refSite).hostname.replace('www.', '');
            if (domain.includes('google')) return ['google', 'organic'];
            if (domain.includes('facebook')) return ['facebook.com', 'referral'];
            if (domain.includes('instagram')) return ['instagram.com', 'referral'];
            return [domain, 'referral'];
        } catch (e) { return ['other_link', 'referral']; }
    }
    return ['direct', 'direct'];
}

// 3. Status Normalization (Required for Reports)
function normalizeStatus(order, rawStatus, docpharmaData = null) {
    const statusUpper = (rawStatus || '').toUpperCase();

    // 1. Check DocPharma (Highest Priority)
    if (docpharmaData) {
        const ds = extractDocpharmaStatusString(docpharmaData);
        if (ds) {
            const dsu = ds.toUpperCase();
            if (dsu.includes('RTO_DELIVERED') || (dsu.includes('RTO') && dsu.includes('DELIVERED'))) return 'RTO';
            if (dsu.includes('DELIVERED')) return 'Delivered';
            if (dsu.includes('RTO')) return 'RTO';
            if (dsu.includes('CANCEL')) return 'Cancelled';
            if (['TRANSIT', 'SHIPPED', 'DISPATCHED'].some(s => dsu.includes(s))) return 'In-Transit';
            if (['PROCESSING', 'BOOKED'].some(s => dsu.includes(s))) return 'Processing';
        }
    }

    if (order.cancelled_at) return 'Cancelled';

    // 2. Check Fresh API "DELIVERED"
    if (statusUpper.includes('DELIVERED') && !statusUpper.includes('RTO') && !statusUpper.includes('UNDELIVERED')) return 'Delivered';

    // 3. Check Webhook Status
    const webhookStatus = (order.rapidshyp_webhook_status || '').toUpperCase();
    if (webhookStatus) {
        if (webhookStatus.includes('RTO_DELIVERED') || webhookStatus.includes('RTO')) return 'RTO';
        if (webhookStatus.includes('DELIVERED')) return 'Delivered';
        if (webhookStatus.includes('TRANSIT') || webhookStatus.includes('OFD') || webhookStatus.includes('SHIPPED')) return 'In-Transit';
        if (webhookStatus.includes('CANCELLED')) return 'Cancelled';
    }

    // 4. Fallback Logic
    if (!rawStatus || ['API ERROR OR TIMEOUT', 'STATUS NOT AVAILABLE'].includes(statusUpper)) {
        if (order.fulfillment_status === 'fulfilled') return 'Delivered';
        if (order.fulfillments && order.fulfillments.length > 0) return 'Processing';
        return 'Unfulfilled';
    }
    
    if (statusUpper.includes('UNDELIVERED') || statusUpper.includes('RTO') || statusUpper.includes('RETURN')) return 'RTO';
    if (['IN_TRANSIT', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELAYED', 'REACHED'].some(s => statusUpper.includes(s))) return 'In-Transit';
    if (['LOST', 'MISROUTED', 'EXCEPTION'].some(s => statusUpper.includes(s))) return 'Exception';
    if (['NA', 'CANCELLED'].some(s => statusUpper.includes(s))) return 'Cancelled';
    
    return 'Processing';
}

function inferShippedDatetime(order) {
    const events = order.rapidshyp_events || [];
    const dates = [];
    events.forEach(ev => {
        const status = (ev.status || '').toUpperCase();
        if (['PICKUP COMPLETED', 'DISPATCHED', 'SHIPPED'].some(k => status.includes(k))) {
            dates.push(new Date(ev.timestamp));
        }
    });
    if (dates.length > 0) return new Date(Math.min(...dates));
    
    if (order.fulfillments && order.fulfillments.length > 0) {
        return new Date(order.fulfillments[0].created_at);
    }
    return null;
}

function inferDeliveredDatetime(order) {
    if (order.delivered_at) return new Date(order.delivered_at);
    return null;
}

module.exports = {
    log,
    sleep,
    makeSignedApiRequest,
    getAllShopifyOrdersPaginated,
    getRawRapidshypStatus,
    getRapidshypTimeline,
    fetchDocpharmaDetails,
    extractDocpharmaStatusString,
    loadCache,
    saveCache,
    getFacebookAds,       // New
    getOrderSourceTerm,   // New
    normalizeStatus,      // New
    inferShippedDatetime,
    inferDeliveredDatetime
};