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
