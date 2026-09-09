// ─────────────────────────────────────────────────────────────────────────────
// FLIPKART LABEL SPLITTER (2026-09-09)
//
// A Flipkart shipping PDF puts the shipping label and the tax invoice on ONE page,
// stacked. Warehouse needs the label; accounts need the invoice; nobody wants to
// hand-crop a hundred of them. This cuts each page in two and returns a ZIP.
//
// ⚠️ PORTED FROM A STANDALONE FLASK APP, DELIBERATELY (user, 2026-09-09: "make sure
// this should not run on python, it runs with our project architecture"). The
// original was Flask + pypdf on port 5050 with its own React page, which would have
// meant a second runtime to install, supervise, restart, secure and keep alive on
// the VPS — for one button. This is the same arithmetic in `pdf-lib`, inside the
// dashboard, behind the dashboard's own login and permission gate.
//
// HOW THE CUT WORKS. We do not rewrite page content — we set the CROPBOX, which is
// what a viewer and a printer obey, so the label prints alone while the bytes
// underneath stay untouched and nothing is re-encoded or degraded.
//
// ⚠️ WHERE THE LINE FALLS, AND WHY IT IS EASY TO GET BACKWARDS. A PDF's origin is the
// BOTTOM-left, so the Flask original's `ratio = 0.55` meant "cut at 55% of the height
// MEASURED UP FROM THE BOTTOM" — which gives the shipping label the top *45%* and the
// tax invoice the bottom *55%*. Its own UI called that "55/45 — if the shipping label
// is taller", which reads like the opposite.
//
// The first version here trusted the label over the maths and cut at the top 55%. It
// was wrong on real Flipkart PDFs (user, 2026-09-09: "55/45 ratio not working proper
// as python work"). This now reproduces the Python exactly: the constant IS the
// python `ratio`, and the two halves are named for what they actually get.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const express = require('express');
const router = express.Router();
const { PDFDocument } = require('pdf-lib');

// 55 / 45, fixed (user, 2026-09-09: "split position should 55:45 be default, no other option").
//
// This is the Flask original's `ratio`, byte for byte: the cut sits at 55% of the page height measured
// UP FROM THE BOTTOM. So:
//     shipping label = everything ABOVE the line  → the top 45% of the page
//     tax invoice    = everything BELOW the line  → the bottom 55%
// One constant, one place to change it if Flipkart ever moves the divider.
const SPLIT_AT_FROM_BOTTOM = 0.55;
// What each half actually ends up with, derived rather than typed twice — the page and the API response
// quote these, so a change to the constant above can never leave the labelling behind.
const SHIPPING_PCT = Math.round((1 - SPLIT_AT_FROM_BOTTOM) * 100);   // 45
const INVOICE_PCT = 100 - SHIPPING_PCT;                              // 55

const MAX_FILES = 60;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;   // the JSON body cap below, minus base64 overhead

// A filename becomes a path inside a ZIP the user then extracts, so it is sanitised rather than
// trusted: "../../etc/x.pdf" or a stray slash would otherwise decide where those files land.
function safeBase(name) {
    const base = String(name || 'label').replace(/\.pdf$/i, '');
    // AN ALLOWLIST, NOT A BLOCKLIST. This string becomes a path inside a ZIP the user then extracts,
    // so "../../etc/passwd.pdf" must not decide where those files land — and a blocklist of the
    // characters you happened to think of is how that goes wrong. Letters, digits, dot and dash
    // survive; every other byte becomes an underscore, runs collapse, and a name that reduces to
    // nothing falls back rather than producing a file called "".
    // ⚠️ Every backslash here matters: written as /.{2,}/ this matches ANY two characters and
    // collapses every filename to "label" — which is exactly what it did on the first attempt.
    const clean = base
        .replace(/[^A-Za-z0-9.-]+/g, '_')
        .replace(/\.{2,}/g, '_')          // no ".." segment survives, wherever it sits
        .replace(/_{2,}/g, '_')
        .replace(/^[_.-]+|[_.-]+$/g, '');
    return (clean || 'label').slice(0, 80);
}

// Split one PDF into { shipping, invoice }, each a Buffer.
// Every page is cut, so a multi-page file yields a multi-page label PDF and a multi-page invoice PDF —
// the pages stay in their original order, which is what makes the two halves line up order-for-order.
// Crop ONE already-copied page to one half. Shared by the single-file helper and the batch below, so
// there is one definition of where the line falls rather than two that can drift.
function cropHalf(p, topHalf) {
    // MediaBox, not getSize(): a page can carry a non-zero origin, and cropping relative to (0,0)
    // would then cut the wrong band entirely.
    const mb = p.getMediaBox();
    // The Python line, verbatim: split_y = h * ratio, measured up from the page's own origin.
    const splitY = mb.y + mb.height * SPLIT_AT_FROM_BOTTOM;
    // pdf-lib takes (x, y, width, height) with y measured from the bottom.
    //   above the line → the shipping label   (pypdf: [0, split_y, w, h])
    //   below the line → the tax invoice      (pypdf: [0, 0, w, split_y])
    if (topHalf) p.setCropBox(mb.x, splitY, mb.width, mb.y + mb.height - splitY);
    else p.setCropBox(mb.x, mb.y, mb.width, splitY - mb.y);
}

