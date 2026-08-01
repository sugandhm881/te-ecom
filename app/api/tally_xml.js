// ─────────────────────────────────────────────────────────────────────────────
// Tally Prime XML engine — builds the request envelopes and parses the replies for the
// Finance → Data Entry dashboard. PURE functions only (no network, no DB), so the whole thing can be
// exercised offline and against a test company before anything touches the live books.
//
// Tally speaks XML over plain HTTP (Gateway of Tally → F1 → Advanced Config → ODBC/HTTP, port 9000).
// Four things about it are load-bearing and easy to get wrong:
//
//   1. Tally answers HTTP 200 even when the import completely failed. Success is CREATED>=1 AND no
//      LINEERROR — never the status code. This is the #1 way Tally integrations silently lose vouchers.
//   2. Dr/Cr is expressed by SIGN, not by a field: a debit is ISDEEMEDPOSITIVE=Yes with a NEGATIVE
//      AMOUNT; a credit is ISDEEMEDPOSITIVE=No with a POSITIVE amount. Get it backwards and the
//      voucher posts inverted — Tally accepts it happily.
//   3. Dates are YYYYMMDD in the company's own calendar. Deriving them via toISOString() shifts IST
//      back 5.5 h and books the voucher to the PREVIOUS day. Always format in Asia/Kolkata.
//   4. An ALLLEDGERENTRIES row naming a ledger that doesn't exist does NOT error — Tally auto-creates
//      the ledger (under Suspense). So callers MUST validate names against the mirrored masters first;
//      buildVoucherXml deliberately has no way to create a master.
// ─────────────────────────────────────────────────────────────────────────────

// ── escaping ─────────────────────────────────────────────────────────────────────────────────────
// Tally's parser is strict about the five XML entities and chokes on raw control characters (it uses
// \x04 internally as a field separator), so strip those rather than pass them through.
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Reverse of esc() for reading Tally's output. Tally emits &#4; between the lines of multi-line
// fields (e.g. addresses); collapse those to newlines rather than leaving a stray control char.
function unesc(s) {
    return String(s == null ? '' : s)
        .replace(/&#4;/g, '\n')
        .replace(/&#(\d+);/g, (_, d) => { const c = Number(d); return c >= 32 ? String.fromCharCode(c) : ''; })
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c >= 32 ? String.fromCharCode(c) : ''; })
        .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');   // last, so "&amp;lt;" doesn't double-decode
}

// ── dates ────────────────────────────────────────────────────────────────────────────────────────
// YYYYMMDD in IST. Accepts a Date, a 'YYYY-MM-DD' string, or 'DD-MM-YYYY' (the shape /get-orders
// returns, which new Date() cannot parse). Never round-trips through toISOString().
function tallyDate(d) {
    if (d instanceof Date) return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/-/g, '');
    const s = String(d || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);           if (m) return m[1] + m[2] + m[3];
    m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);              if (m) return m[3] + m[2] + m[1];
    m = s.match(/^(\d{8})$/);                              if (m) return m[1];
    throw new Error(`Unrecognised date for Tally: "${d}" (expected YYYY-MM-DD)`);
}

// ── money ────────────────────────────────────────────────────────────────────────────────────────
// Compare and total in integer paise. Float rupees make a balanced voucher fail the Dr==Cr check by
// 0.01 for perfectly ordinary numbers (0.1 + 0.2 !== 0.3).
const toPaise = (n) => Math.round(Number(n) * 100);
const fmtAmount = (paise) => (paise / 100).toFixed(2);

// Voucher types this module can build. Accounting-only (their Tally has a single stock item, so no
// inventory lines are involved). Sales/Purchase/Credit Note/Debit Note are ledger-level too — the GST
// rows are ordinary ledger entries against OUTPUT CGST/SGST/IGST.
const VOUCHER_TYPES = ['Payment', 'Receipt', 'Journal', 'Contra', 'Sales', 'Purchase', 'Credit Note', 'Debit Note'];

