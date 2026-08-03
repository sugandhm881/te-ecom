// ─────────────────────────────────────────────────────────────────────────────
// Cron reporting → Microsoft Teams ("Cron Response" channel).
//
// Every scheduled job runs through runCron(), which times it, catches what it throws, and reports.
//
// WHY NOT "post every success": the 26 crons fire ~1,800 times a day (two `*/2` jobs alone are 1,440),
// so a card per success would bury the channel and make the failures — the only messages that matter —
// impossible to see. Default `CRON_REPORT_MODE=digest`:
//   • FAILURE  → an immediate ❌ card with the job, time, duration and the reason.
//   • SUCCESS  → counted, and rolled into one periodic digest card listing every job (runs · ok · failed).
// Set CRON_REPORT_MODE=all to get a card per run (noisy — for debugging only), or `failures` for
// failures only (no digest).
//
// SWALLOWED ERRORS: most jobs already handle their own errors (`.catch(e => console.error(…))`), so
// nothing reaches this wrapper and the run *looks* clean. To report those too, console.error is
// intercepted for the duration of the job and any output is attached as the failure reason. Node is
// single-threaded, but two jobs overlapping across an `await` can cross-attribute a line — rare (the
// schedules mostly differ) and it only ever affects the label on an error that genuinely happened.
// ─────────────────────────────────────────────────────────────────────────────
const config = require('../../config');
const { postTeams, buildCard } = require('./teams');

