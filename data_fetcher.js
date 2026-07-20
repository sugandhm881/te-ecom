const moment = require('moment-timezone');
const pLimit = require('p-limit').default || require('p-limit');
const fs = require('fs');
const path = require('path');
const helpers = require('./app/api/helpers');
const { supabase } = require('./app/supabase');

// Incremental-sync cursor, persisted on disk (survives pm2 restarts). Each pass fetches only orders
// CHANGED since the last run — so DB/API load scales with activity, not with total order count. A daily
// bounded FULL sweep re-checks everything as a backstop, so no order/status is ever permanently missed.
const STATE_FILE = path.join(__dirname, '.sync_state.json');
function readSyncState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; } }
function writeSyncState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { helpers.log('[Sync] state write failed: ' + e.message); } }

const limit = pLimit(10);

// DocPharma rate limiter — 1 call at a time, 1 second between calls
const docpharmaLimit = pLimit(1);
let lastDocPharmaTs = 0;
const DOCPHARMA_DELAY_MS = 1000;

async function throttledDocPharma(orderName) {
    return docpharmaLimit(async () => {
        const wait = DOCPHARMA_DELAY_MS - (Date.now() - lastDocPharmaTs);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastDocPharmaTs = Date.now();
        return helpers.fetchDocpharmaDetails(orderName);
    });
}