// ── validation ───────────────────────────────────────────────────────────────────────────────────
// Runs BEFORE any XML exists. `knownLedgers` is a Set of names from tally_masters_ecom; pass it and
// every ledger is whitelisted (see note 4 above). Returns { ok, errors[], totalPaise }.
function validateVoucher(v, knownLedgers) {
    const errors = [];
    if (!VOUCHER_TYPES.includes(v.voucherType)) errors.push(`Unsupported voucher type "${v.voucherType}"`);
    if (!v.company) errors.push('Company is required');
    try { tallyDate(v.date); } catch (e) { errors.push(e.message); }

    const entries = Array.isArray(v.entries) ? v.entries : [];
    if (entries.length < 2) errors.push('A voucher needs at least two ledger entries (one Dr, one Cr)');

    let drPaise = 0, crPaise = 0;
    entries.forEach((e, i) => {
        const at = `Row ${i + 1}`;
        if (!e.ledger) errors.push(`${at}: ledger is required`);
        else if (knownLedgers && !knownLedgers.has(e.ledger))
            // Refuse rather than let Tally invent the ledger under Suspense.
            errors.push(`${at}: ledger "${e.ledger}" does not exist in Tally — sync masters or fix the name`);
        const dc = String(e.dr_cr || '').toUpperCase();
        if (dc !== 'DR' && dc !== 'CR') errors.push(`${at}: dr_cr must be DR or CR`);
        const p = toPaise(e.amount);
        if (!Number.isFinite(p) || p <= 0) errors.push(`${at}: amount must be a positive number`);
        else if (dc === 'DR') drPaise += p; else if (dc === 'CR') crPaise += p;
    });

    if (!errors.length && drPaise !== crPaise)
        errors.push(`Voucher is unbalanced — Dr ${fmtAmount(drPaise)} vs Cr ${fmtAmount(crPaise)} (difference ${fmtAmount(Math.abs(drPaise - crPaise))})`);

    if (v.partyLedger && knownLedgers && !knownLedgers.has(v.partyLedger))
        errors.push(`Party ledger "${v.partyLedger}" does not exist in Tally`);

    return { ok: errors.length === 0, errors, totalPaise: drPaise };
}

