// ─────────────────────────────────────────────────────────────────────────────
// Finance → Data Entry → Bank Statement import.
//
// Upload a bank statement (xlsx / xls / csv), and for every line work out which Tally ledger it should
// be booked against — learning from how the same books have been written up before (tally_bank_match.js,
// measured at 98.8% leave-one-out on this company's own history). Confirmed rows become normal DRAFT
// vouchers, which then flow through the usual nightly batch + Teams approval. Nothing here posts to
// Tally directly.
//
// Two safeguards do the heavy lifting:
//  • DEDUP. Every statement line gets a hash of date+amount+narration+ref, recorded in
//    tally_bank_lines_ecom with a UNIQUE index. Re-uploading an overlapping statement therefore cannot
//    book the same transaction twice — the single most damaging mistake a bank import can make.
//  • NO GUESSING. A line the matcher is unsure about is returned with low confidence and its reasoning,
//    never silently assigned. A wrong ledger is worse than a blank one.
//
// The file arrives base64-encoded in a JSON body rather than multipart: it avoids adding a multer
// dependency (and an npm install on the VPS) for a handful of KB.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const router = express.Router();
const { supabase } = require('../supabase');
const T = require('./tally_xml');
const M = require('./tally_bank_match');
const tally = require('./tally');

const BANK_DEFAULT = 'HDFC BANK';
// Below this the matcher's answer is a lead, not a decision: it is shown with its reasoning but never
// filled in, and never accepted into a draft without a person confirming it.
const CONFIDENT = 0.8;

// ── reading the sheet ────────────────────────────────────────────────────────────────────────────
// exceljs hands back Dates, formula results and rich text depending on the cell — flatten all of it.
function cellText(cell) {
    let v = cell ? cell.value : null;
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
        if (v.text) v = v.text;
        else if (v.result !== undefined) v = v.result;
        else if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join('');
        else if (v.hyperlink) v = v.text || v.hyperlink;
        else return '';
    }
    return String(v).trim();
}

