// ─────────────────────────────────────────────────────────────────────────────
// Finance → Data Entry — Tally Prime connector. Mounted at /api → routes under /tally/*.
//
// Two delivery modes, one code path (app/api/tally_xml.js builds the XML either way):
//   direct — this server can itself reach Tally (dev box / a finance PC running the app locally).
//            Posting is synchronous, so the user gets Tally's verdict immediately.
//   bridge — production. The VPS cannot reach the finance PC's localhost:9000, so a voucher is parked
//            as `queued` and the agent in tally-bridge/ (running beside Tally) pulls, posts and acks it.
//
// /tally/bridge/* is the ONLY group here that carries no JWT — the agent is a headless script. It is
// authenticated by a constant-time compare of X-Bridge-Key against TALLY_BRIDGE_KEY, and server.js
// lists it in PUBLIC_API so the JWT gate skips it. Everything else needs a finance permission.
//
// Nothing reaches Tally unless TALLY_POST_ENABLED=true. Leave it false until the write path has been
// validated against a throwaway company — a bad voucher in the real books is a manual clean-up.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const config = require('../../config');
const { supabase } = require('../supabase');
const T = require('./tally_xml');
const BM = require('./tally_bank_match');   // ledger-group suggestions reuse the bank matcher's fuzzy name logic

const MODE = () => (String(config.TALLY_MODE || 'bridge').toLowerCase() === 'direct' ? 'direct' : 'bridge');
const POST_ENABLED = () => String(config.TALLY_POST_ENABLED || '').toLowerCase() === 'true';
const BRIDGE_STALE_MS = 60 * 1000;   // no heartbeat for a minute → show the bridge as offline

// ── low-level: talk to Tally (direct mode only) ──────────────────────────────────────────────────
// responseType/transformResponse keep the reply as a raw string — axios would otherwise try to be
// helpful and hand back a half-parsed object, and the parser needs the exact bytes for the audit log.
async function tallyPost(xml, timeout = 60000) {
    const r = await axios.post(config.TALLY_URL, xml, {
        headers: { 'Content-Type': 'text/xml;charset=utf-8' },
        timeout, responseType: 'text', transformResponse: [d => d], validateStatus: () => true,
    });
    if (r.status >= 400) throw new Error(`Tally returned HTTP ${r.status}`);
    return String(r.data || '');
}

// The company to post into: explicit config wins; otherwise ask Tally which company is open (direct),
// or use whatever the bridge last reported. Cached for a minute — it changes only when someone in
// Tally opens a different company.
let _companyCache = { name: null, at: 0 };
async function openCompanies() {
    if (MODE() !== 'direct') return [];
    return T.parseCompanyList(await tallyPost(T.buildCompanyListRequest(), 15000));
}

// Which company are we acting on? An explicit choice always wins. Otherwise we ask Tally — but ONLY
// when exactly one company is open.
//
// With two sets of books loaded, picking "the first one Tally happens to list" is not a reasonable
// default: it silently decides which financial year an entry lands in, and the ordering is Tally's to
// change. Refusing is the correct behaviour — a voucher in the wrong year is far more expensive to
// unpick than an error message.
async function resolveCompany() {
    if (config.TALLY_COMPANY) return config.TALLY_COMPANY;
    if (_companyCache.name && Date.now() - _companyCache.at < 60000) return _companyCache.name;
    if (MODE() === 'direct') {
        const names = await openCompanies();
        if (!names.length) throw new Error('Tally reports no open company — open the company in Tally first.');
        if (names.length > 1) throw new Error(
            `${names.length} companies are open in Tally (${names.join(' | ')}), so it is ambiguous which books this belongs to. ` +
            'Set TALLY_COMPANY in .env, or choose the company on the screen you are using.');
        _companyCache = { name: names[0], at: Date.now() };
        return names[0];
    }
    const { data } = await supabase.from('tally_bridge_status_ecom').select('company').eq('id', 1).maybeSingle();
    if (!data || !data.company) throw new Error('Company unknown — set TALLY_COMPANY, or wait for the bridge agent to report in.');
    return data.company;
}

// ── masters ──────────────────────────────────────────────────────────────────────────────────────
// Read EVERY row, paging past Supabase's silent 1000-row select cap. This set is the whitelist that
// stops Tally auto-creating ledgers under Suspense, so a truncated read would be a correctness bug,
// not just a display one.
// `company` matters as soon as more than one set of books is open: two companies have DIFFERENT charts
// of accounts, and validating a voucher for company A against company B's ledgers would let Tally
// auto-create the missing ledger under Suspense. Omitting it returns every company's ledgers, which is
// only ever right for a single-company setup.
async function loadMasters(kind, company) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
        let q = supabase.from('tally_masters_ecom')
            .select('name, parent, is_billwise, meta, company').eq('kind', kind);
        if (company) q = q.eq('company', company);
        const { data, error } = await q.order('name', { ascending: true }).range(from, from + 999);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return rows;
}
const knownLedgerSet = async (company) => new Set((await loadMasters('ledger', company)).map(r => r.name));

// Write a parsed master dump into tally_masters_ecom, then drop anything that wasn't in this dump —
// so a ledger renamed or deleted in Tally disappears here too instead of lingering in the pickers.
async function saveMasters(kind, rows, company) {
    const startedAt = new Date().toISOString();
    for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map(r => ({
            kind, name: r.name, parent: r.parent || null,
            is_billwise: !!r.is_billwise, meta: r.meta || null,
            company: company || null, synced_at: startedAt,
        }));
        // onConflict must name the SAME columns as the unique index — (kind, name, company). Using
        // (kind, name) would make a second company overwrite the first company's ledger of that name.
        const { error } = await supabase.from('tally_masters_ecom').upsert(chunk, { onConflict: 'kind,name,company' });
        if (error) throw new Error(`saving ${kind}: ${error.message}`);
    }
    if (rows.length) {
        // Prune stale rows for THIS company only. Without the company filter, syncing one company
        // deletes the other company's entire chart of accounts.
        let del = supabase.from('tally_masters_ecom').delete().eq('kind', kind).lt('synced_at', startedAt);
        del = company ? del.eq('company', company) : del.is('company', null);
        const { error } = await del;
        if (error) console.error(`[Tally] stale ${kind} cleanup:`, error.message);
    }
    return rows.length;
}

// Direct-mode master sync: pull each collection straight from Tally. In bridge mode the agent does the
// pulling and POSTs the result to /tally/bridge/masters instead.
const MASTER_KINDS = ['ledger', 'group', 'voucher_type', 'stock_item'];
async function syncMastersDirect() {
    const company = await resolveCompany();
    const counts = {};
    for (const kind of MASTER_KINDS) {
        const parsed = T.parseMasters(await tallyPost(T.buildMastersRequest(kind, company)), kind);
        counts[kind] = await saveMasters(kind, parsed, company);
    }
    await supabase.from('tally_bridge_status_ecom').update({
        company, masters_synced_at: new Date().toISOString(), tally_reachable: true, sync_requested: false,
    }).eq('id', 1);
    return { company, counts };
}

