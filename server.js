const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const config = require('./config');
const { supabase } = require('./app/supabase');

const app = express();
// gzip/deflate every response (all API JSON + the app shell + static). ~80–90% smaller transfer on the
// big dashboard payloads (orders, delivery-perf, docpharma, insights…) → much faster loads, identical data.
app.use(compression());

// Middleware
// CORS restricted to the app's own origin(s). Same-origin dashboard calls send no Origin header and are
// unaffected; this blocks other websites from calling the API from a victim's browser. Override via CORS_ORIGINS.
const CORS_ALLOW = (process.env.CORS_ORIGINS || config.DASHBOARD_URL || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .concat(['http://localhost:5002', 'http://127.0.0.1:5002']);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || CORS_ALLOW.includes(origin)), credentials: true }));
// The Tally bridge agent uploads RAW Tally XML for the books, and the day book alone is ~5MB of XML for
// a financial year (it is gzipped in transit, but body-parser applies its limit AFTER inflation). Give
// that one route its own generous cap rather than raising the global 5mb — a global bump would widen the
// DoS surface on every endpoint. Registered BEFORE the global parser so it wins for this path;
// body-parser then marks the body parsed and the global parser no-ops.
app.use('/api/tally/bridge/books-xml', express.json({ limit: '64mb' }));
app.use('/api/tally/bridge/masters-xml', express.json({ limit: '16mb' }));
app.use('/api/tally/bank/parse', express.json({ limit: '32mb' }));   // statement upload (base64 in JSON)
// Kwikship pincode→zone sheet (base64 in JSON). India has ~19k live pincodes and a courier's
// serviceability export lists one row per pincode, so the whole file is a few MB.
app.use('/api/zone-mapping/upload', express.json({ limit: '32mb' }));

// Capture the raw body (used by the Shopify webhook HMAC check); does not change JSON parsing.
// limit 5mb (default 100kb was too tight): the Ad-Set PDF/Excel download POSTs the full computed report JSON
// (~100kb+ once all orders are counted, grows with the date range) — a 100kb cap threw PayloadTooLargeError.
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.enable('trust proxy');

// Security headers — clickjacking + MIME-sniffing protection (defense against XSS impact).
// CSP is defense-in-depth for the (now-escaped) XSS: even if a payload slips through, connect-src 'self'
// blocks exfiltration via fetch/XHR/beacon, and object-src/base-uri/frame-ancestors/form-action are locked
// down. script/style keep only 'unsafe-inline' for the SPA's inline handlers; 'unsafe-eval' and the CDN
// sources were removed once Tailwind was pre-built and Chart.js self-hosted (no external scripts remain).
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "form-action 'self'",
].join('; ');
// Voice Agent (Sarvam AI) tool — a self-contained /static/voice-agent.html embedded in an iframe under Customer
// Support. It legitimately reaches api.sarvam.ai + the operator's Supabase and plays data:/blob: TTS audio, so
// that ONE file gets a scoped, slightly-relaxed CSP; every other response keeps the strict connect-src 'self'.
const CSP_VOICE = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: https:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https://api.sarvam.ai https://*.supabase.co",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "form-action 'self'",
].join('; ');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', req.path === '/static/voice-agent.html' ? CSP_VOICE : CSP);
    next();
});

// Static Files
// Long-cache static assets (JS/CSS/vendor/images) in the browser → no re-download on every visit, so the
// app shell loads instantly on repeat loads. Safe: the versioned files carry `?v=` cache-busters that change
// on each update (a new query string = a fresh URL), and index.html itself is served no-cache below.
app.use('/static', express.static(path.join(__dirname, 'app/static'), { maxAge: '30d', etag: true }));
app.use('/templates', express.static(path.join(__dirname, 'app/templates'), { maxAge: '7d', etag: true }));

// --- Import Routes ---
const authRoutes = require('./app/api/auth_routes');
const ordersRoutes = require('./app/api/orders');
const adsetRoutes = require('./app/api/adset_performance').router;
const adRoutes = require('./app/api/ad_performance');
const shippingRoutes = require('./app/api/shipping');
const excelRoutes = require('./app/api/excel_report');
const pdfRoutes = require('./app/api/pdf_generator').router;
const webhookRoutes = require('./app/api/webhook_handler');
const easyecomRoutes = require('./app/api/easyecom');
const { syncEasyecomOrders } = require('./app/api/easyecom');
const amazonReviewRoutes = require('./app/api/amazon_review');
const { router: amazonAutoReviewRoutes, initAutoReviewCron } = require('./app/api/amazon_auto_review');
const { router: fulfillmentOpsRoutes, syncLast7Days, syncMTD, syncStatusesToShopify } = require('./app/api/fulfillment_ops');
const serviceabilityRoutes = require('./app/api/serviceability');
const pincodeRoutes = require('./app/api/pincode');
const customerProfileRoutes = require('./app/api/customer_profile');
const { sendWarehouseOpsReport, sendDocpharmaRejectedReport, initDpSlackTrigger, sendEasyecomHoldReport, syncRsCacheEasyecom, autoRouteHandledRejections } = require('./app/api/warehouse_slack_report');
const deliveryReportsRoutes = require('./app/api/delivery_reports');
const opsControlRoutes = require('./app/api/ops_control');
const lastMileRoutes = require('./app/api/last_mile');
const purchaseOrderRoutes = require('./app/api/purchase_orders');
const { router: amazonFbaRoutes, initFbaLocationCron } = require('./app/api/amazon_fba');
const docpharmaReconRoutes = require('./app/api/docpharma_recon');
const rapidshypReconRoutes = require('./app/api/rapidshyp_recon');
const kwikshipReconRoutes = require('./app/api/kwikship_recon');
const { router: pgReconRoutes, syncOrderGateways } = require('./app/api/pg_recon');
const docpharmaInvoiceRoutes = require('./app/api/docpharma_invoices');
const docpharmaLedgerRoutes = require('./app/api/docpharma_ledger');
const docpharmaOverviewRoutes = require('./app/api/docpharma_overview');
const docpharmaInventoryRoutes = require('./app/api/docpharma_inventory');
const { ingestRecentDocpharmaOrders } = require('./app/api/docpharma_portal');
const { backfillJourneys, syncChargesBatch, auditJourneyIntegrity } = require('./app/api/delivery_journey');
const { syncKwikship, applyKwikshipCharges } = require('./app/api/kwikship_sync');
const cron = require('node-cron');
// Every scheduled job goes through the reporter → the Teams "Cron Response" channel. Failures post a
// card with the reason (including errors a job caught itself and only console.error'd); successes are
// rolled into the periodic digest. Reporting NEVER throws, so it can't take a cron down. See
// app/api/cron_report.js for the modes (CRON_REPORT_MODE=digest|all|failures|off).
const { runCron, sendCronDigest } = require('./app/api/cron_report');
const cronJob = (name, expr, fn, opts = { timezone: 'Asia/Kolkata' }) =>
    cron.schedule(expr, () => runCron(name, fn), opts);