// ── build: Import Data (create one voucher) ──────────────────────────────────────────────────────
// Deliberately omits VOUCHERNUMBER so Tally applies its own numbering (all 24 voucher types in this
// company use "Default" numbering). Pass opts.voucherNumber only for a manually-numbered series.
//
// v.optional=true marks it an OPTIONAL voucher — Tally records it in the Day Book but excludes it
// from every financial statement (P&L, balance sheet, ledger balances, GST returns) until a human
// marks it regular in Tally. That makes it the correct way to rehearse the write path against real
// books: the round-trip is genuine, the accounts are untouched.
function buildVoucherXml(v) {
    const { ok, errors } = validateVoucher(v, v.knownLedgers);
    if (!ok) throw new Error('Refusing to build XML — ' + errors.join('; '));

    const date = tallyDate(v.date);
    const rows = v.entries.map(e => {
        const isDr = String(e.dr_cr).toUpperCase() === 'DR';
        // Sign convention (note 2): Dr → deemed-positive Yes + negative amount; Cr → No + positive.
        const amt = fmtAmount(isDr ? -toPaise(e.amount) : toPaise(e.amount));
        // Bill-wise allocation — only meaningful on Sundry Debtors/Creditors ledgers that have it
        // enabled. Without it a Payment/Receipt lands "on account" and never settles the invoice.
        const bill = e.bill_ref ? `
       <BILLALLOCATIONS.LIST>
        <NAME>${esc(e.bill_ref)}</NAME>
        <BILLTYPE>${esc(e.bill_type || 'Agst Ref')}</BILLTYPE>
        <AMOUNT>${amt}</AMOUNT>
       </BILLALLOCATIONS.LIST>` : '';
        return `
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>${isDr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
       <LEDGERFROMITEM>No</LEDGERFROMITEM>
       <ISPARTYLEDGER>${v.partyLedger && e.ledger === v.partyLedger ? 'Yes' : 'No'}</ISPARTYLEDGER>
       <AMOUNT>${amt}</AMOUNT>${bill}
      </ALLLEDGERENTRIES.LIST>`;
    }).join('');

    return `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${esc(v.company)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="${esc(v.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${date}</DATE>
      <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>${esc(v.voucherType)}</VOUCHERTYPENAME>${v.voucherNumber ? `
      <VOUCHERNUMBER>${esc(v.voucherNumber)}</VOUCHERNUMBER>` : ''}${v.partyLedger ? `
      <PARTYLEDGERNAME>${esc(v.partyLedger)}</PARTYLEDGERNAME>` : ''}${v.reference ? `
      <REFERENCE>${esc(v.reference)}</REFERENCE>
      <REFERENCEDATE>${date}</REFERENCEDATE>` : ''}
      <NARRATION>${esc(v.narration)}</NARRATION>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
      <ISINVOICE>No</ISINVOICE>
      <HASCASHFLOW>No</HASCASHFLOW>
      <ISCANCELLED>No</ISCANCELLED>
      <ISOPTIONAL>${v.optional ? 'Yes' : 'No'}</ISOPTIONAL>${rows}
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}

// ── parse: the reply to an Import Data ───────────────────────────────────────────────────────────
// Two shapes come back. Happy path is <RESPONSE><CREATED>1</CREATED>…; a rejected import instead
// returns HEADER/STATUS 0 with a <LINEERROR> in the body. Both arrive as HTTP 200 (note 1), so this
// is the only place that decides success.
function parseImportResponse(xml) {
    const raw = String(xml || '');
    const num = (tag) => { const m = raw.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, 'i')); return m ? parseInt(m[1], 10) : 0; };
    const lineErrors = [...raw.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map(m => unesc(m[1]).trim()).filter(Boolean);

    const created = num('CREATED'), altered = num('ALTERED'), ignored = num('IGNORED');
    const errCount = num('ERRORS'), exceptions = num('EXCEPTIONS'), cancelled = num('CANCELLED');
    const lastVchId = num('LASTVCHID') || null;

    const ok = created + altered > 0 && lineErrors.length === 0 && errCount === 0 && exceptions === 0;
    let error = null;
    if (!ok) {
        if (lineErrors.length) error = lineErrors.join(' | ');
        else if (!raw.trim()) error = 'Tally returned an empty response (is the company open and the Gateway on?)';
        else if (created + altered === 0) error = `Tally accepted the request but created nothing (ignored ${ignored}, errors ${errCount}). Check the company name and that all ledgers exist.`;
        else error = `Tally reported ${errCount} error(s) / ${exceptions} exception(s)`;
    }
    return { ok, created, altered, ignored, cancelled, errors: errCount, exceptions, lineErrors, lastVchId, error, raw };
}

// ── build: master export (Collection request) ───────────────────────────────────────────────────
// One request per kind. ISINITIALIZE=Yes makes Tally build the collection fresh instead of reusing a
// cached one, and NATIVEMETHOD names the fields to include — asking for fewer keeps the reply small.
const MASTER_SPECS = {
    ledger:       { type: 'Ledger',      methods: ['Parent', 'IsBillWiseOn', 'GSTApplicable', 'OpeningBalance'] },
    group:        { type: 'Group',       methods: ['Parent'] },
    voucher_type: { type: 'VoucherType', methods: ['Parent', 'NumberingMethod'] },
    stock_item:   { type: 'StockItem',   methods: ['Parent', 'BaseUnits'] },
    cost_centre:  { type: 'CostCentre',  methods: ['Parent'] },
};

function buildMastersRequest(kind, company) {
    const spec = MASTER_SPECS[kind];
    if (!spec) throw new Error(`Unknown master kind "${kind}"`);
    const id = `EcomCentral${spec.type}List`;
    return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>${id}</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="${id}" ISINITIALIZE="Yes">
      <TYPE>${spec.type}</TYPE>
${spec.methods.map(m => `      <NATIVEMETHOD>${m}</NATIVEMETHOD>`).join('\n')}
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

// Parse a Collection reply into [{name, parent, is_billwise, meta}]. Regex rather than a DOM: Tally's
// collection output is flat and predictable, and this keeps the project dependency-free.
//
// The name lives in the element's NAME *attribute* (<LEDGER NAME="Cash" RESERVEDNAME="">), while the
// requested fields are child elements — some of which are also called NAME, which is exactly why an
// XPath-ish `.NAME` lookup on this data returns the attribute and silently hides the child.
function parseMasters(xml, kind) {
    const spec = MASTER_SPECS[kind];
    if (!spec) throw new Error(`Unknown master kind "${kind}"`);
    const tag = spec.type.toUpperCase();
    const raw = String(xml || '');
    const out = [];

    const blockRx = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    for (const m of raw.matchAll(blockRx)) {
        const attrs = m[1], body = m[2];
        const nameAttr = attrs.match(/\bNAME\s*=\s*"([^"]*)"/i);
        const name = unesc(nameAttr ? nameAttr[1] : '').trim();
        if (!name) continue;

        const child = (t) => {
            const c = body.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i'));
            return c ? unesc(c[1]).trim() : null;
        };
        const yes = (t) => /^yes$/i.test(String(child(t) || ''));

        const meta = {};
        for (const method of spec.methods) {
            const val = child(method.toUpperCase());
            if (val != null && val !== '') meta[method] = val;
        }
        out.push({
            name,
            parent: child('PARENT'),
            is_billwise: kind === 'ledger' ? yes('ISBILLWISEON') : false,
            meta: Object.keys(meta).length ? meta : null,
        });
    }
    // Tally can repeat a master across sub-collections; keep the first of each name.
    const seen = new Set();
    return out.filter(r => (seen.has(r.name) ? false : (seen.add(r.name), true)));
}

// ═════════ READ-ONLY BOOKS: what is ALREADY in Tally (Trial Balance + Day Book) ═════════
// These only ever Export/Collection — they cannot alter anything.
//
// ⚠️ Sign convention for balances is the SAME as for voucher amounts (note 2 above), which is the
// opposite of what most people expect: **negative = DEBIT, positive = CREDIT.** Verified against this
// company's own books, using two account types whose natural side is unambiguous:
//     CENTRAL SALE B2C 18%  (Sales Accounts)    = +1,701,163.84  → Sales is a credit  → positive = Cr
//     ADVERTISEMENT EXPENSE (Indirect Expenses) = -1,198,616.05  → Expense is a debit → negative = Dr
// The real proof is that total Dr must equal total Cr; `trialBalanceTotals` asserts exactly that.

// Small helper: pull a child element's text out of one XML block (Tally wraps values in
// <TAG TYPE="Amount">…</TAG>, so a plain attribute/property lookup gets the wrong thing).
function childText(block, tag) {
    const m = String(block || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? unesc(m[1]).trim() : null;
}
const _num = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const _yes = (s) => /^yes$/i.test(String(s || ''));

// ── Company info: books-from + the active period. Drives the financial-year picker. ──────────────
// NOTE the CMPINFO trap again — a reply also contains a bare <COMPANY>0</COMPANY> counter, so only
// COMPANY elements carrying attributes are real.
function buildCompanyInfoRequest() {
    return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>EcomCentralCompanyInfo</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="EcomCentralCompanyInfo" ISINITIALIZE="Yes">
      <TYPE>Company</TYPE>
      <NATIVEMETHOD>StartingFrom</NATIVEMETHOD>
      <NATIVEMETHOD>EndingAt</NATIVEMETHOD>
      <NATIVEMETHOD>BooksFrom</NATIVEMETHOD>
      <NATIVEMETHOD>StateName</NATIVEMETHOD>
      <NATIVEMETHOD>GSTRegistrationNumber</NATIVEMETHOD>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

// `want` names which company's info to return. Tally's reply lists EVERY open company, so taking the
// first block is only safe with one set of books — with two, it silently returns the wrong company's
// books-begin date, which then mis-decides whether a voucher is inside the accounting period.
function parseCompanyInfo(xml, want) {
    // `<COMPANY ` with a space → has attributes → a real company, not the CMPINFO counter.
    const blocks = [...String(xml || '').matchAll(/<COMPANY\s+[^>]*>([\s\S]*?)<\/COMPANY>/gi)];
    if (!blocks.length) return null;
    const nameOf = (b) => unesc((b[0].match(/\bNAME\s*=\s*"([^"]*)"/i) || [])[1] || '').trim();
    let m = blocks[0];
    if (want) {
        const target = String(want).trim().toUpperCase();
        const hit = blocks.find(b => nameOf(b).toUpperCase() === target);
        if (!hit) return null;      // asked for a company Tally does not have open — say so, don't substitute
        m = hit;
    }
    const nameAttr = m[0].match(/\bNAME\s*=\s*"([^"]*)"/i);
    return {
        name: unesc(nameAttr ? nameAttr[1] : '').trim(),
        booksFrom: tallyDateToIso(childText(m[1], 'BOOKSFROM')),
        periodFrom: tallyDateToIso(childText(m[1], 'STARTINGFROM')),
        periodTo: tallyDateToIso(childText(m[1], 'ENDINGAT')),
        state: childText(m[1], 'STATENAME'),
        gstin: childText(m[1], 'GSTREGISTRATIONNUMBER'),
    };
}

// Indian financial years (1 Apr → 31 Mar) from the books-start year up to the current one, newest
// first. `todayIso` must already be an IST calendar date.
function financialYears(booksFromIso, todayIso) {
    const startY = booksFromIso ? Number(String(booksFromIso).slice(0, 4)) -
        (Number(String(booksFromIso).slice(5, 7)) < 4 ? 1 : 0) : null;
    const y = Number(String(todayIso).slice(0, 4)), m = Number(String(todayIso).slice(5, 7));
    const curY = m >= 4 ? y : y - 1;
    const first = startY == null ? curY : Math.min(startY, curY);
    const out = [];
    for (let f = curY; f >= first; f--) {
        const from = `${f}-04-01`, to = `${f + 1}-03-31`;
        out.push({ key: `${f}-${String((f + 1) % 100).padStart(2, '0')}`, from, to,
                   label: `FY ${f}-${String((f + 1) % 100).padStart(2, '0')}`,
                   current: f === curY,
                   // Don't ask Tally for dates that haven't happened yet.
                   toEffective: to > todayIso ? todayIso : to });
    }
    return out;
}

// ── Trial balance: every ledger with its opening + closing balance ───────────────────────────────
// Passing fromDate makes Tally scope OpeningBalance to that period (so a ledger statement's opening is
// the balance brought forward, not the all-time opening).
function buildTrialBalanceRequest(company, toDate, fromDate) {
    return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>EcomCentralTrialBalance</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>${fromDate ? `
    <SVFROMDATE TYPE="Date">${tallyDate(fromDate)}</SVFROMDATE>` : ''}${toDate ? `
    <SVTODATE TYPE="Date">${tallyDate(toDate)}</SVTODATE>` : ''}
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="EcomCentralTrialBalance" ISINITIALIZE="Yes">
      <TYPE>Ledger</TYPE>
      <NATIVEMETHOD>Parent</NATIVEMETHOD>
      <NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
      <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

// `Profit & Loss A/c` is not a posting ledger — Tally DERIVES its balance as the period's profit, and
// no voucher ever touches it. Summing it alongside the income/expense ledgers double-counts the same
// money, so it is flagged `derived` and left out of the totals (exactly as Tally's own Trial Balance
// report does). Verified on this company: no voucher line references it, yet it reports a balance.
const DERIVED_LEDGERS = new Set(['profit & loss a/c']);

// → [{name, parent, opening, closing, dr, cr, derived}] with dr/cr already split for display.
function parseTrialBalance(xml) {
    const out = [];
    for (const m of String(xml || '').matchAll(/<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER>/gi)) {
        const nameAttr = m[1].match(/\bNAME\s*=\s*"([^"]*)"/i);
        const name = unesc(nameAttr ? nameAttr[1] : '').trim();
        if (!name) continue;
        const closing = _num(childText(m[2], 'CLOSINGBALANCE'));
        out.push({
            name, parent: childText(m[2], 'PARENT'),
            opening: _num(childText(m[2], 'OPENINGBALANCE')),
            closing,
            dr: closing < 0 ? -closing : 0,   // negative closing = debit balance
            cr: closing > 0 ? closing : 0,
            derived: DERIVED_LEDGERS.has(name.toLowerCase()),
        });
    }
    const seen = new Set();
    return out.filter(r => (seen.has(r.name) ? false : (seen.add(r.name), true)));
}

// Grand totals, modelled on how Tally's own Trial Balance adds up:
//   • `derived` ledgers (P&L A/c) are excluded — see above.
//   • Opening balances that don't net to zero are surfaced as **Difference in Opening Balances**, the
//     same balancing line Tally shows. Here HDFC BANK carries a ₹4,73,597.23 opening debit with no
//     contra, so that figure appears on the credit side.
// With both handled, Dr must equal Cr to the paisa. If it doesn't, something is genuinely wrong and
// the UI says so rather than presenting a broken statement as fact.
function trialBalanceTotals(rows) {
    const posting = rows.filter(r => !r.derived);
    const drP = posting.reduce((s, r) => s + toPaise(r.dr), 0);
    const crP = posting.reduce((s, r) => s + toPaise(r.cr), 0);
    // Openings use Tally's sign (negative = debit); the balancing entry is its negation.
    const openDiffP = -posting.reduce((s, r) => s + toPaise(r.opening), 0);
    const openingDiff = {
        amount: Math.abs(openDiffP) / 100,
        side: openDiffP > 0 ? 'CR' : 'DR',     // net debit openings need a credit to balance
        present: openDiffP !== 0,
    };
    const totalDrP = drP + (openDiffP < 0 ? -openDiffP : 0);
    const totalCrP = crP + (openDiffP > 0 ? openDiffP : 0);
    return {
        dr: totalDrP / 100, cr: totalCrP / 100,
        ledgerDr: drP / 100, ledgerCr: crP / 100,
        openingDiff,
        derivedExcluded: rows.filter(r => r.derived).map(r => ({ name: r.name, dr: r.dr, cr: r.cr })),
        balanced: totalDrP === totalCrP,
        diff: Math.abs(totalDrP - totalCrP) / 100,
    };
}

// ── Day Book: vouchers already entered, over a date range ────────────────────────────────────────
// A Collection of Voucher honours SVFROMDATE/SVTODATE. (The stock `TYPE=Data / ID=DayBook` export
// does NOT — it ignored the range and returned only the current date, in ~43KB per voucher. FETCH
// keeps this to ~3KB each instead.)
function buildVouchersRequest(company, fromDate, toDate) {
    return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>EcomCentralVouchers</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
    <SVFROMDATE TYPE="Date">${tallyDate(fromDate)}</SVFROMDATE>
    <SVTODATE TYPE="Date">${tallyDate(toDate)}</SVTODATE>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="EcomCentralVouchers" ISINITIALIZE="Yes">
      <TYPE>Voucher</TYPE>
      <FETCH>Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Narration,Reference,Amount,IsOptional,IsCancelled,MasterID,AllLedgerEntries</FETCH>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

// 'YYYYMMDD' → 'YYYY-MM-DD' (no Date object involved, so no timezone can shift it).
const tallyDateToIso = (d) => {
    const m = String(d || '').match(/^(\d{4})(\d{2})(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

// → [{date, type, number, party, narration, reference, amount, optional, cancelled, masterId, entries[]}]
//
// ⚠️ Every Tally reply opens with a <CMPINFO> block that contains a **literal `<VOUCHER>0</VOUCHER>`
// counter element**. It matches `<VOUCHER\b…>` just like a real voucher, so without the DATE guard
// below it parses into a phantom row of nulls — which then poisons any date sort or type tally.
function parseVouchers(xml) {
    const out = [];
    for (const m of String(xml || '').matchAll(/<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi)) {
        const b = m[1];
        // A real voucher always carries a DATE. The CMPINFO counter never does.
        if (!childText(b, 'DATE')) continue;
        // Ledger lines, when Tally includes them. Same sign rule: negative amount = debit.
        const entries = [];
        for (const e of b.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/gi)) {
            const ledger = childText(e[1], 'LEDGERNAME');
            if (!ledger) continue;
            const amt = _num(childText(e[1], 'AMOUNT'));
            entries.push({ ledger, dr_cr: amt < 0 ? 'DR' : 'CR', amount: Math.abs(amt) });
        }
        // Voucher-level $Amount carries a sign that varies by type; the magnitude is what's meaningful.
        // Prefer the debit total of the lines when we have them — that IS the voucher value.
        const drTotal = entries.filter(x => x.dr_cr === 'DR').reduce((s, x) => s + x.amount, 0);
        const headAmt = Math.abs(_num(childText(b, 'AMOUNT')));
        // REMOTEID + VCHKEY live on the opening tag and are the ONLY reliable delete keys (MASTERID
        // alone is not enough). m[0] is the whole element, so read the attributes from there.
        const openTag = (m[0].match(/^<VOUCHER\b[^>]*>/i) || [''])[0];
        const attr = (a) => { const x = openTag.match(new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`, 'i')); return x ? unesc(x[1]) : null; };
        out.push({
            date: tallyDateToIso(childText(b, 'DATE')),
            type: childText(b, 'VOUCHERTYPENAME'),
            number: childText(b, 'VOUCHERNUMBER'),
            party: childText(b, 'PARTYLEDGERNAME'),
            narration: childText(b, 'NARRATION'),
            reference: childText(b, 'REFERENCE'),
            amount: drTotal > 0 ? drTotal : headAmt,
            optional: _yes(childText(b, 'ISOPTIONAL')),
            cancelled: _yes(childText(b, 'ISCANCELLED')),
            masterId: (childText(b, 'MASTERID') || '').trim() || null,
            alterId: (childText(b, 'ALTERID') || '').trim() || null,
            remoteId: attr('REMOTEID') || childText(b, 'GUID'),
            vchKey: attr('VCHKEY'),
            entries,
        });
    }
    return out;
}

