const moment = require('moment-timezone');
const pLimit = require('p-limit').default || require('p-limit');
const helpers = require('./app/api/helpers');
const config = require('./config');
const mongoose = require('mongoose');
const connectDB = require('./db'); 
const { Order } = require('./models/Schemas'); 

const limit = pLimit(10); 

async function enrichOrder(order, statusCache) {
    // Standard enrichment logic...
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

    const shippedDt = helpers.inferShippedDatetime(order);
    const deliveredDt = helpers.inferDeliveredDatetime(order);
    
    if (shippedDt) order.shipped_at = shippedDt.toISOString();
    if (deliveredDt) order.delivered_at = deliveredDt.toISOString();

    return order;
}

async function runDataSync() {
    helpers.log("=".repeat(70));
    helpers.log("Starting Data Sync Job (Duplicate Protected)");

    if (mongoose.connection.readyState === 0) {
        await connectDB();
    }

    const fetchSince = moment().subtract(180, 'days').toISOString();
    helpers.log(`Fetching Shopify orders since ${fetchSince}`);

    const fields = 'id,name,created_at,total_price,fulfillments,note_attributes,source_name,referring_site,cancelled_at,fulfillment_status,line_items,email,shipping_address,updated_at';
    
    // Step 1: Fetch
    const [createdOrders, updatedOrders] = await Promise.all([
        helpers.getAllShopifyOrdersPaginated({ status: 'any', limit: 250, created_at_min: fetchSince, fields }),
        helpers.getAllShopifyOrdersPaginated({ status: 'any', limit: 250, updated_at_min: fetchSince, fields })
    ]);

    // Step 2: Merge locally (LAYER 1 DEDUPLICATION)
    // We use an Object where Key = Order ID. Objects cannot have duplicate keys.
    // This automatically removes any duplicates returned by Shopify.
    const allRecentOrders = {};
    createdOrders.forEach(o => allRecentOrders[String(o.id)] = o);
    updatedOrders.forEach(o => allRecentOrders[String(o.id)] = o);

    const allOrdersList = Object.values(allRecentOrders);
    helpers.log(`✓ Fetched ${allOrdersList.length} unique orders`);

    // Step 3: Enrich
    helpers.log(`Step 3: Enriching orders (Concurrency: 10)...`);
    let statusCache = {}; 
    let completedCount = 0;
    
    const enrichPromises = allOrdersList.map(order => 
        limit(() => enrichOrder(order, statusCache).then(res => {
            completedCount++;
            if (completedCount % 100 === 0) process.stdout.write(`\rEnriched ${completedCount}/${allOrdersList.length}`);
            return res;
        }))
    );

    const enrichedOrders = await Promise.all(enrichPromises);
    helpers.log(`\n✓ Enriched all orders`);

    // Step 4: Bulk Save (LAYER 2 & 3 DEDUPLICATION)
    helpers.log("Step 4: Saving to Database...");
    
    if (enrichedOrders.length > 0) {
        
        // Final Safety Check: Ensure enrichedOrders has unique IDs before creating bulkOps
        const uniqueOrdersMap = new Map();
        enrichedOrders.forEach(o => uniqueOrdersMap.set(String(o.id), o));
        const finalUniqueOrders = Array.from(uniqueOrdersMap.values());

        const bulkOps = finalUniqueOrders.map(order => ({
            updateOne: {
                // FILTER: This ensures we match the exact order ID in the DB
                filter: { id: order.id },
                // UPDATE: Updates the existing record
                update: { $set: order },
                // UPSERT: Create only if it doesn't exist
                upsert: true
            }
        }));

        // Batch processing to prevent freeze
        const BATCH_SIZE = 500;
        let savedCount = 0;

        for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
            const chunk = bulkOps.slice(i, i + BATCH_SIZE);
            try {
                // This command tells MongoDB to update-or-insert, preventing duplicates
                await Order.bulkWrite(chunk);
                savedCount += chunk.length;
                process.stdout.write(`\rSaving (Upserting)... ${savedCount}/${bulkOps.length}`);
            } catch (e) {
                console.error(`\n❌ Error saving batch ${i}: ${e.message}`);
            }
        }
        helpers.log(`\n✓ Database sync complete.`);
    } else {
        helpers.log("No orders to update.");
    }

    helpers.log("Data Sync Job Finished Successfully");
    helpers.log("=" .repeat(70));
    
    process.exit(0);
}

if (require.main === module) {
    runDataSync();
}