// --- Register Routes ---
app.use('/api', authRoutes);
app.use('/api/admin', require('./app/api/users'));
app.use('/api/admin', require('./app/api/email_settings').router);   // admin-only email/SMTP settings
app.use('/api/admin', require('./app/api/user_activity').adminRouter);  // admin-only User Analytics

// --- Require a valid JWT for ALL data APIs below. Public: login/signup (handled above) + external webhooks. ---
const { tokenRequired: _apiAuth, requirePermission } = require('./app/auth');
// /tally/bridge/* is the Tally bridge agent — a headless script on the finance PC, so it holds no JWT.
// It authenticates with a constant-time X-Bridge-Key compare inside app/api/tally.js (which refuses
// every request outright when TALLY_BRIDGE_KEY is unset).
// `/bot/*` is the EcomBot (Azure Bot Service) messaging endpoint. It carries a MICROSOFT-issued JWT,
// not one of ours, so our gate must let it through — teams_bot.js then verifies that token against
// Microsoft's published signing keys and requires audience == our App ID before acting on anything.
// ONLY the messaging endpoint is public — `/bot/health` reports configuration and stays behind our
// own JWT. A blanket /bot/ exemption would have published that diagnostic to the internet.
const PUBLIC_API = [/^\/login(\/(verify|resend)-otp)?$/, /^\/signup$/, /^\/webhook(\/|$)/, /^\/tally\/bridge\//, /^\/bot\/messages$/];
app.use('/api', (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (PUBLIC_API.some(rx => rx.test(req.path))) return next();
    return _apiAuth(req, res, next);
});

// Server-side per-dashboard authorization for view-specific API groups (UI hiding alone is not enough).
// Admins ('*') pass everything. SHARED endpoints (orders, easyecom, serviceability/EDD, reports, ad/adset)
// are intentionally NOT gated here — multiple dashboards consume them, so gating would break legit access.
const _VIEW_PERMS = [
    [/^\/docpharma/i, 'docpharma-recon'],
    [/^\/rapidshyp-(recon|payments)/i, 'rapidshyp-recon'],   // recon + its own payments ledger
    [/^\/kwikship-(recon|payments)/i, 'kwikship-recon'],     // same shape for KwikShip freight
    [/^\/pg-recon/i, 'gokwik-pg-recon'],                     // GoKwik payment-gateway reconciliation
    [/^\/fba\//i, 'amazon-fba'],
    [/^\/ops-control/i, 'ops-control'],
    [/^\/last-mile/i, 'last-mile'],               // Last-Mile Funnel dashboard (OFD → delivered / RTO), incl. /last-mile/shipment/:awb
    [/^\/purchase-orders/i, 'purchase-orders'],   // Inventory - Purchase Order (EasyEcom PO book)
    [/^\/ndr-action/i, ['ops-control', 'delivery-perf']],   // NDR reattempt/return — both ops surfaces use it
    // Shared shipment-detail lookup — read-only courier tracking used by the Delivery Performance table, the
    // Silent-RTO & SLA rows, AND the Customer Support "click AWB → live tracking" modal, so allow those views'
    // permissions. Must precede the general /delivery-performance rule.
    [/^\/delivery-performance\/shipment/i, ['delivery-perf', 'claims-sla', 'support-dashboard', 'support-queue', 'support-orders', 'support-calls', 'support-contacts']],
    [/^\/delivery-performance/i, 'delivery-perf'],
    [/^\/order-marks/i, 'delivery-perf'],
    [/^\/likely-fake-insight/i, 'delivery-perf'],
    [/^\/escalation-emails/i, 'delivery-perf'],
    [/^\/silent-rto-claims/i, 'claims-sla'],
    [/^\/late-deliveries/i, 'claims-sla'],
    [/^\/intransit-late/i, 'claims-sla'],
    [/^\/kwikship\//i, 'delivery-perf'],   // manual Kwikship tracking re-sync (cron runs nightly 2 AM)
    // Customer Support console — any support view permission unlocks its API group.
    [/^\/support\//i, ['support-dashboard', 'support-queue', 'support-orders', 'support-calls', 'support-contacts', 'support-blacklist', 'customer-profile']],
    // Customer Profile page (replaces Blacklist Numbers) — same audience. Issuing store credit is gated
    // a SECOND time inside the router by requirePermission('support-store-credit'), so being able to
    // view a customer never implies being able to hand out money.
    // Both keys accepted: the view was renamed support-blacklist -> customer-profile, and the DB is
    // shared with live, so users carry both until the old key is retired.
    [/^\/customer\//i, ['customer-profile', 'support-blacklist']],
    [/^\/voice-(config|order-lookup|order-list)/i, 'support-voice'],   // Voice Agent tool endpoints — permitted users / admins only
    // Influencer Marketing CRM — any influencer view permission unlocks its API group.
    [/^\/inf\//i, ['inf-dashboard', 'inf-discover', 'inf-influencers', 'inf-lists', 'inf-calendar', 'inf-mentions']],
    // Inventory Analytics. Stock Count (WH-only) + its deep Count Analysis (manager-only) are separate perms —
    // the more specific analysis rule must precede the count rule, which must precede the general rule.
    [/^\/inventory\/count\/analysis/i, ['inventory-count-analysis', 'inventory']],
    [/^\/inventory\/count/i, ['inventory-count', 'inventory']],
    [/^\/inventory\//i, 'inventory'],
    // Finance → Tally. Drafting and POSTING are deliberately separate rights: a junior can compose and
    // preview a voucher, but only someone holding finance-post-tally can send it into the books. The
    // post rule must precede the general one.
    // The general rule EXCLUDES /tally/bridge/* : being in PUBLIC_API only skips the JWT gate, not this
    // one, so without the lookahead the key-authenticated bridge agent (which carries no JWT, hence no
    // permissions) would match here and get a flat 403.
    // Batch approve/reject/build are admin-only, enforced inside tally_batch.js (a role check, which
    // _VIEW_PERMS cannot express). Listing batches is open to any finance user.
    [/^\/tally\/bank\//i, ['finance-entry']],   // bank import lives in Data Entry
    [/^\/tally\/batches/i, ['finance-entry', 'finance-register', 'finance-books']],
    [/^\/tally\/vouchers\/post-bulk/i, 'finance-post-tally'],   // admin-only is enforced inside tally.js too
    [/^\/tally\/vouchers\/[^/]+\/post/i, 'finance-post-tally'],
    // Read-only view of Tally's existing books — its own perm, so someone can be given visibility
    // into the accounts without any ability to draft or post. Must precede the general rule.
    [/^\/tally\/books\//i, ['finance-books', 'finance-entry', 'finance-register']],
    [/^\/tally\/(?!bridge\/)/i, ['finance-entry', 'finance-register', 'finance-books']],
];
app.use('/api', (req, res, next) => {
    const perms = (req.user && req.user.permissions) || [];
    if (perms.includes('*')) return next();
    for (const [rx, need] of _VIEW_PERMS) {
        if (rx.test(req.path)) return [].concat(need).some(n => perms.includes(n)) ? next() : res.status(403).json({ message: 'You do not have access to this section.' });
    }
    next();
});
// Kwikship manual re-sync — pull latest tracking for Kwikship-allocated orders on demand (the nightly
// 2 AM cron does this automatically). delivery-perf permission (rule above); admins pass.
app.post('/api/kwikship/sync', async (req, res) => {
    try {
        const days = Math.min(parseInt(req.body && req.body.days, 10) || 30, 90);
        const r = await syncKwikship({ days });
        res.json({ ok: !r.skipped, ...r });
    } catch (e) { console.error('[Kwikship] manual sync error:', e.message); res.status(500).json({ ok: false, message: e.message }); }
});

// Voice Agent tool endpoints — JWT-required (auth middleware above) + support-voice permission; admins pass.
// config: hand the browser tool its Sarvam key (from .env) + Supabase URL/anon key (for the call-log tables).
app.get('/api/voice-config', (req, res) => res.json({
    sarvamKey: config.SARVAM_API_KEY || '',
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: config.SUPABASE_ANON_KEY || '',
}));
// order lookup: proxied through the SERVICE key so the tool sees REAL orders WITHOUT opening anon read on the
// RLS-locked orders / shipment_journey_ecom tables. Returns the shape the tool's buildOrderContext expects.
const { supabase: _voiceSb } = require('./app/supabase');
app.get('/api/voice-order-lookup', async (req, res) => {
    try {
        const id = String(req.query.orderId || '').replace(/^#/, '').trim();
        if (!id) return res.status(400).json({ error: 'orderId required' });
        const { data: rows } = await _voiceSb.from('orders')
            .select('name, total_price, financial_status, fulfillment_status, awb_number, courier_name, tracking_status, created_at, order_shipping_addresses(first_name, last_name, name), order_line_items(title)')
            .or(`name.eq.#${id},name.eq.${id}`).limit(1);
        const order = rows && rows[0];
        if (!order) return res.json({ order: null, shipment: null });
        order._awb = order.awb_number || null;
        // order_shipping_addresses is a one-to-one embed → PostgREST returns an OBJECT (not array); line_items is
        // one-to-many → an array. Handle both shapes (same as normalizeSupabaseOrder in orders.js).
        const _saRaw = order.order_shipping_addresses;
        const _addr = Array.isArray(_saRaw) ? (_saRaw[0] || {}) : (_saRaw || {});
        order._customer = _addr.name || `${_addr.first_name || ''} ${_addr.last_name || ''}`.trim() || '';
        const _li = Array.isArray(order.order_line_items) ? order.order_line_items : (order.order_line_items ? [order.order_line_items] : []);
        order._product = _li.length ? (_li[0].title || '') + (_li.length > 1 ? ` +${_li.length - 1} more` : '') : '';
        let shipment = null;
        if (order.awb_number) {
            const { data: sj } = await _voiceSb.from('shipment_journey_ecom')
                .select('dispatched_at, out_for_delivery_at, delivered_at, rto_at, attempts, ndr_count, ndr_reasons, outcome, courier, dest_city, dest_state, first_edd')
                .eq('awb', order.awb_number).limit(1);
            shipment = (sj && sj[0]) || null;
        }
        res.json({ order, shipment });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// order list/search for the tool's Order-ID dropdown — recent orders, or matching ?q= (order name). Each row
// carries customer name + first product + total so the tool can auto-fill those fields on select.
app.get('/api/voice-order-list', async (req, res) => {
    try {
        const q = String(req.query.q || '').replace(/^#/, '').trim();
        let query = _voiceSb.from('orders')
            .select('name, total_price, created_at, order_shipping_addresses(first_name, last_name, name), order_line_items(title)')
            .order('created_at', { ascending: false }).limit(50);
        if (q) query = query.ilike('name', `%${q}%`);
        const { data } = await query;
        const out = (data || []).map(o => {
            const _sa = o.order_shipping_addresses;                 // one-to-one → object; handle object OR array
            const addr = Array.isArray(_sa) ? (_sa[0] || {}) : (_sa || {});
            const customer = addr.name || `${addr.first_name || ''} ${addr.last_name || ''}`.trim() || '';
            const li = Array.isArray(o.order_line_items) ? o.order_line_items : (o.order_line_items ? [o.order_line_items] : []);
            const product = li.length ? (li[0].title || '') + (li.length > 1 ? ` +${li.length - 1} more` : '') : '';
            return { name: o.name, customer, product, total: o.total_price };
        });
        res.json({ orders: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api', ordersRoutes);
app.use('/api', adsetRoutes);
app.use('/api', adRoutes);
app.use('/api', shippingRoutes);
app.use('/api', excelRoutes);
app.use('/api', pdfRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/easyecom', easyecomRoutes);
app.use('/api/amazon', requirePermission('amazon-review'), amazonReviewRoutes);
app.use('/api/amazon', requirePermission('amazon-review'), amazonAutoReviewRoutes);
app.use('/api/fulfillment-ops', requirePermission('fulfillment-ops'), fulfillmentOpsRoutes);
app.use('/api/serviceability', serviceabilityRoutes);
// Pincode → city/state autofill for the address forms. Shared: any logged-in user filling an address
// needs it, so it is deliberately NOT behind a dashboard permission (tokenRequired is inside the router).
app.use('/api', pincodeRoutes);
// Customer Profile (Customer Support) — 360 view, store credit, blacklist. Gated below by
// support-blacklist for the page; the store-credit WRITE additionally needs support-store-credit.
app.use('/api', customerProfileRoutes);
app.use('/api', deliveryReportsRoutes);
app.use('/api', opsControlRoutes);
app.use('/api', lastMileRoutes);
app.use('/api', purchaseOrderRoutes);
app.use('/api', amazonFbaRoutes);
app.use('/api', require('./app/api/teams').router);
app.use('/api', require('./app/api/email_replies').router);   // escalation reply threads + poll
app.use('/api', require('./app/api/support_console'));        // Customer Support console (queue/calls/notes/contacts)
app.use('/api', require('./app/api/user_activity').router);   // activity logging (POST /activity — any signed-in user)
app.use('/api', require('./app/api/influencer_crm'));          // Influencer Marketing CRM (discover/influencers/lists/calendar/mentions)
app.use('/api', require('./app/api/inventory').router);       // Inventory Analytics (daily snapshot dashboard + Teams report)
app.use('/api', require('./app/api/tally').router);           // Finance → Data Entry → Tally Prime (voucher queue + bridge)
app.use('/api', require('./app/api/tally_batch').router);     // Finance → nightly batch push + Teams approval
app.use('/api', require('./app/api/tally_bank').router);      // Finance → bank statement upload, ledger suggestion, draft creation
// Admin → Zone Mapping: upload Kwikship's pincode→zone sheet and re-derive `zone` on Kwikship
// shipments from it. The router gates itself with tokenRequired + requireAdmin.
app.use('/api', require('./app/api/zone_mapping'));
// EcomBot — the Teams bot messaging endpoint (POST /api/bot/messages) + /api/bot/health.
// Public in PUBLIC_API above because it authenticates with Microsoft's own JWT, verified inside.
app.use('/api', require('./app/api/teams_bot'));
app.use('/api', docpharmaReconRoutes);
app.use('/api', rapidshypReconRoutes);
app.use('/api', kwikshipReconRoutes);
app.use('/api', pgReconRoutes);
app.use('/api', docpharmaInvoiceRoutes);
app.use('/api', docpharmaLedgerRoutes);
app.use('/api', docpharmaOverviewRoutes);
app.use('/api', docpharmaInventoryRoutes);
initAutoReviewCron();
initFbaLocationCron();

// ── Finance → nightly Tally push ────────────────────────────────────────────────────────────────
// 23:45 warm the ledger masters so the 23:50 validation reflects Tally as it is right now (a ledger
// renamed during the day must not let a push silently create it afresh under Suspense).
const tallyBatch = require('./app/api/tally_batch');
cronJob('TallyBatch (45 23 * * *)', '45 23 * * *', async () => {
    if (String(config.TALLY_BATCH_CRON_ENABLED || '').toLowerCase() !== 'true') return;
    console.log('[TallyBatch] 23:45 IST — refreshing Tally masters ahead of the nightly push…');
    try { await require('./app/api/tally').syncMastersDirect(); }
    catch (_) { /* bridge mode: runNightly() asks the agent and waits, so this is just a fast path */ }
}, { timezone: 'Asia/Kolkata' });

// 23:50 build the batch, validate every draft, and post the Teams approval card. NOTHING is sent to
// Tally here — an admin's "yes" in Teams (or the dashboard) is what queues the vouchers.
cronJob('TallyBatch (50 23 * * *)', '50 23 * * *', async () => {
    // Check the flag BEFORE announcing the run, like the other three. runNightly() refuses on its own
    // too, but logging "building the nightly batch" and then silently doing nothing reads, in a log
    // people scan at a glance, exactly like a run that worked.
    if (String(config.TALLY_BATCH_CRON_ENABLED || '').toLowerCase() !== 'true') return;
    console.log('[TallyBatch] 23:50 IST — building the nightly Tally batch…');
    await tallyBatch.runNightly().catch(e => console.error('[TallyBatch] nightly error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// Watcher — every 2 min, report a batch to Teams once all of its vouchers are terminal. A cron rather
// than a hook inside /bridge/ack: if the agent dies mid-batch, this still notices and reports.
cronJob('TallyBatch (*/2 * * * *)', '*/2 * * * *', async () => {
    if (String(config.TALLY_BATCH_CRON_ENABLED || '').toLowerCase() !== 'true') return;
    await tallyBatch.checkOpenBatches().catch(e => console.error('[TallyBatch] watcher error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// Hourly — expire batches nobody approved; their vouchers return to draft for the next run, so nothing
// is lost and nothing is ever double-posted.
cronJob('TallyBatch (5 * * * *)', '5 * * * *', async () => {
    if (String(config.TALLY_BATCH_CRON_ENABLED || '').toLowerCase() !== 'true') return;
    await tallyBatch.expireStaleBatches().catch(e => console.error('[TallyBatch] expiry error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// Delivery-journey gap-fill — every 6h, refresh non-final shipments (webhooks handle real-time;
// this catches any misses). Skips shipments already delivered/RTO (is_final) → minimal API.
cronJob('Journey (45 */6 * * *)', '45 */6 * * *', async () => {
    console.log('[Journey] 6-hr gap-fill — refreshing non-final shipment journeys…');
    await backfillJourneys(30).catch(e => console.error('[Journey] gap-fill error:', e.message));
    // Integrity alarm. The gap-fill deliberately SKIPS final shipments, so a wrongly-finalized row is
    // invisible to it by design — which is exactly how 264 rows sat reading "Delivered" on parcels that
    // were still out for delivery, unnoticed for weeks. This costs 3 counting queries and makes that
    // state impossible to hide: any non-zero count names the repair to run (reprocessBadDelivered).
    await auditJourneyIntegrity().catch(e => console.error('[Journey audit] error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// Escalation reply poll — every 10 min, read the mail inbox (IMAP) for replies to sent critical
// emails, save them and AI-score resolution. No-op when no escalations were sent recently.
cronJob('EscMail (*/10 * * * *)', '*/10 * * * *', async () => {
    const { pollEscalationReplies } = require('./app/api/email_replies');
    await pollEscalationReplies().catch(e => console.error('[EscMail] cron error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// RapidShyp charges sync — nightly at 3:15 AM IST. Fetches freight (final_freights) + invoice value
// via the shipment_details API for FINAL shipments that haven't been priced yet, and backfills the
// promise EDD when missing. Drains the backlog in nightly batches and prices each new delivered/RTO.
cronJob('Charges (15 3 * * *)', '15 3 * * *', async () => {
    console.log('[Charges] 3:15 AM IST — syncing RapidShyp freight/value for newly-final shipments…');
    const r = await syncChargesBatch(2500).catch(e => { console.error('[Charges] nightly error:', e.message); return null; });
    if (r) console.log(`[Charges] nightly done — processed ${r.processed}, updated ${r.updated}`);
}, { timezone: 'Asia/Kolkata' });

// Daily inventory report → Microsoft Teams @ 06:30 IST. First re-syncs live from EasyEcom (rebuilds the
// snapshot) so the morning report reflects CURRENT stock, then posts the DOI image. (The Supabase pg_cron
// 'snapshot-inventory-daily-ist' @ 00:00 IST still keeps the dashboard fresh overnight.)
cronJob('Inventory (30 6 * * *)', '30 6 * * *', async () => {
    const inv = require('./app/api/inventory');
    console.log('[Inventory] 06:30 IST — syncing from EasyEcom then posting daily report to Teams…');
    await inv.refreshSnapshot().catch(e => console.error('[Inventory] EasyEcom sync error (posting last snapshot):', e.message));
    await inv.sendInventoryTeamsReport().catch(e => console.error('[Inventory] Teams report error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// DocPharma portal INGESTION — DocPharma doesn't webhook us (webhook_url is null), so every 3h we pull
// their latest orders from the partner portal (auto-login) → upsert docpharma_orders + fetch timelines.
// This is what actually captures NEW DocPharma orders. Also runs ~40s after startup.
cronJob('DP portal (40 */3 * * *)', '40 */3 * * *', async () => {
    console.log('[DP portal] 3-hr ingest — pulling DocPharma latest orders…');
    await ingestRecentDocpharmaOrders().catch(e => console.error('[DP portal] ingest error:', e.message));
}, { timezone: 'Asia/Kolkata' });
setTimeout(() => { ingestRecentDocpharmaOrders().catch(e => console.error('[DP portal] startup ingest error:', e.message)); }, 40000);

// Kwikship (GoKwik) tracking sync — DAILY at 2:00 AM IST. Kwikship is pull-only (no webhook). Refreshes
// journeys ONLY for Kwikship-allocated orders (raw_data.courier_aggregator_name = 'GoKwik Outbound') that
// aren't already final — one Kwikship API call per non-final shipment, zero wasted calls. Writes into the
// shared shipment_journey_ecom with source='kwikship'.
cronJob('Kwikship (0 2 * * *)', '0 2 * * *', async () => {
    console.log('[Kwikship] 2:00 AM IST — syncing tracking for Kwikship-allocated orders…');
    try { const r = await syncKwikship({ days: 30 }); console.log('[Kwikship]', r.skipped ? `skipped (${r.reason})` : `updated ${r.updated}/${r.processed} (of ${r.total} Kwikship orders)`); }
    catch (e) { console.error('[Kwikship] cron error:', e.message); }
    // Cost the shipments against the KwikShip rate card (zone × weight slab + RTO leg + COD fee) into the
    // same freight_* columns the RapidShyp freight lens reads. Pure SQL, no API calls. Runs AFTER the sync
    // so tonight's new shipments — and any whose outcome just became delivered/RTO — are priced correctly;
    // it is idempotent, so re-running only rewrites rows whose cost actually changed.
    // Costs against the rate card AND then fills anything KwikShip never sent — see applyKwikshipCharges().
    try {
        const { data, error, filled } = await applyKwikshipCharges();
        if (error) console.error('[Kwikship] charge recalc error:', error.message);
        else console.log('[Kwikship] charges:', JSON.stringify(data), filled ? `· filled ${JSON.stringify(filled)}` : '');
    } catch (e) { console.error('[Kwikship] charge recalc error:', e.message); }
}, { timezone: 'Asia/Kolkata' });

// New/Repeat classification — re-tag journey rows from Shopify's "Repeat" order tag. Pure SQL (0 API),
// via the refresh_journey_order_type() DB function. Daily at 2:30 AM IST + once shortly after startup.
cronJob('OrderType (30 2 * * *)', '30 2 * * *', async () => {
    console.log('[OrderType] Daily refresh — tagging journeys new/repeat from Shopify tags…');
    const { error } = await supabase.rpc('refresh_journey_order_type');
    if (error) console.error('[OrderType] refresh error:', error.message);
    // Sync destination state/city/pincode from the Shopify address (powers the State filter + Kerala→Zone E).
    const { error: e2 } = await supabase.rpc('refresh_journey_dest');
    if (e2) console.error('[JourneyDest] refresh error:', e2.message);
}, { timezone: 'Asia/Kolkata' });
setTimeout(() => {
    supabase.rpc('refresh_journey_order_type').then(({ error }) => {
        if (error) console.error('[OrderType] startup refresh error:', error.message);
        else console.log('[OrderType] startup new/repeat refresh done');
    });
    supabase.rpc('refresh_journey_dest').then(({ error }) => {
        if (error) console.error('[JourneyDest] startup refresh error:', error.message);
        else console.log('[JourneyDest] startup dest state/city refresh done');
    });
}, 60000);

// Payment-gateway labels for GoKwik PG reconciliation. The orders/create webhook already records the
// gateway, but on a COD or a slow UPI capture Shopify has no `payment_gateway_names` yet at that moment,
// so a nightly-ish sweep re-asks for anything still unlabelled. Cheap: only rows where gateway IS NULL,
// and only the last few days. Without it those orders sit permanently in the "excluded" bucket and the
// PG bill reads low.
cronJob('PG gateway labels (20 */3 * * *)', '20 */3 * * *', async () => {
    const r = await syncOrderGateways({ days: 5 });
    console.log(`[PG] gateway sweep — ${r.updated}/${r.checked} labelled`);
}, { timezone: 'Asia/Kolkata' });

// RS Sync — every 2 hours: last 7 days orders (skips 4 PM slot — MTD runs then)
cronJob('RS Sync (0 */2 * * *)', '0 */2 * * *', async () => {
    const istHour = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
    if (String(istHour) === '16') { console.log('[RS Sync] 2-hr skipping 4 PM slot — MTD cron will handle it'); return; }
    console.log('[RS Sync] 2-hr trigger — syncing last 7 days…');
    await syncLast7Days().catch(e => console.error('[RS Sync] 2-hr error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// RS Sync — daily at 4 PM IST: full MTD sweep
cronJob('RS Sync (0 16 * * *)', '0 16 * * *', async () => {
    console.log('[RS Sync] Daily 4 PM IST — syncing MTD…');
    await syncMTD().catch(e => console.error('[RS Sync] daily error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// Status Sync → Shopify — DISABLED pending review (was pushing stale/incorrect statuses).
// Re-enable only after verifying with a dry-run: `node app/api/fulfillment_ops.js status-sync 7 dry`
// cron.schedule('30 */6 * * *', async () => {
//     console.log('[StatusSync] 6-hr trigger — pushing RapidShyp/DocPharma statuses to Shopify…');
//     await syncStatusesToShopify(30).catch(e => console.error('[StatusSync] error:', e.message));
// }, { timezone: 'Asia/Kolkata' });

// Warehouse Ops report — Confirmed + Ready for Pickup + Unfulfillable, last 30 days, old→new, plus the
// "stuck in Ready for Pickup > 48h" highlight. Every 2 hours across the working day (08:30 → 20:30 IST,
// 7 runs) instead of the old 8:30 / 17:30 / 20:00 trio, so a parcel the courier keeps missing surfaces
// within two hours rather than at the next of three fixed times. Overnight is deliberately skipped —
// nobody acts on a 02:30 card, and each run does a live RapidShyp verify per pending AWB.
cronJob('WH Report (every 2h)', process.env.WH_REPORT_CRON || '30 8-20/2 * * *', async () => {
    console.log('[WH Report] 2-hourly — sending warehouse ops report (last 30d, −1)…');
    await sendWarehouseOpsReport(1).catch(e => console.error('[WH Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// Kept from the old 8 PM job, now standalone at 20:00 so it lands 30 min BEFORE the last report of the
// day: refresh the RapidShyp cache for ALL recent EasyEcom AWBs (forced — nothing skipped as "fresh")
// so the evening report is built on the freshest courier status.
cronJob('RS cache full refresh (0 20 * * *)', '0 20 * * *', async () => {
    console.log('[RS-EC Sync] 8:00 PM IST — full forced RapidShyp cache refresh…');
    await syncRsCacheEasyecom(30, { force: true }).catch(e => console.error('[RS-EC Sync] 8PM error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// DocPharma-rejected → dp-to-mwh-orders — DETECTION pass, last 30 days. Runs at :47 past each hour,
// 8 AM–7 PM IST (08:47 … 19:47). Detects + reports rejections and records them; the warehouse move
// is done by a SEPARATE, gentler auto-route pass 9 min later (:56) so the two never pile up in one
// heavy run. The Slack "rejected" word + CLI `dp` still trigger detection on demand.
cronJob('DP Report (47 8-19 * * *)', '47 8-19 * * *', async () => {
    const hr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    console.log(`[DP Report] ${hr}:47 IST — detecting DocPharma-rejected (last 30 days)…`);
    await sendDocpharmaRejectedReport().catch(e => console.error('[DP Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// Warehouse AUTO-ROUTE pass — runs at :56 past each hour (08:56 … 19:56), 9 min after detection.
// Gently moves the just-detected, not-yet-routed rejections to Shifupro (MWH) via the panel-session
// cookie, paced ~1 order/sec. Kept separate + slow on purpose so it never bursts and crashes.
cronJob('AutoRoute (56 8-19 * * *)', '56 8-19 * * *', async () => {
    const hr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    console.log(`[AutoRoute] ${hr}:56 IST — routing rejected orders → Shifupro…`);
    await autoRouteHandledRejections().catch(e => console.error('[AutoRoute] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// On-Hold report (EasyEcom + Shopify) — twice daily at 11 AM and 6 PM IST. Reads the synced
// b2c_order_easycom table + hold marks (NO EasyEcom API calls) and posts on-hold orders to Teams/Slack.
cronJob('Hold Report (0 11,18 * * *)', '0 11,18 * * *', async () => {
    console.log('[Hold Report] scheduled run (11 AM / 6 PM IST) — sending On-Hold report…');
    await sendEasyecomHoldReport().catch(e => console.error('[Hold Report] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// EasyEcom panel-session freshness watch — every 20 min. The VPS can't reach EasyEcom's panel (AWS
// WAF blocks its datacenter IP), so it can't ping/keep the session warm; the browser sync extension
// keeps the warehouse-routing cookie fresh by re-pushing it every ~20 min. This just watches that the
// cookie stays fresh and warns (server log) if it goes stale — i.e. the extension is offline.
// No-op when no session is saved.
cronJob('EE Session (*/20 * * * *)', '*/20 * * * *', async () => {
    try { const s = await require('./app/api/easyecom').pingPanelSession(); if (s === 'stale') console.warn('[EE Session] keep-alive: panel cookie STALE — the browser sync extension may be offline (re-paste, or restart it).'); }
    catch (e) { console.error('[EE Session] keep-alive error:', e.message); }
}, { timezone: 'Asia/Kolkata' });

// Shopify auto-hold BACKSTOP — every 2 min, hold repeat COD orders (same criteria as the Call Queue
// "Repeat" tab) on Shopify BEFORE EasyEcom imports them, so they can be phone-confirmed before shipping.
// The orders/create webhook does this instantly; this cron catches anything the webhook missed. Skips
// orders already held or manually released. OFF unless SHOPIFY_AUTOHOLD_ENABLED=true.
// ── ShopifyHold auto-hold backstop, hardened 2026-08-20 ─────────────────────────────────────────
// Six red cards in one hour on 20 Aug (22:20–23:20), every one a NETWORK error: `TypeError: fetch
// failed` (Node/undici's wrapper for DNS failures, resets and refused connections) and one axios
// `timeout of 20000ms exceeded`. Nothing was wrong with the job. Three separate faults made a blip
// look like an outage, and all three are fixed here:
//
//   1. NO OVERLAP GUARD. Two of those runs lasted 148s and 243s against a 120-SECOND schedule, so runs
//      were overlapping — concurrent batches hammering the same Shopify endpoint, which makes timeouts
//      MORE likely, which makes runs longer: a spiral that feeds itself. A run now skips if the
//      previous one is still going.
//   2. ONE BAD ORDER ABORTED THE BATCH. `holdOrderSmart` does live Shopify + Supabase calls; a throw on
//      order 7 abandoned the other 43 and surfaced as a whole-cron failure. Each order is isolated now
//      and its reason counted, so the run finishes and reports once.
//   3. ANY ERROR RAISED A CARD. `cron_report.js` turns console.error into an immediate ❌ card, and this
//      cron self-heals in TWO MINUTES — the bar for waking someone has to be higher than one blip. A
//      transient failure now WARNS; only SH_ALERT_AFTER consecutive failures (≈10 min of continuous
//      failure) escalate, then once an hour while it stays down. A non-transient error is still loud
//      immediately — a real bug must never be muffled by this.
const SH_TRANSIENT = /fetch failed|timeout of \d+ ?ms|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network error|Bad Gateway|Service Unavailable|Gateway Time/i;
const shTransient = e => SH_TRANSIENT.test(String((e && e.message) || e));
const SH_ALERT_AFTER = parseInt(process.env.SH_ALERT_AFTER, 10) || 5;   // × 2 min = 10 minutes down
let _shRunning = false, _shFails = 0, _shSkippedOverlap = 0;

cronJob('ShopifyHold (*/2 * * * *)', '*/2 * * * *', async () => {
    if (String(process.env.SHOPIFY_AUTOHOLD_ENABLED || '').toLowerCase() !== 'true') return;
    if (_shRunning) {
        // Never a card: the previous run is still working, and starting a second one is what turned a
        // slow window into a spiral. Counted so a persistent overlap is visible in the logs.
        if (++_shSkippedOverlap % 5 === 1) console.warn(`[ShopifyHold] previous run still going — skipped this tick (${_shSkippedOverlap} in a row)`);
        return;
    }
    _shRunning = true;
    try {
        const { findRepeatCandidates } = require('./app/api/support_console');
        const shopifyHold = require('./app/api/shopify_hold');
        const fromISO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const toISO = new Date().toISOString();
        // One retry on a transient lookup failure — "orders lookup failed: TypeError: fetch failed" was
        // one of the six cards, and a 2s wait clears almost every one of them.
        let cand;
        try { cand = await findRepeatCandidates({ fromISO, toISO }); }
        catch (e1) {
            if (!shTransient(e1)) throw e1;
            await new Promise(x => setTimeout(x, 2000));
            cand = await findRepeatCandidates({ fromISO, toISO });
        }
        let held = 0, skipped = 0, failed = 0;
        const reasons = new Map();   // message → count, for ONE summary line instead of a line per order
        for (const c of cand.slice(0, 50)) {
            try {
                const r = await shopifyHold.holdOrderSmart(c.order_name, c.order_id, shopifyHold.reasonNoteFrom(c.reasons), c.created_at);
                if (r.held) held++; else if (r.skipped) skipped++; else failed++;
                // Backstop for the sibling hold too — if the webhook missed the burst, catch the batch here.
                // Anything already imported into EasyEcom is reported as skipped (a Shopify hold is a no-op
                // there); those stay a manual EasyEcom-hold decision for the team.
                if (r.held) await shopifyHold.holdSiblingOrders({ phone: c.phone, excludeOrderName: c.order_name, reasonNote: shopifyHold.reasonNoteFrom(c.reasons) });
            } catch (e) {
                failed++;
                const m = String(e.message || e).slice(0, 80);
                reasons.set(m, (reasons.get(m) || 0) + 1);
            }
            await new Promise(x => setTimeout(x, 800));   // gentle — one order at a time
        }
        if (held || failed) console.log(`[ShopifyHold] auto-hold backstop: held ${held}, skipped ${skipped}, failed ${failed} of ${cand.length}`);
        // Per-order failures are a WARN, never a card: the next run is 120 seconds away and retries them.
        if (reasons.size) console.warn(`[ShopifyHold] ${failed} order(s) failed this run — ` + [...reasons].map(([m, n]) => `${n}× ${m}`).join(' · '));
        if (_shFails) { console.log(`[ShopifyHold] recovered after ${_shFails} failed run(s)`); _shFails = 0; }
        _shSkippedOverlap = 0;
    } catch (e) {
        _shFails++;
        if (!shTransient(e)) { console.error('[ShopifyHold] cron error:', e.message); return; }
        // Transient: warn while it is plausibly a blip, escalate once it is plainly an outage, then
        // hourly so a long outage is not forgotten after its single card.
        if (_shFails === SH_ALERT_AFTER || (_shFails > SH_ALERT_AFTER && _shFails % 30 === 0)) {
            console.error(`[ShopifyHold] cron error: ${e.message} — ${_shFails} consecutive failed runs (~${_shFails * 2} min). Upstream looks down.`);
        } else {
            console.warn(`[ShopifyHold] transient failure ${_shFails}/${SH_ALERT_AFTER} (${e.message}) — next run in 2 min`);
        }
    } finally { _shRunning = false; }
}, { timezone: 'Asia/Kolkata' });

// Silent-RTO claim mail → RapidShyp — weekly, Monday 9:30 AM IST, last 30 days ending yesterday.
// Lists shipments RTO'd with no delivery attempt + their forward/RTO freight (disputable). No-op if
// there are none or the RapidShyp recipient isn't set in Settings.
cronJob('Silent-RTO (30 9 * * 1)', '30 9 * * 1', async () => {
    console.log('[Silent-RTO] Mon 9:30 AM IST — sending weekly silent-RTO claim report to RapidShyp…');
    try { const r = await deliveryReportsRoutes.sendSilentRtoReport({ days: 30 }); console.log('[Silent-RTO]', r.skipped ? r.reason : `sent ${r.count} to ${r.to.join(', ')}`); }
    catch (e) { console.error('[Silent-RTO] error:', e.message); }
}, { timezone: 'Asia/Kolkata' });

// Late-delivery report (promise date exceeded, delivered only) — ONCE EVERY 15 DAYS (1st & 16th) at 9:45 AM
// IST, last 30 days ending yesterday. Sent to the configured internal recipients.
cronJob('Late-Del (45 9 1,16 * *)', '45 9 1,16 * *', async () => {
    console.log('[Late-Del] 9:45 AM IST (1st/16th) — sending fortnightly late-delivery report…');
    try { const r = await deliveryReportsRoutes.sendLateDeliveriesReport({ days: 30 }); console.log('[Late-Del]', r.skipped ? r.reason : `sent ${r.count} to ${r.to.join(', ')}`); }
    catch (e) { console.error('[Late-Del] error:', e.message); }
}, { timezone: 'Asia/Kolkata' });

// First-OFD-late report (first delivery attempt after the promised EDD — a courier SLA breach) — DAILY at
// 9:30 AM IST, terminal-stage date in the last 30 days ending yesterday. Sends SEPARATE emails per platform
// (RapidShyp rows → RapidShyp recipients, DocPharma rows → DocPharma recipients). No-op if empty.
cronJob('First-OFD (30 9 * * *)', '30 9 * * *', async () => {
    console.log('[First-OFD] 9:30 AM IST — sending daily first-OFD-late report…');
    try { const r = await deliveryReportsRoutes.sendFirstOfdReport({ days: 30 }); console.log('[First-OFD]', r.skipped ? r.reason : `sent ${r.count} to ${r.to.join(', ')}`); }
    catch (e) { console.error('[First-OFD] error:', e.message); }
}, { timezone: 'Asia/Kolkata' });

// In-transit-overdue report (still in transit past the promised EDD) — DAILY at 9:35 AM IST, last 30 days
// ending yesterday. SEPARATE emails per platform (RapidShyp / DocPharma). No-op if empty / recipient unset.
cronJob('Intransit-Late (35 9 * * *)', '35 9 * * *', async () => {
    console.log('[Intransit-Late] 9:35 AM IST — sending daily in-transit-overdue report…');
    try { const r = await deliveryReportsRoutes.sendIntransitLateReport({ days: 30 }); console.log('[Intransit-Late]', r.skipped ? r.reason : `sent ${r.count} to ${r.to.join(', ')}`); }
    catch (e) { console.error('[Intransit-Late] error:', e.message); }
}, { timezone: 'Asia/Kolkata' });

// RapidShyp cache sync for EasyEcom-shipped orders — every 3 hours + once at startup. Keeps the
// rapidshyp_tracking_ecom cache fresh so the warehouse report & ops dashboard read status from the
// DB (the report only live-verifies its final pending set at post time, not every order).
cronJob('RS-EC Sync (20 */3 * * *)', '20 */3 * * *', async () => {
    console.log('[RS-EC Sync] 3-hr trigger — refreshing RapidShyp cache for EasyEcom orders…');
    await syncRsCacheEasyecom().catch(e => console.error('[RS-EC Sync] error:', e.message));
}, { timezone: 'Asia/Kolkata' });
setTimeout(() => { syncRsCacheEasyecom().catch(e => console.error('[RS-EC Sync] startup error:', e.message)); }, 15000);

// ── Cron digest → Teams "Cron Response" ────────────────────────────────────────────────────────
// One roll-up of every job that ran since the last digest (runs · ok · failed + the last error), so
// successes are visible without a card per run. FAILURES don't wait for this — each posts instantly.
// Default 09:00 IST daily; override with CRON_DIGEST_SCHEDULE (e.g. '0 * * * *' for hourly).
cron.schedule(process.env.CRON_DIGEST_SCHEDULE || '0 9 * * *', async () => {
    const r = await sendCronDigest().catch(e => { console.error('[CronReport] digest error:', e.message); return null; });
    if (r && r.sent) console.log(`[CronReport] digest sent — ${r.jobs} jobs, ${r.runs} runs, ${r.failed} failed`);
}, { timezone: 'Asia/Kolkata' });

// Slack trigger — typing "rejected" in #dp-to-mwh-orders runs the MTD DocPharma report.
initDpSlackTrigger();

// Teams keyword listener (Graph) — the Teams-native replacement for the Slack inbound triggers:
// "rejected" in the DP channel runs the DocPharma check; "yes"/"no" in the Amazon channel
// approves/cancels the pending review send. No-op unless TEAMS_REFRESH_TOKEN + channel IDs are set.
require('./app/api/teams_listener').initTeamsListener();

// --- COD Confirmation Data (FROM SUPABASE) ---
// Page past Supabase's 1000-row select cap so ALL confirmations are returned (the old table has ~17k).
async function fetchAllCod(table) {
    const PAGE = 1000;
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
            .from(table)
            .select('id_key, data')
            .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < PAGE) break;
    }
    return rows;
}

app.get('/api/cod-confirmations', async (req, res) => {
    try {
        // Merge historical (cod_confirmations_ecom — frozen sheet data) with live MSG91 webhook
        // confirmations (cod_confirmations_msg91). A webhook confirmation supersedes the old sheet
        // row for the same order.
        const [oldRows, newRows] = await Promise.all([
            fetchAllCod('cod_confirmations_ecom').catch(e => { console.error('COD old fetch:', e.message); return []; }),
            fetchAllCod('cod_confirmations_msg91').catch(e => { console.error('COD new fetch:', e.message); return []; }),
        ]);

        // Dedup by normalized order key (strip leading '#', uppercase) so the same order isn't
        // returned twice; insert old first, then new (new overwrites).
        const norm = (k) => String(k || '').replace(/^#/, '').toUpperCase().trim();
        const byOrder = new Map();
        for (const r of oldRows) byOrder.set(norm(r.id_key), r.data || {});
        for (const r of newRows) byOrder.set(norm(r.id_key), r.data || {});
        res.json(Array.from(byOrder.values()));
    } catch (e) {
        console.error("Error fetching COD data:", e.message);
        res.status(500).json([]);
    }
});

// --- Serve Frontend ---
app.get('/', (req, res) => {
    // Never cache the app shell — otherwise browsers/phones keep showing an old index.html after a deploy.
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'app/templates/index.html'));
});


// --- EasyEcom Sync Strategy (250 API calls/month limit) ---
// PRIMARY: Webhook receives real-time order updates (0 API calls).
// STARTUP:  One sync on server start, but only if last sync was 6+ hours ago
//           to avoid burning calls on frequent restarts.
// NO automatic polling — every API call counts.

setTimeout(async () => {
    try {
        // Check when last sync ran via api_logs_ecom
        const { data: lastLog } = await supabase
            .from('api_logs_ecom')
            .select('created_at')
            .eq('action', 'easyecom_sync')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
        const lastSyncTime = lastLog ? new Date(lastLog.created_at).getTime() : 0;

        if (lastSyncTime > sixHoursAgo) {
            console.log(`[EasyEcom Sync] Skipping startup sync — last ran ${Math.round((Date.now() - lastSyncTime) / 60000)} min ago (saving API call)`);
            return;
        }

        console.log('[EasyEcom Sync] Running startup sync (1 of ~250 monthly API calls)...');
        const result = await syncEasyecomOrders(3); // only last 3 days on startup
        console.log(`[EasyEcom Sync] Startup sync complete: ${result.fetched} fetched, ${result.saved} saved`);
    } catch (e) {
        console.error('[EasyEcom Sync] Startup sync failed:', e.message);
    }
}, 8000);

// --- Start Server ---
app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${config.PORT}`);
});