// TWO STACKS, NOT A ZIP OF PAIRS (user, 2026-09-09: "instead of zip download give 2 option of download
// invoice and label"). A ZIP of per-order folders has to be extracted and the files opened one at a
// time; what the warehouse actually does is print every label in one go and hand every invoice to
// accounts in one go. So the batch is merged into TWO PDFs, page order preserved, which means one
// Ctrl+P each instead of sixty.
async function splitBatch(items) {
    const labels = await PDFDocument.create();
    const invoices = await PDFDocument.create();
    const done = [], failed = [];
    // ONE BAD FILE MUST NOT LOSE THE BATCH. A password-protected or truncated PDF fails on its own and
    // the other 59 still come through, named in the response — a silently short stack is how you ship
    // 59 of 60 orders and never notice.
    for (const it of items) {
        try {
            const src = await PDFDocument.load(it.buf, { ignoreEncryption: true });
            if (!src.getPageCount()) throw new Error('the PDF has no pages');
            for (const [doc, top] of [[labels, true], [invoices, false]]) {
                const pages = await doc.copyPages(src, src.getPageIndices());
                pages.forEach(p => { cropHalf(p, top); doc.addPage(p); });
            }
            done.push({ name: it.name, pages: src.getPageCount() });
        } catch (e) {
            failed.push({ name: it.name, error: e.message });
        }
    }
    return { labels, invoices, done, failed };
}

async function splitPdf(buf) {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pageCount = src.getPageCount();
    if (!pageCount) throw new Error('the PDF has no pages');

    const build = async (topHalf) => {
        const out = await PDFDocument.create();
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p => { cropHalf(p, topHalf); out.addPage(p); });
        return Buffer.from(await out.save());
    };

    return { shipping: await build(true), invoice: await build(false), pages: pageCount };
}

// ── POST /api/label-splitter/split ───────────────────────────────────────────
// Files arrive base64-encoded in a JSON body rather than multipart — the same choice tally_bank.js
// made, and for the same reason: it avoids adding multer and a second body parser to the server for
// one screen. Returns both stacks base64-encoded so the browser can save either without a second
// authenticated request and without a temp file on the server.
router.post('/label-splitter/split', express.json({ limit: '60mb' }), async (req, res) => {
    try {
        const files = Array.isArray(req.body && req.body.files) ? req.body.files : [];
        if (!files.length) return res.status(400).json({ success: false, error: 'No PDFs were sent.' });
        if (files.length > MAX_FILES) return res.status(400).json({ success: false, error: `Too many files at once — ${MAX_FILES} is the limit. Split the batch.` });

        let total = 0;
        for (const f of files) total += Math.ceil(String(f && f.data || '').length * 3 / 4);
        if (total > MAX_TOTAL_BYTES) return res.status(400).json({ success: false, error: 'That batch is over 40 MB. Send it in two.' });

        const { labels, invoices, done, failed } = await splitBatch(
            files.map(f => ({ name: safeBase(f && f.name), buf: Buffer.from(String((f && f.data) || ''), 'base64') })));
        if (!done.length) return res.status(400).json({ success: false, error: 'Every file failed to split.', failed });

        // Named for the ORDER when there is one, and for the batch when there are many — so a single
        // label saved to disk still says which order it belongs to.
        const stamp = new Date().toISOString().slice(0, 10);
        const one = done.length === 1 ? done[0].name : null;
        res.json({
            success: true,
            labels_base64: Buffer.from(await labels.save()).toString('base64'),
            invoices_base64: Buffer.from(await invoices.save()).toString('base64'),
            labels_name: one ? `SHIPPING__${one}.pdf` : `shipping-labels-${stamp}.pdf`,
            invoices_name: one ? `INVOICE__${one}.pdf` : `tax-invoices-${stamp}.pdf`,
            split: done, failed,
            pages: done.reduce((n, d) => n + d.pages, 0),
            shipping_pct: SHIPPING_PCT, invoice_pct: INVOICE_PCT,
        });
    } catch (e) {
        console.error('[label-splitter]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = { router, splitPdf, splitBatch, safeBase, SPLIT_AT_FROM_BOTTOM, SHIPPING_PCT, INVOICE_PCT };
