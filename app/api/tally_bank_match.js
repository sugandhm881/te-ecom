// ─────────────────────────────────────────────────────────────────────────────
// Bank statement → Tally ledger matcher.
//
// Given a bank narration, work out which ledger the transaction should be booked against, by learning
// from how the SAME books have been written up before. Pure functions, no I/O, so the accuracy can be
// measured against real history (see the leave-one-out validation in the tests).
//
// Why learning beats name-matching: this company's own books contain
//     "NEFT CR-DEUT0797BGL-INTERNAL AC FOR INTERMEDIERY-"  →  AMAZON SELLER SERVICES PVT. LIMITED - HR
// Nothing in that text says Amazon. No amount of clever parsing gets there; only prior bookings do.
//
// Ranked strategies, best first — every suggestion carries its confidence AND the reason, so the
// operator can see WHY, rather than trusting a black box with their books:
//   1. learned rule      — an operator previously corrected this exact signature   (1.00)
//   2. seen before       — the same normalised narration exists in history         (0.95)
//   3. strong history    — distinctive tokens overwhelmingly point one way         (0.70–0.90)
//   4. exact party name  — the name in the narration IS a ledger name              (0.80)
//   5. fuzzy party name  — near-miss, e.g. "RANJNA ARYA" vs ledger "RANHJANA ARYA" (0.55–0.75)
//   6. nothing           — say so. A wrong guess in accounting is worse than none.
// ─────────────────────────────────────────────────────────────────────────────

// ── normalisation ────────────────────────────────────────────────────────────────────────────────
// A narration's "signature": the stable part, with everything transaction-specific stripped. Two
// payments to the same person on different days must produce the SAME signature or nothing can be
// learned from history.
function signature(narration) {
    let s = String(narration || '').toUpperCase();
    s = s.replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' ');   // dates
    s = s.replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, ' ');            // IFSC codes (HDFC0001414)
    s = s.replace(/\b[A-Z0-9]*\d{6,}[A-Z0-9]*\b/g, ' ');        // txn refs / account numbers
    s = s.replace(/\bX{3,}\b/g, ' ');                            // masked account numbers
    // Channel/branch noise that varies per transaction but means nothing.
    s = s.replace(/\b(NETBANK|MUM|NET BANKING|NETBANKING|INB|RTGS|TPT|COLLECTION)\b/g, ' ');
    // Drop every token that still contains a digit. Tally truncates narrations at ~50 chars, which
    // leaves partial refs like "HDFCH00" that the \d{6,} rule above cannot catch — and a fragment
    // shared by almost every NEFT row is pure noise that swamps the real signal.
    s = s.split(/[^A-Z0-9]+/).filter(w => w && !/\d/.test(w) && w.length > 1).join(' ');
    return s.trim();
}

// Squash a name for comparison: bank statements run words together ("ANANDITASHARMA") while the
// ledger has spaces ("ANANDITA SHARMA"), and punctuation differs ("PVT. LIMITED" vs "PVT LTD").
const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Words that carry no identifying signal — excluded from token scoring so two unrelated NEFT payments
// don't look similar just because both say "NEFT".
const STOP = new Set(['NEFT', 'IMPS', 'DR', 'CR', 'UPI', 'ACH', 'SI', 'CHQ', 'PAID', 'TO', 'FROM',
    'AC', 'A', 'C', 'THE', 'AND', 'PVT', 'LTD', 'LIMITED', 'PRIVATE', 'INDIA', 'BANK', 'TRANSFER',
    'PAYMENT', 'REF', 'NO', 'FOR', 'OF', 'BY', 'VIA', 'INTERNAL', 'ACCOUNT']);

const tokens = (s) => signature(s).split(' ').filter(w => w.length > 2 && !STOP.has(w));