// ── GET /tally/status — mode, company, connection health, master counts. Drives the UI chip. ──────
router.get('/tally/status', async (req, res) => {
    try {
        const mode = MODE();
        const { data: bs } = await supabase.from('tally_bridge_status_ecom').select('*').eq('id', 1).maybeSingle();
        const counts = {};
        for (const kind of MASTER_KINDS) {
            const { count } = await supabase.from('tally_masters_ecom')
                .select('id', { count: 'exact', head: true }).eq('kind', kind);
            counts[kind] = count || 0;
        }

        let reachable = false, company = null, probeError = null;
        if (mode === 'direct') {
            // Cheap live probe — asking for the company list is the lightest read Tally offers.
            try { company = await resolveCompany(); reachable = true; }
            catch (e) { probeError = e.message; }
        } else {
            const age = bs && bs.last_seen_at ? Date.now() - new Date(bs.last_seen_at).getTime() : null;
            reachable = age != null && age < BRIDGE_STALE_MS && !!(bs && bs.tally_reachable);
            company = (bs && bs.company) || config.TALLY_COMPANY || null;
            if (!reachable) probeError = age == null
                ? 'The bridge agent has never checked in — start it on the Tally PC.'
                : `Bridge last seen ${Math.round(age / 1000)}s ago.`;
        }

        let open = [];
        try { open = await openCompanies(); } catch (_) {}
        res.json({
            success: true, mode, company, reachable, probeError,
            openCompanies: open,
            // >1 company open with nothing configured = every request would be a coin toss. The UI must
            // make the user choose rather than proceed.
            ambiguousCompany: !config.TALLY_COMPANY && open.length > 1,
            postEnabled: POST_ENABLED(), masters: counts,
            bridge: bs ? {
                lastSeenAt: bs.last_seen_at, agentVersion: bs.agent_version,
                mastersSyncedAt: bs.masters_synced_at, syncRequested: bs.sync_requested,
            } : null,
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /tally/masters?kind=ledger&q=hdfc — picker data, served from the mirror (never live). ─────
router.get('/tally/masters', async (req, res) => {
    try {
        const kind = String(req.query.kind || 'ledger');
        if (!MASTER_KINDS.includes(kind)) return res.status(400).json({ success: false, error: `Unknown kind "${kind}"` });
        const q = String(req.query.q || '').trim().toLowerCase();
        let rows = await loadMasters(kind, req.query.company || config.TALLY_COMPANY || undefined);
        if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || String(r.parent || '').toLowerCase().includes(q));
        res.json({ success: true, kind, count: rows.length, rows: rows.slice(0, 500) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /tally/masters/sync — refresh the mirror. Direct: pull now. Bridge: ask the agent to. ────
router.post('/tally/masters/sync', async (req, res) => {
    try {
        if (MODE() === 'direct') return res.json({ success: true, ...(await syncMastersDirect()) });
        await supabase.from('tally_bridge_status_ecom').update({ sync_requested: true }).eq('id', 1);
        res.json({ success: true, queued: true, message: 'Master refresh requested — the bridge agent will pick it up within a minute.' });
    } catch (e) { res.status(502).json({ success: false, error: e.message }); }
});

// ═════════ READ-ONLY BOOKS: what is already in Tally ═════════
// Live pull, cached briefly in memory — the Day Book export is ~5MB for 4 months of vouchers, so a
// page refresh or a second user must not re-fetch and re-parse it every time.
// NOTE: this needs a reachable Tally, i.e. TALLY_MODE=direct. In bridge mode the VPS cannot read the
// books directly; the bridge agent will need to upload them (not built yet), so we say so plainly
// instead of returning a misleading empty statement.
const _books = new Map();   // key → { at, data }
const BOOKS_TTL_MS = 60 * 1000;

async function booksCached(key, ttl, producer) {
    const hit = _books.get(key);
    if (hit && Date.now() - hit.at < ttl) return { ...hit.data, cachedAt: new Date(hit.at).toISOString() };
    const data = await producer();
    _books.set(key, { at: Date.now(), data });
    return { ...data, cachedAt: null };
}

// In bridge mode the server cannot read Tally, so the books come from tally_books_cache_ecom — uploaded
// by the agent every ~15 min. Callers get `syncedAt` so the UI can stamp "as of" rather than imply the
// figures are live. Returns null when the agent has never uploaded (a real "not available yet").
async function readBooksCache(kind, company, from, to) {
    let q = supabase.from('tally_books_cache_ecom').select('payload, synced_at, period_from, period_to')
        .eq('kind', kind).order('synced_at', { ascending: false }).limit(1);
    if (company) q = q.eq('company', company);
    // Prefer an exact period match; otherwise fall back to the newest upload for this kind so the page
    // still shows something (clearly stamped with the period it actually covers).
    const exact = from && to
        ? await supabase.from('tally_books_cache_ecom').select('payload, synced_at, period_from, period_to')
            .eq('kind', kind).eq('company', company).eq('period_from', from).eq('period_to', to).maybeSingle()
        : { data: null };
    const row = (exact && exact.data) || (await q).data?.[0] || null;
    if (!row) return null;
    return { payload: row.payload, syncedAt: row.synced_at, periodFrom: row.period_from, periodTo: row.period_to };
}

// Guard for endpoints that genuinely need a live Tally (nothing cacheable to fall back to).
function requireDirect(res) {
    if (MODE() === 'direct') return false;
    res.status(501).json({ success: false, error:
        'This needs a direct connection to Tally (TALLY_MODE=direct). In bridge mode the agent uploads the books on a schedule instead.' });
    return true;
}

// The books-cache miss message, phrased so it is actionable rather than looking like "no data".
const CACHE_MISS = 'The Tally bridge agent has not uploaded the books yet. Start it on the Tally PC (tally-bridge/agent.js) — it syncs every 15 minutes.';

const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// ── the four read-only book endpoints ────────────────────────────────────────────────────────────
// Each works in BOTH modes through one helper: direct mode pulls live from Tally, bridge mode reads the
// agent's upload from tally_books_cache_ecom. The response always carries `source` ('live'|'cache') and,
// for cache, `syncedAt` — so the UI can stamp "as of 23:45" instead of implying the numbers are live.
async function booksData(kind, company, from, to) {
    if (MODE() === 'direct') {
        const key = `${kind}:${company}:${from || '-'}:${to || '-'}`;
        const out = await booksCached(key, BOOKS_TTL_MS, async () => {
            // Pass the company: Tally's reply lists every open one, and taking the first would return
            // another company's books-begin date — which decides whether a voucher is in period.
            if (kind === 'meta') return { data: T.parseCompanyInfo(await tallyPost(T.buildCompanyInfoRequest(), 20000), company) };
            if (kind === 'trial_balance') return { data: T.parseTrialBalance(await tallyPost(T.buildTrialBalanceRequest(company, to, from), 120000)) };
            return { data: T.parseVouchers(await tallyPost(T.buildVouchersRequest(company, from, to), 240000)) };
        });
        return { data: out.data, source: 'live', syncedAt: null, cachedAt: out.cachedAt };
    }
    const cached = await readBooksCache(kind, company, from, to);
    if (!cached) { const e = new Error(CACHE_MISS); e.cacheMiss = true; throw e; }
    return { data: cached.payload, source: 'cache', syncedAt: cached.syncedAt,
             periodFrom: cached.periodFrom, periodTo: cached.periodTo, cachedAt: null };
}
const bookErr = (res, e) => res.status(e.cacheMiss ? 503 : 502).json({ success: false, error: e.message });

// ── GET /tally/books/meta — company period + the financial years worth offering ──────────────────
// The FY list is derived from the company's own BooksFrom, so the picker can never offer a year the
// books don't cover. `toEffective` clamps the current FY to today — asking Tally for future dates is
// pointless and slow.
router.get('/tally/books/meta', async (req, res) => {
    try {
        const today = istToday();
        const company = config.TALLY_COMPANY || (MODE() === 'direct' ? await resolveCompany() : null);
        const b = await booksData('meta', company, null, null);
        const info = b.data || {};
        res.json({ success: true, source: b.source, syncedAt: b.syncedAt,
            company: info.name || company, booksFrom: info.booksFrom || null,
            periodFrom: info.periodFrom || null, periodTo: info.periodTo || null,
            state: info.state || null, gstin: info.gstin || null,
            today, financialYears: T.financialYears(info.booksFrom, today) });
    } catch (e) { bookErr(res, e); }
});

// ── GET /tally/books/ledger?name=&from=&to= — Tally's "Ledger Vouchers" report ───────────────────
// Opening comes from the period-scoped trial balance (Tally computes the brought-forward figure); the
// movement rows are derived from the vouchers, which are already fetched for the Day Book.
router.get('/tally/books/ledger', async (req, res) => {
    try {
        const name = String(req.query.name || '').trim();
        if (!name) return res.status(400).json({ success: false, error: 'name (ledger) is required' });
        const company = config.TALLY_COMPANY || (MODE() === 'direct' ? await resolveCompany() : null);
        const today = istToday();
        const from = String(req.query.from || `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0)}-04-01`);
        const to = String(req.query.to || today);

        const [bal, vch] = await Promise.all([
            booksData('trial_balance', company, from, to),
            booksData('day_book', company, from, to),
        ]);
        const led = (bal.data || []).find(r => r.name === name);
        if (!led) return res.status(404).json({ success: false, error: `Ledger "${name}" not found in Tally` });

        const stmt = T.ledgerStatement(vch.data || [], name, led.opening);
        // Cross-check the derived closing against Tally's own. A mismatch means the statement is
        // incomplete (vouchers outside the fetched range) — report it instead of showing a wrong total.
        const drift = Math.abs(Math.round(stmt.closing * 100) - Math.round(led.closing * 100)) / 100;
        res.json({ success: true, company, from, to, group: led.parent,
            source: bal.source, syncedAt: bal.syncedAt,
            tallyClosing: led.closing, reconciled: drift === 0, drift, ...stmt });
    } catch (e) { bookErr(res, e); }
});

// ── GET /tally/books/trial-balance — every ledger with its closing balance, grouped ──────────────
router.get('/tally/books/trial-balance', async (req, res) => {
    try {
        const company = config.TALLY_COMPANY || (MODE() === 'direct' ? await resolveCompany() : null);
        const to = req.query.to ? String(req.query.to) : null;
        const from = req.query.from ? String(req.query.from) : null;
        const b = await booksData('trial_balance', company, from, to);
        const rows = b.data || [];
        const totals = T.trialBalanceTotals(rows);
        // Group rollup for the UI's clickable group table (Tally shows a trial balance by group).
        const groups = {};
        rows.filter(r => !r.derived).forEach(r => {
            const g = r.parent || 'Ungrouped';
            groups[g] = groups[g] || { group: g, dr: 0, cr: 0, count: 0 };
            groups[g].dr += r.dr; groups[g].cr += r.cr; groups[g].count++;
        });
        res.json({ success: true, company, asOf: to || null, from: from || null,
            source: b.source, syncedAt: b.syncedAt, cachedAt: b.cachedAt,
            rows, totals, groups: Object.values(groups).sort((a, b2) => (b2.dr + b2.cr) - (a.dr + a.cr)) });
    } catch (e) { bookErr(res, e); }
});

// ── GET /tally/books/vouchers?from=&to= — the Day Book: vouchers already entered in Tally ────────
router.get('/tally/books/vouchers', async (req, res) => {
    try {
        const company = config.TALLY_COMPANY || (MODE() === 'direct' ? await resolveCompany() : null);
        // Default to the current Indian financial year (1 Apr → today, IST).
        const today = istToday();
        const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
        const from = String(req.query.from || `${m >= 4 ? y : y - 1}-04-01`);
        const to = String(req.query.to || today);
        const b = await booksData('day_book', company, from, to);
        const all = b.data || [];

        let rows = all;
        if (req.query.type) rows = rows.filter(r => r.type === String(req.query.type));
        const q = String(req.query.q || '').trim().toLowerCase();
        if (q) rows = rows.filter(r => [r.party, r.narration, r.reference, r.number]
            .some(f => String(f || '').toLowerCase().includes(q)));
        rows = rows.slice().sort((a, b2) => (b2.date || '').localeCompare(a.date || '') || Number(b2.number || 0) - Number(a.number || 0));

        const byType = {};
        all.forEach(r => { byType[r.type] = byType[r.type] || { type: r.type, count: 0, total: 0 };
            byType[r.type].count++; byType[r.type].total += r.amount; });
        res.json({ success: true, company, from, to,
            source: b.source, syncedAt: b.syncedAt, cachedAt: b.cachedAt,
            count: rows.length, totalCount: all.length,
            totalValue: rows.reduce((s, r) => s + r.amount, 0),
            byType: Object.values(byType).sort((a, b2) => b2.count - a.count),
            rows: rows.slice(0, 1000) });
    } catch (e) { bookErr(res, e); }
});

// ── vouchers ─────────────────────────────────────────────────────────────────────────────────────
const VOUCHER_COLS = 'id, voucher_type, voucher_date, company, party_ledger, reference, narration, entries,' +
    ' total_amount, status, attempts, tally_voucher_number, tally_masterid, error, source, source_ref,' +
    ' created_by, posted_by, created_at, updated_at, posted_at';

// Normalise + validate whatever the form sent. Returns { voucher, errors } — never throws on bad input.
async function normaliseDraft(body, company) {
    const entries = (Array.isArray(body.entries) ? body.entries : []).map(e => ({
        ledger: String(e.ledger || '').trim(),
        dr_cr: String(e.dr_cr || '').toUpperCase(),
        amount: Number(e.amount),
        ...(e.bill_ref ? { bill_ref: String(e.bill_ref).trim(), bill_type: e.bill_type || 'Agst Ref' } : {}),
    })).filter(e => e.ledger || e.amount);

    const v = {
        voucherType: String(body.voucher_type || '').trim(),
        date: String(body.voucher_date || '').trim(),
        company,
        partyLedger: body.party_ledger ? String(body.party_ledger).trim() : null,
        reference: body.reference ? String(body.reference).trim() : null,
        narration: body.narration ? String(body.narration).trim() : '',
        entries,
    };
    const check = T.validateVoucher(v, await knownLedgerSet(company));
    return { v, errors: check.errors, totalPaise: check.totalPaise };
}

const rowFromDraft = (v, totalPaise, user) => ({
    voucher_type: v.voucherType, voucher_date: v.date, company: v.company,
    party_ledger: v.partyLedger, reference: v.reference, narration: v.narration,
    entries: v.entries, total_amount: Number(T.fmtAmount(totalPaise)),
    created_by: user || null,
});

// How the register can be ordered. The default is the TRANSACTION date, oldest first — the order the
// money actually moved, and the order books are read and checked in. Sorting by when a row was entered
// is meaningless after a bank import, where several hundred rows share one timestamp and their order is
// really just the order the file happened to be walked.
// created_at is the tie-breaker throughout so paging is stable when many rows share a date.
const VOUCHER_SORTS = {
    date_asc:    [['voucher_date', true],  ['created_at', true]],
    date_desc:   [['voucher_date', false], ['created_at', false]],
    amount_desc: [['total_amount', false], ['voucher_date', true]],
    amount_asc:  [['total_amount', true],  ['voucher_date', true]],
    entered_desc:[['created_at', false]],
    entered_asc: [['created_at', true]],
};

// GET /tally/vouchers — the register. Filters: status, from, to, type, q (party/narration/reference),
// sort (see VOUCHER_SORTS; defaults to oldest transaction first).
router.get('/tally/vouchers', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
        const sort = VOUCHER_SORTS[String(req.query.sort || '')] ? String(req.query.sort) : 'date_asc';
        let q = supabase.from('tally_vouchers_ecom').select(VOUCHER_COLS).limit(limit);
        VOUCHER_SORTS[sort].forEach(([col, asc]) => { q = q.order(col, { ascending: asc }); });
        if (req.query.status) q = q.in('status', String(req.query.status).split(',').map(s => s.trim()).filter(Boolean));
        if (req.query.type) q = q.eq('voucher_type', String(req.query.type));
        if (req.query.from) q = q.gte('voucher_date', String(req.query.from));
        if (req.query.to) q = q.lte('voucher_date', String(req.query.to));
        if (req.query.source) q = q.eq('source', String(req.query.source));
        const search = String(req.query.q || '').trim();
        if (search) q = q.or(`party_ledger.ilike.%${search}%,narration.ilike.%${search}%,reference.ilike.%${search}%,tally_voucher_number.ilike.%${search}%`);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        res.json({ success: true, count: (data || []).length, sort, rows: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /tally/vouchers/:id — one voucher, including the request/response XML for auditing.
router.get('/tally/vouchers/:id', async (req, res) => {
    try {
        const { data, error } = await supabase.from('tally_vouchers_ecom')
            .select(VOUCHER_COLS + ', request_xml, response_xml, idempotency_key')
            .eq('id', req.params.id).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) return res.status(404).json({ success: false, error: 'Voucher not found' });
        res.json({ success: true, row: data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /tally/vouchers — save a draft. Validated here as well as in the browser, because the browser
// is not a trustworthy validator.
router.post('/tally/vouchers', async (req, res) => {
    try {
        const company = req.body.company || await resolveCompany();
        const { v, errors, totalPaise } = await normaliseDraft(req.body, company);
        if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });
        const row = rowFromDraft(v, totalPaise, req.user && req.user.sub);
        row.source = req.body.source || 'manual';
        row.source_ref = req.body.source_ref || null;
        const { data, error } = await supabase.from('tally_vouchers_ecom').insert(row).select(VOUCHER_COLS).single();
        if (error) throw new Error(error.message);
        res.json({ success: true, row: data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PUT /tally/vouchers/:id — edit. Only while it hasn't reached Tally; a posted voucher is history.
router.put('/tally/vouchers/:id', async (req, res) => {
    try {
        const { data: cur } = await supabase.from('tally_vouchers_ecom').select('status, company').eq('id', req.params.id).maybeSingle();
        if (!cur) return res.status(404).json({ success: false, error: 'Voucher not found' });
        if (!['draft', 'failed'].includes(cur.status))
            return res.status(409).json({ success: false, error: `Cannot edit a voucher that is ${cur.status}. Duplicate it instead.` });

        const company = req.body.company || cur.company || await resolveCompany();
        const { v, errors, totalPaise } = await normaliseDraft(req.body, company);
        if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });
        const patch = rowFromDraft(v, totalPaise, null);
        delete patch.created_by;
        patch.status = 'draft'; patch.error = null; patch.attempts = 0;   // an edited failure is a fresh draft
        const { data, error } = await supabase.from('tally_vouchers_ecom')
            .update(patch).eq('id', req.params.id).select(VOUCHER_COLS).single();
        if (error) throw new Error(error.message);
        res.json({ success: true, row: data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// DELETE /tally/vouchers/:id — cancel a draft. Never hard-deletes: the register is an audit trail.
router.delete('/tally/vouchers/:id', async (req, res) => {
    try {
        const { data, error } = await supabase.from('tally_vouchers_ecom')
            .update({ status: 'cancelled' }).eq('id', req.params.id).in('status', ['draft', 'failed'])
            .select('id, status');
        if (error) throw new Error(error.message);
        if (!data || !data.length) return res.status(409).json({ success: false, error: 'Only a draft or failed voucher can be cancelled.' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /tally/ledgers — create ledgers in Tally, deliberately ──────────────────────────────────
// A fresh set of books starts with only Cash and P&L A/c, so the bank import needs somewhere to put
// each counterparty. This is the SAFE opposite of the thing this project guards against: Tally
// silently inventing a ledger under Suspense because a voucher named an unknown one. Here the operator
// names it and picks its group, and the result is checked before anything is booked against it.
//
// GET returns proposals (name + suggested group + why); POST creates the confirmed ones.
router.post('/tally/ledgers', requireAdminPush, async (req, res) => {
    try {
        if (!POST_ENABLED())
            return res.status(403).json({ success: false, error: 'Writing to Tally is disabled (TALLY_POST_ENABLED is not true).' });
        if (MODE() !== 'direct')
            return res.status(501).json({ success: false, error: 'Creating ledgers currently needs TALLY_MODE=direct. In bridge mode the agent would have to relay it.' });

        const company = String(req.body.company || '') || await resolveCompany();
        const wanted = (Array.isArray(req.body.ledgers) ? req.body.ledgers : [])
            .map(l => ({ name: String(l.name || '').trim(), parent: String(l.parent || '').trim(), isBillwise: !!l.isBillwise }))
            .filter(l => l.name && l.parent);
        // Groups alone is a legitimate request — a company can be missing a group that no ledger needs
        // yet (an existing ledger is about to be re-grouped into it). Rejecting here would have forced a
        // throwaway ledger to be invented just to carry the group, leaving junk in real books.
        if (!wanted.length && !(Array.isArray(req.body.groups) && req.body.groups.length))
            return res.status(400).json({ success: false, error: 'Nothing to create — each ledger needs a name and a group.' });

        // Never re-create something that already exists; Tally would error and the batch would half-fail.
        const existing = await knownLedgerSet(company);
        const groups = new Set((await loadMasters('group', company)).map(g => g.name));
        const skipped = wanted.filter(l => existing.has(l.name)).map(l => l.name);

        // Groups the caller asked to be created first, so a ledger can be filed under the same group
        // the accountant uses in the other company instead of being demoted to Sundry Creditors.
        const newGroups = (Array.isArray(req.body.groups) ? req.body.groups : [])
            .map(g => ({ name: String(g.name || '').trim(), parent: String(g.parent || '').trim() }))
            .filter(g => g.name && g.parent && !groups.has(g.name) && groups.has(g.parent));
        const groupsMade = [];
        if (newGroups.length) {
            const gParsed = T.parseImportResponse(await tallyPost(T.buildGroupCreateXml({ company, groups: newGroups }), 120000));
            if (!gParsed.ok)
                return res.status(422).json({ success: false, error: `Could not create the group(s): ${gParsed.error}` });
            const freshG = T.parseMasters(await tallyPost(T.buildMastersRequest('group', company)), 'group');
            await saveMasters('group', freshG, company);
            freshG.forEach(g => groups.add(g.name));
            groupsMade.push(...newGroups.map(g => g.name));
            console.log(`[Tally] ${groupsMade.length} group(s) created in "${company}": ${groupsMade.join(', ')}`);
        }

        const badGroup = wanted.filter(l => !existing.has(l.name) && !groups.has(l.parent))
            .map(l => `${l.name} → "${l.parent}" is not a group in this company`);
        const todo = wanted.filter(l => !existing.has(l.name) && groups.has(l.parent));
        if (!todo.length)
            return res.json({ success: true, created: 0, groupsCreated: groupsMade, skipped, errors: badGroup, message: 'Nothing new to create.' });

        const xml = T.buildLedgerCreateXml({ company, ledgers: todo });
        const parsed = T.parseImportResponse(await tallyPost(xml, 120000));
        if (!parsed.ok) return res.status(422).json({ success: false, error: parsed.error, skipped, errors: badGroup });

        // Refresh the mirror so the new ledgers are immediately usable by the validator.
        const fresh = T.parseMasters(await tallyPost(T.buildMastersRequest('ledger', company)), 'ledger');
        await saveMasters('ledger', fresh, company);

        console.log(`[Tally] ${parsed.created} ledger(s) created in "${company}" by ${(req.user || {}).sub}`);
        res.json({ success: true, created: parsed.created, groupsCreated: groupsMade, skipped, errors: badGroup,
                   ledgers: todo.map(l => l.name), totalLedgersNow: fresh.length });
    } catch (e) { console.error('[Tally] create ledgers:', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /tally/ledgers/regroup — move existing ledgers to a different group ─────────────────────
// The group decides which statement a ledger lands in, so getting it wrong is not cosmetic: paying a
// Sundry Creditor that was never invoiced records no expense at all, it just parks a debit on the
// balance sheet. This exists so a mis-grouped ledger can be corrected BEFORE its vouchers are posted.
//
// It reports how many vouchers each ledger already has in Tally (`postedUse`), because re-grouping a
// ledger that is already in the books moves history between statements — legitimate, but it must be a
// deliberate act rather than a surprise.
router.post('/tally/ledgers/regroup', requireAdminPush, async (req, res) => {
    try {
        if (!POST_ENABLED())
            return res.status(403).json({ success: false, error: 'Writing to Tally is disabled (TALLY_POST_ENABLED is not true).' });
        if (MODE() !== 'direct')
            return res.status(501).json({ success: false, error: 'Re-grouping currently needs TALLY_MODE=direct.' });

        const company = String(req.body.company || '') || await resolveCompany();
        const wanted = (Array.isArray(req.body.ledgers) ? req.body.ledgers : [])
            .map(l => ({ name: String(l.name || '').trim(), parent: String(l.parent || '').trim(),
                         newName: String(l.newName || '').trim() }))
            .filter(l => l.name && l.parent);
        if (!wanted.length) return res.status(400).json({ success: false, error: 'Nothing to re-group.' });

        const current = await loadMasters('ledger', company);
        const byName = new Map(current.map(l => [l.name, l]));
        const groups = new Set((await loadMasters('group', company)).map(g => g.name));

        const errors = [];
        const todo = [];
        for (const l of wanted) {
            const have = byName.get(l.name);
            if (!have) { errors.push(`${l.name} — no such ledger in this company`); continue; }
            if (!groups.has(l.parent)) { errors.push(`${l.name} → "${l.parent}" is not a group in this company`); continue; }
            if (have.parent === l.parent && !l.newName) { errors.push(`${l.name} is already under ${l.parent}`); continue; }
            // A rename carries every voucher with it, including posted ones — Tally updates the
            // references itself. Refuse if the target name is taken, or Tally would merge two accounts.
            if (l.newName && l.newName !== l.name && byName.has(l.newName)) {
                errors.push(`cannot rename ${l.name} — "${l.newName}" already exists`); continue;
            }
            // Carry the existing bill-wise setting through, so the alter doesn't quietly turn it off.
            todo.push({ name: l.name, parent: l.parent, newName: l.newName || null,
                        isBillwise: !!have.is_billwise, from: have.parent });
        }
        if (!todo.length) return res.status(400).json({ success: false, error: errors[0] || 'Nothing to do.', errors });

        const parsed = T.parseImportResponse(await tallyPost(T.buildLedgerRegroupXml({ company, ledgers: todo }), 120000));
        if (!parsed.ok) return res.status(422).json({ success: false, error: parsed.error, errors });

        const fresh = T.parseMasters(await tallyPost(T.buildMastersRequest('ledger', company)), 'ledger');
        await saveMasters('ledger', fresh, company);

        // Report back from Tally's OWN reply, not from what we asked for.
        const after = new Map(fresh.map(l => [l.name, l.parent]));
        const finalName = (l) => l.newName || l.name;
        const moved = todo.filter(l => after.get(finalName(l)) === l.parent);
        const stuck = todo.filter(l => after.get(finalName(l)) !== l.parent)
                          .map(l => `${finalName(l)} is not under ${l.parent} (Tally reports ${after.get(finalName(l)) || 'no such ledger'})`);

        console.log(`[Tally] re-grouped ${moved.length} ledger(s) in "${company}" by ${(req.user || {}).sub}`);
        res.json({ success: true, altered: parsed.altered || parsed.created || moved.length,
                   moved: moved.map(l => ({ name: l.name, renamedTo: l.newName || null, from: l.from, to: l.parent })),
                   errors: errors.concat(stuck) });
    } catch (e) { console.error('[Tally] regroup:', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── DELETE /tally/ledgers — remove ledger masters ────────────────────────────────────────────────
// Refused while our own register still holds a voucher on the ledger; Tally refuses independently if
// its books do. Two separate guards on purpose — ours knows about drafts Tally has never seen.
router.delete('/tally/ledgers', requireAdminPush, async (req, res) => {
    try {
        if (!POST_ENABLED())
            return res.status(403).json({ success: false, error: 'Writing to Tally is disabled (TALLY_POST_ENABLED is not true).' });
        if (MODE() !== 'direct')
            return res.status(501).json({ success: false, error: 'Deleting ledgers currently needs TALLY_MODE=direct.' });

        const company = String(req.body.company || '') || await resolveCompany();
        const names = [...new Set((Array.isArray(req.body.names) ? req.body.names : [])
            .map(n => String(n || '').trim()).filter(Boolean))];
        if (!names.length) return res.status(400).json({ success: false, error: 'No ledger named.' });

        const inUse = [];
        for (const n of names) {
            const { count } = await supabase.from('tally_vouchers_ecom')
                .select('id', { count: 'exact', head: true }).eq('company', company).eq('party_ledger', n);
            if (count) inUse.push(`${n} — ${count} voucher(s) in the register still use it`);
        }
        if (inUse.length) return res.status(409).json({ success: false, error: inUse[0], errors: inUse });

        const parsed = T.parseImportResponse(await tallyPost(T.buildLedgerDeleteXml({ company, names }), 120000));
        // A delete reports DELETED, not CREATED/ALTERED, so the shared "ok" check does not apply here.
        if (parsed.errors || parsed.exceptions || (parsed.lineErrors || []).length)
            return res.status(422).json({ success: false, error: parsed.error || 'Tally refused the delete — the ledger is probably still used by a voucher there.' });

        const fresh = T.parseMasters(await tallyPost(T.buildMastersRequest('ledger', company)), 'ledger');
        await saveMasters('ledger', fresh, company);
        const left = names.filter(n => fresh.some(l => l.name === n));

        console.log(`[Tally] deleted ledger(s) in "${company}": ${names.join(', ')} by ${(req.user || {}).sub}`);
        res.json({ success: true, deleted: names.filter(n => !left.includes(n)), notDeleted: left, raw: parsed.raw ? undefined : undefined });
    } catch (e) { console.error('[Tally] delete ledgers:', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /tally/ledgers/propose — suggest a group for names that have no ledger yet ───────────────
// Looks at how the SAME name is grouped in your OTHER company. That reuses the knowledge without
// copying any data between the two sets of books.
router.post('/tally/ledgers/propose', async (req, res) => {
    try {
        const company = String(req.body.company || '') || await resolveCompany();
        const names = [...new Set((Array.isArray(req.body.names) ? req.body.names : [])
            .map(n => String(n || '').trim()).filter(Boolean))];
        if (!names.length) return res.json({ success: true, proposals: [] });

        const existing = await knownLedgerSet(company);
        // Every OTHER company's ledgers act as the precedent library.
        const all = await loadMasters('ledger');
        const reference = all.filter(l => l.company !== company);
        const groups = new Set((await loadMasters('group', company)).map(g => g.name));

        // Where each reference group sits in the books that DO have it, so a missing one can be created
        // in the right place rather than guessed at.
        const refGroups = new Map((await loadMasters('group')).filter(g => g.company !== company)
            .map(g => [g.name, g.parent]));

        const proposals = names.filter(n => !existing.has(n)).map(name => {
            const s = BM.suggestGroup(name, reference, 'Sundry Creditors');
            const ref = reference.find(r => r.name === name);
            const exists = groups.has(s.group);
            return {
                name,
                // The precedent group is reported EVEN WHEN it does not exist here yet. Silently
                // swapping in "Sundry Creditors" while still printing "sits under INFLUENCER MARKETING
                // EXPENSES in your other company" is how a whole class of salary and influencer
                // payments got filed as trade creditors — the screen said one thing and did another.
                group: s.group,
                groupExists: exists,
                needsGroupCreating: !exists && s.confidence > 0,
                groupParent: exists ? null : (refGroups.get(s.group) || 'Indirect Expenses'),
                isBillwise: ref ? !!ref.is_billwise : false,
                reason: exists ? s.reason
                    : s.confidence > 0
                        ? `${s.reason} — that group does not exist here yet and will be created under ${refGroups.get(s.group) || 'Indirect Expenses'}`
                        : s.reason,
                confidence: Number((s.confidence || 0).toFixed(2)),
            };
        });
        res.json({ success: true, company, proposals,
                   alreadyExist: names.filter(n => existing.has(n)),
                   availableGroups: [...groups].sort() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── DELETE /tally/vouchers/:id/hard — an ADMIN removes an entry from the dashboard, from the UI ────
// Cancel (above) is a soft status change and leaves the row in the register. This is the real delete,
// so that removing a junk entry never means opening the Supabase SQL editor.
//
// It deletes ONLY our row. It does NOT touch Tally — a voucher already in Tally must be removed inside
// Tally (Alt+D), and the confirmation says so, because silently leaving the two out of step would be
// worse than refusing. The full voucher is snapshotted into tally_voucher_deletions_ecom first, with
// who entered it and who removed it, so the audit trail survives the row.
router.delete('/tally/vouchers/:id/hard', async (req, res) => {
    try {
        if (!(req.user && req.user.role === 'admin'))
            return res.status(403).json({ success: false, error: 'Only an admin can delete a voucher entry.' });

        const { data: v } = await supabase.from('tally_vouchers_ecom').select('*').eq('id', req.params.id).maybeSingle();
        if (!v) return res.status(404).json({ success: false, error: 'Voucher not found (already deleted?)' });

        // Mid-flight vouchers must not vanish underneath the bridge agent or an open batch — the agent
        // could be posting this very row, and deleting it would lose the record of what it did.
        if (['queued', 'posting', 'awaiting_approval'].includes(v.status))
            return res.status(409).json({ success: false, error:
                `This voucher is ${v.status === 'awaiting_approval' ? 'in a batch awaiting approval' : 'being posted to Tally'}. Reject the batch (or wait for it to finish) before deleting it.` });

        const reason = String((req.body && req.body.reason) || '').trim();
        // A posted voucher is real accounting history — deleting our copy needs a stated reason.
        if (v.status === 'posted' && !reason)
            return res.status(400).json({ success: false, error: 'This voucher was posted to Tally. Give a reason for deleting our record of it.' });

        let batchRef = null;
        if (v.batch_id) {
            const { data: b } = await supabase.from('tally_push_batches_ecom').select('ref').eq('id', v.batch_id).maybeSingle();
            batchRef = b ? b.ref : null;
        }

        // Snapshot BEFORE deleting. If this insert fails we abort — no audit, no delete.
        const { error: aErr } = await supabase.from('tally_voucher_deletions_ecom').insert({
            voucher_id: v.id, company: v.company,
            voucher_type: v.voucher_type, voucher_date: v.voucher_date, party_ledger: v.party_ledger,
            reference: v.reference, narration: v.narration, total_amount: v.total_amount, entries: v.entries,
            prior_status: v.status, was_posted: v.status === 'posted',
            tally_masterid: v.tally_masterid, tally_voucher_number: v.tally_voucher_number, batch_ref: batchRef,
            snapshot: v,
            entered_by: v.created_by, entered_at: v.created_at, posted_by: v.posted_by,
            deleted_by: req.user.sub, reason: reason || null,
        });
        if (aErr) throw new Error('could not write the deletion audit record: ' + aErr.message);

        const { error: dErr } = await supabase.from('tally_vouchers_ecom').delete().eq('id', v.id);
        if (dErr) throw new Error(dErr.message);

        // If this voucher came from a bank statement, its line is claimed in tally_bank_lines_ecom so the
        // same transaction can't be imported twice. Deleting the voucher has to decide what to do with
        // that claim:
        //   never posted -> release it, so the statement row can be mapped again. Otherwise deleting a
        //                   mis-mapped row would lock it out of the import for good.
        //   was posted   -> KEEP it. The voucher still exists in Tally (this delete never touched Tally),
        //                   so releasing the claim would let a re-import create a second copy there.
        let bankLine = null;
        if (v.source === 'bank-statement') {
            const { data: line } = await supabase.from('tally_bank_lines_ecom')
                .select('*').eq('voucher_id', v.id).maybeSingle();
            if (line) {
                if (v.status === 'posted') {
                    await supabase.from('tally_bank_lines_ecom').update({ voucher_id: null }).eq('id', line.id);
                    bankLine = { released: false, id: line.id,
                        note: 'The statement line stays locked because this voucher is still in Tally. Delete it in Tally first, then release the line to re-map it.' };
                } else {
                    await supabase.from('tally_bank_lines_ecom').delete().eq('id', line.id);
                    // Back into the pending pile, not into thin air: otherwise the only way to see this
                    // line again would be to re-upload the whole statement.
                    // Required lazily — tally_bank.js requires this module, so a top-level require would
                    // be circular and hand back a half-built object.
                    await require('./tally_bank').returnToPending(line, (req.body && req.body.reason) || 'voucher deleted');
                    bankLine = { released: true, note: 'The statement line is back in the pending list, ready to be mapped again.' };
                }
            }
        }

        console.log(`[Tally] voucher ${v.id} (${v.voucher_type} ${v.total_amount}, was ${v.status}) deleted by ${req.user.sub}`);
        res.json({ success: true, deleted: { id: v.id, type: v.voucher_type, amount: v.total_amount, priorStatus: v.status },
                   bankLine,
                   note: v.status === 'posted' ? 'Removed from the dashboard only — it is still in Tally. Delete it there with Alt+D if you meant to reverse it.' : null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /tally/bank/lines/release — free a statement line so it can be imported again ───────────
// Only needed for a line whose voucher had already been POSTED: the claim is deliberately kept then,
// because the voucher still exists in Tally and re-importing would create a second copy. Once the
// operator has deleted it inside Tally, this releases the line.
//
// It refuses while a voucher is still attached — that would be the "delete it in Tally" step skipped.
router.post('/tally/bank/lines/release', async (req, res) => {
    try {
        if (!(req.user && req.user.role === 'admin'))
            return res.status(403).json({ success: false, error: 'Only an admin can release an imported statement line.' });
        const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String).filter(Boolean);
        const hashes = (Array.isArray(req.body && req.body.hashes) ? req.body.hashes : []).map(String).filter(Boolean);
        if (!ids.length && !hashes.length) return res.status(400).json({ success: false, error: 'Nothing to release.' });

        let q = supabase.from('tally_bank_lines_ecom').select('*');
        q = ids.length ? q.in('id', ids) : q.in('line_hash', hashes);
        const { data: lines, error } = await q;
        if (error) throw new Error(error.message);
        if (!lines || !lines.length) return res.status(404).json({ success: false, error: 'No matching imported line found.' });

        // "Still linked" means a voucher that ACTUALLY EXISTS. A dangling id points at a deleted row and
        // must not block the release — that was the state an older delete left behind.
        const linkedIds = [...new Set(lines.map(l => l.voucher_id).filter(Boolean))];
        const alive = new Set();
        for (let i = 0; i < linkedIds.length; i += 100) {
            const { data } = await supabase.from('tally_vouchers_ecom').select('id').in('id', linkedIds.slice(i, i + 100));
            (data || []).forEach(v => alive.add(v.id));
        }
        const stillLinked = lines.filter(l => l.voucher_id && alive.has(l.voucher_id));
        if (stillLinked.length)
            return res.status(409).json({ success: false,
                error: `${stillLinked.length} line(s) still have a voucher in the register. Delete the voucher first — releasing now would let the same transaction be imported twice.` });

        const { error: dErr } = await supabase.from('tally_bank_lines_ecom').delete().in('id', lines.map(l => l.id));
        if (dErr) throw new Error(dErr.message);
        const back = require('./tally_bank').returnToPending;   // lazy: tally_bank requires this module
        for (const l of lines) await back(l, 'released by an admin');
        console.log(`[Tally] ${lines.length} bank line(s) released by ${(req.user || {}).sub}`);
        res.json({ success: true, released: lines.length,
                   lines: lines.map(l => ({ date: l.txn_date, narration: (l.narration || '').slice(0, 60), ledger: l.ledger })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /tally/bank/lines/orphaned — imported lines whose voucher was deleted ─────────────────────
// These are the rows that would otherwise stay locked out of the import for ever.
router.get('/tally/bank/lines/orphaned', async (req, res) => {
    try {
        const { data: all, error } = await supabase.from('tally_bank_lines_ecom')
            .select('id, line_hash, txn_date, narration, withdrawal, deposit, ledger, voucher_id, imported_at')
            .order('txn_date', { ascending: true });
        if (error) throw new Error(error.message);
        const lines = all || [];

        // Two ways a line ends up stranded:
        //   voucher_id NULL      — the delete released the link but kept the claim (voucher had reached Tally)
        //   voucher_id DANGLING  — points at a voucher row that no longer exists, left by an older delete
        //                          that didn't clear the link. Invisible to a plain IS NULL filter.
        const ids = [...new Set(lines.map(l => l.voucher_id).filter(Boolean))];
        const alive = new Set();
        // Chunked on purpose: a single .in() with hundreds of UUIDs overflows the request URL and comes
        // back empty, which would make every line look orphaned.
        for (let i = 0; i < ids.length; i += 100) {
            const { data } = await supabase.from('tally_vouchers_ecom').select('id').in('id', ids.slice(i, i + 100));
            (data || []).forEach(v => alive.add(v.id));
        }
        const rows = lines
            .filter(l => !l.voucher_id || !alive.has(l.voucher_id))
            .map(l => ({ ...l, why: l.voucher_id ? 'voucher deleted (link left behind)' : 'voucher deleted' }))
            .slice(0, 500);
        res.json({ success: true, rows, canRelease: !!(req.user && req.user.role === 'admin') });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /tally/deletions — the deletion log: what was removed, by whom, when and why ──────────────
router.get('/tally/deletions', async (req, res) => {
    try {
        const { data, error } = await supabase.from('tally_voucher_deletions_ecom')
            .select('id, voucher_id, voucher_type, voucher_date, party_ledger, narration, total_amount, entries,' +
                    ' prior_status, was_posted, tally_masterid, tally_voucher_number, batch_ref,' +
                    ' entered_by, entered_at, posted_by, deleted_by, deleted_at, reason')
            .order('deleted_at', { ascending: false })
            .limit(Math.min(parseInt(req.query.limit, 10) || 100, 500));
        if (error) throw new Error(error.message);
        res.json({ success: true, rows: data || [], canDelete: !!(req.user && req.user.role === 'admin') });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /tally/vouchers/preview-xml — show the operator the exact XML that will be sent. Accepts either
// a saved id or an unsaved form payload, so it works before the first save.
router.post('/tally/vouchers/preview-xml', async (req, res) => {
    try {
        let v, company;
        if (req.body.id) {
            const { data } = await supabase.from('tally_vouchers_ecom').select('*').eq('id', req.body.id).maybeSingle();
            if (!data) return res.status(404).json({ success: false, error: 'Voucher not found' });
            company = data.company;
            v = { voucherType: data.voucher_type, date: data.voucher_date, company, partyLedger: data.party_ledger,
                  reference: data.reference || T.refMarker(data.id), narration: data.narration, entries: data.entries };
        } else {
            company = req.body.company || await resolveCompany();
            const n = await normaliseDraft(req.body, company);
            if (n.errors.length) return res.status(400).json({ success: false, error: n.errors[0], errors: n.errors });
            v = n.v;
        }
        res.json({ success: true, xml: T.buildVoucherXml({ ...v, optional: req.body.optional === true, knownLedgers: await knownLedgerSet(company) }) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Apply Tally's verdict to the row. Single writer for the posted/failed transition, shared by the
// direct path and the bridge ack, so both agree on what "posted" means.
async function applyResult(id, parsed, requestXml, postedBy) {
    const patch = parsed.ok
        ? { status: 'posted', posted_at: new Date().toISOString(), error: null,
            tally_masterid: parsed.lastVchId ? String(parsed.lastVchId) : null }
        : { status: 'failed', error: parsed.error };
    if (requestXml) patch.request_xml = requestXml;
    patch.response_xml = (parsed.raw || '').slice(0, 20000);
    if (postedBy) patch.posted_by = postedBy;
    const { data } = await supabase.from('tally_vouchers_ecom').update(patch).eq('id', id).select(VOUCHER_COLS).single();
    return data;
}

// Pushing into the books is ADMIN-ONLY, by explicit instruction. Everyone else drafts; the nightly
// batch (tally_batch.js) is how a non-admin's entries reach Tally, after an admin approves them.
// The permission key `finance-post-tally` is kept so existing grants don't error, but it is no longer
// sufficient on its own — the role check below is the real gate, enforced server-side regardless of UI.
function requireAdminPush(req, res, next) {
    if (req.user && req.user.role === 'admin') return next();
    return res.status(403).json({ success: false,
        error: 'Only an admin can push vouchers to Tally. Your entries are saved as drafts and go up in the nightly batch once an admin approves it.' });
}

// POST /tally/vouchers/:id/post — direct mode posts now; bridge mode queues for the agent. ADMIN ONLY.
// One voucher, start to finish. Shared by the single-post route and the bulk push so the two can never
// diverge on safety: status check, 3-attempt cap, unknown-outcome guard, revalidation against the
// CURRENT chart of accounts, and a status-filtered claim that stops two clicks posting the same row.
// Returns { ok, status, ... } instead of throwing, so a bulk run can carry on past one bad voucher.
async function postVoucherById(id, { user = null, optional = false, force = false } = {}) {
    if (!POST_ENABLED()) return { ok: false, code: 403, error: 'Posting to Tally is disabled (TALLY_POST_ENABLED is not true).' };

    const { data: cur } = await supabase.from('tally_vouchers_ecom').select('*').eq('id', id).maybeSingle();
    if (!cur) return { ok: false, code: 404, error: 'Voucher not found' };
    if (!['draft', 'failed'].includes(cur.status)) return { ok: false, code: 409, error: `Voucher is already ${cur.status}.` };
    if (cur.attempts >= 3) return { ok: false, code: 409, error: 'Failed 3 times already — check it in Tally before retrying.' };
    // A previous attempt whose outcome we never learned might already be in Tally; re-sending would
    // duplicate it silently.
    if (cur.status === 'failed' && /timeout|ECONNRESET|socket hang up|unknown outcome/i.test(cur.error || '') && !force)
        return { ok: false, code: 409, needsConfirm: true,
                 error: 'The previous attempt timed out and may already be in Tally. Check reference ' + T.refMarker(id) + ' before retrying.' };

    const check = T.validateVoucher({
        voucherType: cur.voucher_type, date: cur.voucher_date, company: cur.company,
        partyLedger: cur.party_ledger, entries: cur.entries,
    }, await knownLedgerSet(cur.company));
    if (!check.ok) return { ok: false, code: 400, error: check.errors[0], errors: check.errors };

    const reference = cur.reference || T.refMarker(id);
    let xml;
    try {
        xml = T.buildVoucherXml({
            voucherType: cur.voucher_type, date: cur.voucher_date, company: cur.company,
            partyLedger: cur.party_ledger, reference, narration: cur.narration, entries: cur.entries, optional,
        });
    } catch (e) { return { ok: false, code: 400, error: e.message }; }

    const nextStatus = MODE() === 'direct' ? 'posting' : 'queued';
    const { data: claimed } = await supabase.from('tally_vouchers_ecom')
        .update({ status: nextStatus, reference, request_xml: xml, error: null,
                  attempts: cur.attempts + 1, idempotency_key: 'v:' + id, posted_by: user })
        .eq('id', id).in('status', ['draft', 'failed']).select('id');
    if (!claimed || !claimed.length) return { ok: false, code: 409, error: 'Someone else just submitted this voucher.' };

    if (MODE() === 'bridge') return { ok: true, queued: true, reference, status: 'queued' };

    let parsed;
    try { parsed = T.parseImportResponse(await tallyPost(xml)); }
    catch (e) {
        const row = await applyResult(id, { ok: false, raw: '',
            error: `Could not reach Tally (${e.message}) — unknown outcome, verify in Tally before retrying.` }, xml, null);
        return { ok: false, code: 502, error: row.error, row };
    }
    const row = await applyResult(id, parsed, xml, user);
    if (!parsed.ok) return { ok: false, code: 422, error: parsed.error, row };
    return { ok: true, status: 'posted', row, tallyVoucherId: parsed.lastVchId };
}

router.post('/tally/vouchers/:id/post', requireAdminPush, async (req, res) => {
    try {
        const r = await postVoucherById(req.params.id, {
            user: (req.user && req.user.sub) || null,
            optional: !!(req.body && req.body.optional),
            force: !!(req.body && req.body.force),
        });
        if (r.ok) return res.json({ success: true, ...r, message: r.queued
            ? 'Queued — the bridge agent on the Tally PC will post it within a few seconds.' : undefined });
        res.status(r.code || 500).json({ success: false, ...r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /tally/vouchers/post-bulk — post many, one at a time ─────────────────────────────────────
// Deliberately sequential and capped per request. Tally is single-threaded, and posting hundreds of
// vouchers in parallel is how you get half-written batches and timeouts. The client sends small chunks
// so it can show honest progress and stop the moment something looks wrong.
//
// `stopOnError` (default true) aborts the chunk on the first failure rather than ploughing through
// hundreds of vouchers repeating the same mistake.
router.post('/tally/vouchers/post-bulk', requireAdminPush, async (req, res) => {
    try {
        if (!POST_ENABLED())
            return res.status(403).json({ success: false, error: 'Posting to Tally is disabled (TALLY_POST_ENABLED is not true).' });
        const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String).filter(Boolean);
        if (!ids.length) return res.status(400).json({ success: false, error: 'No vouchers selected.' });
        if (ids.length > 50) return res.status(400).json({ success: false, error: 'Send at most 50 at a time.' });

        const user = (req.user && req.user.sub) || null;
        const optional = !!(req.body && req.body.optional);
        const stopOnError = req.body && req.body.stopOnError === false ? false : true;

        const results = [];
        let posted = 0, failed = 0;
        for (const id of ids) {
            const r = await postVoucherById(id, { user, optional });
            results.push({ id, ok: r.ok, error: r.error || null, status: r.status || null });
            if (r.ok) posted++; else { failed++; if (stopOnError) break; }
            await new Promise(s => setTimeout(s, 120));   // gentle on Tally — it processes one at a time
        }
        console.log(`[Tally] bulk post by ${user}: ${posted} posted, ${failed} failed of ${ids.length}`);
        res.json({ success: true, posted, failed, stopped: stopOnError && failed > 0 && results.length < ids.length, results });
    } catch (e) { console.error('[Tally] bulk post:', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── bridge endpoints (no JWT — X-Bridge-Key only; see PUBLIC_API in server.js) ────────────────────
// Refuses outright when TALLY_BRIDGE_KEY is unset: an unauthenticated queue would let anyone push
// vouchers into the books.
function bridgeAuth(req, res, next) {
    const expected = config.TALLY_BRIDGE_KEY;
    if (!expected) return res.status(503).json({ error: 'Bridge is not configured (TALLY_BRIDGE_KEY unset).' });
    const got = String(req.headers['x-bridge-key'] || '');
    const a = Buffer.from(got), b = Buffer.from(String(expected));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Bad bridge key' });
    next();
}

// The agent says hello every few seconds; this is what turns the UI chip green.
router.post('/tally/bridge/heartbeat', bridgeAuth, async (req, res) => {
    try {
        const patch = {
            last_seen_at: new Date().toISOString(),
            agent_version: req.body.version ? String(req.body.version).slice(0, 40) : null,
            tally_reachable: !!req.body.tallyReachable,
            note: req.body.note ? String(req.body.note).slice(0, 500) : null,
        };
        if (req.body.company) patch.company = String(req.body.company);
        await supabase.from('tally_bridge_status_ecom').update(patch).eq('id', 1);
        const { data } = await supabase.from('tally_bridge_status_ecom').select('sync_requested').eq('id', 1).maybeSingle();
        res.json({ ok: true, syncRequested: !!(data && data.sync_requested), postEnabled: POST_ENABLED() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// The agent claims queued vouchers. Claiming flips them to `posting` under a status filter, so two
// agents (or a restarted one) can't pick up the same voucher twice.
router.get('/tally/bridge/pull', bridgeAuth, async (req, res) => {
    try {
        if (!POST_ENABLED()) return res.json({ vouchers: [] });
        const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
        const { data: queued } = await supabase.from('tally_vouchers_ecom')
            .select('id, request_xml, company, reference').eq('status', 'queued')
            .order('created_at', { ascending: true }).limit(limit);

        const claimed = [];
        for (const v of queued || []) {
            const { data } = await supabase.from('tally_vouchers_ecom')
                .update({ status: 'posting' }).eq('id', v.id).eq('status', 'queued').select('id');
            if (data && data.length) claimed.push({ id: v.id, company: v.company, reference: v.reference, xml: v.request_xml });
        }
        res.json({ vouchers: claimed });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// The agent reports what Tally said. It sends the raw reply; the verdict is decided HERE by the same
// parser the direct path uses, so a buggy agent can't talk us into calling a failure a success.
router.post('/tally/bridge/ack', bridgeAuth, async (req, res) => {
    try {
        const { id, responseXml, transportError } = req.body || {};
        if (!id) return res.status(400).json({ error: 'id required' });
        const { data: cur } = await supabase.from('tally_vouchers_ecom').select('id, status').eq('id', id).maybeSingle();
        if (!cur) return res.status(404).json({ error: 'Voucher not found' });
        if (cur.status !== 'posting') return res.json({ ok: true, ignored: true, status: cur.status });

        const parsed = transportError
            ? { ok: false, error: `Agent could not reach Tally (${String(transportError).slice(0, 300)}) — unknown outcome, verify in Tally before retrying.`, raw: '' }
            : T.parseImportResponse(responseXml);
        const row = await applyResult(id, parsed, null, null);
        res.json({ ok: true, status: row.status, error: row.error || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// The agent uploads the master dump it pulled from Tally (bridge mode's equivalent of syncMastersDirect).
router.post('/tally/bridge/masters', bridgeAuth, async (req, res) => {
    try {
        const { company, masters } = req.body || {};
        if (!masters || typeof masters !== 'object') return res.status(400).json({ error: 'masters required' });
        const counts = {};
        for (const kind of MASTER_KINDS) {
            if (!Array.isArray(masters[kind])) continue;
            counts[kind] = await saveMasters(kind, masters[kind], company);
        }
        await supabase.from('tally_bridge_status_ecom').update({
            company: company || null, masters_synced_at: new Date().toISOString(), sync_requested: false,
        }).eq('id', 1);
        res.json({ ok: true, counts });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// The agent ships RAW Tally XML and the SERVER parses it, so the single parser in tally_xml.js stays
// the only interpretation of Tally's output — the agent can never drift from it or mis-read a reply.
router.post('/tally/bridge/masters-xml', bridgeAuth, async (req, res) => {
    try {
        const { company, masters } = req.body || {};
        if (!masters || typeof masters !== 'object') return res.status(400).json({ error: 'masters required' });
        const counts = {};
        for (const kind of MASTER_KINDS) {
            if (typeof masters[kind] !== 'string') continue;
            counts[kind] = await saveMasters(kind, T.parseMasters(masters[kind], kind), company);
        }
        await supabase.from('tally_bridge_status_ecom').update({
            company: company || null, masters_synced_at: new Date().toISOString(), sync_requested: false,
        }).eq('id', 1);
        res.json({ ok: true, counts });
    } catch (e) { console.error('[Tally] bridge masters-xml:', e.message); res.status(500).json({ error: e.message }); }
});

// Books upload — this is what makes Tally Books work on the LIVE dashboard, where the server cannot
// reach localhost:9000. Stored parsed (not raw) so page loads don't re-parse ~5MB of XML each time.
router.post('/tally/bridge/books-xml', bridgeAuth, async (req, res) => {
    try {
        const { company, periodFrom, periodTo, trialBalance, dayBook } = req.body || {};
        if (!company) return res.status(400).json({ error: 'company required' });
        const now = new Date().toISOString();
        const counts = {};
        const put = async (kind, payload, from, to) => {
            const { error } = await supabase.from('tally_books_cache_ecom').upsert({
                company, kind, period_from: from, period_to: to, payload, synced_at: now,
            }, { onConflict: 'company,kind,period_from,period_to' });
            if (error) throw new Error(`${kind}: ${error.message}`);
        };
        if (typeof trialBalance === 'string' && trialBalance.trim()) {
            const rows = T.parseTrialBalance(trialBalance);
            await put('trial_balance', rows, periodFrom || null, periodTo || null);
            counts.trial_balance = rows.length;
        }
        if (typeof dayBook === 'string' && dayBook.trim()) {
            const rows = T.parseVouchers(dayBook);
            await put('day_book', rows, periodFrom || null, periodTo || null);
            counts.day_book = rows.length;
        }
        // Company/period metadata, so the FY picker works in bridge mode too.
        await put('meta', {
            name: company, booksFrom: periodFrom || null,
            periodFrom: periodFrom || null, periodTo: periodTo || null,
        }, null, null);
        res.json({ ok: true, counts, syncedAt: now });
    } catch (e) { console.error('[Tally] bridge books-xml:', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = { router, syncMastersDirect, loadMasters, knownLedgerSet, tallyPost, resolveCompany, openCompanies, postVoucherById,
                  MODE, POST_ENABLED, applyResult, VOUCHER_COLS, booksData, istToday };
