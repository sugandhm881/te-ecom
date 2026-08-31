const express = require('express');
const router = express.Router();
const axios = require('axios');
const moment = require('moment-timezone');
const config = require('../../config');
const helpers = require('./helpers');
const { tokenRequired } = require('../auth');
const { supabase } = require('../supabase');

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

    // 1 + 2. FETCH ALL ORDERS IN RANGE (PAGINATED). PostgREST caps a single select at 1000 rows, which was
    // silently truncating the whole page — e.g. June had 5,166 orders but only 1,000 were counted, so order
    // counts + delivered revenue were ~5x under and ROAS (full spend / capped revenue) looked artificially low.
    // Loop .range() until a short page returns to get the true totals. (order() gives stable, gap-free paging.)
    const dateCol = dateFilterType === 'shipped_date' ? 'shipped_at'
                  : dateFilterType === 'delivered_date' ? 'delivered_at' : 'created_at';
    // Only the columns getOrderSourceTerm/normalizeStatus/revenue actually read — deliberately SKIP the large
    // `order_data` (full Shopify order) + line_items/shipping_address JSON so fetching ~5k rows stays light.
    // Order by the unique `shopify_id` for stable, gap-free .range() paging (tied timestamps can't drop rows).
    // `awb` joins each order to its courier journey — without it the outcome lookup below silently
    // matches nothing and every Kwikship delivery quietly stays "Processing", which is the bug itself.
    const COLS = 'shopify_id, awb, total_price, raw_rapidshyp_status, docpharma_data, note_attributes, source_name, referring_site, cancelled_at, rapidshyp_webhook_status, fulfillment_status, fulfillments';
    const PAGE = 1000;

    // The Facebook insights call is a live Meta API round-trip and is INDEPENDENT of the order
    // fetch — kick it off now so Meta's latency overlaps the DB pagination instead of stacking
    // after it (was: paginate fully, THEN await FB — the two slow parts ran back-to-back).
    const fbAdsPromise = getFacebookAds(since, until);

    // Page until a short page comes back — NO `count: 'exact'` (2026-08-31). The exact count made
    // PostgREST scan the whole month range twice in one statement; at month-end (6.4k orders of
    // heavy JSON) during a checkpoint that statement hit the DB's statement timeout, the error was
    // logged-and-swallowed, and the 8:07 report emailed every ad set with spend but ZERO orders.
    // Now a failed page is retried once and a still-failing fetch THROWS — the caller must abort
    // (cron skips the PDF, the route returns 500) because no report beats a wrong report.
    const buildOrdersPage = (from) => supabase.from('enriched_orders_ecom')
        .select(COLS)
        .gte(dateCol, startDate).lte(dateCol, endDate)
        .order('shopify_id', { ascending: true })
        .range(from, from + PAGE - 1);

    const shopifyOrdersInRange = [];
    for (let from = 0; ; from += PAGE) {
        let page = await buildOrdersPage(from);
        if (page.error) page = await buildOrdersPage(from);        // one retry (transient timeout/load)
        if (page.error) throw new Error(`enriched_orders_ecom fetch failed at row ${from}: ${page.error.message}`);
        shopifyOrdersInRange.push(...(page.data || []));
        if ((page.data || []).length < PAGE) break;
    }

    const orders = (shopifyOrdersInRange || []).map(row => ({
        ...row.order_data,
        ...row,
        total_price: row.total_price,
        raw_rapidshyp_status: row.raw_rapidshyp_status,
        docpharma_data: row.docpharma_data,
        note_attributes: row.note_attributes || [],
        source_name: row.source_name,
        referring_site: row.referring_site
    }));

    // Courier truth for every order in range, keyed by AWB — `shipment_journey_ecom` is the only table
    // RapidShyp, DocPharma AND Kwikship all write, so it is what makes a delivered Kwikship parcel count
    // as delivered here (see the note on normalizeStatus). One indexed read per 200 AWBs, no API calls.
    // ⚠️ Chunked, never a single .in() over thousands: PostgREST caps every response at 1000 rows without
    // saying so, and a truncated map would silently mis-state the very numbers this fixes.
    const journeyByAwb = {};
    const awbList = [...new Set(orders.map(o => o.awb).filter(Boolean).map(String))];
    for (let i = 0; i < awbList.length; i += 200) {
        let r = await supabase.from('shipment_journey_ecom')
            .select('awb, outcome').in('awb', awbList.slice(i, i + 200));
        if (r.error) r = await supabase.from('shipment_journey_ecom')
            .select('awb, outcome').in('awb', awbList.slice(i, i + 200));
        const { data, error } = r;
        if (error) { console.warn('[Adset] journey lookup failed:', error.message); break; }
        (data || []).forEach(j => { if (j.awb) journeyByAwb[String(j.awb)] = j.outcome; });
    }
    console.log(`[Adset] courier outcome resolved for ${Object.keys(journeyByAwb).length}/${awbList.length} AWBs`);

    const fbAds = await fbAdsPromise;

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

    orders.forEach(order => {
        const [source, term] = helpers.getOrderSourceTerm(order);
        const rawStatus = order.raw_rapidshyp_status;
        const docpharmaData = order.docpharma_data;

        const journeyOutcome = order.awb ? journeyByAwb[String(order.awb)] : null;
        const status = helpers.normalizeStatus ? helpers.normalizeStatus(order, rawStatus, docpharmaData, journeyOutcome) : 'Processing';

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
