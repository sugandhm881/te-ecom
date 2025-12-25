const fs = require('fs-extra');
const moment = require('moment-timezone');
const pLimit = require('p-limit').default || require('p-limit');
const helpers = require('./app/api/helpers');
const config = require('./config');

const limit = pLimit(10); // Equivalent to max_workers=10

async function enrichOrder(order, statusCache) {
    // Extract AWB
    const fulfillments = order.fulfillments || [];
    const awb = fulfillments.find(f => f.tracking_number)?.tracking_number;
    order.awb = awb;

    let rawStatus = null;
    let timeline = [];

    // 1. Try RapidShyp
    if (awb) {
        rawStatus = await helpers.getRawRapidshypStatus(awb, statusCache);
        if (rawStatus && rawStatus !== 'Status Not Available' && rawStatus !== 'API Error or Timeout') {
            timeline = await helpers.getRapidshypTimeline(awb);
        }
    }

    // 2. Fallback to DocPharma
    if (!rawStatus || rawStatus === 'Status Not Available' || rawStatus === 'API Error or Timeout') {
        const orderName = (order.name || '').replace('#', '');
        if (orderName) {
            const docData = await helpers.fetchDocpharmaDetails(orderName);
            if (docData) {
                order.docpharma_data = docData;
                const extracted = helpers.extractDocpharmaStatusString(docData);
                if (extracted) {
                    rawStatus = extracted;
                    timeline = [{ status: rawStatus, timestamp: new Date().toISOString(), location: 'DocPharma API' }];
                }
            }
        }
    }

    // 3. Fallback to Shopify Status
    if (!rawStatus) {
        rawStatus = order.fulfillment_status || 'Unfulfilled';
    }

    order.raw_rapidshyp_status = rawStatus;
    order.rapidshyp_events = timeline;

    // Infer dates
    const shippedDt = helpers.inferShippedDatetime(order);
    const deliveredDt = helpers.inferDeliveredDatetime(order);
    
    if (shippedDt) order.shipped_at = shippedDt.toISOString();
    if (deliveredDt) order.delivered_at = deliveredDt.toISOString();

    return order;
}

async function runDataSync() {
    helpers.log("=" .repeat(70));
    helpers.log("Starting Data Sync Job");

    // Load Existing Data
    let existingOrdersDict = {};
    if (fs.existsSync(config.MASTER_DATA_FILE)) {
        try {
            const data = fs.readJsonSync(config.MASTER_DATA_FILE);
            data.forEach(o => existingOrdersDict[String(o.id)] = o);
            helpers.log(`✓ Loaded ${data.length} existing orders.`);
        } catch (e) { helpers.log("Starting fresh (no valid master file)."); }
    }

    const fetchSince = moment().subtract(180, 'days').toISOString();
    helpers.log(`Fetching Shopify orders since ${fetchSince}`);

    const fields = 'id,name,created_at,total_price,fulfillments,note_attributes,source_name,referring_site,cancelled_at,fulfillment_status,line_items,email,shipping_address,updated_at';
    
    // Step 1 & 2: Fetch Created & Updated
    const [createdOrders, updatedOrders] = await Promise.all([
        helpers.getAllShopifyOrdersPaginated({ status: 'any', limit: 250, created_at_min: fetchSince, fields }),
        helpers.getAllShopifyOrdersPaginated({ status: 'any', limit: 250, updated_at_min: fetchSince, fields })
    ]);

    // Step 3: Merge
    const allRecentOrders = {};
    createdOrders.forEach(o => allRecentOrders[String(o.id)] = o);
    updatedOrders.forEach(o => allRecentOrders[String(o.id)] = o);

    Object.entries(allRecentOrders).forEach(([id, newOrder]) => {
        if (existingOrdersDict[id]) {
            // Update existing but preserve specific fields
            const existing = existingOrdersDict[id];
            existingOrdersDict[id] = { ...existing, ...newOrder };
            if (existing.docpharma_data && !newOrder.docpharma_data) {
                existingOrdersDict[id].docpharma_data = existing.docpharma_data;
            }
        } else {
            existingOrdersDict[id] = newOrder;
        }
    });

    const allOrdersList = Object.values(existingOrdersDict);
    helpers.log(`✓ Combined to ${allOrdersList.length} total unique orders`);

    // Step 4: Load Cache
    const statusCache = helpers.loadCache(config.RAPIDSHYP_CACHE_FILE);

    // Step 5: Enrich Concurrently
    helpers.log(`Step 5: Enriching orders (Concurrency: 10)...`);
    
    let completedCount = 0;
    const enrichPromises = allOrdersList.map(order => 
        limit(() => enrichOrder(order, statusCache).then(res => {
            completedCount++;
            if (completedCount % 50 === 0) helpers.log(`→ Enriched ${completedCount}/${allOrdersList.length}`);
            return res;
        }))
    );

    const enrichedOrders = await Promise.all(enrichPromises);
    helpers.log(`✓ Enriched all orders`);

    // Step 6: Save Cache
    helpers.saveCache(config.RAPIDSHYP_CACHE_FILE, statusCache);
    helpers.log("✓ Cache saved");

    // Step 7: Atomic Write
    const tempFile = `${config.MASTER_DATA_FILE}.tmp`;
    fs.outputJsonSync(tempFile, enrichedOrders, { spaces: 2 });
    fs.renameSync(tempFile, config.MASTER_DATA_FILE);
    helpers.log(`✓ Saved ${enrichedOrders.length} orders to ${config.MASTER_DATA_FILE}`);

    helpers.log("Data Sync Job Finished Successfully");
    helpers.log("=" .repeat(70));
}

if (require.main === module) {
    runDataSync();
}