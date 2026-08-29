// Self-checks for logic that failed SILENTLY in production — the kind where nothing errors, nothing
// looks broken, and the screen just shows something old or the alert never fires. Those are the bugs
// worth a permanent test, because no amount of watching the dashboard reveals them.
//
// Run: npm run selftest        (no framework, no network, no DB — pure logic; exits non-zero on failure)
//
// Add a case here whenever a silent-failure bug is fixed. Not a general test suite; a regression net.

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
    ok ? pass++ : fail++;
}

// ── 1. Cache freshness (helpers.isCacheStale) ────────────────────────────────────────────────────
// Bug 2026-08-17: the shipment scan log was re-fetched ONLY when its cache was empty, so the first
// view froze the timeline forever. TE25-40754 showed "Out for delivery, 13 Aug" for four days while
// the parcel went RTO and kept scanning. 79 of 189 cached logs were stale when it was found.
{
    const { isCacheStale } = require(path.join(ROOT, 'app/api/helpers'));
    const ago = min => new Date(Date.now() - min * 60000).toISOString();
    const TTL = 30 * 60000;

    check('cache: upstream moved after capture → stale',
        isCacheStale({ capturedAt: '2026-08-13T07:36:58.649Z', signalAt: '2026-08-17T05:05:36.508Z', ttlMs: TTL }), true);
    check('cache: fresh capture, no newer signal → fresh',
        isCacheStale({ capturedAt: ago(5), signalAt: ago(10), ttlMs: TTL }), false);
    check('cache: no signal available, past TTL → stale',
        isCacheStale({ capturedAt: ago(90), ttlMs: TTL }), true);
    check('cache: frozen (delivered) ignores TTL → fresh',
        isCacheStale({ capturedAt: ago(90), ttlMs: TTL, frozen: true }), false);
    check('cache: frozen but signal is newer → stale (evidence beats assumption)',
        isCacheStale({ capturedAt: ago(90), signalAt: ago(10), ttlMs: TTL, frozen: true }), true);
    check('cache: never written → stale',
        isCacheStale({ capturedAt: null, ttlMs: TTL }), true);
    check('cache: unparseable timestamp → stale',
        isCacheStale({ capturedAt: 'not-a-date', ttlMs: TTL }), true);
    check('cache: no TTL and no signal → never ages out',
        isCacheStale({ capturedAt: ago(99999) }), false);
}