// ── Ledger statement (Tally's "Ledger Vouchers" report) ──────────────────────────────────────────
// Built from vouchers we already hold rather than a fresh Tally call: each voucher carries its ledger
// lines, so the statement is a filter plus a running total. `opening` uses Tally's sign convention
// (negative = debit) and comes from the period-scoped trial balance.
function ledgerStatement(vouchers, ledgerName, opening) {
    let running = Number(opening) || 0;
    const rows = [];
    const inRange = vouchers
        .filter(v => v.date && !v.cancelled && v.entries.some(e => e.ledger === ledgerName))
        .sort((a, b) => (a.date || '').localeCompare(b.date || '') || Number(a.number || 0) - Number(b.number || 0));

    for (const v of inRange) {
        // A ledger can appear more than once in one voucher; net those lines into a single statement row.
        const signed = v.entries.filter(e => e.ledger === ledgerName)
            .reduce((s, e) => s + (e.dr_cr === 'DR' ? -e.amount : e.amount), 0);
        // An optional voucher shows in the statement (Tally lists it) but must NOT move the balance.
        if (!v.optional) running += signed;
        // The contra side — what the money went to/came from. This is the "Particulars" a human reads.
        const others = v.entries.filter(e => e.ledger !== ledgerName).map(e => e.ledger);
        rows.push({
            date: v.date, type: v.type, number: v.number, narration: v.narration, reference: v.reference,
            optional: v.optional,
            against: [...new Set(others)],
            dr: signed < 0 ? -signed : 0,
            cr: signed > 0 ? signed : 0,
            balance: running,
        });
    }
    const drTotal = rows.reduce((s, r) => s + (r.optional ? 0 : r.dr), 0);
    const crTotal = rows.reduce((s, r) => s + (r.optional ? 0 : r.cr), 0);
    return {
        ledger: ledgerName,
        opening: Number(opening) || 0,
        closing: running,
        drTotal, crTotal,
        count: rows.length,
        rows,
    };
}

