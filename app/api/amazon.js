const fs = require('fs-extra');
const moment = require('moment-timezone');
const helpers = require('./helpers');
const config = require('../../config');

const CACHE_DURATION_SECONDS = 30 * 60; // 30 mins

function getFetchPeriod() {
    const todayStr = moment.utc().format('YYYY-MM-DD');
    let fullFetch = false;
    let lastFetchDate = '';

    try {
        lastFetchDate = fs.readFileSync(config.AMAZON_CACHE_DATE_FILE, 'utf-8').trim();
    } catch (e) { fullFetch = true; }

    if (lastFetchDate !== todayStr) fullFetch = true;
    fs.writeFileSync(config.AMAZON_CACHE_DATE_FILE, todayStr);

    if (fullFetch) {
        return moment.utc().subtract(45, 'days').toISOString();
    } else {
        return moment.utc().startOf('month').toISOString();
    }
}

function normalizeAmazonOrder(order) {
    const address = order.ShippingAddress || {};
    const buyerInfo = order.BuyerInfo || {};
    let customerName = buyerInfo.BuyerName !== 'N/A' ? buyerInfo.BuyerName : (address.Name || 'N/A');

    let status = 'Processing';
    const amzStatus = order.OrderStatus || '';
    if (['Pending', 'Unshipped'].includes(amzStatus)) status = 'New';
    if (['Shipped'].includes(amzStatus)) status = 'Shipped';
    if (['Canceled'].includes(amzStatus)) status = 'Cancelled';

    return {
        platform: "Amazon",
        id: order.AmazonOrderId || 'N/A',
        originalId: order.AmazonOrderId || 'N/A',
        date: order.PurchaseDate ? order.PurchaseDate.substring(0, 10) : '',
        name: customerName,
        total: parseFloat((order.OrderTotal || {}).Amount || 0),
        status: status,
        items: [],
        address: `${address.AddressLine1 || ''}, ${address.City || ''}`.replace(/^, /, '') || 'No address',
        paymentMethod: order.PaymentMethod || 'N/A'
    };
}

async function fetchAmazonOrders() {
    // Cache Check
    if (fs.existsSync(config.AMAZON_CACHE_FILE)) {
        const stats = fs.statSync(config.AMAZON_CACHE_FILE);
        const age = (Date.now() - stats.mtimeMs) / 1000;
        if (age < CACHE_DURATION_SECONDS) {
            console.log(`\n--- [Amazon Cache] Using cached data. Age: ${age.toFixed(0)}s ---`);
            return fs.readJsonSync(config.AMAZON_CACHE_FILE);
        }
    }

    console.log("\n--- [Amazon Cache] Fetching fresh data from API ---");
    const requiredKeys = ['AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'REFRESH_TOKEN'];
    if (!requiredKeys.every(k => config[k])) {
        console.log("[WARNING] Amazon keys missing.");
        return [];
    }

    const createdAfter = getFetchPeriod();
    let allOrders = [];
    let nextToken = null;
    let page = 1;

    try {
        while (true) {
            console.log(`[Amazon API] Fetching page ${page}...`);
            const queryParams = {
                'MarketplaceIds': config.MARKETPLACE_ID,
                'CreatedAfter': createdAfter,
                'dataElements': 'buyerInfo,shippingAddress'
            };
            if (nextToken) queryParams['NextToken'] = nextToken;

            const response = await helpers.makeSignedApiRequest({
                method: 'GET',
                path: '/orders/v0/orders',
                queryParams: queryParams
            });

            const payload = response.payload || {};
            const orders = payload.Orders || [];
            allOrders = allOrders.concat(orders);

            console.log(`[Amazon API] ✅ Fetched page ${page} (${orders.length} orders)`);

            nextToken = payload.NextToken;
            page++;
            if (!nextToken) break;

            await new Promise(r => setTimeout(r, page <= 5 ? 2000 : 5000));
        }

        const normalized = allOrders.map(normalizeAmazonOrder);
        fs.outputJsonSync(config.AMAZON_CACHE_FILE, normalized);
        return normalized;

    } catch (e) {
        console.error("Error fetching Amazon orders:", e.message);
        if (fs.existsSync(config.AMAZON_CACHE_FILE)) {
             return fs.readJsonSync(config.AMAZON_CACHE_FILE);
        }
        return [];
    }
}

module.exports = { fetchAmazonOrders };