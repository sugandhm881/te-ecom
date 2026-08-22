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
    // tailwind.css is PREBUILT and carries NO responsive grid variants at all -- `lg:grid-cols-3` is a
    // silent no-op. The ledger must not lean on one.
    check('kwikship ledger: no uncompiled responsive grid class in the new ledger UI',
        /(md|lg|sm):grid-cols-/.test(ui.slice(ui.indexOf('function ksrLedger()'), ui.indexOf('function ksrUpload'))), false);
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
        /holdOrderSmart\([\s\S]{0,700}?\} catch \(e\) \{[\s\S]{0,120}failed\+\+/.test(srv), true);
    check('shopify hold: the candidate lookup retries a transient failure once',
        /if \(!shTransient\(e1\)\) throw e1;/.test(srv), true);
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