async function enrichOrder(order) {
    const fulfillments = order.fulfillments || [];
    const awb = fulfillments.find(f => f.tracking_number)?.tracking_number;
    order.awb = awb;

    let rawStatus = null;
    let timeline = [];

    // 1. Try RapidShyp
    if (awb) {
        rawStatus = await helpers.getRawRapidshypStatus(awb);
        if (rawStatus && rawStatus !== 'Status Not Available' && rawStatus !== 'API Error or Timeout') {
            timeline = await helpers.getRapidshypTimeline(awb);
        }
    }

    // 2. Fallback to DocPharma
    if (!rawStatus || rawStatus === 'Status Not Available' || rawStatus === 'API Error or Timeout') {
        const orderName = (order.name || '').replace('#', '');
        if (orderName) {
            const docData = await throttledDocPharma(orderName);
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
    helpers.log("Starting Data Sync Job (Supabase)");

    // INCREMENTAL by default — only orders CHANGED since the last run (a small delta), so the RapidShyp
    // status-check + upsert (the real load) happens only for orders that actually moved, not the whole
    // window every pass. Once a day / on first run / after an outage → a bounded FULL sweep as a backstop.
    const WINDOW_DAYS = parseInt(process.env.SYNC_WINDOW_DAYS, 10) || 45;          // full-sweep look-back
    const OVERLAP_MIN = parseInt(process.env.SYNC_OVERLAP_MINUTES, 10) || 90;       // overlap so nothing slips between runs
    const FULL_SWEEP_HOURS = parseInt(process.env.SYNC_FULL_SWEEP_HOURS, 10) || 24;
    const state = readSyncState();
    const runStart = new Date().toISOString();
    const dueFull = !state.lastFullSweepAt || (Date.now() - new Date(state.lastFullSweepAt).getTime()) >= FULL_SWEEP_HOURS * 3600 * 1000;
    const mode = (!state.lastSyncAt || dueFull) ? 'full' : 'incremental';
    const fetchSince = mode === 'full'
        ? moment().subtract(WINDOW_DAYS, 'days').toISOString()
        : moment(state.lastSyncAt).subtract(OVERLAP_MIN, 'minutes').toISOString();
    helpers.log(`[Sync] mode=${mode} · orders changed since ${fetchSince}`);

    const fields = 'id,name,created_at,total_price,fulfillments,note_attributes,source_name,referring_site,cancelled_at,fulfillment_status,line_items,email,shipping_address,updated_at,tags';

    // Step 1: Fetch
    const [createdOrders, updatedOrders] = await Promise.all([
        helpers.getAllShopifyOrdersPaginated({ status: 'any', limit: 250, created_at_min: fetchSince, fields }),
        helpers.getAllShopifyOrdersPaginated({ status: 'any', limit: 250, updated_at_min: fetchSince, fields })
    ]);

    // Step 2: Merge locally (deduplication)
    const allRecentOrders = {};
    createdOrders.forEach(o => allRecentOrders[String(o.id)] = o);
    updatedOrders.forEach(o => allRecentOrders[String(o.id)] = o);

    const allOrdersList = Object.values(allRecentOrders);
    helpers.log(`✓ Fetched ${allOrdersList.length} unique orders`);

    // Step 3: Enrich
    helpers.log(`Step 3: Enriching orders (Concurrency: 10)...`);
    let completedCount = 0;

    const enrichPromises = allOrdersList.map(order =>
        limit(() => enrichOrder(order).then(res => {
            completedCount++;
            if (completedCount % 100 === 0) process.stdout.write(`\rEnriched ${completedCount}/${allOrdersList.length}`);
            return res;
        }))
    );

    const enrichedOrders = await Promise.all(enrichPromises);
    helpers.log(`\n✓ Enriched all orders`);

    // Step 4: Bulk Save to Supabase enriched_orders_ecom
    helpers.log("Step 4: Saving to Supabase...");

    if (enrichedOrders.length > 0) {
        // Deduplicate by ID
        const uniqueOrdersMap = new Map();
        enrichedOrders.forEach(o => uniqueOrdersMap.set(String(o.id), o));
        const finalUniqueOrders = Array.from(uniqueOrdersMap.values());

        // Transform to Supabase rows
        const rows = finalUniqueOrders.map(order => ({
            shopify_id: String(order.id),
            name: order.name || null,
            created_at: order.created_at || null,
            total_price: parseFloat(order.total_price || 0),
            fulfillment_status: order.fulfillment_status || null,
            cancelled_at: order.cancelled_at || null,
            tags: order.tags || null,
            awb: order.awb || null,
            raw_rapidshyp_status: order.raw_rapidshyp_status || null,
            rapidshyp_webhook_status: order.rapidshyp_webhook_status || null,
            rapidshyp_events: order.rapidshyp_events || [],
            shipped_at: order.shipped_at || null,
            delivered_at: order.delivered_at || null,
            docpharma_data: order.docpharma_data || null,
            email: order.email || null,
            phone: (order.shipping_address || {}).phone || null,
            source_name: order.source_name || null,
            referring_site: order.referring_site || null,
            note_attributes: order.note_attributes || [],
            line_items: order.line_items || [],
            shipping_address: order.shipping_address || null,
            fulfillments: order.fulfillments || [],
            order_data: order,
            updated_at: new Date().toISOString()
        }));

        // Batch upsert
        const BATCH_SIZE = 500;
        let savedCount = 0;

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const chunk = rows.slice(i, i + BATCH_SIZE);
            try {
                const { error } = await supabase
                    .from('enriched_orders_ecom')
                    .upsert(chunk, { onConflict: 'shopify_id' });

                if (error) {
                    console.error(`\n❌ Error saving batch ${i}: ${error.message}`);
                } else {
                    savedCount += chunk.length;
                    process.stdout.write(`\rSaving (Upserting)... ${savedCount}/${rows.length}`);
                }
            } catch (e) {
                console.error(`\n❌ Error saving batch ${i}: ${e.message}`);
            }
        }
        helpers.log(`\n✓ Database sync complete.`);
    } else {
        helpers.log("No orders to update.");
    }

    // Advance the cursor only after a successful pass — a failed run leaves it, so the next run re-tries
    // the same window and nothing is skipped. `runStart` (not "now") is the cursor so orders that changed
    // during this pass are re-caught next time (the overlap adds a further safety margin).
    writeSyncState({ lastSyncAt: runStart, lastFullSweepAt: mode === 'full' ? runStart : (state.lastFullSweepAt || runStart) });
    helpers.log("Data Sync Job Finished Successfully");
    helpers.log("=".repeat(70));
}

// Run one pass, then idle before exiting — pm2 restarts us for the next pass. The gap (default 15 min)
// paces BOTH successful and failed runs, so a persistent error can never become a restart storm.
if (require.main === module) {
    const gapMs = (parseInt(process.env.SYNC_GAP_MINUTES, 10) || 15) * 60 * 1000;
    (async () => {
        try { await runDataSync(); }
        catch (e) { helpers.log('[Sync] run failed: ' + (e.message || e)); }
        helpers.log(`[Sync] idling ${Math.round(gapMs / 60000)} min before pm2 restarts the next pass…`);
        await new Promise(r => setTimeout(r, gapMs));
        process.exit(0);
    })();
}