// ── build: create ledgers (master import) ────────────────────────────────────────────────────────
// The danger this project guards against is Tally SILENTLY inventing a ledger under Suspense when a
// voucher names one that doesn't exist. Creating a ledger deliberately — with a group the operator
// chose — is the safe opposite of that, and it is the only way to open a fresh set of books without
// copying another company's chart of accounts.
//
// REPORTNAME is "All Masters" (not "Vouchers"), and the reply is a normal import response, so
// parseImportResponse reads it: CREATED counts the ledgers actually made.
// Delete ledger masters. Tally refuses while any voucher still refers to the ledger, which is the
// behaviour we want — it is the last line of defence against deleting an account that holds history.
function buildLedgerDeleteXml({ company, names }) {
    if (!company) throw new Error('Company is required to delete ledgers');
    const list = [...new Set((names || []).map(n => String(n || '').trim()).filter(Boolean))];
    if (!list.length) throw new Error('No ledgers to delete');
    const body = list.map(n => `
     <LEDGER NAME="${esc(n)}" ACTION="Delete">
      <NAME>${esc(n)}</NAME>
     </LEDGER>`).join('');

    return `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">${body}
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}

// Move existing ledgers to a different group. ACTION="Alter", matched on the NAME attribute.
//
// Only the fields being changed are sent, plus ISBILLWISEON. OPENINGBALANCE is deliberately NOT sent:
// Tally treats a supplied value as the new one, so including it would silently zero any opening balance
// the ledger already carries. Sending nothing leaves it alone.
function buildLedgerRegroupXml({ company, ledgers }) {
    if (!company) throw new Error('Company is required to alter ledgers');
    const list = (ledgers || []).filter(l => l && l.name && l.parent);
    if (!list.length) throw new Error('No ledgers to alter (each needs a name and the new parent group)');
    const seen = new Set();
    const body = list.map(l => {
        const key = String(l.name).trim().toUpperCase();
        if (seen.has(key)) return '';
        seen.add(key);
        return `
     <LEDGER NAME="${esc(l.name)}" ACTION="Alter">
      <NAME>${esc(l.newName || l.name)}</NAME>
      <PARENT>${esc(l.parent)}</PARENT>
      <ISBILLWISEON>${l.isBillwise ? 'Yes' : 'No'}</ISBILLWISEON>
     </LEDGER>`;
    }).join('');

    return `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">${body}
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}