const num = (s) => {
    const n = parseFloat(String(s == null ? '' : s).replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
};

// Bank exports carry a dozen rows of branch/address preamble before the real header. Find the header
// by looking for the columns themselves rather than assuming a fixed row — every bank differs, and the
// same bank changes it between exports.
const HEADER_HINTS = {
    date: ['date', 'txn date', 'transaction date', 'tran date'],
    narration: ['narration', 'description', 'particulars', 'remarks', 'transaction remarks'],
    ref: ['chq./ref.no.', 'chq/ref no', 'ref no', 'reference', 'cheque no', 'chq no', 'ref.no.'],
    valueDate: ['value dt', 'value date'],
    withdrawal: ['withdrawal amt.', 'withdrawal', 'debit', 'dr', 'withdrawal amt', 'debit amount'],
    deposit: ['deposit amt.', 'deposit', 'credit', 'cr', 'deposit amt', 'credit amount'],
    balance: ['closing balance', 'balance', 'running balance'],
};

function findColumns(ws) {
    for (let i = 1; i <= Math.min(ws.rowCount, 60); i++) {
        const row = ws.getRow(i);
        const cells = [];
        for (let c = 1; c <= Math.min(ws.columnCount, 30); c++) cells.push(cellText(row.getCell(c)).toLowerCase().replace(/\s+/g, ' ').trim());
        const map = {};
        for (const [key, hints] of Object.entries(HEADER_HINTS)) {
            const idx = cells.findIndex(v => v && hints.some(h => v === h || v.replace(/[.\s]/g, '') === h.replace(/[.\s]/g, '')));
            if (idx >= 0) map[key] = idx + 1;
        }
        // A real header row must name the narration AND at least one money column.
        if (map.narration && (map.withdrawal || map.deposit)) return { headerRow: i, cols: map };
    }
    return null;
}

// Dates arrive as real Dates, dd/mm/yyyy or dd-MMM-yy. Never via `new Date(str)` — that reads
// dd/mm/yyyy as US mm/dd and would silently mis-date half a statement.
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function toIsoDate(raw) {
    const s = String(raw || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                         if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);                  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/);                  if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{2,4})$/);
    if (m && MONTHS[m[2].toLowerCase()]) {
        const y = m[3].length === 2 ? '20' + m[3] : m[3];
        return `${y}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
    }
    return null;
}

// One line = one hash. Includes the bank ledger so the same amount on two accounts stays distinct.
const lineHash = (bank, t) => crypto.createHash('sha1')
    .update([bank, t.date, t.narration, t.reference || '', t.withdrawal.toFixed(2), t.deposit.toFixed(2)].join('|'))
    .digest('hex');

async function parseWorkbook(buffer, filename) {
    const wb = new ExcelJS.Workbook();
    if (/\.csv$/i.test(filename || '')) {
        const { Readable } = require('stream');
        await wb.csv.read(Readable.from(buffer.toString('utf8')));
    } else {
        await wb.xlsx.load(buffer);   // .xls (BIFF) is NOT supported — the caller is told to re-save as .xlsx
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('The workbook has no sheets.');
    const found = findColumns(ws);
    if (!found) throw new Error('Could not find the statement header. Expected a row naming "Narration" and "Withdrawal"/"Deposit" columns.');
    const { headerRow, cols } = found;

    const rows = [], skipped = [];
    for (let i = headerRow + 1; i <= ws.rowCount; i++) {
        const r = ws.getRow(i);
        const date = toIsoDate(cellText(r.getCell(cols.date || 1)));
        const narration = cols.narration ? cellText(r.getCell(cols.narration)) : '';
        const withdrawal = cols.withdrawal ? num(cellText(r.getCell(cols.withdrawal))) : 0;
        const deposit = cols.deposit ? num(cellText(r.getCell(cols.deposit))) : 0;
        if (!date || !narration || (!withdrawal && !deposit)) {
            if (narration && (withdrawal || deposit)) skipped.push({ row: i, why: 'unreadable date', narration });
            continue;   // preamble, blank rows and the footer land here
        }
        rows.push({
            row: i, date, narration,
            reference: cols.ref ? cellText(r.getCell(cols.ref)) : '',
            withdrawal, deposit,
            balance: cols.balance ? (num(cellText(r.getCell(cols.balance))) || null) : null,
        });
    }
    return { headerRow, cols, rows, skipped };
}

// The running balance is a free integrity check the bank has already computed for us: if every row
// reconciles, nothing was missed, double-read or mis-parsed.
function checkRunningBalance(rows) {
    let checked = 0, broken = 0, firstBreak = null;
    for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1].balance, cur = rows[i].balance;
        if (prev == null || cur == null) continue;
        checked++;
        const expected = Math.round((prev - rows[i].withdrawal + rows[i].deposit) * 100);
        if (Math.abs(expected - Math.round(cur * 100)) > 1) {
            broken++;
            if (!firstBreak) firstBreak = { row: rows[i].row, date: rows[i].date, narration: rows[i].narration };
        }
    }
    return { checked, broken, ok: broken === 0, firstBreak };
}

// ── context the matcher needs ────────────────────────────────────────────────────────────────────
// A company that has just been opened has no history and almost no ledgers, so on its own the matcher
// can say nothing about a year of statement lines. The fix is the same idea as the ledger-group
// proposals: use ANOTHER company's bookings as PRECEDENT. Nothing is copied between the two sets of
// books — we only read how a narration was classified elsewhere and propose the same name here.
//
// The suggestion may therefore name a ledger the target company does not have yet. That is deliberate:
// the review screen flags it as "will be created", the create-ledgers step makes it, and the IMPORT
// still validates against the target company's own chart of accounts, so nothing can be booked against
// a ledger that doesn't exist.
const PRECEDENT_MIN = 20;   // below this much own-history, bring in other companies' bookings

function bankHistoryFrom(payload, bankLedger, precedent) {
    return (payload || [])
        .filter(v => !v.optional && !v.cancelled && v.narration && (v.entries || []).some(e => e.ledger === bankLedger))
        .map(v => {
            // Only a single-contra voucher teaches an unambiguous narration -> ledger mapping.
            const other = (v.entries || []).filter(e => e.ledger !== bankLedger);
            return other.length === 1 ? { narration: v.narration, ledger: other[0].ledger, type: v.type, precedent } : null;
        })
        .filter(Boolean);
}

async function matchContext(bankLedger, company) {
    const [{ data: books }, ownLedgers, { data: rules }] = await Promise.all([
        supabase.from('tally_books_cache_ecom').select('company, payload').eq('kind', 'day_book'),
        tally.loadMasters('ledger', company),
        supabase.from('tally_bank_rules_ecom').select('pattern, ledger, direction').eq('bank_ledger', bankLedger),
    ]);

    const rows = books || [];
    let history = rows.filter(r => r.company === company)
        .flatMap(r => bankHistoryFrom(r.payload, bankLedger, false));

    let precedentFrom = [];
    if (history.length < PRECEDENT_MIN) {
        for (const r of rows) {
            if (r.company === company) continue;
            const h = bankHistoryFrom(r.payload, bankLedger, true);
            if (h.length) { history = history.concat(h); precedentFrom.push(r.company); }
        }
    }

    // Ledgers the matcher may PROPOSE: this company's own, plus any named in the precedent history.
    // Import-time validation stays scoped to the target company (see /tally/bank/import).
    const own = new Set((ownLedgers || []).map(l => l.name));
    const ledgers = (ownLedgers || []).slice();
    if (precedentFrom.length) {
        const all = await tally.loadMasters('ledger');
        for (const l of all) {
            if (l.company === company || own.has(l.name)) continue;
            own.add(l.name);
            ledgers.push({ name: l.name, parent: l.parent, is_billwise: l.is_billwise, fromOtherCompany: true });
        }
    }
    return { history, ledgers, rules: rules || [], bankLedger, precedentFrom, ownLedgerNames: new Set((ownLedgers || []).map(l => l.name)) };
}

// ── narration labels ─────────────────────────────────────────────────────────────────────────────
// A running account with a service partner carries two unrelated kinds of transaction that the bank
// narration does not distinguish — with RapidShyp, money out is a wallet recharge and money in is a COD
// remittance. Direction is what tells them apart, so the label is keyed on it.
//
// The label goes at the FRONT: Tally shows a limited amount of narration, and the label is the part
// worth keeping when the reference number gets cut off.
async function narrationLabels(company) {
    const { data, error } = await supabase.from('tally_narration_labels_ecom')
        .select('ledger, direction, label').eq('company', company);
    if (error) { console.error('[TallyBank] labels:', error.message); return new Map(); }
    return new Map((data || []).map(r => [`${r.ledger}|${r.direction}`, r.label]));
}

const labelNarration = (labels, ledger, voucherType, narration) => {
    const label = labels.get(`${ledger}|${voucherType === 'Payment' ? 'payment' : 'receipt'}`);
    if (!label) return narration;
    // Don't stack the label on a narration that already carries it (a re-import, or an edited row).
    if (String(narration || '').toLowerCase().startsWith(label.toLowerCase())) return narration;
    return narration ? `${label} | ${narration}` : label;
};

// ── narration label admin ────────────────────────────────────────────────────────────────────────
router.get('/tally/narration-labels', async (req, res) => {
    try {
        const company = String(req.query.company || '') || await tally.resolveCompany();
        const { data, error } = await supabase.from('tally_narration_labels_ecom')
            .select('id, ledger, direction, label').eq('company', company).order('ledger');
        if (error) throw new Error(error.message);
        res.json({ success: true, company, rows: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/tally/narration-labels', async (req, res) => {
    try {
        const company = String(req.body.company || '') || await tally.resolveCompany();
        const rows = (Array.isArray(req.body.labels) ? req.body.labels : [])
            .map(l => ({ company, ledger: String(l.ledger || '').trim(),
                         direction: String(l.direction || '').toLowerCase().trim(),
                         label: String(l.label || '').trim(),
                         created_by: (req.user && req.user.sub) || null }))
            .filter(l => l.ledger && l.label && ['payment', 'receipt'].includes(l.direction));
        if (!rows.length) return res.status(400).json({ success: false, error: 'Each label needs a ledger, a direction (payment|receipt) and the text.' });

        // The ledger must exist, or the label would silently never apply.
        const known = await tally.knownLedgerSet(company);
        const bad = rows.filter(r => !known.has(r.ledger)).map(r => r.ledger);
        if (bad.length) return res.status(400).json({ success: false, error: `Not a ledger in this company: ${bad[0]}` });

        const { error } = await supabase.from('tally_narration_labels_ecom')
            .upsert(rows, { onConflict: 'company,ledger,direction' });
        if (error) throw new Error(error.message);
        res.json({ success: true, saved: rows.length });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/tally/narration-labels/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('tally_narration_labels_ecom').delete().eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── the pending pile ─────────────────────────────────────────────────────────────────────────────
// Every uploaded line that hasn't become a voucher is kept in tally_bank_pending_ecom, so "what is
// still unmapped" survives closing the tab. Without it the only way back to that list is to upload the
// whole statement again, which is slow and invites picking the wrong file.
//
// A line is in exactly one place at a time: pending (not yet booked) or tally_bank_lines_ecom (booked).
async function rememberPending(rows, { company, bankLedger, filename, user }) {
    if (!rows.length) return 0;
    const payload = rows.map(r => ({
        line_hash: r.hash, company, bank_ledger: bankLedger, txn_date: r.date,
        narration: r.narration || '', reference: r.reference || null,
        withdrawal: r.withdrawal || 0, deposit: r.deposit || 0,
        balance: r.balance == null ? null : Number(r.balance),
        source_file: filename || null, uploaded_by: user || null,
    }));
    let kept = 0;
    // ignoreDuplicates: re-uploading the same statement must not disturb rows already sitting here —
    // in particular it must not overwrite a returned_reason explaining why a line came back.
    for (let i = 0; i < payload.length; i += 200) {
        const { data, error } = await supabase.from('tally_bank_pending_ecom')
            .upsert(payload.slice(i, i + 200), { onConflict: 'line_hash', ignoreDuplicates: true })
            .select('id');
        if (error) { console.error('[TallyBank] pending upsert:', error.message); break; }
        kept += (data || []).length;
    }
    return kept;
}

// Put a line back after its voucher was removed. Called on delete/release so a quarantined row
// reappears in the mapping list instead of vanishing until the next upload.
async function returnToPending(line, reason) {
    if (!line) return;
    const { error } = await supabase.from('tally_bank_pending_ecom').upsert({
        line_hash: line.line_hash, company: line.company, bank_ledger: line.bank_ledger,
        txn_date: line.txn_date, narration: line.narration || '', reference: line.reference || null,
        withdrawal: line.withdrawal || 0, deposit: line.deposit || 0, balance: line.balance,
        source_file: line.source_file || null, returned_reason: reason || null,
        uploaded_by: line.imported_by || null,
    }, { onConflict: 'line_hash' });
    if (error) console.error('[TallyBank] return to pending:', error.message);
}

// Score a set of statement lines against the current books. Shared by the upload route and the pending
// list so both screens describe a line identically.
async function scoreRows(rows, { company, bankLedger }) {
    const ctx = await matchContext(bankLedger, company);
    let booksFrom = null;
    try {
        const meta = await tally.booksData('meta', company, null, null);
        booksFrom = (meta.data && meta.data.booksFrom) || null;
    } catch (_) { /* books unavailable — skip the check rather than block the screen */ }
    const scored = rows.map(t => {
        const s = M.suggestLedger(t.narration, ctx);
        // Name(s) to offer when nothing matched and a new ledger has to be created. A starting point
        // the operator edits and assigns a group to — never created on its own.
        return {
            ...t,
            partyGuesses: M.newLedgerCandidates(t.narration),
            beforeBooks: !!(booksFrom && t.date < booksFrom),
            voucherType: M.voucherFor(t),
            amount: t.withdrawal || t.deposit,
            suggestion: s ? { ledger: s.ledger, confidence: Number(s.confidence.toFixed(2)), reason: s.reason,
                              method: s.method, contested: !!s.contested, alternatives: s.alternatives || [],
                              needsCreating: !ctx.ownLedgerNames.has(s.ledger) } : null,
        };
    });
    return { rows: scored, booksFrom, ctx };
}

// The counts both screens show. `already` is only ever set by the upload path.
const bankSummary = (rows) => {
    const usable = rows.filter(r => !r.already && !r.beforeBooks);
    const dates = rows.map(r => r.date).sort();
    return {
        total: rows.length,
        alreadyImported: rows.filter(r => r.already).length,
        beforeBooksFrom: rows.filter(r => r.beforeBooks).length,
        usable: usable.length,
        confident: usable.filter(r => r.suggestion && r.suggestion.confidence >= CONFIDENT).length,
        unsure: usable.filter(r => r.suggestion && r.suggestion.confidence < CONFIDENT).length,
        unmatched: usable.filter(r => !r.suggestion).length,
        dateFrom: dates[0] || null, dateTo: dates[dates.length - 1] || null,
        totalOut: rows.reduce((a, r) => a + r.withdrawal, 0),
        totalIn: rows.reduce((a, r) => a + r.deposit, 0),
    };
};

// ── GET /tally/bank/pending — the lines still waiting to be mapped ───────────────────────────────
// Returns the same shape as /parse, so the review screen renders it without knowing the difference.
// Suggestions are recomputed on every call rather than stored: as ledgers get created and mappings
// learned, rows that were unmatchable last week can become obvious, and a stored guess would go stale.
router.get('/tally/bank/pending', async (req, res) => {
    try {
        const company = String(req.query.company || '') || await tally.resolveCompany();
        const rows = [];
        for (let f = 0; ; f += 1000) {
            const { data, error } = await supabase.from('tally_bank_pending_ecom')
                .select('line_hash, bank_ledger, txn_date, narration, reference, withdrawal, deposit, balance, source_file, returned_reason, uploaded_at')
                .eq('company', company).order('txn_date', { ascending: true }).range(f, f + 999);
            if (error) throw new Error(error.message);
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        if (!rows.length) return res.json({ success: true, pending: true, company, rows: [], summary: bankSummary([]) });

        const bankLedger = rows[0].bank_ledger || BANK_DEFAULT;
        const base = rows.map(r => ({
            hash: r.line_hash, date: r.txn_date, narration: r.narration || '', reference: r.reference || '',
            withdrawal: Number(r.withdrawal) || 0, deposit: Number(r.deposit) || 0,
            balance: r.balance == null ? null : Number(r.balance),
            already: false, returnedReason: r.returned_reason || null,
        }));
        const { rows: scored, booksFrom, ctx } = await scoreRows(base, { company, bankLedger });
        const files = [...new Set(rows.map(r => r.source_file).filter(Boolean))];
        res.json({
            success: true, pending: true, company, bankLedger, booksFrom,
            filename: files.length === 1 ? files[0] : `${rows.length} saved row(s)`,
            precedentFrom: ctx.precedentFrom || [],
            // No balance check: this is a subset of a statement, so its running balance has gaps by
            // design and asserting either way would be misleading.
            balanceCheck: null, headerRow: null, skipped: [],
            summary: bankSummary(scored), rows: scored,
        });
    } catch (e) { console.error('[TallyBank] pending:', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── GET /tally/bank/pending/count — just the number, for the badge on the upload screen ──────────
router.get('/tally/bank/pending/count', async (req, res) => {
    try {
        const company = String(req.query.company || '') || await tally.resolveCompany();
        const { count, error } = await supabase.from('tally_bank_pending_ecom')
            .select('id', { count: 'exact', head: true }).eq('company', company);
        if (error) throw new Error(error.message);
        res.json({ success: true, company, count: count || 0 });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /tally/bank/parse — read a statement and suggest a ledger for every line ─────────────────
router.post('/tally/bank/parse', async (req, res) => {
    try {
        const { filename, contentBase64 } = req.body || {};
        if (!contentBase64) return res.status(400).json({ success: false, error: 'No file was uploaded.' });
        if (/\.xls$/i.test(filename || ''))
            return res.status(400).json({ success: false, error: 'Old .xls files are not supported. Open it in Excel and "Save As" → .xlsx (or .csv), then upload again.' });

        const buffer = Buffer.from(String(contentBase64).replace(/^data:[^,]+,/, ''), 'base64');
        const bankLedger = String(req.body.bankLedger || BANK_DEFAULT);
        let parsed;
        try { parsed = await parseWorkbook(buffer, filename); }
        catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        if (!parsed.rows.length) return res.status(400).json({ success: false, error: 'No transaction rows were found in that file.' });

        const company = String(req.body.company || '') || await tally.resolveCompany();
        const ctx = await matchContext(bankLedger, company);
        const known = new Set(ctx.ledgers.map(l => l.name));
        if (!known.has(bankLedger))
            return res.status(400).json({ success: false, error: `"${bankLedger}" is not a ledger in Tally. Sync ledgers first.` });

        // Which of these lines have we already imported? Checked in chunks — the `.in()` filter has a
        // practical URL-length limit, and a year's statement is ~1000 rows.
        const hashes = parsed.rows.map(t => lineHash(bankLedger, t));
        const seen = new Set();
        for (let i = 0; i < hashes.length; i += 200) {
            const { data } = await supabase.from('tally_bank_lines_ecom')
                .select('line_hash').in('line_hash', hashes.slice(i, i + 200));
            (data || []).forEach(r => seen.add(r.line_hash));
        }

        // Tally rejects vouchers dated before the company's books begin. scoreRows flags those too, so
        // the whole file doesn't fail one row at a time later.
        const scored = await scoreRows(
            parsed.rows.map((t, i) => ({ ...t, hash: hashes[i], already: seen.has(hashes[i]) })),
            { company, bankLedger });
        const rows = scored.rows;
        const booksFrom = scored.booksFrom;

        // Save everything still unbooked, so this list can be reopened without the file. Rows dated
        // outside the books are kept as well — they become importable the moment the operator widens
        // "Books beginning from" in Tally, and dropping them would hide the problem instead.
        const savedNow = await rememberPending(rows.filter(r => !r.already),
            { company, bankLedger, filename, user: (req.user && req.user.sub) || null });

        const usable = rows.filter(r => !r.already && !r.beforeBooks);
        res.json({
            success: true, filename: filename || null, bankLedger, booksFrom, company,
            // Which other books the suggestions were learned from, so the screen can say so plainly.
            precedentFrom: ctx.precedentFrom || [],
            headerRow: parsed.headerRow, skipped: parsed.skipped.slice(0, 20),
            balanceCheck: checkRunningBalance(parsed.rows),
            savedForLater: savedNow,
            summary: bankSummary(rows),
            rows,
        });
    } catch (e) { console.error('[TallyBank] parse:', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /tally/bank/import — turn confirmed lines into DRAFT vouchers ───────────────────────────
// Drafts only: they still go through the nightly batch and an admin's approval before reaching Tally.
router.post('/tally/bank/import', async (req, res) => {
    try {
        const items = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
        if (!items.length) return res.status(400).json({ success: false, error: 'Nothing to import.' });
        const bankLedger = String(req.body.bankLedger || BANK_DEFAULT);
        const filename = req.body.filename || null;
        const user = (req.user && req.user.sub) || null;
        const company = String(req.body.company || '') || await tally.resolveCompany();
        const known = await tally.knownLedgerSet(company);
        const learn = req.body.learn !== false;

        // Tally refuses any voucher dated before the company's books-begin date. Catching it here beats
        // creating hundreds of drafts that would each fail at posting time — the operator needs to widen
        // "Books beginning from" in Tally (or use another company) before these can be imported at all.
        let booksFrom = null;
        try { const meta = await tally.booksData('meta', company, null, null); booksFrom = (meta.data && meta.data.booksFrom) || null; }
        catch (_) { /* books unavailable — don't block on a check we can't perform */ }

        // Re-derive the suggestions here rather than trusting what the browser sends. The rule is that a
        // match the matcher is under 80% sure of must not become a draft unless a person chose it, and a
        // rule enforced only in the page is not enforced at all — a stale tab or a repeated request
        // would walk straight past it.
        const ctx = await matchContext(bankLedger, company);
        const labels = await narrationLabels(company);

        const created = [], failed = [], duplicates = [];
        for (const it of items) {
            const t = {
                date: String(it.date || ''), narration: String(it.narration || ''),
                reference: String(it.reference || ''),
                withdrawal: Number(it.withdrawal) || 0, deposit: Number(it.deposit) || 0,
            };
            const ledger = String(it.ledger || '').trim();
            const label = `${t.date} ${(t.narration || '').slice(0, 40)}`;

            if (!ledger) { failed.push({ label, error: 'no ledger chosen' }); continue; }

            // Under 80% and nobody confirmed it — refuse. Booking a guess into real books is worse than
            // leaving the line unmapped, and it stays in the pending pile to be looked at.
            if (!it.confirmed) {
                const sg = M.suggestLedger(t.narration, ctx);
                if (sg && sg.ledger === ledger && sg.confidence < CONFIDENT) {
                    failed.push({ label, error: `only ${Math.round(sg.confidence * 100)}% sure of "${ledger}" — confirm it on screen before it can become a draft` });
                    continue;
                }
            }
            if (!known.has(ledger)) { failed.push({ label, error: `ledger "${ledger}" does not exist in Tally` }); continue; }
            if (ledger === bankLedger) { failed.push({ label, error: 'cannot book the bank against itself' }); continue; }
            if (booksFrom && t.date < booksFrom) {
                failed.push({ label, error: `dated ${t.date}, before this company's books begin (${booksFrom}) — Tally would reject it. Widen "Books beginning from" in Tally first.` });
                continue;
            }

            const hash = lineHash(bankLedger, t);
            // Claim the line FIRST. The unique index is what actually prevents a double import — a
            // check-then-insert would still race two operators clicking Import at the same moment.
            const { error: claimErr } = await supabase.from('tally_bank_lines_ecom').insert({
                line_hash: hash, company, bank_ledger: bankLedger, txn_date: t.date,
                narration: t.narration, reference: t.reference || null,
                withdrawal: t.withdrawal, deposit: t.deposit,
                balance: it.balance == null ? null : Number(it.balance),
                ledger, source_file: filename, imported_by: user,
            });
            if (claimErr) {
                if (String(claimErr.message || '').match(/duplicate|unique/i)) duplicates.push({ label });
                else failed.push({ label, error: claimErr.message });
                continue;
            }

            const entries = M.entriesFor(t, ledger, bankLedger);
            const voucherType = M.voucherFor(t);
            const narration = labelNarration(labels, ledger, voucherType, t.narration);
            const check = T.validateVoucher({ voucherType, date: t.date, company, partyLedger: ledger, entries }, known);
            if (!check.ok) {
                await supabase.from('tally_bank_lines_ecom').delete().eq('line_hash', hash);   // release the claim
                failed.push({ label, error: check.errors[0] });
                continue;
            }

            const { data: v, error: vErr } = await supabase.from('tally_vouchers_ecom').insert({
                voucher_type: voucherType, voucher_date: t.date, company,
                party_ledger: ledger, reference: t.reference || null, narration,
                entries, total_amount: Number(T.fmtAmount(check.totalPaise)),
                status: 'draft', created_by: user,
                source: 'bank-statement', source_ref: hash.slice(0, 16),
            }).select('id').single();
            if (vErr) {
                await supabase.from('tally_bank_lines_ecom').delete().eq('line_hash', hash);
                failed.push({ label, error: vErr.message });
                continue;
            }
            await supabase.from('tally_bank_lines_ecom').update({ voucher_id: v.id }).eq('line_hash', hash);
            // It is booked now, so it is no longer waiting to be mapped.
            await supabase.from('tally_bank_pending_ecom').delete().eq('line_hash', hash);
            created.push({ id: v.id, label, ledger });

            // Remember the mapping so this narration shape is never asked about again.
            // Learn from the ORIGINAL bank wording — the label is ours, and matching on it would teach
            // the matcher a pattern that never appears in a real statement.
            if (learn && t.narration) {
                const pattern = M.signature(t.narration);
                if (pattern && pattern.length > 4) {
                    const { error: rErr } = await supabase.from('tally_bank_rules_ecom')
                        .upsert({ bank_ledger: bankLedger, pattern, ledger, direction: 'any',
                                  company, created_by: user, updated_at: new Date().toISOString() },
                                { onConflict: 'bank_ledger,pattern,direction' });
                    if (rErr) console.error('[TallyBank] rule upsert:', rErr.message);
                }
            }
        }

        console.log(`[TallyBank] import by ${user}: ${created.length} drafts, ${duplicates.length} dupes, ${failed.length} failed`);
        res.json({ success: true, created: created.length, duplicates: duplicates.length,
                   failed: failed.length, failures: failed.slice(0, 30), duplicateLabels: duplicates.slice(0, 10) });
    } catch (e) { console.error('[TallyBank] import:', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ── learned rules: list / delete ─────────────────────────────────────────────────────────────────
router.get('/tally/bank/rules', async (req, res) => {
    try {
        const { data, error } = await supabase.from('tally_bank_rules_ecom')
            .select('*').order('updated_at', { ascending: false }).limit(500);
        if (error) throw new Error(error.message);
        res.json({ success: true, rows: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/tally/bank/rules/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('tally_bank_rules_ecom').delete().eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, returnToPending, narrationLabels, labelNarration, parseWorkbook, findColumns, toIsoDate, lineHash, checkRunningBalance, matchContext };
