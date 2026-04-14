const moment = require('moment-timezone');
const helpers = require('./helpers');
const config = require('../../config');
const { supabase } = require('../supabase');

const CACHE_DURATION_SECONDS = 30 * 60; // 30 mins

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
        created_at: order.PurchaseDate || new Date().toISOString(),
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
    // 1. Check Supabase cache
    try {
        const { data: cachedOrders } = await supabase
            .from('amazon_orders')
            .select('*')
            .order('purchase_date', { ascending: false })
            .limit(1);

        if (cachedOrders && cachedOrders.length > 0) {
            const lastUpdate = moment(cachedOrders[0].updated_at || cachedOrders[0].purchase_date);
            const now = moment();
            if (now.diff(lastUpdate, 'seconds') < CACHE_DURATION_SECONDS) {
                console.log(`\n--- [Amazon DB] Using cached data (< 30m old) ---`);
                const { data } = await supabase.from('amazon_orders').select('*');
                return data || [];
            }
        }
    } catch (e) { /* ignore */ }

    console.log("\n--- [Amazon API] Fetching fresh data ---");
    const requiredKeys = ['AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'REFRESH_TOKEN'];
    if (!requiredKeys.every(k => config[k])) {
        console.log("[WARNING] Amazon keys missing.");
        return [];
    }

    const createdAfter = moment.utc().subtract(30, 'days').toISOString();
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

            await helpers.sleep(page <= 5 ? 2000 : 5000);
        }

        // Normalize
        const normalized = allOrders.map(normalizeAmazonOrder);
        return normalized;

    } catch (e) {
        console.error("Error fetching Amazon orders:", e.message);
        return [];
    }
}

module.exports = { fetchAmazonOrders };
