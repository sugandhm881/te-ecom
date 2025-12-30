const express = require('express');
const router = express.Router();
const axios = require('axios');
const moment = require('moment-timezone');
const config = require('../../config');
const { Order } = require('../../models/Schemas'); // Import DB

async function getFacebookDailySpend(since, until) {
    const url = `https://graph.facebook.com/v18.0/act_${config.FACEBOOK_AD_ACCOUNT_ID}/insights`;
    const params = {
        'time_range': JSON.stringify({ since, until }),
        'time_increment': 1,
        'fields': 'spend,date_start',
        'access_token': config.FACEBOOK_ACCESS_TOKEN
    };

    try {
        const response = await axios.get(url, { params });
        const data = response.data.data || [];
        const spendData = {};
        data.forEach(item => {
            spendData[item.date_start] = parseFloat(item.spend || 0);
        });
        return spendData;
    } catch (e) {
        console.error(`Facebook API Error: ${e.message}`);
        return {};
    }
}

// REPLACED: Fetch from DB instead of Shopify API
async function getShopifyOrdersForAds(since) {
    try {
        // Query DB for all orders created after 'since'
        const orders = await Order.find({
            created_at: { $gte: moment(since).toISOString() }
        }).lean();
        return orders;
    } catch (e) {
        console.error("DB Fetch Error in ad performance:", e);
        return [];
    }
}

function getSimulatedLogisticsStatus(order) {
    if (order.cancelled_at) return 'Cancelled';
    const tags = (order.tags || '').toLowerCase();
    if (tags.includes('rto')) return 'RTO';
    
    // Use our new enriched status if available
    if (order.raw_rapidshyp_status) {
        const s = order.raw_rapidshyp_status.toUpperCase();
        if (s.includes('DELIVERED')) return 'Delivered';
        if (s.includes('RTO')) return 'RTO';
        if (s.includes('TRANSIT') || s.includes('SHIPPED')) return 'In-Transit';
    }

    if (order.fulfillment_status === 'fulfilled') {
        return 'In-Transit'; // Default if fulfilled but no detailed status
    }
    return 'Processing';
}

router.get('/get-ad-performance', async (req, res) => {
    const { since, until } = req.query;
    if (!since || !until) {
        return res.status(400).json({ error: 'A "since" and "until" date range is required.' });
    }

    try {
        const [facebookSpend, shopifyOrders] = await Promise.all([
            getFacebookDailySpend(since, until),
            getShopifyOrdersForAds(since)
        ]);

        const dailyData = {};
        const startDate = moment(since);
        const endDate = moment(until);
        
        for (let m = moment(startDate); m.isSameOrBefore(endDate); m.add(1, 'days')) {
            const dateStr = m.format('YYYY-MM-DD');
            dailyData[dateStr] = {
                date: dateStr, spend: 0, totalOrders: 0, revenue: 0,
                deliveredOrders: 0, cancelledOrders: 0, rtoOrders: 0,
                inTransitOrders: 0, processingOrders: 0
            };
        }

        // Merge Facebook
        Object.keys(facebookSpend).forEach(date => {
            if (dailyData[date]) dailyData[date].spend = facebookSpend[date];
        });

        // Merge Shopify (From DB)
        shopifyOrders.forEach(order => {
            const orderDate = moment(order.created_at).format('YYYY-MM-DD');
            if (dailyData[orderDate]) {
                const slot = dailyData[orderDate];
                const status = getSimulatedLogisticsStatus(order);

                slot.totalOrders += 1;
                if (status !== 'Cancelled' && status !== 'RTO') {
                    slot.revenue += parseFloat(order.total_price || 0);
                }

                if (status === 'Delivered') slot.deliveredOrders++;
                else if (status === 'RTO') slot.rtoOrders++;
                else if (status === 'Cancelled') slot.cancelledOrders++;
                else if (status === 'In-Transit') slot.inTransitOrders++;
                else slot.processingOrders++;
            }
        });

        const result = Object.values(dailyData).sort((a, b) => a.date.localeCompare(b.date));
        res.json(result);

    } catch (e) {
        console.error(`Error in get-ad-performance: ${e}`);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;