// ── party extraction ─────────────────────────────────────────────────────────────────────────────
// Pull the likely counterparty out of the common Indian bank narration shapes:
//   NEFT DR-<IFSC>-<NAME>-NETBANK,MUM-<ref>      → NAME
//   IMPS-<ref>-<NAME>-<BANK>-<ref>               → NAME
//   <accountno>-TPT-<PURPOSE>-<NAME>             → NAME  (purpose is often SALARY / GST FILLINGS)
//   <ref>/RAZP<MERCHANT>                         → MERCHANT
function extractParty(narration) {
    const raw = String(narration || '').toUpperCase().trim();
    const out = [];

    let m = raw.match(/\b(?:NEFT|RTGS)\s*(?:DR|CR)?[-\s]+[A-Z]{4}0[A-Z0-9]{6}[-\s]+([^-]+?)(?:[-,]|$)/);
    if (m) out.push(m[1]);

    m = raw.match(/\bIMPS[-\s]*\d+[-\s]+([^-]+?)(?:[-,]|$)/);
    if (m) out.push(m[1]);

    // ...-TPT-<PURPOSE>-<NAME>: PURPOSE first, then the person. Order decides ties, and this company
    // books to the expense head whenever one exists: "TPT-PROFESSIONAL FEES-ANAND KUMAR" goes to
    // PROFESSIONAL FEES, while "TPT-SALARY-ANSARUL ALI" goes to the person — because SALARY is a
    // GROUP, not a ledger, so it never matches and the person wins on its own merit.
    m = raw.match(/\bTPT[-\s]+([^-]+?)[-\s]+([^-]+?)\s*$/);
    if (m) { out.push(m[1]); out.push(m[2]); }
    else { const m2 = raw.match(/\bTPT[-\s]+([^-]+?)\s*$/); if (m2) out.push(m2[1]); }

    // UPI-<NAME>-<vpa>@<psp>-... — the payee name sits between the tag and the VPA.
    m = raw.match(/\bUPI[-\s]+([^-@]+?)(?:[-@]|$)/);
    if (m) out.push(m[1]);

    m = raw.match(/RAZP([A-Z]+)/);              // Razorpay merchant tag
    if (m) out.push(m[1]);

    // Fallback: the longest alphabetic run, which is usually the name.
    const words = raw.replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
    if (words.length) out.push(words.join(' '));

    return out.map(x => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// ── fuzzy comparison ─────────────────────────────────────────────────────────────────────────────
function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length || !b.length) return Math.max(a.length, b.length);
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}
// 1 = identical, 0 = nothing in common.
function similarity(a, b) {
    const x = squash(a), y = squash(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    // One containing the other is a strong signal: "HARSHITHAK" vs ledger "HARSHITHA".
    if (x.length >= 5 && y.length >= 5 && (x.includes(y) || y.includes(x)))
        return 0.9 - Math.abs(x.length - y.length) / Math.max(x.length, y.length) * 0.3;
    const d = levenshtein(x, y);
    return Math.max(0, 1 - d / Math.max(x.length, y.length));
}

// ── the matcher ──────────────────────────────────────────────────────────────────────────────────
// history : [{ narration, ledger, type }]  — past bank vouchers from this company's own books
// ledgers : [{ name, parent }]             — the live chart of accounts
// rules   : [{ pattern, ledger }]          — operator corrections, pattern = a signature
function suggestLedger(narration, { history = [], ledgers = [], rules = [], bankLedger = 'HDFC BANK' } = {}) {
    const sig = signature(narration);
    if (!sig) return null;
    const known = new Set(ledgers.map(l => l.name));
    const ok = (name) => name && known.has(name) && name !== bankLedger;
    const cands = [];

    // 1. an operator taught us this one — always wins
    for (const r of rules) {
        if (!r || !r.pattern) continue;
        if (r.pattern === sig || (sig.includes(r.pattern) && r.pattern.length > 6)) {
            if (ok(r.ledger)) return { ledger: r.ledger, confidence: 1, reason: 'you mapped this before', method: 'rule' };
        }
    }

    // 2. the exact same narration shape has been booked before
    const exact = history.filter(h => signature(h.narration) === sig && ok(h.ledger));
    if (exact.length) {
        const counts = tally(exact.map(h => h.ledger));
        const [ledger, n] = counts[0];
        cands.push({
            ledger, confidence: Math.min(0.97, 0.85 + (n / exact.length) * 0.12),
            reason: `booked to ${ledger} ${n} time${n > 1 ? 's' : ''} before with the same narration`,
            method: 'history-exact',
            alternatives: counts.slice(1, 4).map(([l, c]) => ({ ledger: l, count: c })),
        });
    }

    // 3. the counterparty name looks like a ledger name.
    // Ranked ABOVE token similarity: "NAVJOTKAUR" being exactly the ledger "NAVJOT KAUR" is hard
    // evidence, whereas shared tokens are circumstantial.
    let best = null;
    for (const cand of extractParty(narration)) {
        for (const l of ledgers) {
            if (l.name === bankLedger) continue;
            const sim = similarity(cand, l.name);
            if (sim > (best ? best.sim : 0.66)) best = { sim, ledger: l.name, cand };
        }
    }
    if (best) cands.push({
        ledger: best.ledger,
        confidence: best.sim >= 0.995 ? 0.92 : Math.min(0.78, best.sim * 0.85),
        reason: best.sim >= 0.995
            ? `"${best.cand}" matches the ledger name exactly`
            : `"${best.cand}" closely matches the ledger "${best.ledger}"`,
        method: best.sim >= 0.995 ? 'name-exact' : 'name-fuzzy',
    });

    // 4. distinctive tokens shared with history, weighted by INVERSE DOCUMENT FREQUENCY.
    // Without IDF a fragment present in most rows (a bank code, a channel name) dominates and every
    // transaction gets mapped to whichever party happens to have the most history.
    const myTokens = new Set(tokens(narration));
    if (myTokens.size && history.length) {
        const df = new Map();
        history.forEach(h => new Set(tokens(h.narration)).forEach(t => df.set(t, (df.get(t) || 0) + 1)));
        const N = history.length;
        const idf = (t) => {
            const d = df.get(t) || 0;
            if (!d) return 0;
            if (d / N > 0.25) return 0;              // in a quarter of all rows → carries no information
            return Math.log(N / d);
        };
        const scores = new Map();
        for (const h of history) {
            if (!ok(h.ledger)) continue;
            const ht = new Set(tokens(h.narration));
            let w = 0;
            for (const t of ht) if (myTokens.has(t)) w += idf(t) * Math.min(t.length, 14) / 10;
            if (w > 0) scores.set(h.ledger, Math.max(scores.get(h.ledger) || 0, w));
        }
        if (scores.size) {
            const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
            const [ledger, score] = ranked[0];
            const runnerUp = ranked[1] ? ranked[1][1] : 0;
            // Require a clear leader AND real absolute weight; a near-tie means we do not know.
            const margin = runnerUp ? (score - runnerUp) / score : 1;
            if (score >= 0.8 && margin >= 0.35) cands.push({
                ledger, confidence: Math.min(0.85, 0.45 + Math.min(score, 3) * 0.1 + margin * 0.2),
                reason: `distinctive wording matches past entries booked to ${ledger}`,
                method: 'history-tokens',
                alternatives: ranked.slice(1, 4).map(([l]) => ({ ledger: l })),
            });
        }
    }

    if (!cands.length) return null;   // Say nothing rather than guess — a wrong ledger is worse than a blank.
    cands.sort((a, b) => b.confidence - a.confidence);
    const top = cands[0];
    // If a second method disagrees at close confidence, flag it rather than hide the doubt.
    const rival = cands.find(c => c.ledger !== top.ledger);
    if (rival && top.confidence - rival.confidence < 0.12) {
        top.confidence = Math.min(top.confidence, 0.6);
        top.reason += ` (but "${rival.ledger}" is also plausible — please check)`;
        top.contested = true;
    }
    return top;
}

// Count occurrences, most frequent first.
function tally(arr) {
    const m = new Map();
    arr.forEach(x => m.set(x, (m.get(x) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Which group should a NEW ledger sit under? Reuse how the SAME name is grouped in another set of
// books — that carries the knowledge across without copying any data between companies, which matters
// when the two companies are deliberately kept separate.
// `reference` is [{name, parent, is_billwise}] from any other company.
function suggestGroup(name, reference = [], fallback = 'Sundry Creditors') {
    let best = null;
    for (const r of reference) {
        if (!r || !r.name || !r.parent) continue;
        const sim = similarity(name, r.name);
        if (sim > (best ? best.sim : 0.8)) best = { sim, parent: r.parent, from: r.name };
    }
    return best
        ? { group: best.parent, reason: `"${best.from}" sits under ${best.parent} in your other company`, confidence: best.sim }
        : { group: fallback, reason: 'no precedent in your other books — defaulting', confidence: 0 };
}

// Money out of the bank is a Payment (Dr party, Cr bank); money in is a Receipt (Dr bank, Cr party).
function voucherFor({ withdrawal, deposit }) {
    return Number(withdrawal) > 0 ? 'Payment' : Number(deposit) > 0 ? 'Receipt' : null;
}

// Build the two ledger lines for a bank transaction, in the shape tally_xml.buildVoucherXml expects.
function entriesFor({ withdrawal, deposit }, partyLedger, bankLedger = 'HDFC BANK') {
    const amt = Number(withdrawal) > 0 ? Number(withdrawal) : Number(deposit);
    if (!(amt > 0)) return null;
    return Number(withdrawal) > 0
        ? [{ ledger: partyLedger, dr_cr: 'DR', amount: amt }, { ledger: bankLedger, dr_cr: 'CR', amount: amt }]
        : [{ ledger: bankLedger, dr_cr: 'DR', amount: amt }, { ledger: partyLedger, dr_cr: 'CR', amount: amt }];
}

// ── names to offer when CREATING a ledger for a line nothing matched ─────────────────────────────
// Deliberately separate from extractParty. That feeds the MATCHER, where an extra candidate is
// harmless — it simply fails to match anything. These are shown to a person as "create this ledger",
// where a bad candidate costs attention and risks a junk ledger in real books. Keeping them apart
// also means this can be tuned without disturbing the 98.8%-validated matcher.
function newLedgerCandidates(narration) {
    const raw = String(narration || '').toUpperCase().trim();
    const out = [];

    // "<gateway reference>/<merchant>" — e.g. K4RHQ54EAR62LNOXD4/PAYUOPENSOURCEBUSINE. The reference
    // is random per transaction; the merchant after the slash is the actual counterparty.
    const slash = raw.match(/^[A-Z0-9]{6,}\/(.+)$/);
    if (slash) out.push(slash[1]);

    // extractParty already returns "...-TPT-<PURPOSE>-<NAME>" as purpose-then-person. Both are offered:
    // when nothing matched, the purpose is usually not a ledger and the person is what needs creating.
    //
    // Its LAST entry is always the catch-all "longest alphabetic run", which reads
    // "NEFT DR-CNRB0019102-RAKESH SHARMA-NETBANK, MUM-HDFCN..." as "CNRB RAKESH SHARMA NETBANK HDFCN
    // UPTODATE". That is a fine thing to try to match against and a terrible ledger name, so it is held
    // back and only offered when no structured read produced anything.
    const parts = extractParty(narration);
    const fallback = parts.length ? parts[parts.length - 1] : null;
    out.push(...parts.slice(0, -1));

    const keep = [];
    const consider = (c0) => {
        if (!c0 || keep.length >= 2) return;          // two options is a choice; five is a puzzle
        const c = String(c0).replace(/[^A-Z0-9&.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (c.length < 4 || STOP.has(c)) return;
        // Skip a candidate that is one already kept with junk bolted on the front — the fallback read
        // of "BHDFOPV0L3WLHF/BILLDKGOOGLEADS" is "BHDFOPV WLHF BILLDKGOOGLEADS", which adds nothing
        // once BILLDKGOOGLEADS is on the list.
        if (keep.some(k => c.toLowerCase().endsWith(k.toLowerCase()))) return;
        keep.push(c);
    };

    out.forEach(consider);
    if (!keep.length) consider(fallback);             // last resort, never an extra option
    return keep;
}

module.exports = { signature, squash, tokens, extractParty, newLedgerCandidates, similarity, levenshtein, suggestGroup,
                   suggestLedger, voucherFor, entriesFor };
