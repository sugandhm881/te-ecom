// Minimal Amazon SP-API Reports (2021-06-30) client: create a report, poll until DONE,
// download the (usually gzipped, tab-delimited) document, and parse it to rows.
// Relies on makeSignedApiRequest, which now signs POST bodies (see helpers.js).
const axios = require('axios');
const zlib = require('zlib');
const { makeSignedApiRequest } = require('./helpers');
const config = require('../../config');

const MKT = config.MARKETPLACE_ID || 'A21TJRUUN4KGV';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function requestReport(reportType, { dataStartTime, dataEndTime, reportOptions, marketplaceIds } = {}) {
    const bodyObj = { reportType, marketplaceIds: marketplaceIds || [MKT] };
    if (dataStartTime) bodyObj.dataStartTime = dataStartTime;
    if (dataEndTime) bodyObj.dataEndTime = dataEndTime;
    if (reportOptions) bodyObj.reportOptions = reportOptions;
    const body = JSON.stringify(bodyObj);
    const r = await makeSignedApiRequest({ method: 'POST', path: '/reports/2021-06-30/reports', body, headers: { 'Content-Type': 'application/json' } });
    return r.reportId;
}

async function pollReport(reportId, { intervalMs = 6000, maxWaitMs = 210000 } = {}) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        await sleep(intervalMs);
        const r = await makeSignedApiRequest({ method: 'GET', path: `/reports/2021-06-30/reports/${reportId}` });
        const st = r.processingStatus;
        if (st === 'DONE') return r.reportDocumentId;
        if (st === 'CANCELLED' || st === 'FATAL') throw new Error(`Report ${reportId} ${st}`);
    }
    throw new Error(`Report ${reportId} timed out`);
}

async function fetchDocument(reportDocumentId) {
    const doc = await makeSignedApiRequest({ method: 'GET', path: `/reports/2021-06-30/documents/${reportDocumentId}` });
    const raw = await axios.get(doc.url, { responseType: 'arraybuffer' });
    let buf = Buffer.from(raw.data);
    if (doc.compressionAlgorithm === 'GZIP') buf = zlib.gunzipSync(buf);
    return buf.toString('utf8');
}

// Tab-delimited report -> array of objects keyed by (quote-stripped) header cells.
function parseTsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.length);
    if (!lines.length) return [];
    const strip = s => s.replace(/^"|"$/g, '');
    const hdr = lines[0].split('\t').map(strip);
    return lines.slice(1).map(line => {
        const cells = line.split('\t').map(strip);
        const o = {};
        hdr.forEach((h, i) => { o[h] = cells[i]; });
        return o;
    });
}

async function runReport(reportType, opts = {}, pollOpts = {}) {
    const reportId = await requestReport(reportType, opts);
    const docId = await pollReport(reportId, pollOpts);
    const text = await fetchDocument(docId);
    return parseTsv(text);
}

module.exports = { requestReport, pollReport, fetchDocument, parseTsv, runReport };
