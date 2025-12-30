const express = require('express');
const router = express.Router();
const axios = require('axios');
const moment = require('moment-timezone');
const config = require('../../config');
const helpers = require('./helpers');
const { tokenRequired } = require('../auth');

// IMPORT DB MODEL
const { Order } = require('../../models/Schemas');

const UNATTRIBUTED_ID = 'unattributed';

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

// CORE FUNCTION exported for Router and Cron Job
async function getAdsetPerformanceData(since, until, dateFilterType = 'created_at') {
    const startDate = moment(since).startOf('day').toISOString();
    const endDate = moment(until).endOf('day').toISOString();

    // 1. BUILD MONGODB QUERY
    let query = {};
    
    // Adjust query based on filter type
    if (dateFilterType === 'shipped_date') {
        query.shipped_at = { $gte: startDate, $lte: endDate };
    } else if (dateFilterType === 'delivered_date') {
        query.delivered_at = { $gte: startDate, $lte: endDate };
    } else {
        // Default to created_at
        query.created_at = { $gte: startDate, $lte: endDate };
    }

    // 2. FETCH FROM DB
    const shopifyOrdersInRange = await Order.find(query).lean();

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
        // Use helper logic for attribution
        const [source, term] = helpers.getOrderSourceTerm(order);
        const rawStatus = order.raw_rapidshyp_status;
        const docpharmaData = order.docpharma_data;
        
        const status = helpers.normalizeStatus ? helpers.normalizeStatus(order, rawStatus, docpharmaData) : 'Processing'; 

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
            adset.terms = termsArray; 
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