const MODE = () => String(process.env.CRON_REPORT_MODE || 'digest').toLowerCase();
const HOOK = () => config.TEAMS_WEBHOOK_CRON || process.env.TEAMS_WEBHOOK_CRON || null;
const istNow = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
// Jobs whose SUCCESS card is suppressed under MODE=all (failures always post). Comma-separated
// substrings of the job name, case-insensitive — e.g. CRON_REPORT_SKIP="TallyBatch,EE Session".
const isMuted = name => String(process.env.CRON_REPORT_SKIP || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    .some(s => String(name).toLowerCase().includes(s));

// name → { runs, ok, failed, lastAt, lastMs, lastError }
const stats = new Map();
const stat = name => stats.get(name) || stats.set(name, { runs: 0, ok: 0, failed: 0, lastAt: null, lastMs: 0, lastError: null }).get(name);

// `text` MUST go in postTeams' third arg (opts), not inside the payload — that's what puts a plain
// `text` (HTML) field in the webhook body alongside `card`. Flows built on "Post message in a chat or
// channel" read that text; card-based flows read `card`. Sending both makes either flow style work.
async function post(payload, text) {
    const hook = HOOK();
    if (!hook) return false;                       // not configured → stay silent, never throw
    try { return await postTeams(hook, payload, text ? { text } : {}); }
    catch (e) { console.error('[CronReport] Teams post failed:', e.message); return false; }
}

// One ❌ card per failure — the job, when, how long it ran, and why it failed.
async function postFailure(name, ms, reason) {
    const text = `<b>❌ Cron failed — ${esc(name)}</b><br>`
        + `<b>When:</b> ${esc(istNow())} IST<br>`
        + `<b>Duration:</b> ${(ms / 1000).toFixed(1)}s<br>`
        + `<b>Reason:</b> <code>${esc(String(reason).slice(0, 900))}</code>`;
    await post({ blocks: [
        { type: 'header', text: { type: 'plain_text', text: `❌ Cron failed — ${name}`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*When:* ${istNow()} IST\n*Duration:* ${(ms / 1000).toFixed(1)}s\n*Reason:*\n\`\`\`${String(reason).slice(0, 900)}\`\`\`` } },
    ] }, text);
}

async function postSuccess(name, ms, note) {
    const text = `<b>✅ ${esc(name)}</b> — ok in ${(ms / 1000).toFixed(1)}s${note ? ' · ' + esc(note) : ''} <i>(${esc(istNow())} IST)</i>`;
    await post({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ *${name}* — ok in ${(ms / 1000).toFixed(1)}s${note ? ' · ' + note : ''}  _(${istNow()} IST)_` } }] }, text);
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Wrap a scheduled job. NEVER throws — a reporting problem must not kill the cron.
async function runCron(name, fn) {
    const s = stat(name);
    const t0 = Date.now();
    const swallowed = [];
    const origErr = console.error;
    console.error = (...args) => { try { swallowed.push(args.map(a => (a && a.message) ? a.message : String(a)).join(' ')); } catch (_) {} origErr.apply(console, args); };
    let thrown = null;
    try { await fn(); }
    catch (e) { thrown = e; }
    finally { console.error = origErr; }
    const ms = Date.now() - t0;
    s.runs++; s.lastAt = new Date().toISOString(); s.lastMs = ms;
    const reason = thrown ? (thrown && thrown.message ? thrown.message : String(thrown))
                 : (swallowed.length ? swallowed.slice(0, 5).join(' | ') : null);
    if (reason) {
        s.failed++; s.lastError = reason;
        if (MODE() !== 'off') await postFailure(name, ms, reason);
    } else {
        s.ok++;
        // MODE=all → a card for EVERY run, in real time. CRON_REPORT_SKIP mutes the SUCCESS card for
        // named jobs (comma-separated, matched case-insensitively as a substring of the job name) — use
        // it for the high-frequency watchdogs (`*/2`, `*/10`, `*/20`) that otherwise drown the channel.
        // FAILURES are never muted: a job in the skip list still posts a card the moment it fails.
        if (MODE() === 'all' && !isMuted(name)) await postSuccess(name, ms);
    }
    return { ok: !reason, ms, reason };
}

// Periodic roll-up so successes are visible without a card per run.
async function sendCronDigest() {
    if (MODE() === 'failures' || MODE() === 'off') return { skipped: 'mode' };
    if (!HOOK()) return { skipped: 'no webhook' };
    const rows = [...stats.entries()].sort((a, b) => (b[1].failed - a[1].failed) || a[0].localeCompare(b[0]));
    if (!rows.length) {
        if (String(process.env.CRON_DIGEST_WHEN_EMPTY || '').toLowerCase() !== 'true') return { skipped: 'nothing ran' };
    }
    const totalRuns = rows.reduce((a, [, v]) => a + v.runs, 0);
    const totalFail = rows.reduce((a, [, v]) => a + v.failed, 0);
    const line = ([n, v]) => `${v.failed ? '❌' : '✅'} *${n}* — ${v.runs} run${v.runs !== 1 ? 's' : ''}, ${v.ok} ok, ${v.failed} failed`
        + (v.lastError ? `\n   ↳ _${String(v.lastError).slice(0, 160)}_` : '');
    const head = `*${totalRuns}* run${totalRuns !== 1 ? 's' : ''} across *${rows.length}* job${rows.length !== 1 ? 's' : ''} · *${totalFail}* failure${totalFail !== 1 ? 's' : ''}`;
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `🕒 Cron digest — ${totalFail ? totalFail + ' failed' : 'all clear'}`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: head } },
        { type: 'divider' },
    ];
    for (let i = 0; i < rows.length; i += 20) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: rows.slice(i, i + 20).map(line).join('\n') } });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_since the last digest · ${istNow()} IST_` }] });
    const text = `<b>🕒 Cron digest — ${totalFail ? totalFail + ' failed' : 'all clear'}</b><br>${esc(head.replace(/\*/g, ''))}<br>`
        + rows.map(([n, v]) => `${v.failed ? '❌' : '✅'} <b>${esc(n)}</b> — ${v.runs} runs, ${v.ok} ok, ${v.failed} failed`
            + (v.lastError ? `<br>&nbsp;&nbsp;↳ <i>${esc(String(v.lastError).slice(0, 160))}</i>` : '')).join('<br>');
    await post({ blocks }, text);
    stats.clear();                                  // window resets after each digest
    return { sent: true, jobs: rows.length, runs: totalRuns, failed: totalFail };
}

function cronStats() { return [...stats.entries()].map(([name, v]) => ({ name, ...v })); }

module.exports = { runCron, sendCronDigest, cronStats };