// Create GROUP masters. Needed because a company's chart of accounts includes groups the accountant
// invented (INFLUENCER MARKETING EXPENSES, SALARY) — a ledger cannot be filed under one of those in a
// second company until the group itself exists there.
function buildGroupCreateXml({ company, groups }) {
    if (!company) throw new Error('Company is required to create groups');
    const list = (groups || []).filter(g => g && g.name && g.parent);
    if (!list.length) throw new Error('No groups to create (each needs a name and a parent group)');
    const seen = new Set();
    const body = list.map(g => {
        const key = String(g.name).trim().toUpperCase();
        if (seen.has(key)) return '';
        seen.add(key);
        return `
     <GROUP NAME="${esc(g.name)}" ACTION="Create">
      <NAME>${esc(g.name)}</NAME>
      <PARENT>${esc(g.parent)}</PARENT>
     </GROUP>`;
    }).join('');

    return `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">${body}
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}

function buildLedgerCreateXml({ company, ledgers }) {
    if (!company) throw new Error('Company is required to create ledgers');
    const list = (ledgers || []).filter(l => l && l.name && l.parent);
    if (!list.length) throw new Error('No ledgers to create (each needs a name and a parent group)');
    const seen = new Set();
    const body = list.map(l => {
        const key = String(l.name).trim().toUpperCase();
        if (seen.has(key)) return '';           // Tally errors on a duplicate inside one message
        seen.add(key);
        return `
     <LEDGER NAME="${esc(l.name)}" ACTION="Create">
      <NAME>${esc(l.name)}</NAME>
      <PARENT>${esc(l.parent)}</PARENT>
      <ISBILLWISEON>${l.isBillwise ? 'Yes' : 'No'}</ISBILLWISEON>
      <AFFECTSSTOCK>No</AFFECTSSTOCK>
      <ISCOSTCENTRESON>No</ISCOSTCENTRESON>
      <OPENINGBALANCE>0</OPENINGBALANCE>
     </LEDGER>`;
    }).join('');

    return `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">${body}
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}

