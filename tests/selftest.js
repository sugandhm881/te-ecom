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

// ── 3. RapidShyp sync: transient failures must not raise a cron-failure card ─────────────────────
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
