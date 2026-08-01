#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
 * Ecom Central — Tally Bridge Agent
 *
 * Runs on the PC where Tally Prime is running. Tally's XML gateway only listens on that machine's
 * localhost:9000 and has NO authentication whatsoever, so it must never be exposed to the internet or
 * a tunnel. Instead this agent reaches OUT to the dashboard: nothing inbound is opened.
 *
 *   heartbeat  every 5s   → dashboard knows Tally is alive (drives the green chip in the UI)
 *   pull/ack   every 5s   → claim approved vouchers, POST them to Tally, report the RAW reply back
 *   masters    every 15m  → mirror ledgers/groups/voucher types so the entry form can validate names
 *   books      every 15m  → upload trial balance + day book so the LIVE dashboard can show them
 *
 * Deliberate design choices:
 *  • The agent never decides success. It returns Tally's raw XML and the server parses it with the
 *    same code the direct path uses — so a bug here cannot turn a failure into a "posted".
 *  • It never constructs a voucher. The server sends fully-built, already-validated XML.
 *  • A transport failure is reported as an explicit transportError, so the server can mark the outcome
 *    UNKNOWN rather than assume nothing happened (a blind retry would duplicate the voucher).
 *
 * Setup: copy .env.example → .env, fill it in, then `node agent.js` (or install-service.ps1).
 * ───────────────────────────────────────────────────────────────────────────── */
'use strict';

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// axios comes from the parent project's node_modules so this folder needs no install of its own.
let axios;
try { axios = require('axios'); }
catch (_) { axios = require(path.join(__dirname, '..', 'node_modules', 'axios')); }

const VERSION = '1.0.0';

const CFG = {
    dashboard: (process.env.DASHBOARD_URL || 'http://localhost:5002').replace(/\/+$/, ''),
    key: process.env.BRIDGE_KEY || '',
    tally: process.env.TALLY_URL || 'http://localhost:9000',
    company: process.env.TALLY_COMPANY || '',
    pollMs: Math.max(2000, parseInt(process.env.POLL_MS, 10) || 5000),
    syncMin: Math.max(1, parseInt(process.env.SYNC_MINUTES, 10) || 15),
    pullLimit: Math.min(20, parseInt(process.env.PULL_LIMIT, 10) || 5),
    logFile: process.env.LOG_FILE || path.join(__dirname, 'agent.log'),
    verbose: String(process.env.VERBOSE || '').toLowerCase() === 'true',
};

if (!CFG.key) {
    console.error('FATAL: BRIDGE_KEY is not set in tally-bridge/.env. The dashboard will reject every call.');
    process.exit(1);
}

// ── logging: console + a size-capped rotating file, so an unattended agent leaves a trail ────────
function log(level, msg) {
    const line = `[${new Date().toISOString()}] ${level} ${msg}`;
    if (level !== 'DEBUG' || CFG.verbose) console.log(line);
    try {
        if (fs.existsSync(CFG.logFile) && fs.statSync(CFG.logFile).size > 5 * 1024 * 1024)
            fs.renameSync(CFG.logFile, CFG.logFile + '.1');
        fs.appendFileSync(CFG.logFile, line + '\n');
    } catch (_) { /* never let logging kill the agent */ }
}
const info = (m) => log('INFO ', m);
const warn = (m) => log('WARN ', m);
const err = (m) => log('ERROR', m);
const dbg = (m) => log('DEBUG', m);

// ── transports ───────────────────────────────────────────────────────────────────────────────────
const api = (method, route, body, ms = 30000) => axios({
    method, url: CFG.dashboard + '/api/tally/bridge' + route, data: body,
    headers: { 'X-Bridge-Key': CFG.key, 'Content-Type': 'application/json' },
    timeout: ms, validateStatus: () => true,
});

