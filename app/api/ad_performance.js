const express = require('express');
const router = express.Router();
const axios = require('axios');
const moment = require('moment-timezone');
const config = require('../../config');

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

async function getShopifyOrdersForAds(since) {
    let url = `https://${config.SHOPIFY_SHOP_URL}/admin/api/2024-07/orders.json`;
    const headers = { 'X-Shopify-Access-Token': config.SHOPIFY_TOKEN };
    let params = { status: 'any', limit: 250, created_at_min: since };
    let allOrders = [];

    try {
        while (url) {
            const response = await axios.get(url, { headers, params });
            allOrders = allOrders.concat(response.data.orders || []);
            
            const linkHeader = response.headers['link'];
            url = null;
            if (linkHeader && linkHeader.includes('rel="next"')) {
                const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                if (match) {
                    url = match[1];
                    params = {};
                }
            }
        }
    } catch (e) {
        console.error(`Shopify API Error in ad performance: ${e.message}`);
    }
    return allOrders;
}

function getSimulatedLogisticsStatus(order) {
    if (order.cancelled_at) return 'Cancelled';
    const tags = (order.tags || '').toLowerCase();
    if (tags.includes('rto')) return 'RTO';
    if (order.fulfillment_status === 'fulfilled') {
        const idStr = String(order.id);
        // Simulate based on last 2 digits
        return parseInt(idStr.slice(-2)) < 80 ? 'Delivered' : 'In-Transit';
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

        // Merge Shopify
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