// ── 2. The scan log must not be served from a write-once cache ───────────────────────────────────
// Guards the shape of the fix, not just the helper: if someone restores "fetch only when empty", or
// drops the write-back, the freeze returns and no test of pure logic would notice.
{
    const src = fs.readFileSync(path.join(ROOT, 'app/api/delivery_reports.js'), 'utf8');
    check('scan log: staleness is decided by the shared rule', /isCacheStale\(\{/.test(src), true);
    check('scan log: refresh writes the new cache back (no only-when-empty guard)',
        /if \(j && !\(j\.raw && /.test(src), false);
    check('scan log: falls back to the stale copy when the courier is unreachable',
        /cachedScans && cachedScans\.length\) scans = cachedScans/.test(src), true);
}

// ── 3. Ad-set order status must come from the courier, not Shopify's fulfillment state ───────────
// Bug 2026-08-17: the Ad Set Breakdown (and its daily PDF) classified status from
// enriched_orders_ecom, where a Kwikship parcel's raw_rapidshyp_status is Shopify's "FULFILLED".
// That matches no courier keyword, so a DELIVERED Kwikship order counted as "Processing" for life.
// Over 30 days: 805 delivered orders missed (674 Kwikship) = ₹6.5 lakh of delivered revenue absent,
// and 221 RTOs uncounted — so ROAS read ~2× lower than reality. Nothing errored; the report was
// simply wrong, every day.
{
    const { normalizeStatus } = require(path.join(ROOT, 'app/api/helpers'));
    const kwikshipDelivered = { fulfillment_status: 'fulfilled', fulfillments: [{}] };

    check('adset: courier delivered beats Shopify FULFILLED',
        normalizeStatus(kwikshipDelivered, 'FULFILLED', null, 'delivered'), 'Delivered');
    check('adset: courier rto wins',
        normalizeStatus({}, 'OUT_FOR_DELIVERY', null, 'rto'), 'RTO');
    check('adset: courier lost maps to Exception',
        normalizeStatus({}, 'IN_TRANSIT', null, 'lost'), 'Exception');
    check('adset: WITHOUT the courier outcome the old bug reappears (Processing)',
        normalizeStatus(kwikshipDelivered, 'FULFILLED', null, null), 'Processing');
    // in_transit / ndr_pending must NOT override — the older fields carry a more specific live state
    check('adset: in_transit does not coarsen a live status',
        normalizeStatus({}, 'OUT_FOR_DELIVERY', null, 'in_transit'), 'In-Transit');
    check('adset: unknown outcome falls through to the existing logic',
        normalizeStatus({}, 'DELIVERED', null, 'something_new'), 'Delivered');

    // An UNDELIVERED scan is a failed delivery ATTEMPT, not a return. Counting it as RTO inflated the
    // rate on every ad set (49 orders MTD, RTO 23.6% → 21.8%). RTO requires an actual RTO/RETURN.
    check('adset: an undelivered scan is not an RTO',
        normalizeStatus({}, 'Undelivered - Consignee Unavailable', null, null), 'In-Transit');
    check('adset: an initiated RTO still counts',
        normalizeStatus({}, 'RTO_INITIATED', null, null), 'RTO');
    check('adset: a return still counts',
        normalizeStatus({}, 'RETURN TO ORIGIN', null, null), 'RTO');
    check('adset: courier verdict beats the raw text',
        normalizeStatus({}, 'UNDELIVERED', null, 'rto'), 'RTO');
    check('adset: undelivered is not mistaken for delivered',
        normalizeStatus({}, 'UNDELIVERED', null, null) === 'Delivered', false);

    // The join key must be selected, or every lookup silently misses and nothing changes.
    for (const f of ['app/api/adset_performance.js', 'app/api/excel_report.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        check(`adset: ${path.basename(f)} reads shipment_journey_ecom`, /shipment_journey_ecom/.test(src), true);
    }
    check('adset: adset_performance selects awb (the join key)',
        /const COLS = '[^']*\bawb\b/.test(fs.readFileSync(path.join(ROOT, 'app/api/adset_performance.js'), 'utf8')), true);
}

// ── 4. Order Insights: status from the courier, and honest delta colouring ───────────────────────
// Bug 2026-08-17: `pending` was defined as `orders.tracking_status is null`, a column never written
// for many orders — so 1,798 showed as "Pending Processing" when 644 were already delivered and only
// 91 were genuinely pending. The RPCs now read shipment_journey_ecom. These guards cover the client
// half: a period comparison must be requested, and pipeline-state cards must not be coloured as if
// they were performance.
{
    const orders = fs.readFileSync(path.join(ROOT, 'app/api/orders.js'), 'utf8');
    check('insights: endpoint returns the previous period', /prevTrend/.test(orders) && /prev:\s*pSummary/.test(orders), true);

    const app = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    check('insights: pending is not coloured good/bad',
        /Pending Processing[\s\S]{0,160}'flat'/.test(app), true);
    check('insights: in-transit is not coloured good/bad',
        /'In Transit',[\s\S]{0,200}'flat'/.test(app), true);
    check('insights: RTO is red when rising, not green',
        /'RTO',[\s\S]{0,160}insDelta\(sm\.rto, pv\.rto, 'down'\)/.test(app), true);
    check('insights: rates divide by SETTLED orders, not all orders',
        /const settled = counts\.delivered \+ counts\.rto/.test(app), true);
    // RTO% and cancellation% have DIFFERENT denominators (settled vs closed), so the combined figure
    // must be recomputed from counts. Summing the two percentages is arithmetically wrong.
    check('insights: combined loss is recomputed from counts, not summed from percentages',
        /\(\(counts\.rto \+ counts\.cancelled\) \/ closed\)/.test(app), true);
    check('insights: cancellation rate uses closed orders as its denominator',
        /const closed = settled \+ counts\.cancelled/.test(app) && /counts\.cancelled \/ closed/.test(app), true);
}

// ── 5. A "silent" RTO must mean the courier never attempted delivery ──────────────────────
// Bug 2026-08-18: silent was inferred as "RTO with no NDR record", which holds only for RapidShyp.
// Kwikship returns parcels without logging an NDR, so 139 of 143 Kwikship RTOs labelled "silent · no
// attempt" had an out-for-delivery scan in their own timeline. Only 4 were genuine.
{
    const src = fs.readFileSync(path.join(ROOT, 'app/api/delivery_reports.js'), 'utf8');
    const hasFn = src.match(/const hasAttemptEvidence = .*\r?\n/)[0];
    const isFn  = src.match(/const isSilentRto = .*\r?\n/)[0];
    // `const` stays inside the eval's own scope; `var` leaks into this block, which is what we need.
    eval((hasFn + isFn).replace(/const /g, 'var '));

    check('silent rto: an out-for-delivery scan means it WAS attempted (the Kwikship case)',
        isSilentRto({ outcome: 'rto', attempts: 0, ndr_count: 0, out_for_delivery_at: '2026-08-16T09:16:00Z' }), false);
    check('silent rto: a counted attempt means it WAS attempted',
        isSilentRto({ outcome: 'rto', attempts: 1, ndr_count: 0, out_for_delivery_at: null }), false);
    check('silent rto: a logged NDR means it WAS attempted',
        isSilentRto({ outcome: 'rto', attempts: 0, ndr_count: 2, out_for_delivery_at: null }), false);
    check('silent rto: no evidence anywhere → genuinely silent',
        isSilentRto({ outcome: 'rto', attempts: 0, ndr_count: 0, out_for_delivery_at: null }), true);
    check('silent rto: a delivered shipment is never silent',
        isSilentRto({ outcome: 'delivered', attempts: 0, ndr_count: 0, out_for_delivery_at: null }), false);
    // The chip and the explorer list must never disagree: the server ships one verdict per row and the
    // client filters on it. Re-testing ndr_count client-side is what made the chip say 4 and the list 143.
    check('silent rto: the server ships a per-row verdict', /silent: isSilentRto\(r\)/.test(src), true);
    {
        const app = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
        check('silent rto: the explorer filters on the server verdict, not ndr_count',
            /state==='rto_silent'\) list=list\.filter\(r=>r\.state==='rto' && r\.silent\)/.test(app), true);
        check('silent rto: no stale ndr_count test survives in the explorer',
            /rto_silent'\) list=list\.filter\(r=>r\.state==='rto' && \(r\.ndr_count\|\|0\)===0\)/.test(app), false);
    }
    // The first-attempt split must PARTITION tracked (delivered-1st + failed-1st + not-attempted), and
    // the failed cohort must account for every outcome including the rare `lost` — a breakdown whose
    // parts do not add up is worse than no breakdown.
    // ⚠️ THE CARD RENDERED BLANK THE FIRST TIME because the fields were added to summarizeAll() only —
    // that builds the COMPARISON period; the current period's kpis object is assembled separately in the
    // request handler. Any KPI field has to exist in BOTH or one period silently has none.
    check('first attempt: the split exists in BOTH period builders',
        (src.match(/faDelivered:/g) || []).length >= 2 && (src.match(/faTransit:/g) || []).length >= 2, true);
    // The four buckets must PARTITION tracked: delivered-1st / RTO-with-no-NDR / NDR cohort / still moving.
    check('first attempt: buckets are mutually exclusive by construction',
        /faRtoRows = rows\.filter\(r => r\.outcome === 'rto' && \(r\.ndr_count \|\| 0\) === 0\)/.test(src)
        && /faTransitRows = rows\.filter\(r => !\(r\.outcome === 'delivered' && r\.first_attempt_success\)/.test(src), true);
    // The NDR bucket must be the SAME cohort the NDR Recovery card counts, or the two cards state
    // different NDR totals for the same shipments.
    check('first attempt: NDR bucket uses the NDR-cohort definition (ndr_count > 0)',
        (src.match(/faNdrRows = rows\.filter\(r => \(r\.ndr_count \|\| 0\) > 0\)/g) || []).length >= 2, true);
    // Reattempting is a subset of in-transit, shipped as a server verdict like `silent` so the explorer
    // filter and the FASR card can never disagree.
    check('reattempting: the server ships a per-row verdict',
        /reattempting: r\.outcome === 'in_transit' && hasAttemptEvidence\(r\)/.test(src), true);
    {
        const app = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
        const html = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');
        check('reattempting: the explorer filters on the server verdict',
            /state==='reattempting'\) list=list\.filter\(r=>r\.reattempting\)/.test(app), true);
        check('reattempting: the option exists in the explorer dropdown',
            html.includes('value="reattempting"'), true);
    }
    check('reattempting: the in-transit breakdown row partitions in-transit',
        /transitBreakdown: \{ total: inTransit\.length,/.test(src)
        && /fresh: inTransit\.length - transitRetry\.length/.test(src), true);
    {
        const app2 = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
        const html2 = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');
        check('reattempting: both chips have a matching explorer filter',
            /state==='in_transit_fresh'\) list=list\.filter/.test(app2)
            && html2.includes('value="in_transit_fresh"'), true);
        check('reattempting: the breakdown row is rendered next to the RTO row',
            /dpTransit\(d\.transitBreakdown/.test(app2) && html2.includes('id="dp-transit"'), true);
    }
    // RTO is split two independent ways over the SAME total: by attempt evidence (attempted+silent) and
    // by NDR (RTO-1st + after-NDR). They OVERLAP — every silent RTO is inside RTO-1st — so each cut must
    // add to the total on its own and the four must never be summed together.
    check('rto cuts: the NDR cut is shipped as its own pair, not a third term',
        /first: faRtoRows\.length, afterNdr: rto\.length - faRtoRows\.length/.test(src), true);
    check('rto cuts: RTO 1st is a per-row server verdict',
        /rto_first: r\.outcome === 'rto' && \(r\.ndr_count \|\| 0\) === 0/.test(src), true);
    {
        const app3 = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
        const html3 = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');
        check('rto cuts: both new chips have explorer filters',
            /state==='rto_first'\) list=list\.filter\(r=>r\.rto_first\)/.test(app3)
            && /state==='rto_after_ndr'\) list=list\.filter/.test(app3)
            && html3.includes('value="rto_first"') && html3.includes('value="rto_after_ndr"'), true);
        check('rto cuts: silent is rendered as a SUBSET ("of which"), never as a third term of the sum',
            app3.includes('of which') && /RTO 1st.*no NDR/.test(app3)
            && !/chip\('rto_silent'[\s\S]{0,80}\+`<span class="text-slate-400">\+<\/span>`/.test(app3), true);
    }
    check('silent rto: the claims report still filters on rto_no_attempt + rapidshyp',
        src.includes("rto_no_attempt', true)") && src.includes("eq('source', 'rapidshyp')"), true);
}

// ── 4b. Status-changed must not depend on who had a tab open ────────────────────────────────────
// Bug 2026-08-18: the Undelivered tab dropped terminal shipments and THEN wrote undelivered_tracking,
// so the settled orders — the only ones Status-changed exists to show — were never recorded. 447 orders
// with a real NDR had no row at all. Order matters here and nothing else enforces it, so assert it.
{
    const src = fs.readFileSync(path.join(ROOT, 'app/api/support_console.js'), 'utf8');
    const queue = src.match(/router\.get\('\/support\/queue'[\s\S]*?\n\s*\} else \{ \/\/ repeat/)[0];
    const und = queue.slice(0, queue.indexOf("} else if (tab === 'changed')"));
    const changed = queue.slice(queue.indexOf("} else if (tab === 'changed')"));

    check('status changed: an undelivered order is recorded BEFORE the terminal filter can drop it',
        und.indexOf('rememberUndelivered(') >= 0 && und.indexOf('rememberUndelivered(') < und.indexOf('terminalByAwb('), true);
    check('status changed: nothing writes undelivered_tracking after rows has been filtered',
        /terminalByAwb\([\s\S]*undelivered_tracking/.test(und), false);
    check('status changed: the tab derives "was undelivered" from the courier journey, not from a page load',
        changed.indexOf('syncUndeliveredFromJourney(') >= 0
        && changed.indexOf('syncUndeliveredFromJourney(') < changed.indexOf("from('undelivered_tracking')"), true);
    // The population rule itself, exercised — not just its presence in the source. TE25-39935 is the
    // case that forced it: zero failed attempts, nine days past its promise date.
    eval(src.match(/function undeliveredMoment\(j\)[\s\S]*?\n\}\r?\n/)[0]);   // \r? — this file is CRLF
    const late = undeliveredMoment({ outcome: 'delivered', ndr_count: 0, first_edd: '2026-08-09T00:00:00Z',
        delivered_at: '2026-08-18T07:19:45Z', ofd_dates: ['2026-08-18T05:11:25Z'], order_date: '2026-08-03T13:18:38Z' })[0];
    check('status changed: a parcel delivered after its promised date counts as undelivered', !!late, true);
    check('status changed: it became undelivered when the promise broke, not at the late attempt',
        String(late).slice(0, 10), '2026-08-09');
    check('status changed: an on-time delivery with no failed attempt never enters the list',
        undeliveredMoment({ outcome: 'delivered', ndr_count: 0, first_edd: '2026-08-10T00:00:00Z',
            delivered_at: '2026-08-09T11:00:00Z', ofd_dates: ['2026-08-09T06:00:00Z'] })[0], null);
    check('status changed: a failed delivery attempt still counts on its own',
        !!undeliveredMoment({ outcome: 'in_transit', ndr_count: 2, first_edd: null, ofd_dates: ['2026-08-09T06:00:00Z'] })[0], true);
    check('status changed: an RTO is undelivered whatever its dates say',
        !!undeliveredMoment({ outcome: 'rto', ndr_count: 0, first_edd: '2026-08-20T00:00:00Z', ofd_dates: [] })[0], true);
    // fetchPaged(build, maxRows) — a numeric second argument silently truncates the candidate list.
    check('status changed: the candidate fetch has no silent row cap',
        /\.range\(f, t\),\s*\d+\)/.test(changed), false);
    // The rule is undelivered → DELIVERED or RTO. "Anything that is no longer undelivered" also catches
    // orders that are merely moving again, which are still open and belong on no settled list.
    check('status changed: the tab lists settled outcomes, not just "no longer undelivered"',
        [/SETTLED_BUCKETS\.includes\(r\.bucket\)/.test(changed),
         /!UNDELIVERED_BUCKETS\.includes\(r\.bucket\)/.test(changed)], [true, false]);
    check('status changed: settled means delivered + rto',
        /const SETTLED_BUCKETS = \['delivered', 'rto'\];/.test(src), true);
}

// ── 4c. Teams reports must survive a phone ──────────────────────────────────────────────────────
// Bug 2026-08-19 (reported from Teams mobile): the reorder table had grown to TEN columns — at phone
// width every header truncated to one letter — and the report image did nothing when tapped, because a
// card Image never opens Teams' viewer without an explicit selectAction. The column comment had already
// drifted from the code once (said 7, had 10), so both constraints are enforced here, through the REAL
// renderer rather than by grepping the source.
{
    const { buildCard } = require(path.join(ROOT, 'app/api/teams'));
    const inv = fs.readFileSync(path.join(ROOT, 'app/api/inventory.js'), 'utf8');
    const colTitles = [...inv.match(/const table = \{[\s\S]*?columns: \[([\s\S]*?)\]/)[1].matchAll(/title: '([^']*)'/g)].map(m => m[1]);
    check('teams mobile: the reorder table fits a phone (≤5 columns)', colTitles.length <= 5, true);
    const payload = { blocks: [
        { type: 'image', image_url: 'https://x.test/r.png', alt_text: 'r' },
        { type: 'table', columns: colTitles.map(t => ({ title: t })), rows: [colTitles.map(() => '1')] },
    ] };
    for (const rich of [false, true]) {
        const card = buildCard(payload, { rich }).attachments[0].content;
        const img = card.body.find(x => x.type === 'Image');
        // allowExpand = Teams' OWN full-screen viewer. A selectAction/Action.OpenUrl also fails this on
        // purpose: it opens the browser, which the user rejected — the image must expand inside Teams.
        check(`teams mobile: the ${rich ? 'bot (1.5)' : 'webhook (1.4)'} card image expands inside Teams`,
            [!!(img.msteams && img.msteams.allowExpand), !!img.selectAction], [true, false]);
        const tbl = card.body.find(x => x.type === (rich ? 'Table' : 'ColumnSet'));
        check(`teams mobile: the ${rich ? 'bot' : 'webhook'} table renders every column`, tbl.columns.length, colTitles.length);
    }
}

// ── 4d. PO SKU picker: a new product must be orderable the day it is created ────────────────────
// Bug 2026-08-19: the picker was built ONLY from PO history, so the FIRST order of every new SKU was
// impossible (TE-ABD1, created that afternoon, matched nothing). The fix unions the live EasyEcom
// product master. These pin the load-bearing parts of that union.
{
    const po = fs.readFileSync(path.join(ROOT, 'app/api/purchase_orders.js'), 'utf8');
    const ui = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    check('po picker: the catalogue reaches the live product master, not just PO history',
        /GetProductMaster/.test(po) && /neverOrdered: true/.test(po), true);
    // Bearer-only is a 403 on this endpoint (verified live) — losing the x-api-key header would break
    // the master fetch while every PO endpoint kept working, which is exactly the hard-to-spot kind.
    check('po picker: the master fetch sends both auth headers',
        /fetchProductMaster[\s\S]{0,600}'x-api-key': config\.EASYECOM_API_KEY/.test(po), true);
    check('po picker: bundles are not offered as purchasable',
        /product_type !== 'combo_product'/.test(po), true);
    // Master tax_rate is a fraction (0.05 = 5%); feeding it through unconverted would suggest 0% GST.
    check('po picker: the master tax fraction is converted to a percent', (() => {
        eval(po.match(/const pctFromFraction = [^\n]+\n/)[0].replace('const ', 'globalThis._pf = '));
        return [_pf(0.05), _pf(0.18), _pf(null), _pf(18)];
    })(), [5, 18, null, null]);
    check('po picker: the UI renders a never-ordered row instead of "₹null"',
        /neverOrdered \? `new/.test(ui) && /o\.lastPrice != null \? o\.lastPrice : o\.masterCost/.test(ui), true);
}

// ── 4e. Escalation sheet push: the row mapping is the contract with the courier ─────────────────
// The basket's sheet exit (2026-08-19) appends rows to a Google Sheet SHARED WITH RAPIDSHYP, so a
// mapping drift is visible to a partner, not just to us. These exercise the real helper functions.
{
    const src = fs.readFileSync(path.join(ROOT, 'app/api/delivery_reports.js'), 'utf8');
    const grab = name => src.match(new RegExp('(const|function) ' + name + '[\\s\\S]*?\\n(?=const |function |// |router)'))[0];
    eval(grab('sheetCourierName')); eval(grab('_istD')); eval(grab('sheetEdd')); eval(grab('sheetTypeFor'));
    check('escalation sheet: the courier cell uses the last-mile name the sheet filters on',
        [sheetCourierName('DelhiveryDirectSurface500G'), sheetCourierName('Ekart Brands'), sheetCourierName('Shadowfax')],
        ['Delhivery', 'Ekart', 'Shadowfax']);
    check('escalation sheet: an NDR shipment is typed Reattempt/Fake NDR whatever its EDD says',
        sheetTypeFor({ ndr_count: 2, first_edd: '2020-01-01' }), 'Reattempt/Fake NDR');
    check('escalation sheet: a breached promise with no attempt is typed EDD Breached',
        sheetTypeFor({ ndr_count: 0, first_edd: '2020-01-01' }), 'EDD Breached_no attempt');
    check('escalation sheet: the JWT is built with the options object, never positional args',
        /new google\.auth\.JWT\(\{ email:/.test(src) && !/new google\.auth\.JWT\([a-z]/.test(src), true);
    // A repeat push must be appended and MARKED, not skipped — the sheet's own Duplicate column is the
    // team's dedup mechanism, and silently dropping a row would hide a repeat escalation from them.
    check('escalation sheet: repeats are marked Duplicate, not silently skipped',
        /dup \? 'Duplicate' : ''/.test(src) && !/have\.has[\s\S]{0,80}continue/.test(src), true);
    // The sheet is shared WITH RapidShyp — a KwikShip/DocPharma AWB on it escalates to a partner who
    // never carried the parcel. Non-RS shipments must be filtered AND reported back (they stay in the
    // basket for the email), never silently dropped and never pushed.
    check('escalation sheet: only rapidshyp-sourced shipments are pushed',
        /source \|\| ''\)\.toLowerCase\(\) === 'rapidshyp'/.test(src), true);
    check('escalation sheet: skipped shipments are reported back, not swallowed',
        /skippedAwbs: skippedRows\.map/.test(src), true);
    const ui = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    check('escalation sheet: the basket keeps non-RapidShyp shipments after a push',
        /pushedAwbs \|\| awbs\)\.forEach\(a => \{ _dpBasket\.delete\(a\)/.test(ui), true);
    // The Agent column is a dropdown; a raw portal username gets the red not-on-the-list flag on every
    // row. The matcher must map "sugandhm881" to the sheet's own "Sugandh" and fall back visibly.
    eval(grab('matchAgentOption'));
    check('escalation sheet: the portal user maps to the sheet Agent dropdown',
        [matchAgentOption('sugandhm881@x', ['Diksha', 'Shaveta', 'Sugandh', 'Anadita', 'Ashish']),
         matchAgentOption('diksha@x', ['Diksha', 'Sugandh']),
         matchAgentOption('nobody@x', ['Diksha', 'Sugandh'])],
        ['Sugandh', 'Diksha', 'nobody']);
    // The bar's colours must live in real CSS — plain bg-slate-900 / bg-white\/10 / z-[60] are NOT in
    // the prebuilt tailwind.css, which is how the bar shipped as a white pill with white text.
    const css = fs.readFileSync(path.join(ROOT, 'app/static/smooth.css'), 'utf8');
    // A sheet push is NOT an email. It wore the ✉️ badge and the “Escalation sent — thread will
    // appear…” footer, telling the agent a mail was sent that never was (user, 2026-08-19).
    check('escalation sheet: a sheet push never wears the mail badge',
        /sheet_pushed: sheetSet\.has/.test(src) && /mark_type === 'critical_mail_sent'/.test(src), true);
    check('escalation sheet: the UI gives sheet pushes their own badge and viewer',
        /Pushed to escalation sheet/.test(ui) && /dp-view-sheet/.test(ui) && /dpSheetThreadHtml/.test(ui), true);
    // The agent's reason, typed at add-to-basket, must beat the batch override, which beats auto.
    // Skip stores an EXPLICIT '' and the sheet cell must stay BLANK - a truthiness test anywhere
    // in the chain would quietly resurrect the auto text the user asked to remove.
    check('escalation sheet: a skipped reason stays blank on the sheet, not auto-filled',
        /hasOwnProperty\.call\(perAwbReason/.test(src) && /a in _dpBasketReasons/.test(ui), true);
    check('escalation sheet: per-AWB reason wins over batch over auto',
        /hasOwnProperty\.call\(perAwbReason[\s\S]{0,220}reasonOverride \|\| sheetReasonFor\(j\)/.test(src), true);
    // The one add door is the Call Queue button; DP's add was removed 2026-08-19 on request.
    check('escalation sheet: adding to the basket asks for the reason',
        /dpBasketReasonModal\(awb,/.test(ui) && /_dpBasketReasons\[awb\] = reason/.test(ui), true);
    // 2026-08-19 refinements: the EDD column is the TEAM's to maintain (never filled from our
    // side), the TYPE is chosen per AWB at add time, and the basket also lives on the Call Queue
    // Undelivered tab (its home for the support team).
    check('escalation sheet: the EDD cell is never filled from our side',
        /'' \/\* EDD/.test(src) && !/sheetEdd\(j\.first_edd\), ''/.test(src), true);
    check('escalation sheet: per-AWB type wins over batch over auto',
        /perAwbType\[String\(j\.awb\)\] \|\| ''\)\.trim\(\) \|\| typeOverride \|\| sheetTypeFor\(j\)/.test(src), true);
    check('escalation sheet: the add popup asks for the type too',
        /dp-bk-type/.test(ui) && /_dpBasketTypes\[awb\] = ty/.test(ui), true);
    check('escalation sheet: the basket lives on the Call Queue Undelivered tab',
        /supBasketBtn/.test(ui) && /_supTab!=='und'\|\|!r\.awb_number/.test(ui.replace(/\s/g, '')), true);
    // Late 2026-08-19: no Auto in the type dropdown (agent picks a concrete type), non-RapidShyp
    // adds go straight in (their exit is the email), and the Undelivered tab shows WHEN each
    // escalation left (date+time from the marks) with the same response viewers as DP.
    // The dropdown mirrors the SHEET's own validation list (19 values today) via
    // /escalation-sheet/options — a hardcoded subset went stale the day it shipped. No Auto either.
    check('escalation sheet: the type dropdown is built from the sheet, with no Auto option',
        /dp-bk-type[\s\S]{0,140}types\.map\(t => `<option>/.test(ui)
        && /escalation-sheet\/options/.test(ui)
        && !/Auto — from the shipment/.test(ui), true);
    check('escalation sheet: the options endpoint reads the sheet validation',
        /escalation-sheet\/options[\s\S]{0,400}readValidationList\(sheets, 'G2:G2'\)/.test(src), true);
    // The bar's sheet exit exists only when the basket holds a RapidShyp order — an email-only
    // basket (KwikShip/DocPharma) must not offer a button the server would refuse.
    check('escalation sheet: the bar hides the sheet exit for an email-only basket',
        /rsN \? `<button id="dp-basket-sheet"/.test(ui) && /_dpBasketPlats\[a\] \|\| 'rapidshyp'/.test(ui), true);
    check('escalation sheet: a non-RapidShyp add skips the sheet popup',
        ui.split("toLowerCase()==='rapidshyp') dpBasketReasonModal").length === 2, true);
    check('escalation sheet: Delivery Performance no longer offers an add-to-basket',
        [/dp-basket-add/.test(ui), /dpBasketEligible/.test(ui)], [false, false]);
    check('escalation sheet: the Undelivered tab shows escalated date AND time',
        /escalated_at/.test(fs.readFileSync(path.join(ROOT, 'app/api/support_console.js'), 'utf8'))
        && /supDT\(r\.escalated_at\)/.test(ui) && /toLocaleTimeString/.test(ui), true);
    check('escalation sheet: the queue reuses the SAME response renderers as DP',
        /supEscThreadModal[\s\S]{0,1600}dpThreadHtml\(awb\)[\s\S]{0,600}dpSheetThreadHtml\(awb\)/.test(ui), true);
    check('escalation sheet: the basket bar is painted by real CSS, not phantom utilities',
        /#dp-basket-bar\{ background:#0f172a/.test(css) && !/bg-white\/10/.test(ui), true);
}

// ── 4e2. Call Queue hold/release/cancel: the row responds, the page does not reload ───────────
// 2026-08-20 user ask. Every action ended in supLoadQueue() — a full re-fetch that flashed the grid
// and lost the agent's place. The outcome is known at API success, so the row is patched in place;
// the 30s poll reconciles. Behavioural pin on the two helpers plus a structural one on the handlers.
{
    const ui = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    let repaints = 0;
    const supQueueTable = () => repaints++;
    let _supQueueRows = [{ order_id: 1, shopify_hold: null }, { order_id: 2 }];
    eval(ui.match(new RegExp('function supRowPatch.*'))[0]);
    eval(ui.match(new RegExp('function supRowDrop.*'))[0]);
    supRowPatch('1', r => { r.shopify_hold = { status: 'held' }; });
    check('call queue actions: a patch updates the row and repaints once',
        [_supQueueRows[0].shopify_hold.status, repaints], ['held', 1]);
    supRowDrop(1);
    check('call queue actions: cancel drops the row client-side',
        [_supQueueRows.length, _supQueueRows[0].order_id, repaints], [1, 2, 2]);
    // The five action handlers must not re-fetch the whole queue on success any more.
    const handlers = ui.slice(ui.indexOf('async function supDoHold'), ui.indexOf('async function supRefreshTracking'));
    check('call queue actions: no handler reloads the page/queue on success',
        (handlers.match(/supLoadQueue\(\)/g) || []).length, 0);
    check('call queue actions: every success path answers through the row',
        (handlers.match(/supRowPatch\(|supRowDrop\(/g) || []).length >= 5, true);
    // Shopify release and EasyEcom release must stay the SAME experience (user, 2026-08-20):
    // emerald 'go' confirm popup that turns into the loader while the API runs.
    const rel = f => { const fn = ui.slice(ui.indexOf('async function ' + f)); return ['tone:' + String.fromCharCode(39) + 'go', 'busyTitle:`Releasing', 'work:()=>supFetch'].every(x => fn.slice(0, 900).includes(x)); };
    check('call queue actions: both releases share the confirm-then-loader popup',
        [rel('supDoUnhold'), rel('supDoEeUnhold')], [true, true]);
    check('call queue actions: hold and cancel show a busy popup, not button text',
        (handlers.match(/supBusyModal\(/g) || []).length >= 2 && !/textContent='(Holding|Releasing|Cancelling)/.test(handlers), true);
    // The result must be SHOWN in the popup (user, 2026-08-20: 'Unhold successfully is not showed').
    // Success = a ✓ beat that closes itself; errors stay until Read via a Close button.
    check('call queue actions: success and failure are shown in the popup itself',
        [/successTitle/.test(ui) && (handlers.match(/successTitle:/g) || []).length >= 3,
         (handlers.match(/busy\.success\(/g) || []).length >= 2,
         /supcf-errclose/.test(ui) && /supbm-close/.test(ui)], [true, true, true]);
}

// ── 4f. WH Ops report: pickup sections grouped by Platform · Courier ───────────────────────
// 2026-08-20 user ask: the WH team chases a specific courier's van, so Ready-for-Pickup and Stuck
// name the platform and courier per group. Exercised through the real helpers.
{
    const src = fs.readFileSync(path.join(ROOT, 'app/api/warehouse_slack_report.js'), 'utf8');
    const grab = name => src.match(new RegExp('(const|function) ' + name + '[\\s\\S]*?\\n(?=const |function |async function |// )'))[0];
    const normName = n => String(n || '').replace('#', '').trim();
    eval(grab('PLATFORM_LABEL_WH')); eval(grab('courierShort')); eval(grab('groupByCourier'));
    check('wh report: courier names are normalised without losing identity',
        [courierShort('Delhivery Enterprise'), courierShort('Blue Dart Air'), courierShort('Speed Post'), courierShort('Shree Maruti Surface')],
        ['Delhivery', 'Bluedart', 'Speed Post', 'Shree Maruti']);
    // A freshly-labelled parcel has no journey row until its first courier scan, so the lookup
    // must fall back to EasyEcom's own allocation (2026-08-20: two Shree Maruti orders read
    // "No courier assigned yet" three hours after manifest). Structural pin on the fallback.
    check('wh report: pre-scan parcels fall back to the EasyEcom allocation',
        /const missing = uniq\.filter\(n => !map\[n\]\)/.test(src) && /courier_aggregator_name/.test(src), true);
    const pc = { 'TE25-1': { platform: 'RapidShyp', courier: 'Delhivery' }, 'TE25-2': { platform: 'RapidShyp', courier: 'Delhivery' }, 'TE25-3': { platform: 'KwikShip', courier: 'Shadowfax' } };
    const g = groupByCourier([{ name: '#TE25-1' }, { name: '#TE25-2' }, { name: '#TE25-3' }, { name: '#TE25-4' }], pc);
    check('wh report: groups sort largest first, unassigned last',
        g.map(x => x[0]), ['RapidShyp · Delhivery', 'KwikShip · Shadowfax', 'No courier assigned yet']);
    check('wh report: the stuck list is grouped by the courier to chase',
        /stuckBlocks\(stuck, pc\)/.test(src) && /groupedOrderBlocks\('Ready for Pickup'/.test(src) && /groupedOrderBlocks\('Confirmed'/.test(src), true);
    check('wh report: a dry run builds the payload and posts nothing',
        /if \(dry\) \{ console\.log\('\[WH Report\] DRY RUN[\s\S]{0,60}return payload; \}/.test(src), true);
}

// ── 4g. Open-PO lookup: one EasyEcom flake must not silently over-state every reorder qty ───────
// 2026-08-20, 06:30 report: 'Open POs could not be read' — reproduced fine seconds later. The lookup
// now retries once, then serves its last good copy flagged stale; throwing is the last resort.
{
    const po = fs.readFileSync(path.join(ROOT, 'app/api/purchase_orders.js'), 'utf8');
    const inv = fs.readFileSync(path.join(ROOT, 'app/api/inventory.js'), 'utf8');
    check('open po: a failed fetch retries before giving up',
        /fetch failed, retrying in 3s/.test(po), true);
    check('open po: the last good copy is served flagged stale, not dropped',
        /_lastGoodOpenPo, stale: true/.test(po.replace(/\s+/g, ' ')) || /\.\.\._lastGoodOpenPo, stale: true/.test(po.replace(/\s+/g, ' ')), true);
    // A short-closed PO (goods came by an unlinked GRN, PO marked Completed) keeps its pending
    // frozen forever - 4,717 phantom inbound units were suppressing reorders (2026-08-20).
    check('open po: a Completed PO never counts as inbound stock',
        /const PO_DEAD = new Set\(\[4, 5, 7\]\)/.test(po), true);
    // -- An RTO's charges change, and we used to read them ONCE ----------------------------------
    // RapidShyp re-prices a parcel when it turns around: they add the return leg and REMOVE the COD
    // collection fee. Checked against their live API one day after an RTO -- ours said rto 0 / cod
    // 29.50 / total 80.24, theirs said rto 50.74 / cod 0 / total 101.48.
    //
    // The old select asked for `charges_fetched_at IS NULL`, i.e. each shipment was priced ONCE, EVER,
    // so anything that RTO'd after pricing kept its pre-RTO snapshot: 982 RTOs with no return leg and
    // freight understated by ~25,182 rupees. (Two earlier theories were wrong before this one: that
    // RapidShyp was over-charging, then that they billed the leg 45 days later. Both were OUR lag.)
    const djApi = fs.readFileSync(path.join(ROOT, 'app/api/delivery_journey.js'), 'utf8');
    const rsApi = fs.readFileSync(path.join(ROOT, 'app/api/rapidshyp_recon.js'), 'utf8');
    const rsUi = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    check('charges: a shipment is no longer priced once and never re-read',
        [/\.eq\('outcome', 'rto'\)\.eq\('freight_rto', 0\)/.test(djApi), /RTO_REPRICE_GRACE_MS/.test(djApi)],
        [true, true]);
    // Re-pricing is driven by SHAPE, not age -- an RTO with no return leg is unfinished whatever its date.
    check('charges: the re-price queue is oldest-RTO-first so a backlog drains in order',
        /\.order\('rto_at', \{ ascending: true \}\)/.test(djApi), true);
    // A stale-select failure must never stop brand-new shipments being priced.
    check('charges: a stale-RTO lookup failure still lets new shipments price',
        /stale-RTO select failed \(new shipments still priced\)/.test(djApi), true);
    // The recon flag now means "our copy is behind", not "they under-billed" or "wait 45 days".
    check('rapidshyp recon: a missing return leg reads as OUR sync being behind',
        [/flags\.push\('rto_leg_stale'\)/.test(rsApi), /RTO_REPRICE_GRACE_HOURS/.test(rsApi),
         !/RTO_BILL_LAG_DAYS/.test(rsApi)], [true, true, true]);
    // "Not synced" must mean we have NOT LOOKED since the RTO, not merely that a leg is missing.
    // Flagging on shape alone warned about all 24 remaining legless RTOs -- every one already re-read
    // after its RTO and matching RapidShyp exactly, 0.0d to 89.0d old. A warning that fires on correct
    // data is worse than none, because it teaches people to ignore it.
    check('rapidshyp recon: stale means our snapshot predates the return, not just a missing leg',
        [/readSinceRto/.test(rsApi), /legMissing && !readSinceRto/.test(rsApi),
         /cod > 0 && legMissing && readSinceRto/.test(rsApi)], [true, true, true]);
    // ...and the claims panel and its KPI line must apply the SAME test, or they disagree with the recon.
    check('claims: the panel and KPI use the same re-read test as the recon',
        [/const readSince = /.test(rsUi), /&& !readSince;/.test(rsUi),
         /!\(r\.charges_fetched_at && new Date\(r\.charges_fetched_at\)/.test(rsUi)], [true, true, true]);
    // The re-price queue must keep asking while the RETURN is still travelling — RapidShyp bills the
    // leg when the parcel gets BACK, and TE25-40292 / TE25-41443 were still IN_TRANSIT 4-5 days in —
    // but it must also CLOSE, or it re-reads settled shipments for ever (returns at 54, 71 and 89 days
    // genuinely carry no leg). So: at most once a day, and give up after RTO_RECHECK_MAX_DAYS.
    check('charges: the re-price queue re-checks daily and then gives up',
        [/const RTO_RECHECK_MAX_DAYS = 60;/.test(djApi),
         /new Date\(r\.charges_fetched_at\)\.getTime\(\) <= dayAgo/.test(djApi),
         /new Date\(r\.rto_at\)\.getTime\(\) < oldestWorthAsking/.test(djApi)], [true, true, true]);

    check('rapidshyp recon: the understatement is estimated rather than ignored',
        [/rtoLegStaleEst/.test(rsApi), rsUi.includes('data-flag=' + String.fromCharCode(34) + 'rto_leg_stale')],
        [true, true]);
    // Billed figures are still never rewritten -- the correction comes from re-reading their API.
    check('rapidshyp recon: the billed figures are never rewritten locally',
        /cod_charges: c\.cod/.test(rsApi) && !/cod_charges: isRto \? 0/.test(rsApi), true);
    // The claims panel showed forward + RTO 0 against a bigger total and never named the COD fee.
    check('claims panel: the COD fee and the un-synced return leg are both named',
        [/COD fee: /.test(rsUi), /not synced yet/.test(rsUi), /Billed: /.test(rsUi)],
        [true, true, true]);

    // -- COD confirmation is sent DIRECT via MSG91, not through n8n + a Google Sheet --------------
    // Asked for: "make it with our own system direct, not with any workflow". Ships DISABLED: n8n is
    // still sending today, and running both double-messages every customer.
    const mc = fs.readFileSync(path.join(ROOT, 'app/api/msg91_cod.js'), 'utf8');
    const wh = fs.readFileSync(path.join(ROOT, 'app/api/webhook_handler.js'), 'utf8');
    const srv3 = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('msg91 cod: disabled until every credential AND the enable flag are set',
        /MSG91_COD_SEND_ENABLED/.test(mc) && /&& !!AUTH\(\) && !!WA_NUMBER\(\)/.test(mc), true);
    // The template name is CODE, not configuration — it is not a secret, and renaming the message this
    // feature exists to send should be reviewed like a code change (user, 2026-08-24).
    check('msg91 cod: the template name lives in code, not in .env',
        /const COD_TEMPLATE_NAME = 'cod_confirmation_v1';/.test(mc) && !/process\.env\.MSG91_COD_TEMPLATE/.test(mc), true);
    // The language code must match the template's registration EXACTLY. Sends with 'en'/'en_US' were
    // accepted with status:success and never delivered -- WhatsApp drops a language-mismatched template
    // at delivery with no error back through MSG91. en_GB and the namespace come from MSG91's own curl.
    check('msg91 cod: language and namespace match the registered template',
        [/const COD_TEMPLATE_LANG = 'en_GB';/.test(mc),
         /const COD_TEMPLATE_NAMESPACE = '76ec8535_ee9d_416e_b89d_8c2362647b62';/.test(mc),
         /language: \{ code: COD_TEMPLATE_LANG/.test(mc)], [true, true, true]);
    // Insert-then-send with a UNIQUE order_name: a crash can lose one message, never send it twice.
    check('msg91 cod: the send log is written BEFORE the API call and dedupes on order_name',
        [/Log BEFORE sending/.test(mc), /23505/.test(mc),
         /unique/.test(fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260824_cod_confirm_sends.sql'), 'utf8'))],
        [true, true, true]);
    // ⚠ THE PLAN CHANGED THE SAME DAY IT SHIPPED: no automatic sending, ever. The webhook trigger and
    // the 15-min backstop cron were REMOVED — messages go out only from the Call Queue popup, after the
    // agent approves a rendered preview. These assert the auto-paths stay dead.
    check('msg91: no automatic sending — webhook and cron triggers are gone',
        [/sendForWebhookOrder\(o\)/.test(wh), /MSG91-COD backstop/.test(srv3)], [false, false]);
    const wa = fs.readFileSync(path.join(ROOT, 'app/api/msg91_wa.js'), 'utf8');
    const waUi = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    // Templates are ROWS: name, exact language, namespace, variable mapping and preview body all live in
    // wa_template_sequences_msg91 — adding V2/V3 or a whole new sequence is an INSERT, never a deploy.
    check('msg91 wa: templates and sequences are data, resolved from the registry table',
        [/wa_template_sequences_msg91/.test(wa), /variables \|\| \[\]/.test(wa), /body_text/.test(wa)],
        [true, true, true]);
    // The button IS the progression: the server picks the first unsent version, and the UNIQUE
    // (order,sequence,version) row is the turnstile — two agents cannot both send V1.
    check('msg91 wa: the server decides the next version and the unique key blocks double-sends',
        [/find\(t => !done\.has\(t\.version\)\)/.test(wa), /23505/.test(wa),
         /sequence complete/.test(wa)], [true, true, true]);
    // Nothing sends without the agent seeing the rendered message first.
    check('msg91 wa: a rendered preview gates every send',
        [/renderPreview/.test(wa), /supWaPreview/.test(waUi), /Send V\$\{d\.version\} now/.test(waUi)],
        [true, true, true]);
    // The test allowlist still guards the manual path — 41 customers were messaged once already.
    // The operator's stated flow, encoded server-side: V1 free; V(n+1) only after a NO-ANSWER call
    // logged since V(n) went out. Proven live: send while locked -> HTTP 423 with the reason; one
    // no_answer call row -> V2 unlocked and its preview rendered.
    check('msg91 wa: later versions unlock only after a no-answer call since the previous send',
        [/NO_CONTACT_OUTCOMES/.test(wa), /nextAvailable/.test(wa), /423/.test(wa),
         /cl\.called_at\)\.getTime\(\) > prevAt/.test(wa)], [true, true, true, true]);
    // Logging a call updates the modal IN PLACE (user: the page must not reload) and re-evaluates the
    // WhatsApp buttons -- a no-answer log is exactly what unlocks the next version.
    check('call queue: logging a call never rebuilds the modal, and refreshes the WA buttons',
        [/supd-calls-list/.test(waUi), /insertAdjacentHTML\('afterbegin'/.test(waUi),
         /supWaButtons\(o\.order_name\|\|o\.order_id/.test(waUi)], [true, true, true]);
    check('msg91 wa: the allowlist guards manual sends too',
        /allowlistBlocks\(orderName, order\.phone\)/.test(wa), true);
    // Only genuine live COD with a reachable phone; every skip carries its reason.
    // ⚠ 41 real customers were double-messaged when the enable flag met a fresh server start: the
    // backstop read its 24h lookback as “missed” orders. The lookback was meant as the blast limiter
    // and it WAS the blast. The rule now: an un-logged order older than the 2h send window is SEALED
    // (status seeded, nothing sent) — a webhook miss is caught in minutes; older is history, and
    // history is never messaged. Holds across flag flips, restarts and downtime.
    // The operator's explicit instruction after 41 customers were messaged during testing: "Test only
    // that which I said -- mobile number or order." While MSG91_COD_ALLOWLIST is set, anything not on
    // it is refused regardless of every other flag -- the accident is structurally impossible.
    check('msg91 cod: the test allowlist blocks everyone not explicitly named',
        [/function allowlistBlocks/.test(mc), /MSG91_COD_ALLOWLIST/.test(mc),
         /const gate = allowlistBlocks\(orderName, phone\);/.test(mc)], [true, true, true]);
    check('msg91 cod: the backstop can only ever send orders younger than the send window',
        [/BACKSTOP_SEND_WINDOW_MS = 2 \* 60 \* 60 \* 1000/.test(mc), /status: 'seeded'/.test(mc),
         /history is never messaged/.test(mc)], [true, true, true]);
    check('msg91 cod: prepaid, cancelled, test and phone-less orders are refused with a reason',
        [/not COD \(financial_status=/.test(mc), /'cancelled'/.test(mc), /'test order'/.test(mc), /'no usable phone'/.test(mc)],
        [true, true, true, true]);

    // A sent chip is a RECEIPT: clicking it shows the exact message that went out, rendered from
    // the fields snapshotted at send time — not today's values, which may have drifted since.
    check('msg91 wa: sent chips carry the send-time message text and open a viewer',
        [/sent_text: sentText/.test(wa), /done\.payload\.fields \? renderPreview\(t, done\.payload\.fields\)/.test(wa),
         /supd-wa-chip/.test(waUi), /function supWaSentView/.test(waUi)], [true, true, true, true]);
    // The chat is merged by PHONE from the only three stores that hold pieces of it: msg91_messages
    // (outbound mirror — direction is ALWAYS '1', it holds no replies), wa_sends_msg91 (our manual
    // sends with rendered text), cod_confirmations_msg91 (the sole inbound store). Our send and its
    // sync mirror are the same message — the ±5 min dedupe keeps it from showing twice.
    check('msg91 wa: /support/wa/chat merges outbound mirror + our sends + replies, deduped',
        [/router\.get\('\/support\/wa\/chat'/.test(wa), /cod_confirmations_msg91/.test(wa),
         /mirrored/.test(wa), /< 5 \* 60000/.test(wa),
         /data->>Shipping Phone Number/.test(wa)], [true, true, true, true, true]);
    // The order popup's message card is a real chat (mini, scrollable, newest visible) with a
    // full-history popup — replacing a card that was permanently "No messages" because it queried
    // by orders.phone, which is null here; the chat endpoint resolves the ADDRESS phone.
    check('msg91 wa: the order popup shows a chat fed by the address phone, plus a full-chat popup',
        [/function supWaChat\(/.test(waUi), /function supWaChatModal/.test(waUi),
         /supd-wachat-full/.test(waUi), /host\.scrollTop=host\.scrollHeight/.test(waUi),
         /Recent MSG91 messages/.test(waUi)], [true, true, true, true, false]);
    // "I want to see complete chat, not cod_confirmation_v1 (text not stored)": the sync stopped
    // copying variables into the content column, but they always ride in raw_data.content — the chat
    // reads both, and any template whose body_text is in the registry renders the COMPLETE sentence
    // regardless of who sent it (our button, n8n, a campaign). Our own send-time render outranks the
    // mirror's bare variables when the two are merged.
    check('msg91 wa: chat recovers text from raw_data and renders registry templates in full',
        [/raw_content:raw_data->>content/.test(wa), /renderFromVars/.test(wa),
         /bodyByName/.test(wa), /if \(text && !mirror\.text\) mirror\.text = text/.test(wa)],
        [true, true, true, true]);
    // Placement (user, twice): not at the bottom, and not in the top header — the WhatsApp send
    // button and sent chips live INSIDE the WhatsApp chat card, with the conversation they belong to.
    check('msg91 wa: the send button and chips live in the chat card, not the modal header',
        [/id="supd-wa" class="flex items-center gap-1\.5 flex-wrap mb-2"/.test(waUi),
         /supd-wa"[^\n]*supd-logcall/.test(waUi)], [true, false]);
    // Dashboard OTPs go WHATSAPP-FIRST (2026-08-26): dashboard_otp_v1 AUTHENTICATION template,
    // code in body_1 AND the copy-code button; email is the automatic fallback so a template
    // hiccup can never lock the team out; 2FA counts as configured if EITHER channel works; and
    // staff numbers are deliberately NOT gated by the customer allowlist. Proven live: real OTP
    // delivered to the admin's WhatsApp.
    {
        const om = fs.readFileSync(path.join(ROOT, 'app/otp_mail.js'), 'utf8');
        check('otp: WhatsApp-first with email fallback, both channels count as configured',
            [/dashboard_otp_v2/.test(om), /button_1: \{ subtype: 'url'/.test(om),
             /falling back to email/.test(om), /if \(waConfigured\(\)\) return true;/.test(om),
             /NOT gated by MSG91_COD_ALLOWLIST/.test(om)],
            [true, true, true, true, true]);
    }
    // AUTOMATIC WhatsApp (2026-08-26 plan): cod_auto (instant V1 on Shopify orders/create +
    // 30-min V2 reminder if no reply), ndr_auto (attempt-driven V1/V2 + RTO V3 from
    // shipment_journey_ecom), cod_hold (manual, hold-gated, sequential unlock). All proven live:
    // instant send + reminder delivered to the allowlisted phone; NDR bootstrap sealed 1,008
    // pre-existing trigger states as 'seeded' — history is never messaged; re-ticks are silent.
    check('wa auto: engines exist, allowlist-gated, turnstile-logged, seed-sealed',
        [/async function performAutoSend/.test(wa), /autoCodOnCreate/.test(wa),
         /codReminderTick/.test(wa), /ndrSeed/.test(wa), /status: 'seeded'/.test(wa),
         /allowlistBlocks\(orderName, order\.phone\)/.test(wa)],
        [true, true, true, true, true, true]);
    // The reminder's reply-check is RECENT-only: an old reply about a previous order from the same
    // phone must not silence reminders for a new order forever.
    // WhatsApp accepts-then-drops a send whose variable count mismatches the registered
    // placeholders (the cancelled-template lesson: 3 placeholders, 4 variables, nothing arrived).
    check('wa: a placeholder/variable mismatch fails loudly instead of silently not delivering',
        [/phMax !== \(tpl\.variables \|\| \[\]\)\.length/.test(wa)], [true]);
    check('wa auto: only a reply NEWER than the V1 send cancels the reminder',
        [/gte\('updated_at', row\.created_at\)/.test(wa)], [true]);
    // Gate rules are DATA: gate='seq' unlocks on previous-sent (no call needed), mode='auto' is
    // never a popup button (chips only, and refused by the manual send route), requires_hold
    // sequences exist only while the order is held on Shopify (server-checked via getHoldStates).
    check('wa auto: sequence gates — seq unlock, auto refusal, hold requirement',
        [/\(tpl\.gate \|\| 'call'\) !== 'seq'/.test(wa), /this sequence is sent automatically/.test(wa),
         /only for orders currently held on Shopify/.test(wa),
         /s\.mode==='auto'/.test(waUi), /s\.hidden/.test(waUi)],
        [true, true, true, true, true]);
    // The webhook hook is back, deliberately (plan change): COD confirm armed on orders/create —
    // and since 2026-08-27 it fires THREE MINUTES later (user spec), on cod_confirmation_v1, with a
    // cron backstop so a restart inside the window cannot lose the send. The send re-reads the order
    // first: a cancellation inside those three minutes wins.
    check('wa auto: orders/create webhook arms the COD confirmation',
        [/autoCodOnCreate\(o\)/.test(fs.readFileSync(path.join(ROOT, 'app/api/webhook_handler.js'), 'utf8'))],
        [true]);
    check('wa auto: COD V1 is delayed 3 minutes, not instant, and has a restart-safe backstop',
        [/COD_V1_DELAY_MS = 3 \* 60e3/.test(wa), /setTimeout\(\(\) => sendCodV1\(orderName, 'timer'\), delayMs\)/.test(wa),
         /async function codInitialTick/.test(wa), /codInitialTick\(\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
         /cancelled before the 3-minute mark/.test(wa), /cod_confirmation_v1\s+— 3 MINUTES/.test(wa)],
        [true, true, true, true, true, true]);
    {
        // Behavioural: the eligibility rule and the timer arming, with the real functions.
        const src = wa;
        const elig = new Function('return ' + src.slice(src.indexOf('function codV1Eligible'), src.indexOf('async function sendCodV1')))();
        check('wa auto: V1 eligibility — COD only, no test, no cancelled',
            [elig({ financial_status: 'pending' }, 'TE1'), elig({ financial_status: 'paid' }, 'TE1'), elig({ financial_status: 'pending', test: true }, 'TE1'),
             elig({ financial_status: 'pending', cancelled_at: 'x' }, 'TE1'), elig({ financial_status: 'pending' }, '')],
            [null, 'not COD (financial_status=paid)', 'test order', 'already cancelled', 'no order name']);
    }
    // The registry row is DATA (the reason the template swap needs no deploy) — the migration that
    // records the swap must name the right template, and must not be the instant one any more.
    const mig = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260827_wa_cod_v1_template.sql'), 'utf8');
    check('wa auto: cod_auto V1 registry row is cod_confirmation_v1 (migration on record)',
        [/set template_name = 'cod_confirmation_v1'/.test(mig), /sequence_key = 'cod_auto' and s\.version = 1/.test(mig)], [true, true]);

    // "I want real template" — the registered bodies are synced from MSG91's get-template-client
    // (control.msg91.com, path param; recovered from the docs page source after every api.msg91.com
    // guess 404'd) into msg91_template_catalog, and the catalog OVERRIDES registry body_text when
    // rendering the chat: every known template shows the message the customer actually received,
    // body + footer. MSG91 lists a name+language twice when a rejected draft sits beside the
    // approved revision — deduped before upsert (approved wins) or Postgres refuses the batch.
    check('msg91 wa: template catalog synced from MSG91 and preferred for chat rendering',
        [/get-template-client\//.test(wa), /msg91_template_catalog/.test(wa),
         /catalogSyncedAt/.test(wa), /approved/.test(wa),
         /footer_text \? '\\n\\n' \+ t\.footer_text/.test(wa)], [true, true, true, true, true]);
    // Sends that predate field snapshots render with the order's CURRENT fields instead of
    // "(text not stored)" — name, product, order and amount do not change after the fact.
    check('msg91 wa: snapshot-less sends fall back to current order fields',
        [/fieldsCache/.test(wa), /resolveOrderFields\(s2\.order_name\)/.test(wa)], [true, true]);
    // WhatsApp shows *text* as bold; the bubbles do too — escaped FIRST, bolded after.
    check('msg91 wa: bubbles render WhatsApp bold, escape-then-substitute',
        [/function supWaMd/.test(waUi), /escapeHtml\(t\)\.replace\(\/\\\*/.test(waUi)], [true, true]);
    // The reply decision arrives as CONFIRMED (webhook vocabulary), the reject as CANCEL — the chat
    // chips must accept both spellings or the confirm chip silently never renders.
    check('msg91 wa: chat decision chips match the stored vocabulary (CONFIRMED / CANCEL)',
        [/decU\.startsWith\('CONFIRM'\)/.test(waUi), /decU==='CANCEL'\|\|decU==='REJECT'/.test(waUi)],
        [true, true]);

    // -- GRN (Inventory → GRN): the receiving half of the purchase cycle --------------------------
    // getGrnDetails has the SAME silent-slice trap as the PO endpoint (verified live 2026-08-26:
    // bare call = 6 GRNs / one week; created_after=2024-01-01 = 67 back to Feb over 14 pages), its
    // status ids do not match EasyEcom's own doc (live: 2=In Progress, 5=Completed vs documented
    // 1=CREATED, 3=QC Complete), and it 429s under bursts — hence date param, cursor walk, the
    // API's own status STRING, and a one-retry ladder.
    {
        const gr = fs.readFileSync(path.join(ROOT, 'app/api/grn.js'), 'utf8');
        const srvG = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const htmlG = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');
        check('grn: created_after always sent, nextUrl walked, one retry on a burst 429',
            [/getGrnDetails\?created_after=/.test(gr), /body\.nextUrl/.test(gr),
             /retrying in 3s/.test(gr)], [true, true, true]);
        // The frequent-429 fix (user, 2026-08-26 night): a 429 mid-walk retries THAT PAGE with
        // backoff (the whole-walk retry re-fetched every earlier page, doubling the burst), pages
        // are paced 150ms apart, and the GRN page reads the PO book through the SHARED poBookCached
        // instead of walking the same 14 pages the PO page just walked.
        check('grn: 429s handled per page with pacing, PO book shared between the two dashboards',
            [/r\.status === 429 && a < 3/.test(gr), /pace the limiter/.test(gr),
             (poSrc => /r\.status === 429 && a < 3/.test(poSrc) && /function poBookCached/.test(poSrc) && /module\.exports\.poBookCached/.test(poSrc))(fs.readFileSync(path.join(ROOT, 'app/api/purchase_orders.js'), 'utf8')),
             /poBookCached\(since, !!req\.query\.fresh\)/.test(gr)],
            [true, true, true, true]);
        check('grn: status label comes from the API string, never a hardcoded id map',
            [/g\.grn_status \|\|/.test(gr), /GRN STATUS IDS DO NOT MATCH/.test(gr)], [true, true]);
        // grn_detail_price is the LINE TOTAL (62/62 non-zero live GRNs), though EasyEcom's doc sample
        // reads as a unit rate — multiplying by quantity would inflate a 391-unit line 391×.
        check('grn: grn_detail_price treated as line total, unit rate derived by division',
            [/IS THE LINE TOTAL, NOT THE UNIT RATE/.test(gr),
             /lineValue: num\(i\.grn_detail_price\)/.test(gr),
             /grn_detail_price\) \* num\(i\.received_quantity\)/.test(gr)], [true, true, false]);
        // "Awaiting receipt" reuses the PO page's own open/dead semantics — one definition, no drift.
        check('grn: awaiting-receipt reuses the PO book (fetchAllPurchaseOrders + shapePo)',
            [/require\('\.\/purchase_orders'\)/.test(gr), /p\.isOpen/.test(gr),
             /module\.exports\.fetchAllPurchaseOrders/.test(fs.readFileSync(path.join(ROOT, 'app/api/purchase_orders.js'), 'utf8'))],
            [true, true, true]);
        // A dead PO book degrades the panel, never the GRN list — and it now RETRIES first (it walks
        // as many pages as the GRN fetch into the same limiter; without the retry it was consistently
        // the half that died). When it still fails, the KPI card and the pipeline stage show a DASH,
        // never 0 — "0 units awaited" reads as nothing owed, the wrong reading of "could not check".
        check('grn: PO-book failure retries, then degrades to a dash — never a fake zero',
            [/poBookAvailable/.test(gr), /awaiting-receipt panel degraded/.test(gr),
             /PO book fetch failed, retrying in 3s/.test(gr),
             /d\.poBookAvailable === false \? '—'/.test(waUi),
             (waUi.match(/PO book could not be read — hit Refresh/g) || []).length >= 2],
            [true, true, true, true, true]);
        check('grn: route mounted and gated by its own view permission',
            [/app\.use\('\/api', require\('\.\/app\/api\/grn'\)\)/.test(srvG),
             /\[\/\^\\\/grn\/i, 'grn'\]/.test(srvG)], [true, true]);
        check('grn: nav below Purchase Order, view shell, deep link, perm catalog entry',
            [/nav-grn/.test(htmlG), /grn-view/.test(htmlG),
             /'nav-grn': 'grn'/.test(waUi), /function grnInit/.test(waUi),
             /\['grn','GRN \(EasyEcom goods receiving\)'\]/.test(waUi)],
            [true, true, true, true, true]);
        // The pipeline strip and the Awaiting card show LIVE state — what is still owed does not
        // depend on the page's date window; an old open PO is exactly the one not to hide.
        check('grn: pipeline and awaiting figures are live, not filtered by the date window',
            [/ignores filters/.test(waUi), /LIVE state of the whole book/.test(waUi)], [true, true]);
        // -- GRN writes (Receive stock): POST /wms/QueueGrnApi, async queue + CheckGrnStatus --------
        // One endpoint serves both flows (with purchase_order_id = against PO; without = Auto GRN).
        // The PO-based param table says `vendorId` (code) but BOTH of EasyEcom's own body samples
        // send numeric snake_case `vendor_id` — the CreatePurchaseOrder trap again; samples win.
        check('grn write: gated on grn-write, vendor_id snake_case, PO vendor taken from the PO',
            [/perms\.includes\('grn-write'\)/.test(gr), /vendor_id: vendorId/.test(gr),
             /vendorId = po\.vendorId \|\| vendorId/.test(gr),
             /purchase_order_id: poId/.test(gr)], [true, true, true, true]);
        // A typo'd 6000 against a 600-unit line would create phantom sellable stock — every PO-based
        // line is held against the PO's PENDING quantity, and a dead PO refuses receipts outright.
        check('grn write: over-receive and dead-PO receipts are refused before EasyEcom is called',
            [/is only owed/.test(gr), /is not on PO/.test(gr), /a dead PO cannot receive goods/.test(gr)],
            [true, true, true]);
        // The job is ASYNC ({code:200, queueId}); success is judged on code/status AND a queueId, and
        // CheckGrnStatus is polled so the caller hears what EasyEcom actually said.
        check('grn write: async queue — never trusts HTTP 200 alone, polls CheckGrnStatus',
            [/CheckGrnStatus/.test(gr), /body\.code != null \? body\.code : body\.status/.test(gr),
             /!queueId/.test(gr), /waitForGrnJob/.test(gr)], [true, true, true, true]);
        // Optional fields are OMITTED when blank (the PO-create lesson: '' becomes a blank batch),
        // and cost is per-unit — PROVEN on the first live GRN (2355800: 588 × 33.70 → 19,815.60
        // stored), the opposite reading of getGrnDetails' line-total price, deliberately.
        check('grn write: blank optionals omitted, per-unit cost reading proven live',
            [/line\.batch_code = String\(it\.batch\)\.trim\(\)/.test(gr), /PROVEN LIVE 2026-08-26/.test(gr),
             /588 × 33\.70/.test(gr)], [true, true, true]);
        // QueueGrnApi reports validation failures as an ARRAY of {SKU, Error} objects (seen live:
        // "Manufacturing Date is mandatory as the product category is configured with LOT") — fed
        // raw into the error string it renders "[object Object]". Flattened per SKU; and since these
        // products are LOT-configured, the Receive form carries a Mfg-date column beside Expiry.
        check('grn write: EasyEcom array errors flattened readable, mfg date on the form',
            [/function eeMsgText/.test(gr), /eeMsgText\(body\.message\)/.test(gr),
             /x\.Error \|\| x\.error/.test(gr),
             /data-f="mfg"/.test(waUi), /mfg:\/\^/.test(waUi)], [true, true, true, true, true]);
        check('grn write: Receive UI exists, gated, PO lines prefilled and capped at pending',
            [/function grnOpenReceive/.test(waUi), /canWriteGrn/.test(waUi),
             /grnRxLineFromPending/.test(waUi), /the PO is only owed/.test(waUi),
             /grn-receive/.test(htmlG),
             /\['grn-write','Receive stock/.test(waUi)], [true, true, true, true, true, true]);
        // -- GRN document + rich confirmation + MRP auto-fill (user, 2026-08-26 evening) ------------
        // EasyEcom has NO GRN-document endpoint (probed live: 5 candidates all 404, unlike POs), so
        // the document is ALWAYS ours — pdfkit, filename GRN-<id>.pdf, and the footer says who made
        // it. Columns come from ONE edge table (the first render overprinted RATE on AMOUNT) and the
        // row advances by the WRAPPED height of the product name, not a fixed 15px.
        check('grn doc: generated PDF route — no EasyEcom original exists, layout self-consistent',
            [/router\.get\('\/grn\/:grnId\/pdf'/.test(gr), /EASYECOM HAS NO GRN-DOCUMENT ENDPOINT/.test(gr),
             /filename="GRN-\$\{g\.grnId\}\.pdf"/.test(gr), /heightOfString/.test(gr)],
            [true, true, true, true]);
        // After the queue job finishes, the NEW GRN is read back (matched inside an IST-naive string
        // window — new Date() on EasyEcom's zoneless stamp shifts by the server's timezone) so the
        // confirmation shows what EasyEcom RECORDED, with the document one click away; the plain
        // summary stays as the fallback. Every GRN row's expansion also carries the download.
        check('grn doc: post-create confirmation shows the recorded GRN + download, row button too',
            [/grn: createdGrn/.test(gr), /IST-NAIVE/.test(gr),
             /function grnShowCreated/.test(waUi), /function grnDownloadPdf/.test(waUi),
             /Download GRN document/.test(waUi), /grn-dl/.test(waUi)],
            [true, true, true, true, true, true]);
        // The document reproduces EASYECOM'S OWN GRN LAYOUT (user supplied a real portal print of
        // GRN 2355558): bordered company header, "GRN" band, vendor/PO info block with the ":-"
        // labels (vendor address + TIN from the RAW vendor master — fetchVendors strips both), the
        // 14-column grid and the Grand Total band. The "EasyEcom print" portal link was REMOVED on
        // request — the generated document is now the one download (printGRN stays refused to API
        // auth: "Not authorised", portal-session-only).
        check('grn doc: EasyEcom-format document, portal link removed',
            [/EASYECOM'S OWN GRN LAYOUT/.test(gr), /Vendor TinNo :-/.test(gr),
             /tax_identification_number/.test(gr), /function rawVendors/.test(gr),
             /Grand Total:/.test(gr), /Total Quantity:/.test(gr),
             /app\.easyecom\.io\/wms\/printGRN/.test(waUi)],
            [true, true, true, true, true, true, false]);
        // MRP auto-fills from the live product master (probe: master carries mrp) — on PO lines via
        // pendingItems, in Auto mode when a typed SKU matches skuInfo; never overwrites a typed value.
        check('grn: MRP auto-fetched from the product master, typed values never overwritten',
            [/function skuInfoMap/.test(gr), /mrp: \(skuInfo\[/.test(gr),
             /mrp:i\.mrp != null \? i\.mrp : ''/.test(waUi),
             /l\.mrp === '' \|\| l\.mrp == null/.test(waUi)], [true, true, true, true]);
        // Mfg/expiry are MONTH pickers (product dating is month-level, per the user) — YYYY-MM is
        // expanded to the first of the month on BOTH sides (EasyEcom's own convention: a July-2029
        // expiry is stored 2029-07-01), so the API stays usable with either form.
        // Complete GRN (user: "still complete GRN button i need to click on Easyecom — do directly
        // from our GRN module"): POST /wms/completeGrn is UNDOCUMENTED, found by probing — the one
        // candidate of 12 answering 405-on-GET. Payload { grn_id, c_id } where c_id is the GRN's own
        // inwarded_warehouse_c_id ('company_id'/'companyId' answer "Company Id is missing"; the c_id
        // shape was proven by "Cannot complete GRN as it is already in completed status"). Failures
        // arrive as HTTP 200 + status:400 (the updatePoStatus trap); gated on grn-write; the button
        // renders only on not-yet-completed GRNs, with a confirm.
        check('grn complete: probe-found endpoint, c_id from the GRN itself, gated + confirmed',
            [/router\.post\('\/grn\/complete'/.test(gr), /grn_id: grnId, c_id: g\.warehouseCid/.test(gr),
             /warehouseCid: g\.inwarded_warehouse_c_id/.test(gr), /is already \$\{g\.status\}/.test(gr),
             /function grnCompleteAction/.test(waUi), /grn-cmpl/.test(waUi),
             /!\/complete\/i\.test\(g\.status\)/.test(waUi)],
            [true, true, true, true, true, true, true]);
        // After a complete: a REAL result panel (ecResult, not a vanishing toast), the row flips to
        // Completed immediately, and the fresh fetch runs SILENTLY — a full-page loader after an
        // action that already happened reads as a reload (user, 2026-08-26 night).
        check('grn complete: result panel + optimistic row flip + silent background refresh',
            [/g\.status = 'Completed'; g\.statusId = 5; grnRender\(_grnData\)/.test(waUi),
             /grnLoad\(true, true\)/.test(waUi),
             /async function grnLoad\(fresh, silent\)/.test(waUi),
             /if\(!silent\) ecLoadingShow/.test(waUi)],
            [true, true, true, true]);
        check('grn: mfg/expiry are month pickers, YYYY-MM expanded to first-of-month both sides',
            [/type="month"[^\n]*data-f="mfg"/.test(waUi), /type="month"[^\n]*data-f="expiry"/.test(waUi),
             /\^\\d\{4\}-\\d\{2\}\$/.test(waUi), /it\[k\] = String\(it\[k\]\)\.trim\(\) \+ '-01'/.test(gr)],
            [true, true, true, true]);
    }

    // -- PO Approvals (maker-checker before EasyEcom) + PO-line enrichment ------------------------
    // A PO is drafted (po_approvals_ecom), approvers are emailed, and only Approve fires the real
    // EasyEcom create — through performPoCreate, the SAME implementation as the direct route (which
    // shrank to an admin escape hatch). Full flow proven without touching EasyEcom: submit → list →
    // self-approve refused → EE-format draft PDF (with product image) → reject → double-decide
    // refused (7/7). Separately: EasyEcom sends NO product name on PO lines (and no EAN/HSN on new
    // SKUs — TE-ABD1 showed all dashes), so lines are enriched from the product master.
    {
        const poa = fs.readFileSync(path.join(ROOT, 'app/api/po_approvals.js'), 'utf8');
        const poSrc = fs.readFileSync(path.join(ROOT, 'app/api/purchase_orders.js'), 'utf8');
        const htmlA = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');
        check('po approvals: one create implementation, direct route is an admin escape hatch',
            [/async function performPoCreate/.test(poSrc), /module\.exports\.performPoCreate/.test(poSrc),
             /Purchase orders now go through approval/.test(poSrc),
             /performPoCreate\(row\.payload, u\.sub\)/.test(poa)], [true, true, true, true]);
        check('po approvals: maker-checker — requester cannot approve their own PO (admins may)',
            [/row\.requested_by === u\.sub/.test(poa), /different approver has to release it/.test(poa)],
            [true, true]);
        // A failed EE create parks the request on 'failed' with the error recorded — Approve retries;
        // a half-done approval must never vanish back into pending or disappear.
        check('po approvals: failed EE create stays actionable',
            [/status: 'failed'/.test(poa), /create_error/.test(poa)], [true, true]);
        // ⚠️ NOTIFICATION IS IN-APP ONLY. The email version was removed the day it shipped: the user
        // wants notifications inside Ecom Central, and the shared sendMail helper AUTO-FILLS THE
        // REPORT CC LIST when no `cc` is passed, so the "approvers-only" mail leaked to the whole
        // report audience. po_approvals must never import sendMail again; the channel is the
        // pending-count poll → nav badge + toast, gated to approvers.
        check('po approvals: in-app notification only — no mail import, badge + toast + login popup',
            [/require\('\.\/email_settings'\)/.test(poa) === false, /pending-count/.test(poa),
             /function poaBadgeTick/.test(waUi), /nav-po-approvals-badge/.test(waUi),
             /awaiting your approval/.test(waUi),
             /function poaLoginPopup/.test(waUi), /navigate\('po-approvals'\)/.test(waUi),
             /nav-po-approvals-badge/.test(htmlA),
             /approvers have been emailed|notified by email|emailed the moment/.test(waUi) === false],
            [true, true, true, true, true, true, true, true, true]);
        // The badge/popup machinery dies WITH the session: _clearSession stops the poll, cancels the
        // delayed popup timer and removes a visible popup — one fired onto the signed-out page
        // (user-reported); the popup also re-checks authToken, which _clearSession nulls.
        check('po approvals: notification cannot outlive the session',
            [/function poaBadgeStop/.test(waUi), /poaBadgeStop === 'function'\) poaBadgeStop\(\)/.test(waUi),
             /clearTimeout\(_poaPopupTO\)/.test(waUi), /\|\| !authToken\) return;/.test(waUi)],
            [true, true, true, true]);
        // Draft PDF = EasyEcom's OWN PO sheet (from a real EE document): product image, vendor
        // TIN/address from the raw vendor master, IGST/CGST split by vendor state, EE's quirky
        // value-in-words ("twenty thousands … point three eight Paise" reproduced exactly), and a
        // rupee-capable font (Helvetica has no ₹ — the first render printed "¹101.1").
        check('po approvals: draft PDF is the EE sheet — image, TIN, words, ₹ font fallback',
            [/product_image_url/.test(poa), /tax_identification_number/.test(poa),
             /interstate \? `IGST-/.test(poa), /function inrWords/.test(poa),
             /RUPEE_FONT/.test(poa), /DRAFT — pending approval/.test(poa)],
            [true, true, true, true, true, true]);
        // Session EXPIRY lands on the signout page in an expiry voice (amber clock, "Session
        // expired", why + login button) — never a bare login form with no explanation (user,
        // 2026-08-27). All three expiry paths route through it: the 6-hour timer, a 401 mid-work,
        // and a stale token at page open. Manual sign-out resets the page to its thank-you voice.
        check('session expiry: explained on the signout page, all three paths, no bare login',
            [/function sessionExpired\(\)/.test(waUi), /SO_MODES/.test(waUi),
             /Session expired/.test(waUi), /soSetContent\('expired'\)/.test(waUi),
             /soSetContent\('bye'\)/.test(waUi),
             (waUi.match(/sessionExpired\(\)/g) || []).length >= 4,
             /401\) \{ showNotification\("Session expired\."/.test(waUi)],
            [true, true, true, true, true, true, false]);
        // Loading is a CENTRED POPUP overlay (user, 2026-08-27: the KPI-cell loader sat off to the
        // left and read as a broken page); previous content stays dimly visible behind it, and the
        // overlay always hides again — even on an error (finally).
        check('loading: centred overlay for PO / GRN / PO Approvals, always hidden again',
            [/function ecLoadingShow/.test(waUi), /ec-loading-overlay/.test(waUi),
             /ecLoadingShow\('Loading purchase orders…'\)/.test(waUi),
             /ecLoadingShow\('Loading goods receipts…'\)/.test(waUi),
             /ecLoadingShow\('Loading approval queue…'\)/.test(waUi),
             (waUi.match(/finally\{ (if\(!silent\) )?ecLoadingHide\(\); \}/g) || []).length >= 3],
            [true, true, true, true, true, true]);
        // The loader wears the app's dark-premium identity (the welcome-splash card language, not a
        // bare white box — user: "this is not our standard"), and an expired session RESUMES the
        // page it interrupted on the next login (permission re-checked; manual sign-out still goes
        // Home — leaving is a choice).
        // brandLoader IS the popup now: hooked once, all ~35 dashboards inherit the design with
        // their own labels; a marker shim + visibility watcher hides the overlay exactly when the
        // old inline loader used to disappear (content replaced / view left / modal closed).
        // The LEGACY #global-loader (fetchApiData's overlay) wears the SAME dark card — its old
        // white design flashed for sub-second API calls before the new overlay took over (user:
        // "loader design is different… after that new design loader work").
        // DOI + PO (user, 2026-08-27): (stock + raised-PO pending units) ÷ DRR — the runway once the
        // open POs land, beside today's DOI. Computed ONCE in buildReorder, shipped to the dashboard
        // table, the Teams image payload and the fallback card, so all three state the same number.
        {
            const inv = fs.readFileSync(path.join(ROOT, 'app/api/inventory.js'), 'utf8');
            check('inventory: DOI-with-raised-PO computed once, on the page + report image + card',
                [/\(stock \+ poQty\) \/ drr/.test(inv), /doi_with_po: doiWithPo/.test(inv),
                 /doi_with_po: r\.doi_with_po/.test(inv),
                 /r\.doi_with_po\.toFixed\(1\)/.test(inv),
                 /'DOI \+ PO'/.test(waUi), /doi_with_po==null/.test(waUi)],
                [true, true, true, true, true, true]);
        }
        check('loading: legacy global loader restyled to the same dark card — one design everywhere',
            [/gl-card/.test(htmlA), /SAME dark-premium card as ecLoadingShow/.test(htmlA),
             /rgba\(8, 11, 26, 0\.45\)/.test(htmlA), /loader-dot-bounce/.test(htmlA) === false],
            [true, true, true, true]);
        check('loading: brandLoader hooked app-wide — marker shim + visibility watcher',
            [/data-ec-loading/.test(waUi), /_eclWatchStart/.test(waUi),
             /offsetParent !== null/.test(waUi),
             /ecLoadingShow\(label\); _eclWatchStart\(\);/.test(waUi)],
            [true, true, true, true]);
        check('loading: dark-premium card; expiry resumes the interrupted page on next login',
            [/eclSpin 1s linear infinite/.test(waUi), /linear-gradient\(165deg,#211d54,#111536 60%,#0b0f26\)[\s\S]{0,400}eclCardIn/.test(waUi),
             /ec-resume-view/.test(waUi), /VALID_VIEWS\.has\(resume\) && canView\(resume\)/.test(waUi),
             /page you were on after signing in/.test(waUi)],
            [true, true, true, true, true]);
        // The draft opens in a VIEWER popup (iframe on a blob URL, Download inside) — not a direct
        // download; the approve button says just "Approve"; and the hero's stat gap is INLINE
        // because gap-10 is not in the prebuilt tailwind.css (stats ran together, user-reported).
        check('po approvals: draft viewer popup, plain Approve, inline hero gap',
            [/poa-pv-dl/.test(waUi), /<iframe src="\$\{url\}"/.test(waUi),
             /'Approve again \(retry\)' : 'Approve'/.test(waUi),
             /style="gap:44px/.test(waUi)],
            [true, true, true, true]);
        // The viewer was blocked by CSP (no frame-src → default-src 'self' refuses blob: iframes)
        // and a cold open took 6–8 s (sequential vendor/master/image fetches). Fixed: frame-src
        // allows blob:, the server builds in parallel, and the CLIENT PREFETCHES each pending
        // draft's PDF at render — the click is instant; cache pruned as requests leave the queue.
        check('po approvals: blob iframes allowed by CSP, PDFs prefetched for instant open',
            [/frame-src 'self' blob:/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
             /function poaPrefetchPdfs/.test(waUi), /_poaPdfCache/.test(waUi),
             /URL\.revokeObjectURL\(u\)/.test(waUi),
             /await Promise\.all\(items\.map\(async it =>/.test(poa)],
            [true, true, true, true, true]);
        check('po approvals: UI wired — submit path, dashboard, nav, permission',
            [/\/api\/po-approvals\/submit/.test(waUi), /function poaInit/.test(waUi),
             /'nav-po-approvals': 'po-approvals'/.test(waUi),
             /\['po-approvals','PO Approvals/.test(waUi),
             /nav-po-approvals/.test(htmlA), /po-approvals-view/.test(htmlA),
             /po-approvals\\\/submit/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))],
            [true, true, true, true, true, true, true]);
        check('po lines: name/EAN/HSN enriched from the product master (EasyEcom sends none)',
            [/master enrichment failed/.test(poSrc), /i\.description = m\.product_name/.test(poSrc),
             /i\.ean = m\.EANUPC/.test(poSrc), /i\.hsn = m\.hsn_code/.test(poSrc)], [true, true, true, true]);
        // GST for previously-ordered SKUs reads the MASTER's per-product tax_rate first (user, TE-AAD1
        // showed "no HSN on record" though EasyEcom held everything — and the HSN-chapter guess says
        // 12% where the configured rate is 5%; a genus is not the product). HSN chapter = fallback only.
        check('po picker: history rows take GST from the product master, HSN chapter is fallback',
            [/GST FOR HISTORY ROWS COMES FROM THE PRODUCT MASTER FIRST/.test(poSrc),
             /const masterTax = m \? pctFromFraction\(m\.tax_rate\) : null;/.test(poSrc),
             /masterTax != null \? masterTax : gstFromHsn\(hsn\)/.test(poSrc)],
            [true, true, true]);
    }

    // -- Rejected COD: the customer's written "no" gets its own queue tab -------------------------
    // A tapped REJECT on the MSG91 WhatsApp template writes a CANCEL confirmation; by explicit
    // instruction the tab takes NO automatic action -- no hold, no Shopify cancel -- it exists so the
    // team SEES every rejection (shipping a told-you-so parcel is a guaranteed RTO).
    const scApi = fs.readFileSync(path.join(ROOT, 'app/api/support_console.js'), 'utf8');
    const scUi = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    const scHtml = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');
    check('rejected cod: the tab is wired end to end and takes no automatic action',
        [/tab === 'rejected'/.test(scApi), /Confirmation received', 'CANCEL'/.test(scApi),
         /data-tab="rejected"/.test(scHtml), /isRejTab/.test(scUi),
         !/cancelOrder|holdOrderSmart/.test(scApi.slice(scApi.indexOf("tab === 'rejected'"), scApi.indexOf("tab === 'changed'")))],
        [true, true, true, true, true]);
    // A rejection the webhook could not pin to an order must still appear -- an invisible rejection is
    // how the parcel ships anyway.
    check('rejected cod: phone-only rejections still get a row',
        /matched by phone only/.test(scUi) && /PHONE:/.test(scApi.slice(0, 4000)) || /still gets a stub row/.test(scApi), true);

    // -- Voice agent: the chat model is one constant, and not the reasoning variant ---------------
    // `sarvam-30b` was hardcoded at two call sites and its deprecation broke the agent mid-call. Of the
    // replacements, `sarvam-105b` is a reasoning model -- tested live, it spent a whole 40-token budget
    // thinking and returned content:null, which on a voice call is dead air.
    const va = fs.readFileSync(path.join(ROOT, 'app/static/voice-agent.html'), 'utf8');
    check('voice agent: one model constant, no hardcoded model at the call sites',
        [(va.match(/model: SARVAM_CHAT_MODEL,/g) || []).length, /sarvam-30b",/.test(va),
         /SARVAM_CHAT_MODEL = "sarvam-105b-conversations"/.test(va)],
        [2, false, true]);
    // Sarvam's STT cannot read MediaRecorder's webm/opus -- 400 "check the audio format" -- while WAV
    // bytes pass under every model param (verified live). The recording is converted before upload.
    // The agentic-tuned model invents tool calls (`<tool_call>close_positive ...`) that NOTHING here
    // defines, and the page once spoke that markup aloud to a customer. Angle-bracket machinery is
    // stripped before display/TTS, and an all-machinery reply falls back to a real goodbye.
    check('voice agent: invented tool calls are stripped before anything is spoken',
        [/function sanitizeReply/.test(va), /tool_call/.test(va), /CLOSING_LINE/.test(va),
         /SPOKEN TEXT ONLY\. You have NO tools\./.test(va)],
        [true, true, true, true]);
    // Stage 2 (2026-08-25, "delay still happen"): the mic no longer records-then-uploads. While the
    // button is held, 16 kHz PCM streams over the realtime STT socket (manual endpointing — push-to-
    // talk IS manual endpointing); speech_end finalizes in ~130-330ms where the old path took 1-1.5s.
    // Full-turn proof with the page's own extracted classes and REAL synthesized Hindi speech:
    // release → transcript.final 327ms → first chat chunk 922ms → FIRST AUDIO 1,166ms (was ~6.7s).
    check('voice agent: speech streams to the realtime STT socket while the button is held',
        [/speech-to-text-realtime\/ws/.test(va), /endpointing=manual/.test(va),
         /class SttLive/.test(va), /api-subscription-key\." \+ currentApiKey/.test(va)],
        [true, true, true, true]);
    // ⚠ The WAV lesson survives in the FALLBACK: if the socket dies mid-utterance, the SAME captured
    // PCM is wrapped in a WAV header (Sarvam REST judges bytes, not filenames) and posted — the
    // customer's words are never lost to a transport failure.
    check('voice agent: a dead socket falls back to REST STT with the same captured audio',
        [/function pcmToWav/.test(va), /fd\.append\("file", wav, "audio\.wav"\)/.test(va),
         /callSTTRest\(pcmToWav\(concatPcm\(pcmParts\)\)\)/.test(va)],
        [true, true, true]);
    // TTS also streams: one socket per agent turn, opened in parallel with the chat request; audio
    // chunks (linear16, first at ~0.5s measured) feed straight onto the player timeline; socket
    // failure degrades to the REST per-sentence path, never to silence.
    check('voice agent: streaming TTS with a REST fallback, torn down by every stopSpeech path',
        [/text-to-speech\/ws\?model=bulbul:v3/.test(va), /class TtsStream/.test(va),
         /feedPcm16/.test(va), /function stopSpeech/.test(va)],
        [true, true, true, true]);
    // Voice-quality round (user test call): the STREAM launched without enable_preprocessing while
    // REST always had it — digits and mixed English came out text-ish ("text and speak mismatch").
    // Both paths now carry preprocessing + the picked speaker/pace, everything spoken passes
    // toSpokenText (dashes → a breath, quotes/brackets/symbols vanish — verified on the exact
    // utterances from the real call), and every prompt carries the SPOKEN_STYLE rules: no symbols,
    // never read a full order ID, respectful gender-neutral verb forms, never repeat a sentence.
    check('voice agent: the stream speaks like the REST path — preprocessing, speaker, pace, normalizer',
        [/enable_preprocessing: true, pace: getPace\(\)/.test(va), /function toSpokenText/.test(va),
         /const spoken = toSpokenText\(text\)/.test(va), /SPOKEN_STYLE/.test(va),
         /speaker: getSpeaker\(\)/.test(va), /id="voice-select"/.test(va)],
        [true, true, true, true, true, true]);
    // A real call ended with the identical goodbye twice (machinery-only reply → same fallback).
    check('voice agent: the goodbye fallback never repeats itself verbatim',
        [/lastAgent\.content\.trim\(\) === text\.trim\(\)/.test(va)], [true]);
    // The picked VOICE is the agent's identity: a male voice was saying "कर रही हूँ" because the
    // prompt never said who was talking. agentPersona() injects the speaker's name + gender with the
    // correct first-person verb forms, and the customer is greeted by FIRST name + जी only — proven
    // live: rahul → "मैं Rahul बोल रहा हूँ", priya → "मैं Priya बात कर रही हूँ", full name never read.
    check('voice agent: the prompt knows the voice\'s gender and greets by first name',
        [/const SPEAKER_INFO/.test(va), /function agentPersona/.test(va),
         /SPOKEN_STYLE \+ agentPersona\(\)/.test(va),
         /order\.customerName \|\| ""\)\.trim\(\)\.split\(/.test(va)],
        [true, true, true, true]);
    // REAL calls (Vobiz bridge, 2026-08-25): the same Sarvam pipeline server-side. Formats align on
    // both legs (Vobiz L16/16k in = Sarvam STT's linear16; bulbul linear16/24k out = Vobiz playAudio
    // L16/24k) so the bridge forwards base64, not transcoded audio; VAD does turn-taking (no
    // push-to-talk on a phone); a vad.speech_start while the agent talks sends clearAudio (barge-in);
    // webhooks are public-path but token-gated (bad token → <Hangup/>); and the SAME allowlist that
    // guards WhatsApp guards who can be rung while testing.
    {
        const vb = fs.readFileSync(path.join(ROOT, 'app/api/vobiz_bridge.js'), 'utf8');
        const srvV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        check('vobiz bridge: caller audio flows to VAD STT and TTS flows back, with barge-in',
            [/endpointing=vad/.test(vb), /clearAudio/.test(vb), /playAudio/.test(vb),
             /sampleRate: 24000/.test(vb), /allowlistBlocks\(/.test(vb),
             /VOBIZ_L16_SWAP/.test(vb)], [true, true, true, true, true, true]);
        // THE WIRE FORMAT, as learned across seven real calls (the docs' concepts page is STALE):
        // frames are EVENT-keyed ({event:"start"/"media"}, media payload nested at media.payload);
        // playAudio must be event-keyed WITH the streamId from the start event (type-keyed frames
        // are ignored SILENTLY — the caller heard nothing while the whole pipeline ran); audio goes
        // out in ~60ms slices; the wss URL inside the XML must escape & as &amp; (a raw ampersand
        // made Vobiz's parser reject the document — calls cut 3s after answer); and the webhook
        // host must be reachable from India (trycloudflare is ISP-blocked; pinggy worked).
        check('vobiz bridge: the wire format that actually worked on a real call',
            [/event: 'playAudio', streamId: this\.streamId/.test(vb), /&amp;sid=/.test(vb),
             /const SLICE = 2880/.test(vb), /d\.start && d\.start\.streamId/.test(vb),
             /d\.media\.payload \|\| d\.media\.audio/.test(vb)], [true, true, true, true, true]);
        // "Customer thank you mean call should be end": once the brand closing is spoken, a short
        // thanks/bye hangs up (a real question still gets answered); a fallback timer ends the call
        // even if the customer stays silent after the goodbye.
        // Recording is the live-call API, not the XML verb: the verb recorded ONLY the agent leg
        // (user listened: customer side silent) and sat in the XML critical path; the API starts a
        // both-legs recording AFTER the stream is up (202 "call recording started", proven live).
        check('vobiz bridge: recording via live-call API, off the XML critical path',
            [/startCallRecording/.test(vb), /Call\/\${callId}\/Record\//.test(vb.replace(/\`/g,'')) || /\/Record\//.test(vb),
             /recordXml = \(\) => ''/.test(vb)], [true, true, true]);
        check('vobiz bridge: the goodbye ends the call, not just the sentence',
            [/closingDone/.test(vb), /hangup\(800\)/.test(vb), /scheduleGoodbyeCut/.test(vb) && /this\.vadActive && el < 18000/.test(vb)],
            [true, true, true]);
        // Presence check (2026-08-26): a silent line gets "Hello? can you hear me?" in the CALL'S
        // language at ~9s and an auto-hangup at 15s from start — proven with a silent-customer sim
        // (opening t+1.7s → hello-check t+10s → ended t+15.7s). Any transcript, hums included,
        // proves a person and cancels the timers. All ten languages have a vetted hello line.
        check('vobiz bridge: a silent customer gets a hello-check then a 15s auto-hangup',
            [/const HELLO_CHECK/.test(vb), /this\.presence = true/.test(vb),
             /el >= 9000 && !this\.speaking && !this\.screenerSeen/.test(vb),
             /this\.screenerSeen \? 60000 : this\.sawVoice \? 30000 : 15000/.test(vb),
             (vb.match(/-IN': '/g) || []).length >= 20], [true, true, true, true, true]);
        // A hum is not a yes — but it IS presence: fillers mark the person before being ignored.
        check('vobiz bridge: fillers are ignored as turns but counted as presence',
            [/FILLER_RX/.test(vb), /filler ignored/.test(vb),
             vb.indexOf('this.presence = true') < vb.indexOf('FILLER_RX')], [true, true, true]);
        check('vobiz bridge: wired into the server — public webhooks, gated call route, WS upgrade',
            [/\/vobiz\\\/\(answer\|hangup\)\$\//.test(srvV.replace(/\\/g, '\\\\')) || /vobiz\\\/\(answer\|hangup\)/.test(srvV),
             /vobiz.{0,30}call\|recording.{0,60}'support-voice', 'support-queue'/.test(srvV),
             /attachVobizWs\(httpServer\)/.test(srvV)], [true, true, true]);
    }
    // Language texture is PER LANGUAGE: a static "everyday Hinglish" rule dragged even English
    // calls into Hindi (caught live before shipping). The Hindi branch carries Hinglish + the
    // respectful-plural customer forms (a real call guessed होंगी); every other language gets its
    // own native register, a hard no-Hindi guard, and a language-matched honorific ("Sugandh ji"
    // in Roman for English — a जी was leaking Devanagari into English and Tamil turns). Proven
    // live: English opens in pure Indian English, Tamil in colloquial phone-Tamil, zero Devanagari
    // outside Hindi. And sentences must carry their SUBJECT — a real call said a bare "पहुँच जाएगा".
    check('voice agent: each language speaks its own texture, never translated Hindi',
        [/lang === "Hindi"/.test(va), /Speak \$\{lang\} ONLY/.test(va),
         /never Devanagari script inside a non-Hindi sentence/.test(va),
         /NEVER gendered guesses/.test(va), /COMPLETE SENTENCES/.test(va),
         /LANGUAGE TEXTURE/.test(va)],
        [true, true, true, true, true, true]);
    // "Make it fast like real human conversation" (2026-08-25). The old flow was serial — whole chat
    // completion, then TTS of the whole reply, then audio: ~6s dead air on a long turn (measured:
    // first token 445ms vs full 1.6s; TTS 1.65s/sentence vs 4.1s/reply). Now the chat STREAMS, the
    // reply is cut at sentence boundaries as tokens arrive (first sentence ASAP, later ones batched),
    // each sentence TTSes while earlier ones play, gapless on one AudioContext — and the mic
    // re-enables on the FIRST audio chunk so the customer can barge in mid-sentence.
    check('voice agent: streamed chat + sentence-pipelined TTS replace the serial turn',
        [/stream: true/.test(va), /async function callChatStream/.test(va), /class SpeechPlayer/.test(va),
         /function playAudio/.test(va), /const agentReply = await callChat\(/.test(va)],
        [true, true, true, false, false]);
    // Two spoken-text safety rules inside the splitter: a '.' only ends a sentence before whitespace
    // ("Rs.50" must never be cut into a TTS chunk), and nothing is emitted past an unclosed '<' —
    // tool-call machinery split across stream deltas is held back whole for sanitizeReply (verified
    // against a simulated stream: machinery split over 4 deltas, zero leakage into spoken chunks).
    check('voice agent: the sentence splitter cannot speak half a number or half a tool call',
        [/i \+ 1 < s\.length && \/\\s\/\.test\(s\[i \+ 1\]\)/.test(va),
         /work\.lastIndexOf\("<"\)/.test(va)], [true, true]);
    // Barge-in: pressing the mic (or ending the call) silences the agent NOW, mid-word.
    check('voice agent: the mic button interrupts the agent like a real call',
        [/if \(currentPlayer\) \{ currentPlayer\.stop\(\); currentPlayer = null; \}/.test(va),
         /onFirstAudio/.test(va)], [true, true]);

    // -- PG recon identifies GoKwik by SHOPIFY TAGS ----------------------------------------------
    // Asked for directly: tags, not EasyEcom, not gateway labels. The GoKwik tag covers ~98% of orders
    // in every month of 2026 and needs no sync; orders.gateway had 103 July / 466 August nulls. The
    // July COD invoice (2,765 tx / 47,397.66) only converges once abandoned-cart orders are excluded
    // and the fee base excludes shipping: 47,808 computed, 0.87% apart, vs 12.7% before.
    const pgApi = fs.readFileSync(path.join(ROOT, 'app/api/pg_recon.js'), 'utf8');
    const pgMig = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260824_pg_recon_tags.sql'), 'utf8');
    check('pg recon: classification is tags-first, in SQL, with the gateway reading only as fallback',
        [/,gokwik,/.test(pgMig), /,kc_abc,/.test(pgMig), /gk_member/.test(pgMig),
         /Tagless fallback/.test(pgMig)], [true, true, true, true]);
    // Membership decides billability: a manual or Cashfree COD must never be charged to GoKwik.
    check('pg recon: only GoKwik-processed orders are charged',
        /c\.gk_member and not c\.is_abc/.test(pgMig), true);
    // The ABC exclusion is an ASSUMPTION (evidence-based, unconfirmed by GoKwik) -- so it must be a
    // visible number everywhere, never a silent subtraction.
    check('pg recon: the abandoned-cart exclusion is visible in summary, CSV and UI',
        [/abc_orders/.test(pgMig), /'ABC'/.test(pgApi), /abandoned-cart/.test(fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8'))],
        [true, true, true]);
    // A tag-identified order with no gateway label must still resolve the gokwik% prepaid rate.
    check('pg recon: a tag-only order still finds its rate',
        /GoKwik \(by tag\)/.test(pgMig), true);

    // -- What is ALLOWED onto the Silent-RTO claim list ------------------------------------------
    // Three admission rules, stated by the user and enforced in the query, not the UI:
    //   1. the shipment's CURRENT status must itself be an RTO state -- `outcome` remembers that an RTO
    //      event happened once, it does not notice the courier reverting it (TE25-41443 / TE25-40292
    //      sat on the claim list while RapidShyp's live status said IN_TRANSIT);
    //   2. not a single OFD (rto_no_attempt, already enforced);
    //   3. never a LOST shipment -- lost has its own tab and its own larger claim, and one parcel must
    //      not be claimed twice.
    const drApi = fs.readFileSync(path.join(ROOT, 'app/api/delivery_reports.js'), 'utf8');
    check('silent-rto: the current status must itself be an RTO state',
        (drApi.match(/\.or\('status_code\.is\.null,status_code\.ilike\.RTO\*'\)/g) || []).length, 2);
    check('silent-rto: the evidence workbook uses the same admission rule as the claim list',
        /Same admission rule as the claim list/.test(drApi), true);
    // In the classifier, LOST now outranks RTO: a return that went lost never came back, and calling it
    // rto filed it on the claim list while the Lost tab (where its money is recovered) never saw it.
    const djApi2 = fs.readFileSync(path.join(ROOT, 'app/api/delivery_journey.js'), 'utf8');
    check('outcome: lost outranks rto in both classifiers, delivered still outranks both',
        (djApi2.match(/'delivered' : lost \? 'lost' : rto \? 'rto'/g) || []).length, 2);
    // A lost row with NO order date must still appear -- .gte() silently drops NULLs, which hid two
    // real lost shipments from every window on the one tab meant to miss nothing.
    check('lost tab: a null order date cannot hide a lost shipment',
        /order_date\.is\.null/.test(drApi), true);

    // -- A COD fee on a SILENT RTO is the easiest line in the claim ------------------------------
    // Nobody attempted delivery, so nobody collected cash, so the collection fee cannot be due. It was
    // buried inside the freight total, and the claim mail sent RapidShyp a lump sum they could argue
    // with. Live: 7 of 205 silent RTOs carry one, 207.68 rupees.
    const clHtml2 = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');
    check('silent-rto claim: the COD fee is itemised, not buried in the total',
        [/codCount: cod\.length/.test(drApi), /totalCod: round2/.test(drApi),
         /'COD fee', 'Shipping cost', 'Invoice value'/.test(drApi)], [true, true, true]);
    // The mail has to SAY why it is not due, or it is just another number in a table.
    check('silent-rto claim: the mail explains why a COD fee cannot be due on an unattempted parcel',
        /no delivery was attempted, so no cash was ever collected and the fee cannot be due/.test(drApi), true);
    // And the dashboard must show the split that prompted this -- COD charged, RTO leg not.
    check('silent-rto table: RTO freight and COD fee are separate columns',
        [/data-sort="freight_rto"/.test(clHtml2), /data-sort="cod_charges"/.test(clHtml2)], [true, true]);
    // Two columns added -> the empty-state colspan must move with them, in both files.
    check('silent-rto table: the empty state still spans the whole row',
        [/id="srto-tbody"><tr><td colspan="10"/.test(clHtml2),
         /colspan="10" class="px-4 py-8 text-center text-slate-400">No silent RTOs match/.test(rsUi)],
        [true, true]);

    // -- Claims: payment, the Lost tab, and the Excel export -------------------------------------
    const clApi = fs.readFileSync(path.join(ROOT, 'app/api/delivery_reports.js'), 'utf8');
    const clUi = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    const clHtml = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');
    // Built from SOURCE, not require()d: pulling in the router opens a Supabase client and dragged the
    // whole suite past two minutes. The rules are what is under test, not the module wiring.
    // CR stripped FIRST: these files are CRLF on disk, so a search for a bare newline-brace-newline
    // finds nothing and the slice comes back empty -- which fails as "scanRemark is not defined",
    // a message that points nowhere near the real cause.
    const clFlat = clApi.split(String.fromCharCode(13)).join('');
    const remarkSrc = clFlat.slice(clFlat.indexOf('const RTO_REASONS = ['),
        clFlat.indexOf(String.fromCharCode(10) + '}' + String.fromCharCode(10), clFlat.indexOf('function scanRemark(row)')) + 3);
    const scanRemark = new Function(remarkSrc + String.fromCharCode(10) + 'return scanRemark;')();

    // The four MOST COMMON scans on an RTO describe the parcel MOVING, not why it turned around:
    // return_received (198), return_expected (177), Dispatched for RTO (112), RETURN Accepted (93).
    // Taking "the last RTO-ish scan" would label almost every claim `return_received` -- worse than
    // blank, because it reads as an answer.
    check('claims remarks: movement scans are never mistaken for a reason',
        scanRemark({ raw: { scans: ['return_received', 'return_expected', 'Dispatched for RTO',
            'RETURN Accepted', 'Return to Origin InTransit'].map(s => ({ scan: s })) } }),
        'No reason in the scan log');
    // The reasons the user asked for, verbatim from the live vocabulary.
    check('claims remarks: the cancellation reasons are read out of the scan log',
        [scanRemark({ raw: { scans: [{ scan: 'Consignee verified cancellation' }] } }),
         scanRemark({ raw: { scans: [{ scan: 'Code verified cancellation' }] } })],
        ['Consignee verified cancellation/RTO', 'Code verified cancellation/RTO']);
    // A blank cell cannot distinguish "the courier gave no reason" from "we never stored the log", and
    // those are argued very differently -- 77 of 205 silent-RTOs have no scan log at all.
    check('claims remarks: a blank says WHICH kind of blank it is',
        [scanRemark({}), scanRemark({ raw: { scans: [] } })],
        ['No scan log stored', 'No scan log stored']);
    // Specific beats generic when several cause scans are present.
    check('claims remarks: the most specific reason wins',
        scanRemark({ raw: { scans: [{ scan: 'Undelivered' }, { scan: 'Consignee verified cancellation' }] } }),
        'Consignee verified cancellation/RTO');

    // The export is built SERVER-side from a fresh query. The PG-recon export was built from the
    // rendered page and silently produced 5,000 of 5,592 rows -- a file that looks complete and is not.
    check('claims export: rows are re-fetched on the server, not taken from the page',
        /cfg\.fetch\(rg\.fromISO, rg\.toISO\)/.test(clApi) && /claimsFilterRows/.test(clApi), true);
    check('claims export: every tab can be exported, including Lost',
        ['srto', 'late', 'intransit', 'ofd', 'lost'].every(k => new RegExp(`\\n    ${k}: \\{`).test(clApi)), true);
    // Dates as real Dates and money as numbers -- a date-shaped string cannot be sorted or filtered,
    // which is most of the reason to want a spreadsheet rather than a CSV.
    check('claims export: dates and money keep their types',
        /kind === 'date'[\s\S]{0,120}new Date\(v\)/.test(clApi) && /numFmt = 'dd-mm-yyyy'/.test(clApi), true);
    // Scan logs are ~70 entries per shipment; they must not ride along on every page load.
    check('claims export: scan logs are fetched only for an export, and chunked',
        /async function remarksByAwb/.test(clApi) && /awbs\.slice\(i, i \+ 200\)/.test(clApi), true);

    // The Lost tab: registered everywhere a tab has to be registered, or it half-works.
    check('claims: the Lost tab is wired end to end',
        [/'lost'\]/.test(clUi), /lost: 'claims-panel-lost'/.test(clUi), /lost: '\/api\/lost-shipments'/.test(clUi),
         /lost: 'lost-tbody'/.test(clUi), /function claimsRenderLost/.test(clUi),
         /id="claims-panel-lost"/.test(clHtml), /data-tab="lost"/.test(clHtml)],
        [true, true, true, true, true, true, true]);
    // A lost parcel has neither delivered_at nor rto_at -- that is what makes it lost -- so order_date
    // is the only timestamp it reliably has to window on.
    check('claims: lost shipments are windowed on order_date, the only date they all have',
        /WINDOWED ON `order_date`, NOT ON A TERMINAL DATE/.test(clApi), true);
    // The Lost tab was registered in every other registry and MISSED in the row-click list, so its rows
    // silently would not expand while all the detail-row code existed and looked correct. Driven off
    // _CLAIMS_TBODY now, so a new tab cannot be half-wired again.
    check('claims: row expansion is driven off the tbody registry, not a hand-typed list',
        /Object\.values\(_CLAIMS_TBODY\)\.forEach\(id => \{/.test(clUi), true);
    // colspan was pinned at 7 while Silent-RTO grew to 8 columns and Lost arrived with 9.
    check('claims: the detail panel spans the whole row, whatever the column count',
        /querySelectorAll\('thead th'\)\.length/.test(clUi) && !/claims-detail\"><td colspan=\"7\"/.test(clUi), true);
    // A lost parcel neither delivered nor returned; a greyed \Delivered\ step invites the reader to
    // think it might still arrive.
    check('claims: a lost timeline ends at the last scan, not at a blank Delivered',
        /const isLost = which === 'lost'/.test(clUi) && /Written off/.test(clUi), true);

    check('claims: payment mode is shown on the tables, not just in the filter',
        /function claimsPayChip/.test(clUi) && /data-sort="payment_mode"/.test(clHtml), true);

    // ⚠ The download must go through fetch() with the auth header. This app authenticates with a
    // BEARER TOKEN IN A HEADER, and a link navigation carries no headers -- the first version downloaded
    // the server 401 body as a file called "export" with no extension. A failed download that still
    // produces a file is the worst kind, because it looks like it worked.
    // ExcelJS applies a ROW-level fill across all 16,384 columns, so the indigo header band ran off
    // past column AH into empty cells. Only the columns that exist may be styled.
    check('claims export: the header band stops at the last real column',
        [/for \(let i = 1; i <= cols\.length; i\+\+\) \{/.test(clApi) && /cell\.fill = \{ type: .pattern./.test(clApi),
         !/head\.fill =/.test(clApi)], [true, true]);

    check('claims export: the download is authenticated, not a bare link',
        [/export\.xlsx\?[^\n]*headers: getAuthHeaders\(\)/.test(clUi),
         clUi.includes('a.download = name;'),
         // the old, broken form: an anchor pointed straight at the endpoint, carrying no token
         !clUi.includes('a.href = ' + String.fromCharCode(96) + '/api/claims')],
        [true, true, true]);
    // An UNLISTED path falls through to next(), i.e. any signed-in user whatever their role. The export
    // hands over the whole claims book in one file, so it must be gated like the views it comes from.
    const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split(String.fromCharCode(13)).join('');
    const tblStart = srvSrc.indexOf('const _VIEW_PERMS');
    const VIEW = new Function('return ' + srvSrc.slice(srvSrc.indexOf('[', tblStart), srvSrc.indexOf(String.fromCharCode(10) + '];', tblStart) + 2))();
    const gated = p => { for (const [rx, need] of VIEW) if (rx.test(p)) return [].concat(need).includes('claims-sla'); return false; };
    check('claims: every claims route is behind the claims-sla permission',
        ['/silent-rto-claims', '/late-deliveries', '/intransit-late', '/first-ofd-late', '/lost-shipments', '/claims/export.xlsx'].map(gated),
        [true, true, true, true, true, true]);

    // -- The snapshot must give the SAME answer twice ---------------------------------------------
    // One fixed 7-day window (15-21 Aug) produced 2,667 units at 06:30, 2,940 at 10:17 and a true
    // 2,830. The window never moved -- the edge fn paged ~10,000 orders with .range() and NO .order()
    // while the order sync was updating those rows, so whole PAGES were double-counted or dropped.
    // That is why every SKU moved by the same ~10-15% instead of moving independently.
    const edgeFn = fs.readFileSync(path.join(ROOT, 'supabase/functions/snapshot-inventory/index.ts'), 'utf8');
    check('snapshot: paging is ordered, so two runs of one window agree',
        /\.order\("order_id", \{ ascending: true \}\)[\s\S]{0,80}\.range\(from/.test(edgeFn), true);
    // The same warehouse arrives as "Shifupro Technologies Pvt. Ltd." before dispatch and "rapidshyp"
    // after. Mapping only one split it in two and made DRR climb as the dispatch queue was worked.
    check('snapshot: both names of the Shifupro warehouse credit the same bucket',
        /"shifupro technologies pvt\. ltd\.": "wo66194027524"/.test(edgeFn), true);
    // A stock-0 placeholder shares the upsert key with the real stock row, so a partial EasyEcom feed
    // overwrote 502 real units with a zero and the dashboard read Out of Stock.
    check('snapshot: a placeholder never overwrites a real stock row',
        /if \(locsWithInventory\.has\(loc\)\) continue;/.test(edgeFn), true);
    check('snapshot: a partial inventory feed leaves yesterday alone rather than writing zeros',
        /skusWithStock\.size < baseSkus\.size \* 0\.6/.test(edgeFn) && /skipped: true/.test(edgeFn), true);
    // It lived only in Supabase until 2026-08-22, which is why this took a day to explain.
    check('snapshot: the edge fn is in the repo, not only in Supabase',
        /Deno\.serve/.test(edgeFn) && /SOURCE OF TRUTH/.test(edgeFn), true);
    // Zone counts carry their share of the total -- the MIX is what gets acted on.
    const dpUi = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    const dpCss = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');
    check('delivery performance: zone/state options show a share, not just a count',
        [/dp-multi-share/.test(dpUi), /optTotal/.test(dpUi), /\.dp-multi-share \{/.test(dpCss)], [true, true, true]);

    // -- A new product must join the dashboard by itself -----------------------------------------
    // The snapshot's SKU list is the `base_sku` set in sku_pack_mapping and NOTHING else (verified:
    // 17 registered, 17 in the snapshot, identical sets), so a launched product stayed invisible in the
    // table, the charts, the reorder sheet and the Teams report until somebody hand-added a mapping row.
    const invApi = fs.readFileSync(path.join(ROOT, 'app/api/inventory.js'), 'utf8');
    check('new products: registration happens BEFORE the snapshot is built',
        invApi.indexOf('registerNewProducts()') < invApi.indexOf('functions/v1/snapshot-inventory'), true);
    // "Every EasyEcom SKU" would drag in ~60 drafts, FBA variants, channel codes and combos -- and
    // EasyEcom's own is_combo reads false for every one of them, so it cannot be the filter.
    check('new products: only real stock at our own warehouse qualifies',
        [/SHIFUPRO_LOC_CODE/.test(invApi), /qtyBySku\[sku\] > 0/.test(invApi),
         /NOT_A_PRODUCT/.test(invApi), /isCodeName/.test(invApi)], [true, true, true, true]);
    // EasyEcom states one physical pool in each pack's unit (524 / 262 / 131), so the RATIO proves the
    // multiplier. Registering a pack as its own base would triple-count the same bottles; taking the
    // multiplier from the trailing digit alone would corrupt DRR silently.
    check('new products: a pack multiplier comes from the stock ratio, never the SKU name alone',
        /ratioProves = bq > 0 && pq > 0 && bq % pq === 0 && bq \/ pq === p\.n/.test(invApi), true);
    check('new products: an unproven pack is reported, not registered on a guess',
        /unsure\.push/.test(invApi) && /needing a human/.test(invApi), true);
    // A first snapshot that comes back empty reads as OUT OF STOCK, and the 06:30 Teams report would
    // announce a freshly-stocked product that way. Checked against EasyEcom and re-run once instead.
    check('new products: an empty first snapshot is verified and re-run, not trusted',
        /came back with no stock though EasyEcom/.test(invApi) && /out = await runSnapshot\(\);/.test(invApi), true);
    // Registration must never cost us the snapshot itself.
    check('new products: a registration failure still leaves the snapshot running',
        /registration failed \(snapshot continues\)/.test(invApi), true);

    // -- Raised PO must explain itself -----------------------------------------------------------
    // "Raised PO 549" for TE-BB1 against a PO raised for 500 reads as a bug. It is 500 from PO 69 plus
    // a 49-unit remnant of PO 38 -- raised 5 Jun, 1 of 50 units ever received, still Open 77 days on.
    // The sum was right; nothing on the page could explain it.
    const poApi = fs.readFileSync(path.join(ROOT, 'app/api/purchase_orders.js'), 'utf8');
    const poUi = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    check('raised po: the figure carries the POs it is made of',
        [/detailBySku/.test(poApi), /open_po_detail/.test(fs.readFileSync(path.join(ROOT, 'app/api/inventory.js'), 'utf8')), /poTitle/.test(poUi)],
        [true, true, true]);
    // A line pending long past its raise date is a forgotten PO. It stays subtracted -- EasyEcom still
    // calls it open -- but it must be VISIBLE, since a stale remnant suppressing a re-order is exactly
    // how this number does damage.
    check('raised po: a long-pending line is flagged stale, not silently dropped',
        [/const PO_STALE_DAYS = 45;/.test(poApi), /stale: ageDays != null && ageDays > PO_STALE_DAYS/.test(poApi),
         /bySku\[sku\] = \(bySku\[sku\] \|\| 0\) \+ i\.pending;/.test(poApi)],
        [true, true, true]);
    // A tooltip nobody hovers is not a warning: the stale POs are named in the footnotes too.
    check('raised po: stale POs are named on the page, not only on hover',
        /stale PO line/.test(poUi) && /close the PO in EasyEcom/.test(poUi), true);

    check('open po: the report names the stale copy instead of claiming failure',
        /po\.stale\) poStaleAt = po\.fetchedAt/.test(inv) && /subtracted from the last good copy/.test(inv), true);
}

// -- 4h. GoKwik PG recon: the count line and the export must cover the WHOLE window --------------
// 2026-08-20, user-reported: the Reconciliation header read "4,911 charged" and "89 not charged" for a
// 5,592-order month -- a pair that sums to the 5,000 ROW CAP, not to the window -- while the banner
// claimed every total covered all of them. It understated the July charge by Rs 11,421. The CSV export
// had the same flaw, which is worse: a short file nobody can tell is short. Buckets are now computed
// over every row server-side, and the export is built there too.
{
    const src = fs.readFileSync(path.join(ROOT, 'app/api/pg_recon.js'), 'utf8');
    const ui = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    eval(src.match(/function pgrBuckets[\s\S]*?\n\}\r?\n/)[0]);
    const rows = [
        { payment_type: 'cod',     charged: true,  order_value: 100, fee: 2,   gst: 0.36, total_charge: 2.36 },
        { payment_type: 'cod',     charged: true,  order_value: 200, fee: 4,   gst: 0.72, total_charge: 4.72 },
        { payment_type: 'prepaid', charged: false, order_value: 50 },
        { payment_type: 'partial', charged: true,  order_value: 300, fee: 7.5, gst: 1.35, total_charge: 8.85 },
    ];
    const b = pgrBuckets(rows);
    check('pg recon: buckets partition every row exactly once',
        b.reduce((a, x) => a + x.orders, 0), rows.length);
    check('pg recon: charged + not-charged buckets rebuild the full count',
        [b.filter(x => x.charged).reduce((a, x) => a + x.orders, 0),
         b.filter(x => !x.charged).reduce((a, x) => a + x.orders, 0)], [3, 1]);
    check('pg recon: an uncharged row contributes 0 charge, never null',
        b.filter(x => !x.charged).reduce((a, x) => a + x.charge, 0), 0);
    check('pg recon: charge survives bucketing',
        Math.round(b.reduce((a, x) => a + x.charge, 0) * 100) / 100, 15.93);
    check('pg recon: the count line reads buckets, not the rendered page',
        /_pgr\.buckets/.test(ui) && !/cnt\.textContent = pgrNum\(rows\.length\) \+ ' orders/.test(ui), true);
    check('pg recon: the reconciliation CSV is built server-side over the full window',
        /pg-recon\/export\.csv/.test(src) && /pg-recon\/export\.csv/.test(ui), true);
}

// -- 4i. KwikShip Freight Recon: a COMPUTED expectation that must never masquerade as an invoice ---
// Built 2026-08-20. Unlike RapidShyp Recon (charges are RapidShyp's own, from their API), KwikShip
// publishes no billing endpoint: every rupee is OUR computation from kwikship_rate_card_ecom. These
// pin the arithmetic that decides what we think we owe, and the honesty line that says so.
{
    const ks = require(path.join(ROOT, 'app/api/kwikship_recon'));
    const ui = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    const api = fs.readFileSync(path.join(ROOT, 'app/api/kwikship_recon.js'), 'utf8');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8');

    // Influencer video metrics refresh themselves weekly — Friday 11 PM IST (asked for 2026-08-25).
    // ⚠ Orchestrated from NODE, never the edge fn: the old refresh-recent-video-metrics fn dispatched
    // fetch-reel-metrics with the edge runtime's injected key and EVERY dispatch 401'd at the gateway
    // ("Refresh: dispatched 0/32") while this server's legacy service JWT passes (202, proven live).
    // The cron and the panel's bulk Refresh share the same Node dispatcher, so they cannot disagree —
    // and the video-list query pages past the silent 1000-row cap with .order per page.
    {
        const inf = fs.readFileSync(path.join(ROOT, 'app/api/influencer_crm.js'), 'utf8');
        check('influencer: Friday 11 PM IST cron refreshes recent video metrics from Node',
            [/InfVideos \(0 23 \* \* 5\)/.test(srv), /'0 23 \* \* 5'/.test(srv),
             /refreshVideoMetrics/.test(srv), /module\.exports\.refreshVideoMetrics = refreshVideoMetrics/.test(inf),
             /invokeFn\('fetch-reel-metrics', \{ url: v\.video_url, videoId: v\.id \}/.test(inf),
             /makeQ\(\)\.range\(from, from \+ 999\)/.test(inf)], [true, true, true, true, true, true]);
        check('influencer: the panel bulk refresh uses the same Node dispatcher (edge orchestration retired)',
            [/refreshVideoMetrics\(\{ scope: b\.scope, influencerId: b\.influencerId, days: b\.days \}\)/.test(inf),
             /invokeFn\('refresh-recent-video-metrics'/.test(inf)], [true, false]);
    }

    const cfg = { gst_pct: 18, cod_pct: 1.3, cod_min: 25 };
    const rows = [
        { outcome: 'delivered',  payment_mode: 'COD',     value: 1000, priced: true,  is_final: true,  forward: 43, rto: 0,  cod: 25, charge: 68, weight: 100, zone: 'D', flags: [] },
        { outcome: 'rto',        payment_mode: 'COD',     value: 500,  priced: true,  is_final: true,  forward: 43, rto: 43, cod: 0,  charge: 86, weight: 100, zone: 'D', flags: [] },
        { outcome: 'delivered',  payment_mode: 'Prepaid', value: 800,  priced: true,  is_final: true,  forward: 23, rto: 0,  cod: 0,  charge: 23, weight: 100, zone: 'A', flags: [] },
        { outcome: 'in_transit', payment_mode: 'COD',     value: 600,  priced: false, is_final: false, forward: 0,  rto: 0,  cod: 0,  charge: 0,  weight: 100, zone: 'A', flags: [] },
    ];
    const s2 = ks.summarize(rows, cfg);

    // GST is carried SEPARATELY and never folded into the freight figure -- the user asked for that on
    // every recon page, and a merged number is impossible to hold against a tax invoice.
    check('kwikship: freight and GST stay separate, and add up',
        [s2.charge, s2.gst, s2.chargeInclGst], [177, 31.86, 208.86]);
    // COD cash reaches us only on delivery: an RTO collects nothing, so it owes no remittance.
    check('kwikship: only DELIVERED cod shipments create an expected remittance',
        [s2.expectedCodRemittance, s2.codRtoValue, s2.prepaidValue], [1000, 500, 800]);
    check('kwikship: a still-moving shipment is in-flight, not an unpriced billing gap',
        [s2.priced, s2.unpriced, s2.inFlight], [3, 0, 1]);

    // Buckets must cover every row -- the count line reads them instead of the capped page.
    const b = ks.buckets(rows);
    check('kwikship: buckets partition every shipment exactly once',
        [b.reduce((a, x) => a + x.shipments, 0), Math.round(b.reduce((a, x) => a + x.charge, 0) * 100) / 100],
        [rows.length, 177]);

    // `unpriced` means FINAL-but-unpriced only. Counting in-flight shipments as billing gaps is what
    // made RapidShyp Recon report 1,131 missing invoices when the true number was 181.
    check('kwikship: unpriced flags a settled shipment, never one still moving',
        [ks.flagsOf({ is_final: true,  freight_total: null, applied_weight: 100, zone: 'D' }).includes('unpriced'),
         ks.flagsOf({ is_final: false, freight_total: null, applied_weight: 100, zone: 'D' }).includes('unpriced')],
        [true, false]);
    check('kwikship: a COD fee on a prepaid shipment is flagged',
        ks.flagsOf({ is_final: true, freight_total: 23, applied_weight: 100, zone: 'A', payment_mode: 'Prepaid', cod_charges: 25 }).includes('cod_on_prepaid'), true);

    // The filter lives once, server-side, so the CSV and the screen cannot drift.
    check('kwikship: the export filter is shared, and the CSV is built server-side over the full window',
        [/export\.csv/.test(api) && /applyFilter\(/.test(api), /kwikship-recon\/export\.csv/.test(ui)], [true, true]);
    check('kwikship: the page states the charges are computed, not invoiced',
        /not a KwikShip invoice/i.test(ui) && /computed: true/.test(api), true);
    // ALL SIX registration points -- adding the permission alone leaves the nav item invisible, which
    // cost a debugging round on the GoKwik PG build (index.html is static).
    // The window basis is the terminal status date (delivered_at / rto_at), not the order date: freight
    // is earned when a shipment CLOSES, so a parcel ordered 28 Jul and delivered 3 Aug is August
    // freight. Live proof at the switch: July held 85 shipments by order date but 8 by close date.
    check('kwikship: shipments are windowed on the terminal status date, never the order date',
        [/fetchByDate\('delivered_at'/.test(api) && /fetchByDate\('rto_at'/.test(api),
         /basis: 'closed_at'/.test(api),
         /gte\('order_date', fromISO\)/.test(api)],
        [true, true, false]);
    // A shipment that has not closed belongs to no window -- it must be COUNTED, not silently absent.
    check('kwikship: still-moving shipments are surfaced, not dropped in silence',
        /openShipments\(/.test(api) && /still moving/.test(ui), true);
    // The close date must agree with the OUTCOME: the fetch matches either timestamp, so a parcel
    // carrying both would be pulled in by one column and labelled by the other -- across a month
    // boundary that is an off-by-one indistinguishable from a timezone bug.
    check('kwikship: an RTO is dated by rto_at even when a delivered_at also exists',
        /String\(r\.outcome \|\| ''\) === 'rto' \? \(r\.rto_at \|\| r\.delivered_at\)/.test(api), true);
    check('kwikship: the ledger groups months by the close date too',
        /istDay\(r\.closed_at \|\| r\.order_date\)/.test(api), true);
    // -- Ledger: the TWO-SIDED account, not a freight bill list ----------------------------------
    // KwikShip COLLECTS the COD and remits it net of freight, exactly as DocPharma settles. The first
    // version carried only the freight side and so announced "3358.72 payable to KwikShip" for a month
    // in which KwikShip was holding 3.87 LAKH of ours -- the sign of the account was inverted.
    check('kwikship ledger: both sides of the account are carried, not just freight',
        [/codCollected/.test(api), /receivable/.test(api), /remitExpected/.test(api), /payableInvoiced/.test(api)],
        [true, true, true, true]);
    // An RTO collects no cash, so its value must never enter the receivable.
    check('kwikship ledger: only DELIVERED COD becomes receivable',
        /oc === 'delivered'\) \{ b\.codDelivered\+\+; b\.codCollected \+= r\.value \|\| 0; \}/.test(api), true);
    // A month KwikShip has not billed is not a liability yet -- netting the rate-card estimate would
    // report money as settled that nobody has actually claimed.
    check('kwikship ledger: only INVOICED freight is netted, the estimate stays a memo',
        [/b\.payableActual = b\.invGrand;/.test(api), /unInvoicedMemo/.test(api)], [true, true]);
    // The old code did `if (months[m]) months[m].payments += ...` -- a remittance in a month with no
    // closed shipment was silently dropped, making the account look further behind than it was.
    check('kwikship ledger: a payment in a shipment-less month still lands',
        /payments\.forEach\(p => \{\s*\n\s*if \(!inWindow/.test(api), true);
    // ...but only inside the window asked for, or an August bill shows as a phantom month on a July view.
    check('kwikship ledger: an out-of-window invoice does not invent a month',
        /const inWindow = m => m !== 'unknown' && m >= mFrom && m <= mTo;/.test(api), true);
    // FIFO frontier: partners pay lump sums, so "settled through" is the honest reading, not an average.
    check('kwikship ledger: settlement is FIFO with a stated frontier',
        [/settledThrough/.test(api), /unsettledMonths/.test(api), /overpaid/.test(api)], [true, true, true]);
    // The ledger strip uses an auto-fit grid, which reflows on CONTENT rather than on a breakpoint --
    // right for a KPI row whose card count varies. (This test once asserted that `lg:` grid classes are
    // not compiled at all; that was false and is corrected in tailwind-audit below.)
    check('kwikship ledger: the KPI strip sizes itself from content, not a fixed column count',
        /repeat\(auto-fit,minmax\(215px,1fr\)\)/.test(ui), true);
    // What IS true about the prebuilt stylesheet, checked against the file rather than remembered.
    const tw = fs.readFileSync(path.join(ROOT, 'app/static/tailwind.css'), 'utf8');
    check('tailwind-audit: the responsive grid classes the dashboard uses ARE compiled',
        ['lg\\:grid-cols-2', 'lg\\:grid-cols-3', 'lg\\:grid-cols-4', 'lg\\:col-span-2'].map(k => tw.includes(k)),
        [true, true, true, true]);
    // ...and the ones that genuinely are NOT. Checked against the FILE, because every guess about
    // this stylesheet has been wrong in one direction or the other: text-[10px], text-[11px],
    // z-[90] and hover:bg-* all ARE compiled; opacity modifiers, gap-y, pl-8 and `lift` are not.
    check('tailwind-audit: what is genuinely missing from the prebuilt stylesheet',
        ['.bg-emerald-50\\/30', '.bg-white\\/10', '.gap-y-2{', '.pl-8{', '.lift{'].map(k => tw.includes(k)),
        [false, false, false, false, false]);
    check('tailwind-audit: and what IS present, contrary to earlier belief',
        ['.text-\\[10px\\]', '.text-\\[11px\\]', '.z-\\[90\\]', '.hover\\:bg-slate-50:hover'].map(k => tw.includes(k)),
        [true, true, true, true]);
    // Money moves both ways; a remittance rendered as a payment out inverts the balance.
    check('kwikship payments: direction is recorded and shown',
        [/ksrp-dir/.test(ui), /_ksrPayOut/.test(ui), /direction: b\.direction \|\| 'received'/.test(api)], [true, true, true]);

    // -- Invoices: the real bill, held against the computed expectation --------------------------
    // The invoice parser reads layouts we have never seen, so the one thing it must never do is
    // produce a WRONG number that looks plausible enough to save unchecked.
    // The parser leans on a few module-level helpers, so build it with its real dependencies rather
    // than eval'ing the function alone (which silently loses MONTHS and reports a scope error as a bug).
    const grabFn = re => api.match(re)[0];
    const parserSrc = [
        grabFn(/const MONTHS = [^\n]+\n/),
        grabFn(/const _n = [^\n]+\n/),
        grabFn(/const _c = [^\n]+\n/),
        grabFn(/function monthPeriod[\s\S]*?\n\}\n/),
        grabFn(/function amountOnLine[\s\S]*?\n\}\n/),
        grabFn(/function parseInvoiceText[\s\S]*?\n\}\n/),
        'return { monthPeriod, parseInvoiceText };',
    ].join('\n');
    const { monthPeriod, parseInvoiceText: parseInv } =
        new Function('parseInvDate', parserSrc)(require(path.join(ROOT, 'app/api/docpharma_invoices')).parseInvDate);
    check('kwikship invoices: a stated month becomes the whole calendar period',
        [monthPeriod("Jul'26"), monthPeriod('February 2026')],
        [{ from: '2026-07-01', to: '2026-07-31' }, { from: '2026-02-01', to: '2026-02-28' }]);
    // `CGST9 (9%) 4,265.79` must yield the AMOUNT, not the 9. Reading a rate as a rupee figure gives a
    // small, believable number -- the worst kind of parse error.
    const real = parseInv("Invoice No. : GKHR/2627/018734\nInvoice Date : 01 Aug 2026\nService Period : Jul'26\n"
        + 'No of Transactions: 2765\nTotal Taxable Amount 47,397.66\nCGST9 (9%) 4,265.79\nSGST9 (9%) 4,265.79\nTotal 55,929.00');
    check('kwikship invoices: GST reads the amount, never the rate',
        [real.gst_amount, real.freight_amount, real.shipments, real.period_from], [8531.58, 47397.66, 2765, '2026-07-01']);
    check('kwikship invoices: a rate-only line yields nothing rather than a wrong total',
        parseInv('IGST 18%\nTotal 100.00').gst_amount == null, true);
    // The second real layout (Goexcelsior HR/26-27/0014132) stacks THREE totals: `Sub Total 327.00`,
    // `Total 386.00`, `Balance Due 386.00`. Reading the first line containing "Total" returned 327 --
    // the PRE-TAX figure, short by exactly the GST, which is the one number this page exists to check.
    const stacked = parseInv('Invoice Number : HR/26-27/0014132\nInvoice Date : 07/08/2026\n'
        + '# Item & Description HSN/SAC Qty Taxable Value (Excl. GST)\n1 Freight Charge 996511 1.00 327.00\n'
        + 'Total In Words\nIndian Rupee Three Hundred Eighty-Six Only\n'
        + 'Sub Total 327.00\nCGST (9%) 29.43\nSGST (9%) 29.43\nRounding 0.14\nTotal \u20b9386.00\nBalance Due \u20b9386.00');
    check('kwikship invoices: a sub-total is never mistaken for the total',
        [stacked.freight_amount, stacked.gst_amount, stacked.total_amount, stacked.invoice_no],
        [327, 58.86, 386, 'HR/26-27/0014132']);
    // A lump-sum freight line has Qty 1.00 -- a line-item count, NOT a shipment count. Inventing
    // shipments = 1 would show a variance of -1,966 against the month.
    check('kwikship invoices: a line-item qty is not a shipment count', stacked.shipments, null);
    // Part-paid: Balance Due is smaller than the bill, and the BILL is what a variance measures.
    check('kwikship invoices: the invoice total wins over a smaller balance due',
        parseInv('Sub Total 1000.00\nIGST (18%) 180.00\nTotal 1180.00\nBalance Due 500.00').total_amount, 1180);
    // A missing table must degrade to a setup message, not a 500. PostgREST answers PGRST205 here --
    // it never reaches Postgres, so the 42P01 everyone tests for never appears.
    check('kwikship invoices: a missing table degrades to a setup prompt',
        /PGRST205/.test(api) && /needsSetup/.test(api) && /needsSetup/.test(ui), true);
    check('kwikship invoices: parsing never writes -- it fills the form for review',
        /returns fields for REVIEW, saves nothing|for REVIEW, saves nothing/.test(api), true);
    // Asked for: Method removed from the payment form, PDF/Excel upload added.
    check('kwikship payments: the Method field is gone and an upload replaces it',
        [/ksrp-method/.test(ui), /kwikship-payments\/parse/.test(ui) && /ksrp-file/.test(ui)], [false, true]);
    // apply_kwikship_charges() RECOMPUTES applied_weight from the courier payload, wiping any weight
    // we supplied -- so every call must be followed by the backfill or shipments KwikShip never
    // weighed go straight back to unpriced. It was called from THREE places with the backfill after
    // only one, so TE25-42790 un-priced itself again the moment anyone re-zoned. One wrapper now.
    {
        const sync = fs.readFileSync(path.join(ROOT, 'app/api/kwikship_sync.js'), 'utf8');
        const zm = fs.readFileSync(path.join(ROOT, 'app/api/zone_mapping.js'), 'utf8');
        const srv2 = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const raw = [sync, zm, srv2].join(' ').match(/rpc\('apply_kwikship_charges'\)/g) || [];
        check('kwikship: the costing RPC is called in exactly one place', raw.length, 1);
        check('kwikship: that one place backfills straight after costing',
            /async function applyKwikshipCharges\(\)[\s\S]{0,600}backfillKwikshipFromOrders\(\)/.test(sync), true);
        check('kwikship: re-zoning goes through the wrapper, not the raw RPC',
            (zm.match(/applyKwikshipCharges\(\)/g) || []).length, 2);
    }
    check('kwikship: every registration point is wired',
        [/require\('\.\/app\/api\/kwikship_recon'\)/.test(srv),
         /kwikship-\(recon\|payments\)/.test(srv),
         /case 'kwikship-recon':/.test(ui),
         /'nav-kwikship-recon': 'kwikship-recon'/.test(ui),
         /\['kwikship-recon','KwikShip Freight Recon'\]/.test(ui),
         /id="nav-kwikship-recon"/.test(html) && /id="kwikship-recon-view"/.test(html)],
        [true, true, true, true, true, true]);
}

// -- 4j. ShopifyHold: a */2 cron must not card a network blip ------------------------------------
// Six red cards in one hour on 20 Aug, every one a network error (`TypeError: fetch failed`, one axios
// timeout). Nothing was wrong with the job. Two of those runs lasted 148s and 243s against a 120s
// schedule -- runs were OVERLAPPING, which makes timeouts likelier, which makes runs longer.
{
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const SH_TRANSIENT = eval(srv.match(/const SH_TRANSIENT = (\/.+\/i);/)[1]);
    // Built FROM server.js, never re-typed here: a hand-copied classifier drifts from the real one,
    // and a test that passes against its own copy of the rule is worse than no test. (It happened:
    // this line missed the e.transient flag the moment server.js grew one.)
    const shTransient = eval(srv.match(/const shTransient = ([^;]+);/)[1]);
    const AFTER = parseInt((srv.match(/SH_ALERT_AFTER, 10\) \|\| (\d+)/) || [])[1], 10);

    // The four real messages from the cards, verbatim.
    // The four real messages from the cards, verbatim.
    // WARNING: `terminated` is undici's message when the connection dies mid-response, and it was on
    // THREE of the four cards from 21 Aug 20:42-20:44. It was missing from SH_TRANSIENT, so it fell
    // through to the non-transient branch and raised a card on EVERY occurrence -- the hardening did
    // nothing at all for the failure that was actually happening.
    check('shopify hold: undici own vocabulary is classed transient',
        ['terminated', 'HeadersTimeoutError: Headers Timeout Error', 'BodyTimeoutError',
         'ConnectTimeoutError', 'UND_ERR_SOCKET', 'ECONNREFUSED',
         'Client network socket disconnected before secure TLS connection'].map(m => shTransient({ message: m })),
        [true, true, true, true, true, true, true]);
    // Replay of that exact night: four consecutive transient failures, SH_ALERT_AFTER = 5 -> no card.
    check('shopify hold: the 21 Aug burst raises no card at all',
        ['terminated', 'terminated', 'fetch failed', 'terminated']
            .reduce((n, m, i) => n + ((shTransient({ message: m }) ? (i + 1 === AFTER ? 1 : 0) : 1)), 0), 0);
    // A run we abandon at the deadline is transient by CONSTRUCTION -- flagged, not matched on wording,
    // because a message-shaped test for our own error is a string we could rename by accident.
    check('shopify hold: an abandoned run is transient by flag, not by wording',
        [shTransient({ transient: true, message: 'run still going after 100s' }),
         /e\.transient = true/.test(srv)], [true, true]);
    // The deadline stops the tick WAITING; it must NOT clear the overlap guard, or the abandoned run
    // would still be holding orders while the next tick started behind it.
    check('shopify hold: a hung run is abandoned without letting the next tick overlap it',
        /work\.then\(\(\) => \{ _shRunning = false; \}, \(\) => \{ _shRunning = false; \}\);/.test(srv)
        && !/finally \{ _shRunning = false; \}/.test(srv), true);

    check('shopify hold: the real network failures are classed transient',
        ['cron error: TypeError: fetch failed', 'orders lookup failed: TypeError: fetch failed',
         'TypeError: fetch failed', 'timeout of 20000ms exceeded'].map(m => shTransient({ message: m })),
        [true, true, true, true]);
    // A genuine bug must never be muffled by the transient path -- that is the failure mode of this
    // kind of fix, and it is worse than the noise it removes.
    check('shopify hold: a genuine bug is never classed transient',
        ["Cannot read properties of undefined (reading 'order_name')", 'holdOrderSmart is not a function',
         'invalid input syntax for type uuid'].map(m => shTransient({ message: m })),
        [false, false, false]);

    // Escalation: warn while it is plausibly a blip, card once it is plainly an outage, then hourly.
    const policy = n => (n === AFTER || (n > AFTER && n % 30 === 0));
    check('shopify hold: one blip raises no card, a sustained outage does',
        [policy(1), policy(AFTER - 1), policy(AFTER), policy(30), policy(60)],
        [false, false, true, true, true]);
    let cards = 0; for (let n = 1; n <= 30; n++) if (policy(n)) cards++;
    check('shopify hold: an hour of continuous failure cards twice, not thirty times', cards, 2);

    check('shopify hold: overlapping runs are skipped, not stacked',
        /_shRunning/.test(srv) && /previous run still going/.test(srv), true);
    check('shopify hold: one failing order cannot abandon the batch',
        /holdOrderSmart\([\s\S]{0,1200}?\} catch \(e\) \{[\s\S]{0,120}failed\+\+/.test(srv), true);
    check('shopify hold: the candidate lookup retries a transient failure once',
        /if \(!shTransient\(e1\)\) throw e1;/.test(srv), true);
}

// ── 4g2. Repeat-COD identity: phone ∪ email, closed — the rules in ONE place ────────────────────
// TE25-45095 (2026-08-27): RTO in April + cancellation in May under phone A, new COD order under phone B
// with the SAME email — both copies of the rule keyed history on phone only and saw a first-time
// buyer. Now repeat_rules.js owns the identity closure AND the rule evaluation for the webhook, the
// */2 cron and the Call Queue. These tests replay that order's shape, the placeholder guard, the
// runaway-closure fallback, and every payment-type branch, on the pure functions.
{
    const RR = require(path.join(ROOT, 'app/api/repeat_rules'));
    const rows = [
        { order_id: '1', order_name: '#TE25-21864', phone: '+919607878181', email: 'more.vinaya123@gmail.com', bucket: 'rto', created_at: '2026-04-13T16:56:19Z', total_price: 748 },
        { order_id: '2', order_name: '#TE25-25202', phone: '+919607878181', email: 'more.vinaya123@gmail.com', bucket: 'cancelled', created_at: '2026-05-08T07:49:17Z', total_price: 748 },
        { order_id: '3', order_name: '#TE25-45095', phone: '+917030520199', email: 'more.vinaya123@gmail.com', bucket: 'order_to_dispatch', created_at: '2026-08-27T10:45:45Z', total_price: 798 },
        { order_id: '9', order_name: '#OTHER', phone: '9999999999', email: 'stranger@x.com', bucket: 'rto', created_at: '2026-06-01T00:00:00Z', total_price: 500 },
    ];
    const cand = { order_id: '3', created_at: '2026-08-27T10:45:45Z', total_price: 798, financial_status: 'pending', address: 'Flat 4, Some Long Street Name, Some Locality, Pune, Maharashtra, 411001' };
    // Webhook moment: the new order is NOT in order_buckets yet, so the pool is history only.
    const pool = rows.filter(r => r.order_id !== '3');
    const idPhoneOnly = RR.closeIdentity({ phone: '7030520199' }, pool);
    const idBoth = RR.closeIdentity({ phone: '7030520199', email: 'More.Vinaya123@gmail.com' }, pool);
    check('repeat: phone-only seed finds nothing for TE25-45095 (the old behaviour)', idPhoneOnly.orders.map(o => o.order_id), []);
    check('repeat: phone ∪ email closes over the old phone and finds the RTO history',
        [idBoth.orders.map(o => o.order_id).sort(), [...idBoth.phones].sort(), [...idBoth.emails]],
        [['1', '2'], ['7030520199', '9607878181'], ['more.vinaya123@gmail.com']]);
    // Cron moment: the order IS in the pool — a phone seed reaches the email through its own row.
    check('repeat: once the order is in the pool even a phone seed closes over the email',
        RR.closeIdentity({ phone: '7030520199' }, rows).orders.map(o => o.order_id).sort(), ['1', '2', '3']);
    check('repeat: TE25-45095 now holds on recent_undelivered (RTO counts, cancelled does not)',
        RR.evaluateReasons({ cand, history: idBoth.orders, deliveredHighValue: false, deliveredAddrNorms: new Set() }), ['recent_undelivered']);
    check('repeat: a placeholder phone is never an identity key', [RR.phoneKey('9999999999'), RR.phoneKey('+91 70305 20199'), RR.emailKey('dummy@x.com'), RR.emailKey(' A@B.COM ')], [null, '7030520199', null, 'a@b.com']);
    // Runaway closure: 401 orders share one email → fall back to the seed keys, never merge strangers.
    const big = Array.from({ length: 401 }, (_, i) => ({ order_id: 'b' + i, phone: '8' + String(100000000 + i), email: 'shared@x.com', bucket: 'rto', created_at: '2026-01-01T00:00:00Z' }));
    const ov = RR.closeIdentity({ phone: '8100000000', email: 'shared@x.com' }, big);
    check('repeat: a closure past MAX_MERGE falls back to the seed keys and flags overflow', [ov.overflow, ov.phones.size, ov.emails.size], [true, 1, 1]);
    // Payment-type branches and the trust exceptions.
    const hist = [{ order_id: 'h1', bucket: 'in_transit', created_at: '2026-08-01T00:00:00Z' }, { order_id: 'h2', bucket: 'rto', created_at: '2026-07-01T00:00:00Z' }];
    const base = { order_id: 'c', created_at: '2026-08-27T00:00:00Z', total_price: 1600, address: 'short addr' };
    check('repeat: fully prepaid never holds', RR.evaluateReasons({ cand: { ...base, financial_status: 'paid' }, history: hist, deliveredHighValue: false, deliveredAddrNorms: new Set() }), []);
    check('repeat: partially paid holds on high_value only', RR.evaluateReasons({ cand: { ...base, financial_status: 'partially_paid' }, history: hist, deliveredHighValue: false, deliveredAddrNorms: new Set() }), ['high_value']);
    check('repeat: COD gets every reason that applies', RR.evaluateReasons({ cand: { ...base, financial_status: 'pending' }, history: hist, deliveredHighValue: false, deliveredAddrNorms: new Set() }).sort(), ['high_value', 'in_flight', 'recent_undelivered', 'short_address']);
    check('repeat: a past ≥₹1500 delivery and a delivered same-address drop those two reasons',
        RR.evaluateReasons({ cand: { ...base, financial_status: 'pending' }, history: hist, deliveredHighValue: true, deliveredAddrNorms: new Set([RR.normAddr('Short Addr')]) }).sort(), ['in_flight', 'recent_undelivered']);
    check('repeat: any delivered order in the last 3 makes the customer trusted for the history rule',
        RR.evaluateReasons({ cand: { ...base, total_price: 500, address: 'a long enough address to pass the sixty character minimum easily', financial_status: 'pending' }, history: [...hist, { order_id: 'h3', bucket: 'delivered', created_at: '2026-08-10T00:00:00Z' }], deliveredHighValue: false, deliveredAddrNorms: new Set() }), ['in_flight']);
    // Structural: both callers go through the one module; the webhook now passes the email.
    const sh = fs.readFileSync(path.join(ROOT, 'app/api/shopify_hold.js'), 'utf8');
    const sc = fs.readFileSync(path.join(ROOT, 'app/api/support_console.js'), 'utf8');
    const wh = fs.readFileSync(path.join(ROOT, 'app/api/webhook_handler.js'), 'utf8');
    check('repeat: webhook and cron/queue both evaluate through repeat_rules (no second copy of the rule)',
        [/RR\.evaluateReasons\(/.test(sh), /RR\.evaluateReasons\(/.test(sc), /RR\.fetchHistory\(/.test(sh), /RR\.fetchHistory\(/.test(sc),
         /const HIGH_VALUE_MIN = 1500/.test(sh), /const HIGH_VALUE_MIN = 1500/.test(sc), /holdReasonsDetailed\(\{ phone, email,/.test(wh)],
        [true, true, true, true, false, false, true]);
}

// ── 4g3. Hold coverage: every COD order is evaluated, recorded, and never starved ────────────────
// "No order should be skipped from rule" (2026-08-27). Three structural guarantees: (1) every path
// writes the evaluation ledger; (2) the */2 cron drops already-held orders BEFORE its per-tick cap, so
// settled orders cannot starve a new one; (3) a 'stale' Shopify verdict falls through to the EasyEcom
// path instead of ending the attempt; plus (4) the 10-minute reconciler that evaluates any COD order
// the webhook and cron both missed. The work-list rule is exercised on the pure filter.
{
    const RR = require(path.join(ROOT, 'app/api/repeat_rules'));
    const sh = fs.readFileSync(path.join(ROOT, 'app/api/shopify_hold.js'), 'utf8');
    const wh = fs.readFileSync(path.join(ROOT, 'app/api/webhook_handler.js'), 'utf8');
    const sv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('coverage: webhook, cron and reconciler all write the evaluation ledger',
        [(wh.match(/RR\.recordEvaluation\(/g) || []).length >= 2, /RR\.recordEvaluation\(supabase, \{ orderName: c\.order_name, path: 'cron'/.test(sv), /path: 'reconcile'/.test(sh)],
        [true, true, true]);
    check('coverage: the cron drops held/released orders BEFORE the per-tick cap (no starvation)',
        [/const open = cand\.filter\(c => \{ const st = states\[/.test(sv), /for \(const c of open\.slice\(0, 100\)\)/.test(sv), /for \(const c of cand\.slice\(0, 50\)\)/.test(sv)],
        [true, true, false]);
    check("coverage: a 'stale' Shopify verdict falls through to the EasyEcom hold path",
        [/first\.skipped !== 'in-easyecom' && first\.skipped !== 'stale'/.test(sh), /if \(createdAt && !\(opts && opts\.allowImported\)\)/.test(sh)], [true, true]);
    check('coverage: the 10-minute reconciler exists and is on the cron table',
        [/async function reconcileHoldCoverage/.test(sh), /cronJob\('HoldCoverage \(\*\/10 \* \* \* \*\)'/.test(sv), /unevaluatedCodOrders/.test(sh)], [true, true, true]);
    check('coverage: ledger table migration is on record',
        /create table if not exists hold_evaluations_ecom/.test(fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260827_hold_evaluations.sql'), 'utf8')), true);
    // The work-list rule: COD (pending / partially_paid), not cancelled, not test, 5 min–48 h old.
    const src = fs.readFileSync(path.join(ROOT, 'app/api/repeat_rules.js'), 'utf8');
    check('coverage: reconciler work list = COD, live, non-test, inside the 5min–48h window, with no ledger row',
        [/\.in\('financial_status', \['pending', 'partially_paid'\]\)\.is\('cancelled_at', null\)\.neq\('test', true\)/.test(src),
         /minAgeMin = 5, maxAgeH = 48/.test(src), /filter\(o => !seen\.has\(orderKey\(o\.name\)\)\)/.test(src)],
        [true, true, true]);
    // Ledger verdicts are derived, never free text.
    check('coverage: ledger verdict is derived from payment status + reasons',
        /verdict = \['paid', 'refunded', 'partially_refunded'\]\.includes\(fin\) \? 'prepaid' : \(reasons && reasons\.length \? 'hold' : 'no_reason'\)/.test(src), true);
    check('coverage: an identity gap (Shopify says Repeat, we found no history) is called out in the log',
        /Shopify tags it Repeat but no history was found/.test(wh), true);
    void RR;
}

// ── 4g4. WhatsApp cut-over: open to every customer, calls stay listed, duplicates skipped ────────
// 2026-08-27, user: "make it happen for everyone not just allowed list". The allowlist is DATA (an
// env var), so cut-over is its removal; the code must (1) read "unset = open", (2) keep Vobiz CALLS on
// their own list so opening messages does not open phone calls, and (3) skip a template the phone
// already received from anyone — our log or the MSG91 mirror (n8n) — recording a 'skipped' row that
// no path ever mistakes for a send.
{
    const wa = fs.readFileSync(path.join(ROOT, 'app/api/msg91_wa.js'), 'utf8');
    const vb = fs.readFileSync(path.join(ROOT, 'app/api/vobiz_bridge.js'), 'utf8');
    const { allowlistBlocksFor } = require(path.join(ROOT, 'app/api/msg91_wa'));
    const saved = process.env.ZZ_TEST_LIST;
    delete process.env.ZZ_TEST_LIST;
    check('wa cutover: an unset allowlist blocks nobody', allowlistBlocksFor('ZZ_TEST_LIST')('TE1', '9876543210'), null);
    process.env.ZZ_TEST_LIST = '+91 98765 43210, TE25-1';
    check('wa cutover: a set allowlist still blocks everyone not named (phone or order)',
        [allowlistBlocksFor('ZZ_TEST_LIST')('TE9', '9876543210'), allowlistBlocksFor('ZZ_TEST_LIST')('TE25-1', '1111111111'), allowlistBlocksFor('ZZ_TEST_LIST')('TE9', '2222222222')],
        [null, null, 'not on ZZ_TEST_LIST (test mode)']);
    if (saved === undefined) delete process.env.ZZ_TEST_LIST; else process.env.ZZ_TEST_LIST = saved;
    check('wa cutover: WhatsApp reads MSG91_COD_ALLOWLIST, Vobiz calls read VOBIZ_CALL_ALLOWLIST',
        [/const allowlistBlocks = allowlistBlocksFor\('MSG91_COD_ALLOWLIST'\)/.test(wa), /allowlistBlocksFor\('VOBIZ_CALL_ALLOWLIST'\)/.test(vb), /allowlistBlocks\b/.test(vb)],
        [true, true, true]);
    check('wa cutover: a template already delivered to the phone is skipped and recorded, never re-sent',
        [/async function sentToPhoneRecently/.test(wa), /const dup = await sentToPhoneRecently\(order\.phone, tpl\.template_name\)/.test(wa),
         /status: 'skipped'/.test(wa), (wa.match(/!\['failed', 'skipped'\]\.includes\(s\.status\)/g) || []).length],
        [true, true, true, 2]);
    check('wa cutover: the mirror lookup shifts for its IST-as-UTC timestamps', /5\.5 \* 3600e3/.test(wa), true);
}

// ── 4i. Voice-agent self-learning: reviewed once, lessons merged not duplicated, injected in both agents ──
{
    const AL = require(path.join(ROOT, 'app/api/agent_learning'));
    check('learn: similar rules merge, different rules do not',
        [AL.similarity('Ask the confirm question only after the customer greets you back', 'Ask the confirmation question only once the customer has greeted you back') >= 0.45,
         AL.similarity('Ask the confirm question only after the customer greets you back', 'Close with the brand thank-you line in the customer language') >= 0.45], [true, false]);
    const n = AL.normaliseReview({ outcome: 'confirmed', scores: { clarity: 9, empathy: 7, brevity: 8, correctness: 9, language_fit: 6 }, strengths: ['x'], issues: [], lessons: [
        { title: 'Wait for the human', rule: 'When a screening assistant answers, state name and reason once, then stay silent until a person speaks.', category: 'screening', confidence: 0.9, evidence_quote: 'please stay on the line' },
        { title: 'bad', rule: 'too short', category: 'nope', confidence: 2 }] });
    check('learn: a review is normalised — overall derived, bad lessons dropped, categories constrained',
        [n.outcome, n.scores.overall, n.lessons.length, n.lessons[0].category, n.lessons[0].confidence], ['confirmed', 7.8, 1, 'screening', 0.9]);
    check('learn: JSON is recovered from a fenced or chatty AI reply', AL.parseJson('Sure!\n```json\n{"outcome":"other"}\n```')?.outcome, 'other');
    check('learn: the two channels share one purpose', [AL.baseType('cod_confirm_vobiz'), AL.baseType('cod_confirm'), AL.langName('hi-IN'), AL.langName('Hindi')], ['cod_confirm', 'cod_confirm', 'Hindi', 'Hindi']);
    const src = fs.readFileSync(path.join(ROOT, 'app/api/agent_learning.js'), 'utf8');
    check('learn: a call is reviewed once (unique call_id) and the prompt block is capped',
        [/call_id\s+uuid not null unique/.test(fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260828_agent_learning.sql'), 'utf8')), /slice\(0, MAX_ACTIVE_INJECT\)/.test(src), AL.MAX_ACTIVE_INJECT <= 15], [true, true, true]);
    check('learn: activation needs a second call, or near-certainty from one', [AL.ACTIVATE_REINFORCED, AL.ACTIVATE_CONFIDENCE], [2, 0.95]);
    check('learn: a rate limit backs off, then stops the run instead of writing wrong reviews', [/RETRY_WAITS_MS = \[20e3, 45e3\]/.test(src), /if \(transientAi\(e\.message\)\) break;/.test(src), typeof AL.dedupeLessons], [true, true, 'function']);
    const vb = fs.readFileSync(path.join(ROOT, 'app/api/vobiz_bridge.js'), 'utf8');
    const va = fs.readFileSync(path.join(ROOT, 'app/static/voice-agent.html'), 'utf8');
    const sv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('learn: both agents inject the lessons block',
        [/lessonsPromptBlock\(/.test(vb), /\$\{s\.lessonsBlock \|\| ''\}/.test(vb), /\/api\/voice-lessons\?call_type=/.test(va)], [true, true, true]);
    check('learn: nightly cron + gated routes + nav', [/cronJob\('AgentLearn \(15 2 \* \* \*\)'/.test(sv), /\/support\\\/agent-learning/.test(sv), /nav-support-agent-learning/.test(fs.readFileSync(path.join(ROOT, 'app/templates/index.html'), 'utf8')), /'support-agent-learning'/.test(fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8'))], [true, true, true, true]);
}

// ── 4j. DocPharma journey dates come from the portal timeline, by the DATABASE ──────────────────
// 2026-08-29: Dispatch→Delivery TAT read "0 shipments" for DocPharma — the partner API has no dispatch /
// OFD / RTO timestamps, so 0 of 1,215 journeys had dispatched_at. The portal sync already stores them
// on docpharma_orders; a SQL function + trigger + hourly pg_cron now copy them across (NULLs only).
{
    const mig = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260829_docpharma_journey_dates.sql'), 'utf8');
    check('dp dates: function fills only NULLs, trigger on docpharma_orders, hourly pg_cron, one-time backfill',
        [/coalesce\(j\.dispatched_at, s\.dispatched_at\)/.test(mig), /create trigger trg_docpharma_orders_journey/.test(mig),
         /cron\.schedule\('docpharma-journey-dates-hourly', '50 \* \* \* \*'/.test(mig), /select public\.sync_docpharma_journey_dates\(interval '400 days'\);/.test(mig),
         /where s->>'label' = 'out_for_delivery'/.test(mig)], [true, true, true, true, true]);
}

// ── 4k. Dispatch→Delivery TAT card filters the explorer, like Order→Dispatch already did ────────
{
    const app = fs.readFileSync(path.join(ROOT, 'app/static/app.js'), 'utf8');
    const dr = fs.readFileSync(path.join(ROOT, 'app/api/delivery_reports.js'), 'utf8');
    check('dtd filter: server ships dtdDays per row, client mirrors the day buckets and filters on them',
        [/dtdDays: r\.outcome === 'delivered' \? diff\(r\.dispatched_at, r\.delivered_at, 'days'\)/.test(dr),
         /const DP_DTD_BUCKETS = \[/.test(app), /dpDtdBucket\(r\.dtdDays\)===_dpDtdFilter/.test(app),
         /t\.dispatchToDelivery, c\?c\.dtdAvg:null, true, 'dtd'\)/.test(app), /data-kind="\$\{kind\}"/.test(app)], [true, true, true, true, true]);
    // The client's day buckets must equal the server's — the card counts and the filtered rows must agree.
    const srv = (dr.match(/const BUCKETS_DAYS = \[(.*)\];/) || [])[1] || '';
    const cli = (app.match(/const DP_DTD_BUCKETS = \[([\s\S]*?)\];/) || [])[1] || '';
    const labels = s => (s.match(/label: '([^']+)'/g) || []).map(x => x.replace(/label: '|'/g, ''));
    check('dtd filter: client buckets equal server buckets', labels(cli), labels(srv));
}

// ── 4h. Secrets vault: every credential is AES-256-GCM at rest, and nothing reads around it ─────
// Added 2026-08-27. `.env` is sealed into `.env.vault` by app/secrets.js; config.js and every
// standalone script go through that one loader, and the rotated Teams refresh token is written back
// INTO the vault. These tests pin the crypto round trip, the precedence (vault beats a leftover
// plaintext file), the "no key = loud failure" rule, and that no code path re-grew a plaintext door.
{
    const os = require('os');
    const S = require(path.join(ROOT, 'app/secrets'));
    const dotenv = require('dotenv');
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pravidhi-vault-'));
    const KEY = S.generateMasterKey();
    const text = 'PORT=5002\nJWT_SECRET=abcdefghijklmnopqrstuvwxyz0123456789\n# a comment survives\nTEAMS_REFRESH_TOKEN=old\nQUOTED="a b#c"\n';
    const savedEnv = { key: process.env.PRAVIDHI_MASTER_KEY, file: process.env.PRAVIDHI_MASTER_KEY_FILE, port: process.env.PORT, rt: process.env.TEAMS_REFRESH_TOKEN };
    process.env.PRAVIDHI_MASTER_KEY = KEY; delete process.env.PRAVIDHI_MASTER_KEY_FILE;
    delete process.env.PORT; delete process.env.TEAMS_REFRESH_TOKEN;
    const refused = fn => { try { fn(); return 'accepted'; } catch (_) { return 'refused'; } };
    try {
        const v = S.encryptText(text, KEY);
        check('vault: sealed with AES-256-GCM', [v.v, v.alg, v.kdf], [1, 'aes-256-gcm', 'raw']);
        check('vault: ciphertext carries no key NAME in the clear', /JWT_SECRET|TEAMS_REFRESH/.test(JSON.stringify(v)), false);
        check('vault: round trip is byte-exact (comments and quoting included)', S.decryptVault(v, KEY), text);
        check('vault: wrong key is refused, never garbage', refused(() => S.decryptVault(v, 'ff'.repeat(32))), 'refused');
        const tampered = Object.assign({}, v, { ct: v.ct.slice(0, -2) + (v.ct.endsWith('00') ? '11' : '00') });
        check('vault: a flipped ciphertext byte fails the GCM tag', refused(() => S.decryptVault(tampered, KEY)), 'refused');
        const pv = S.encryptText(text, 'a passphrase, not hex');
        check('vault: a passphrase is stretched with scrypt and salted', [pv.kdf, typeof pv.salt, S.decryptVault(pv, 'a passphrase, not hex') === text], ['scrypt', 'string', true]);

        fs.writeFileSync(path.join(T, '.env'), text);
        S._reset();
        const plain = S.load({ dir: T, quiet: true });
        check('vault: plaintext-only boot loads but WARNS', [plain.mode, plain.warnings.length > 0], ['plain', true]);
        // DEV mode: .env beside a (stale) vault → .env wins and the vault is re-sealed from it
        S.sealVault(T, text.replace('PORT=5002', 'PORT=6001'));
        S._reset(); delete process.env.PORT;
        const l = S.load({ dir: T, quiet: true });
        check('vault: dev mode — the local .env is the source and the stale vault is re-sealed from it', [l.mode, l.parsed.PORT, l.resealed, S.openVault(T).text === text], ['dev', '5002', true, true]);
        S._reset(); delete process.env.PORT;
        check('vault: dev mode — an unchanged .env does not rewrite the vault', S.load({ dir: T, quiet: true }).resealed, false);
        check('vault: dotenv quoting is honoured through the vault', l.parsed.QUOTED, 'a b#c');
        check('vault: dev persist() writes .env AND re-seals the vault', [S.persist('TEAMS_REFRESH_TOKEN', 'rotated', { dir: T }), /rotated/.test(fs.readFileSync(path.join(T, '.env'), 'utf8')), /rotated/.test(S.openVault(T).text)], ['dev', true, true]);
        check('vault: persist refuses a non-env key name', refused(() => S.persist('rm -rf', 'x', { dir: T })), 'refused');
        check('vault: upsertLine quotes values with spaces/#, keeps other lines', dotenv.parse(S.upsertLine('A=1\nB=2\n', 'B', 'x y#z')), { A: '1', B: 'x y#z' });
        // SERVER mode: vault only
        fs.unlinkSync(path.join(T, '.env'));
        S._reset(); delete process.env.TEAMS_REFRESH_TOKEN; delete process.env.PORT;
        const sv = S.load({ dir: T, quiet: true });
        check('vault: server mode — vault only, decrypted at boot, rotated value present', [sv.mode, sv.parsed.TEAMS_REFRESH_TOKEN, sv.parsed.PORT], ['vault', 'rotated', '5002']);
        check('vault: server persist() re-seals the vault and creates NO plaintext file', [S.persist('TEAMS_REFRESH_TOKEN', 'rotated2', { dir: T }), fs.existsSync(path.join(T, '.env')), /rotated2/.test(S.openVault(T).text)], ['vault', false, true]);
        delete process.env.PRAVIDHI_MASTER_KEY; process.env.PRAVIDHI_MASTER_KEY_FILE = path.join(T, 'no-such-key');
        S._reset();
        check('vault: a vault with no key is a LOUD boot failure, not a silent fall-through',
            (() => { try { S.load({ dir: T, quiet: true }); return 'silent'; } catch (e) { return e.code; } })(), 'NO_KEY');
    } finally {
        S._reset();
        if (savedEnv.key !== undefined) process.env.PRAVIDHI_MASTER_KEY = savedEnv.key; else delete process.env.PRAVIDHI_MASTER_KEY;
        if (savedEnv.file !== undefined) process.env.PRAVIDHI_MASTER_KEY_FILE = savedEnv.file; else delete process.env.PRAVIDHI_MASTER_KEY_FILE;
        if (savedEnv.port !== undefined) process.env.PORT = savedEnv.port;
        if (savedEnv.rt !== undefined) process.env.TEAMS_REFRESH_TOKEN = savedEnv.rt;
        try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {}
    }

    // No code path may read .env around the loader. dotenv.config() is allowed in exactly one place:
    // the bridge agent's fallback for a copy deployed without app/secrets.js.
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'static') return [];
        const p = path.join(d, e.name); return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
    });
    const files = walk(ROOT).map(f => [path.relative(ROOT, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')]);
    const dotenvUsers = files.filter(([, src]) => /require\(['"]dotenv['"]\)\.config\(/.test(src)).map(([f]) => f).sort();
    check('vault: dotenv.config() is called only by the bridge agent fallback', dotenvUsers, ['tally-bridge/agent.js']);
    const envReaders = files.filter(([f, src]) => !/^(app\/secrets\.js|tools\/secrets\.js|tests\/selftest\.js)$/.test(f)
        && /(readFileSync|writeFileSync)\([^)]*['"]\.env['"]/.test(src)).map(([f]) => f);
    check('vault: nothing reads or writes a plaintext .env by hand any more', envReaders, []);
    const tl = fs.readFileSync(path.join(ROOT, 'app/api/teams_listener.js'), 'utf8');
    check('vault: the rotated Teams refresh token is persisted through the vault', /secrets\.persist\('TEAMS_REFRESH_TOKEN'/.test(tl), true);
    const ee = fs.readFileSync(path.join(ROOT, 'app/api/easyecom.js'), 'utf8');
    check('vault: the cached EasyEcom JWT is written encrypted (never a bare jwt_token: token)', [/jwt_token: encrypt\(token\)/.test(ee), /jwt_token: token\b/.test(ee)], [true, false]);
    check('vault: ...and a legacy plaintext row is still readable', /startsWith\('v1\$'\) \? decrypt\(data\.jwt_token\)/.test(ee), true);
    const dbg = fs.readFileSync(path.join(ROOT, 'debug_easyecom.js'), 'utf8');
    check('vault: the debug script no longer prints credential prefixes', /(API_KEY|JWT)[^\n]*\.slice\(0, ?\d+\)/.test(dbg), false);
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    check('vault: .env.vault and the master key are git-ignored', [/^\.env\.vault$/m.test(gi), /master\.key/.test(gi), /^tally-bridge\/\.env\.vault$/m.test(gi)], [true, true, true]);
}

// ── 5. RapidShyp sync: transient failures must not raise a cron-failure card ─────────────────────
// Bug 2026-08-17: an 8s timeout on 3 AWBs turned a 13-minute run into "❌ Cron failed". The job only
// fetches AWBs with no row yet, so a failure self-heals on the next run two hours later — while a
// genuine outage still has to be loud.
{
    const src = fs.readFileSync(path.join(ROOT, 'app/api/fulfillment_ops.js'), 'utf8');
    const consts = src.match(/const RS_TIMEOUT_MS[\s\S]*?const isTransient = [^\n]*\n/)[0];
    const fn = src.match(/async function enrichAWBsBackground[\s\S]*?\n}\n/)[0];

    let axiosImpl, warns = [], errors = [];
    const axios = { post: (...a) => axiosImpl(...a) };
    const supabase = { from: () => ({ upsert: async () => ({}) }) };
    const RS_URL = 'x', RS_HDR = () => ({});
    const notRapidshypAwbs = new Set();
    const persisted = new Set();
    const loadKnownForeignAwbs = async awbs => awbs.forEach(a => { if (persisted.has(a)) notRapidshypAwbs.add(a); });
    const rememberForeignAwb = async awb => { notRapidshypAwbs.add(awb); persisted.add(awb); };
    const realLog = console.log, realWarn = console.warn, realErr = console.error;
    eval(consts + fn);   // defines enrichAWBsBackground in this scope — do not pre-declare it

    const timeout = () => new Error('timeout of 25000ms exceeded');          // no .response ⇒ transient
    const bad400 = () => Object.assign(new Error('400'), { response: { status: 400 } });
    const good = async () => ({ data: { success: true, records: [{ shipment_details: [{ shipment_status: 'In Transit' }] }] } });
    const quiet = fn2 => { console.log = () => {}; console.warn = m => warns.push(String(m)); console.error = m => errors.push(String(m));
        return fn2().finally(() => { console.log = realLog; console.warn = realWarn; console.error = realErr; }); };

    return (async () => {
        let n = 0;
        axiosImpl = async () => (++n === 1 ? Promise.reject(timeout()) : good());
        warns = []; errors = [];
        let r = await quiet(() => enrichAWBsBackground(['A']));
        check('rs sync: one retry recovers a transient timeout', [r.ok, r.failed, errors.length], [1, 0, 0]);

        n = 0;
        axiosImpl = async () => (++n <= 4 ? Promise.reject(timeout()) : good());
        warns = []; errors = [];
        r = await quiet(() => enrichAWBsBackground(Array.from({ length: 20 }, (_, i) => 'B' + i)));
        check('rs sync: a few failures warn, never fail the cron', [r.failed, errors.length], [2, 0]);

        axiosImpl = async () => Promise.reject(timeout());
        warns = []; errors = [];
        r = await quiet(() => enrichAWBsBackground(Array.from({ length: 500 }, (_, i) => 'D' + i)));
        check('rs sync: an outage aborts early instead of walking 500 AWBs', [r.aborted, r.failed <= 6], [true, true]);

        axiosImpl = async () => Promise.reject(bad400());
        warns = []; errors = [];
        r = await quiet(() => enrichAWBsBackground(['E1']));
        check('rs sync: HTTP 400 is a fact, not a failure', [r.failed, errors.length], [0, 0]);

        notRapidshypAwbs.clear();                                            // simulate a process restart
        axiosImpl = async () => { throw new Error('must not be called for a known-foreign AWB'); };
        r = await quiet(() => enrichAWBsBackground(['E1']));
        check('rs sync: the 400 verdict survives a restart', [r.skipped, r.failed], [1, 0]);

        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail ? 1 : 0);
    })();
}