// The masters and books uploads carry raw Tally XML — the day book alone is ~5MB for a financial year.
// gzip it (XML compresses ~10:1) so a 15-minute sync costs a few hundred KB instead of megabytes.
// body-parser inflates Content-Encoding: gzip automatically.
const apiGzip = (route, body, ms = 180000) => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(body)), { level: 6 });
    return axios.post(CFG.dashboard + '/api/tally/bridge' + route, gz, {
        headers: { 'X-Bridge-Key': CFG.key, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        timeout: ms, validateStatus: () => true, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
};

// Raw string in, raw string out — the server needs Tally's exact bytes for the audit log.
const tally = (xml, ms = 180000) => axios.post(CFG.tally, xml, {
    headers: { 'Content-Type': 'text/xml;charset=utf-8' },
    timeout: ms, responseType: 'text', transformResponse: [d => d], validateStatus: () => true,
});

// ── Tally read helpers (Export/Collection only — these cannot alter anything) ─────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const collection = (id, type, opts = {}) => {
    const sv = [`<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>`];
    if (opts.company) sv.push(`<SVCURRENTCOMPANY>${esc(opts.company)}</SVCURRENTCOMPANY>`);
    if (opts.from) sv.push(`<SVFROMDATE TYPE="Date">${opts.from}</SVFROMDATE>`);
    if (opts.to) sv.push(`<SVTODATE TYPE="Date">${opts.to}</SVTODATE>`);
    const body = opts.fetch
        ? `<FETCH>${opts.fetch}</FETCH>`
        : (opts.methods || []).map(m => `<NATIVEMETHOD>${m}</NATIVEMETHOD>`).join('');
    return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>`
        + `<BODY><DESC><STATICVARIABLES>${sv.join('')}</STATICVARIABLES><TDL><TDLMESSAGE>`
        + `<COLLECTION NAME="${id}" ISINITIALIZE="Yes"><TYPE>${type}</TYPE>${body}</COLLECTION>`
        + `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
};

// Only COMPANY elements WITH attributes are real — every reply also carries a bare
// <COMPANY>0</COMPANY> counter inside its CMPINFO block.
function companyNames(xml) {
    return [...String(xml || '').matchAll(/<COMPANY\s+[^>]*\bNAME\s*=\s*"([^"]*)"/gi)]
        .map(m => m[1]).filter(Boolean).filter((n, i, a) => a.indexOf(n) === i);
}

let cachedCompany = null;
async function resolveCompany() {
    if (CFG.company) return CFG.company;
    if (cachedCompany) return cachedCompany;
    const r = await tally(collection('BridgeCompanies', 'Company', { methods: ['Name'] }), 20000);
    const names = companyNames(r.data);
    if (!names.length) throw new Error('Tally reports no open company');
    cachedCompany = names[0];
    return cachedCompany;
}

// ── heartbeat ────────────────────────────────────────────────────────────────────────────────────
let lastSyncAt = 0;
let syncing = false;

async function heartbeat() {
    let reachable = false, company = null, note = null;
    try { company = await resolveCompany(); reachable = true; }
    catch (e) { note = 'Tally unreachable: ' + e.message; }
    const r = await api('post', '/heartbeat', { version: VERSION, tallyReachable: reachable, company, note });
    if (r.status !== 200) { warn(`heartbeat → HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); return null; }
    return r.data;   // { ok, syncRequested, postEnabled }
}

// ── push queued vouchers ─────────────────────────────────────────────────────────────────────────
async function drainQueue() {
    const r = await api('get', `/pull?limit=${CFG.pullLimit}`);
    if (r.status !== 200) { warn(`pull → HTTP ${r.status}`); return 0; }
    const list = (r.data && r.data.vouchers) || [];
    if (!list.length) return 0;
    info(`pulled ${list.length} voucher(s) to post`);

    for (const v of list) {
        if (!v.xml) {
            await api('post', '/ack', { id: v.id, transportError: 'server sent no XML for this voucher' });
            continue;
        }
        try {
            const resp = await tally(v.xml);
            if (resp.status >= 400) throw new Error(`Tally HTTP ${resp.status}`);
            // The SERVER decides ok/failed from this raw body — the agent must not interpret it.
            const ack = await api('post', '/ack', { id: v.id, responseXml: String(resp.data || '') });
            info(`voucher ${v.id} → ${(ack.data && ack.data.status) || 'ack HTTP ' + ack.status}` +
                 (ack.data && ack.data.error ? ` (${ack.data.error})` : ''));
        } catch (e) {
            // Outcome genuinely unknown: Tally may or may not have applied it. Say so — the server then
            // demands a manual check before any retry, instead of duplicating the voucher.
            err(`voucher ${v.id} transport failure: ${e.message}`);
            await api('post', '/ack', { id: v.id, transportError: e.message });
        }
        await new Promise(s => setTimeout(s, 400));   // gentle on Tally — it is single-threaded
    }
    return list.length;
}

// ── masters + books upload ───────────────────────────────────────────────────────────────────────
const MASTERS = {
    ledger:       { type: 'Ledger',      methods: ['Parent', 'IsBillWiseOn', 'GSTApplicable', 'OpeningBalance'] },
    group:        { type: 'Group',       methods: ['Parent'] },
    voucher_type: { type: 'VoucherType', methods: ['Parent', 'NumberingMethod'] },
    stock_item:   { type: 'StockItem',   methods: ['Parent', 'BaseUnits'] },
};

// The agent ships RAW XML; the server parses it with app/api/tally_xml.js. Keeping the single parser
// server-side means the agent can never drift from it.
async function syncMastersAndBooks(company) {
    const masters = {};
    for (const [kind, spec] of Object.entries(MASTERS)) {
        const r = await tally(collection(`Bridge_${spec.type}`, spec.type, { company, methods: spec.methods }), 120000);
        masters[kind] = String(r.data || '');
    }
    const mr = await apiGzip('/masters-xml', { company, masters }, 120000);
    if (mr.status !== 200) warn(`masters upload → HTTP ${mr.status} ${JSON.stringify(mr.data).slice(0, 200)}`);
    else info(`masters synced: ${JSON.stringify(mr.data.counts || {})}`);

    // Books: trial balance (as of today) + the day book for the current Indian financial year.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const fyFrom = `${m >= 4 ? y : y - 1}0401`;
    const toCompact = today.replace(/-/g, '');

    const tb = await tally(collection('BridgeTrialBalance', 'Ledger',
        { company, from: fyFrom, to: toCompact, methods: ['Parent', 'OpeningBalance', 'ClosingBalance'] }), 120000);
    const db = await tally(collection('BridgeVouchers', 'Voucher', { company, from: fyFrom, to: toCompact,
        fetch: 'Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Narration,Reference,Amount,IsOptional,IsCancelled,MasterID,AlterID,AllLedgerEntries' }), 240000);

    const payload = {
        company,
        periodFrom: `${fyFrom.slice(0, 4)}-${fyFrom.slice(4, 6)}-${fyFrom.slice(6, 8)}`,
        periodTo: today,
        trialBalance: String(tb.data || ''),
        dayBook: String(db.data || ''),
    };
    const rawKb = Math.round((payload.trialBalance.length + payload.dayBook.length) / 1024);
    const br = await apiGzip('/books-xml', payload, 240000);
    if (br.status !== 200) warn(`books upload → HTTP ${br.status} ${JSON.stringify(br.data).slice(0, 200)}`);
    else info(`books synced: ${JSON.stringify(br.data.counts || br.data)} (${rawKb}KB XML, gzipped)`);
}

// ── main loop ────────────────────────────────────────────────────────────────────────────────────
let stopping = false;
let consecutiveFailures = 0;

async function tick() {
    let hb = null;
    try { hb = await heartbeat(); consecutiveFailures = 0; }
    catch (e) { consecutiveFailures++; warn(`heartbeat failed (${consecutiveFailures}): ${e.message}`); }

    // Only bother with the queue when the server says posting is switched on.
    if (hb && hb.postEnabled) {
        try { await drainQueue(); } catch (e) { err('queue drain: ' + e.message); }
    } else if (hb) {
        dbg('posting disabled server-side — not pulling the queue');
    }

    const dueBySchedule = Date.now() - lastSyncAt > CFG.syncMin * 60 * 1000;
    if (!syncing && (dueBySchedule || (hb && hb.syncRequested))) {
        syncing = true;
        const why = hb && hb.syncRequested ? 'requested by the dashboard' : `every ${CFG.syncMin}m`;
        try {
            const company = await resolveCompany();
            info(`syncing masters + books (${why})…`);
            await syncMastersAndBooks(company);
            lastSyncAt = Date.now();
        } catch (e) { err('sync: ' + e.message); }
        finally { syncing = false; }
    }
}

async function main() {
    info(`Tally Bridge Agent v${VERSION}`);
    info(`  dashboard : ${CFG.dashboard}`);
    info(`  tally     : ${CFG.tally}`);
    info(`  company   : ${CFG.company || '(whichever Tally has open)'}`);
    info(`  poll ${CFG.pollMs}ms · sync every ${CFG.syncMin}m · log ${CFG.logFile}`);

    while (!stopping) {
        await tick();
        // Back off when the dashboard is unreachable so a long outage doesn't hammer it or the log.
        const wait = consecutiveFailures > 3 ? 30000 : CFG.pollMs;
        await new Promise(s => setTimeout(s, wait));
    }
    info('stopped');
}

['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { info(`${sig} — shutting down`); stopping = true; setTimeout(() => process.exit(0), 500); }));
process.on('unhandledRejection', e => err('unhandledRejection: ' + (e && e.message)));

main().catch(e => { err('fatal: ' + e.message); process.exit(1); });
