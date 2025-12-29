const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const axios = require('axios');
const moment = require('moment-timezone');
const config = require('../../config');
const helpers = require('./helpers');
const { tokenRequired } = require('../auth');

const UNATTRIBUTED_ID = 'unattributed';

function loadMasterOrdersUtf8Safe(path) {
    try {
        return fs.readJsonSync(path);
    } catch (e) {
        console.warn(`[WARN] JSON load failed for ${path}: ${e.message}`);
        return [];
    }
}

function createEmptyBucket(bucketId, name, spend = 0) {
    return {
        id: bucketId,
        name: name,
        spend: spend,
        totalOrders: 0,
        revenue: 0,
        deliveredOrders: 0,
        deliveredRevenue: 0,
        rtoOrders: 0,
        cancelledOrders: 0,
        inTransitOrders: 0,
        processingOrders: 0,
        exceptionOrders: 0,
        terms: {}
    };
}

function processOrderIntoBucket(order, bucket, status, adsetId = null, adsetRevenueAcc = null) {
    bucket.totalOrders += 1;
    const orderRevenue = parseFloat(order.total_price || 0);

    if (status !== 'Cancelled' && status !== 'RTO') {
        bucket.revenue += orderRevenue;
    }

    if (status === 'Delivered') {
        bucket.deliveredOrders += 1;
        bucket.deliveredRevenue = (bucket.deliveredRevenue || 0) + orderRevenue;
        if (adsetId && adsetRevenueAcc) {
            adsetRevenueAcc[adsetId] = (adsetRevenueAcc[adsetId] || 0) + orderRevenue;
        }
    } else if (status === 'RTO') bucket.rtoOrders++;
    else if (status === 'Cancelled') bucket.cancelledOrders++;
    else if (status === 'In-Transit') bucket.inTransitOrders++;
    else if (status === 'Processing') bucket.processingOrders++;
    else if (status === 'Exception') bucket.exceptionOrders++;
}

async function getFacebookAds(since, until) {
    // Ported from helpers.py
    const url = `https://graph.facebook.com/v18.0/act_${config.FACEBOOK_AD_ACCOUNT_ID}/insights`;
    const params = {
        'level': 'ad',
        'fields': 'ad_id,ad_name,adset_id,adset_name,spend,clicks,campaign_name',
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

// Ported get_order_source_term logic from helpers
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

// CORE FUNCTION exported for Router and Cron Job
async function getAdsetPerformanceData(since, until, dateFilterType = 'created_at') {
    const startDate = moment(since);
    const endDate = moment(until);

    if (!fs.existsSync(config.MASTER_DATA_FILE)) {
        throw new Error("Master data file not found.");
    }

    const allOrders = loadMasterOrdersUtf8Safe(config.MASTER_DATA_FILE);
    const shopifyOrdersInRange = [];
    
    // Using pick_date_for_filter ported logic in helpers (assumed existing in helpers.js or defined here)
    // If not in helpers, implement simple date check here:
    allOrders.forEach(o => {
        // Simple logic for date filtering matching python's pick_date_for_filter
        let d = o.created_at; 
        // (Full logic should be in helpers.js, calling it here implies usage)
        // For standalone safety:
        if (dateFilterType === 'shipped_date' && o.shipped_at) d = o.shipped_at;
        if (dateFilterType === 'delivered_date' && o.delivered_at) d = o.delivered_at;
        
        if (d) {
            const dt = moment(d);
            // Check day inclusivity
            if (dt.isBetween(startDate, endDate, 'day', '[]')) {
                shopifyOrdersInRange.push(o);
            }
        }
    });

    const fbAds = await getFacebookAds(since, until);
    
    const performanceData = {};
    const fbAdMap = {};
    fbAds.forEach(ad => fbAdMap[ad.ad_id] = ad);

    fbAds.forEach(ad => {
        if (!performanceData[ad.adset_id]) {
            performanceData[ad.adset_id] = createEmptyBucket(ad.adset_id, ad.adset_name);
        }
        performanceData[ad.adset_id].terms[ad.ad_id] = createEmptyBucket(ad.ad_id, ad.ad_name, ad.spend);
    });

    performanceData[UNATTRIBUTED_ID] = createEmptyBucket(UNATTRIBUTED_ID, "Unattributed Sales");

    const adsetDeliveredRevenueTotals = {};

    shopifyOrdersInRange.forEach(order => {
        const [source, term] = getOrderSourceTerm(order);
        const rawStatus = order.raw_rapidshyp_status;
        const docpharmaData = order.docpharma_data;
        
        // Use helper status normalizer
        const status = helpers.normalizeStatus ? helpers.normalizeStatus(order, rawStatus, docpharmaData) : 'Processing'; 
        // NOTE: Make sure normalizeStatus is exported in helpers.js. If not, add it.

        let adsetBucket = null;
        let termBucket = null;
        let adsetIdForRevenue = null;

        if (source === 'facebook_ad') {
            const matchedAd = fbAdMap[term];
            if (matchedAd) {
                adsetBucket = performanceData[matchedAd.adset_id];
                adsetIdForRevenue = matchedAd.adset_id;
                if (adsetBucket) {
                    termBucket = adsetBucket.terms[matchedAd.ad_id];
                }
            }
        }

        if (!termBucket) {
            adsetBucket = performanceData[UNATTRIBUTED_ID];
            adsetIdForRevenue = UNATTRIBUTED_ID;
            if (!adsetBucket.terms[source]) {
                adsetBucket.terms[source] = createEmptyBucket(source, term);
            }
            termBucket = adsetBucket.terms[source];
        }

        processOrderIntoBucket(order, adsetBucket, status, adsetIdForRevenue, adsetDeliveredRevenueTotals);
        if (termBucket !== adsetBucket) {
            processOrderIntoBucket(order, termBucket, status);
        }
    });

    const result = [];
    Object.values(performanceData).forEach(adset => {
        adset.spend = Object.values(adset.terms).reduce((acc, t) => acc + (t.spend || 0), 0);
        adset.deliveredRevenue = Object.values(adset.terms).reduce((acc, t) => acc + (t.deliveredRevenue || 0), 0);

        if ((adset.totalOrders || 0) > 0 || adset.spend > 0) {
            const termsArray = Object.values(adset.terms).filter(t => (t.totalOrders || 0) > 0 || (t.spend || 0) > 0);
            termsArray.sort((a, b) => (b.totalOrders || 0) - (a.totalOrders || 0));
            adset.terms = termsArray; // Replace dict with sorted array
            result.push(adset);
        }
    });

    result.sort((a, b) => (b.spend || 0) - (a.spend || 0));
    return { adsetPerformance: result };
}

// Route
router.get('/get-adset-performance', tokenRequired, async (req, res) => {
    try {
        const { since, until, date_filter_type } = req.query;
        if (!since || !until) {
            return res.status(400).json({ error: "A 'since' and 'until' date range is required." });
        }
        const data = await getAdsetPerformanceData(since, until, date_filter_type || 'created_at');
        res.json(data);
    } catch (e) {
        console.error("CRITICAL Adset Performance ERROR:", e);
        res.status(500).json({ error: `Internal server error: ${e.message}` });
    }
});

module.exports = { router, getAdsetPerformanceData }; 
// Note: We export getAdsetPerformanceData for the Cron Job