// ── build: delete a voucher (ACTION="Delete") ────────────────────────────────────────────────────
// Tally identifies the target by REMOTEID (its GUID) plus VCHKEY. MASTERID alone is NOT enough for a
// delete, which is why parseVouchers captures all three. The reply reports <DELETED>1</DELETED>.
// This is the only destructive request this module can build; it takes explicit keys and can never be
// derived from a name or an amount, so it cannot delete "the wrong voucher that looked similar".
function buildDeleteVoucherXml({ company, remoteId, vchKey, voucherType, date, voucherNumber }) {
    if (!company) throw new Error('Company is required to delete a voucher');
    if (!remoteId || !vchKey) throw new Error('Refusing to build a delete without both REMOTEID and VCHKEY — Tally cannot target the voucher reliably without them');
    if (!voucherType) throw new Error('Voucher type is required to delete a voucher');
    return `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER REMOTEID="${esc(remoteId)}" VCHKEY="${esc(vchKey)}" VCHTYPE="${esc(voucherType)}" ACTION="Delete">
      <DATE>${tallyDate(date)}</DATE>
      <VOUCHERTYPENAME>${esc(voucherType)}</VOUCHERTYPENAME>${voucherNumber ? `
      <VOUCHERNUMBER>${esc(voucherNumber)}</VOUCHERNUMBER>` : ''}
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}

// A delete succeeds only when Tally says DELETED>=1. Reusing parseImportResponse would wrongly read a
// delete as a failure, since nothing was CREATED.
function parseDeleteResponse(xml) {
    const raw = String(xml || '');
    const num = (t) => { const m = raw.match(new RegExp(`<${t}>\\s*(-?\\d+)\\s*</${t}>`, 'i')); return m ? parseInt(m[1], 10) : 0; };
    const lineErrors = [...raw.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map(m => unesc(m[1]).trim()).filter(Boolean);
    const deleted = num('DELETED'), errs = num('ERRORS'), exceptions = num('EXCEPTIONS');
    const ok = deleted > 0 && !lineErrors.length && errs === 0 && exceptions === 0;
    let error = null;
    if (!ok) {
        if (lineErrors.length) error = lineErrors.join(' | ');
        else if (!raw.trim()) error = 'Tally returned an empty response';
        else if (deleted === 0) error = 'Tally did not delete anything — the voucher may already be gone, or the company/period does not match.';
        else error = `Tally reported ${errs} error(s) / ${exceptions} exception(s)`;
    }
    return { ok, deleted, errors: errs, exceptions, lineErrors, error, raw };
}

// ── build: list the companies loaded in Tally (used by the connection check) ─────────────────────
function buildCompanyListRequest() {
    return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>EcomCentralCompanyList</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="EcomCentralCompanyList" ISINITIALIZE="Yes">
      <TYPE>Company</TYPE>
      <NATIVEMETHOD>Name</NATIVEMETHOD>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

function parseCompanyList(xml) {
    return [...String(xml || '').matchAll(/<COMPANY\b[^>]*\bNAME\s*=\s*"([^"]*)"/gi)]
        .map(m => unesc(m[1]).trim()).filter(Boolean)
        .filter((n, i, a) => a.indexOf(n) === i);
}

// Short, stable marker stamped into REFERENCE so a retry after a lost acknowledgement can ask Tally
// "did this already land?" instead of blindly creating the voucher twice.
const refMarker = (id) => 'ECOM-' + String(id).replace(/-/g, '').slice(0, 8).toUpperCase();

module.exports = {
    buildGroupCreateXml,
    buildLedgerRegroupXml,
    buildLedgerDeleteXml,
    esc, unesc, tallyDate, tallyDateToIso, toPaise, fmtAmount,
    VOUCHER_TYPES, MASTER_SPECS,
    validateVoucher, buildVoucherXml, parseImportResponse,
    buildMastersRequest, parseMasters,
    buildCompanyListRequest, parseCompanyList,
    buildTrialBalanceRequest, parseTrialBalance, trialBalanceTotals,
    buildVouchersRequest, parseVouchers,
    buildCompanyInfoRequest, parseCompanyInfo, financialYears,
    ledgerStatement,
    buildDeleteVoucherXml, parseDeleteResponse,
    buildLedgerCreateXml,
    refMarker,
};
