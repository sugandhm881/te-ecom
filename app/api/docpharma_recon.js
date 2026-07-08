// DocPharma Reconciliation API.
// Membership = docpharma_orders — DocPharma's OWN order export (imported via docpharma_import.js).
// This is the authoritative billing list (order id, date, value, payment, status, delivered date).
// Our own systems (b2c location / Shopify tag / journey) can't reliably identify DocPharma's set, so the
// export is the source of truth. b2c adds AWB/courier/destination for the scan-log detail on expand.
// The active rate card (docpharma_rate_card) turns each order's status into an expected DocPharma charge.
//   Delivered · Prepaid  → Flat Service Charge
//   Delivered · COD       → Flat Service Charge + COD Collection Charge (flat)
//   RTO                   → Flat Service Charge + RTO Charge (forward + return leg)
//   Rejected / Cancelled  → ₹0 (never shipped → not billed)
// Everything is logged to docpharma_recon_log.
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const { syncDocpharmaOrderFromPortal } = require('./docpharma_portal');
const { parseDocpharmaCsv } = require('./docpharma_import_lib');

const norm = n => String(n || '').replace(/^#/, '').trim();
const BILLABLE = new Set(['delivered', 'rto']);   // only these incur a DocPharma charge

async function getActiveRateCard() {
    const { data } = await supabase.from('docpharma_rate_card')
        .select('id, flat_service_charge, rto_charge, cod_collection_charge, effective_from, updated_at')
        .eq('is_active', true).order('effective_from', { ascending: false }).limit(1).maybeSingle();
    return data || { id: null, flat_service_charge: 0, rto_charge: 0, cod_collection_charge: 0 };
}

// Turn one DocPharma order's status into charges using the rate card.
function computeCharges(o, rc) {
    const isCOD = /cod/i.test(o.payment_type || '');
    const flat = Number(rc.flat_service_charge) || 0;
    const rtoC = Number(rc.rto_charge) || 0;
    const codC = Number(rc.cod_collection_charge) || 0;
    let service = 0, rto = 0, cod = 0, billable = false;
    const st = (o.order_status || '').toLowerCase();
    if (st === 'delivered') { service = flat; cod = isCOD ? codC : 0; billable = true; }
    else if (st === 'rto') { service = flat; rto = rtoC; billable = true; }   // forward service + return leg
    // rejected / cancelled / shipped / other → ₹0 (never delivered nor RTO'd → not billed)
    const total = service + rto + cod;
    return { isCOD, service, rto, cod, total, billable };
}
function bucket(o) {
    const st = (o.order_status || '').toLowerCase();
    if (st === 'delivered') return 'delivered';
    if (st === 'rto') return 'rto';
    if (st === 'rejected') return 'rejected';
    if (st === 'cancelled') return 'cancelled';
    return st || 'other';
}

// GET /api/docpharma-recon?from=&to=&status=&payment=&search=
router.get('/docpharma-recon', async (req, res) => {
    try {
        // Date window is interpreted in IST (Asia/Kolkata), matching how order/delivered/RTO dates display.
        const istDay = d => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // → 'YYYY-MM-DD' in IST
        const toStr = req.query.to || istDay(new Date());
        let fromStr = req.query.from;
        if (!fromStr) { const d = new Date(); d.setDate(d.getDate() - 30); fromStr = istDay(d); }
        const fromISO = `${fromStr}T00:00:00.000+05:30`;
        const toISO = `${toStr}T23:59:59.999+05:30`;
        const istDate = ts => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null;

        const rc = await getActiveRateCard();

        // 1. DocPharma's own order export (authoritative), filtered by order date.
        const drows = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await supabase.from('docpharma_orders')
                .select('partner_order_id, customer_name, order_date, order_value, payment_type, order_status, delivered_date, awb, tracking_url, dest_city, dest_state, dest_pincode, eta, reason, dispatched_at, rto_at, scans')
                .gte('order_date', fromISO).lte('order_date', toISO)
                .order('partner_order_id', { ascending: true })       // stable sort → consistent pagination (no dup/skip)
                .range(off, off + 999);
            if (error) throw new Error(error.message);
            drows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        const names = [...new Set(drows.map(d => norm(d.partner_order_id)).filter(Boolean))];
        if (!names.length) return res.json({ success: true, range: { from: fromStr, to: toStr }, rateCard: rc, kpis: emptyKpis(), orders: [] });

        // 2. EasyEcom adds AWB / courier / destination for the scan-log detail (display only).
        const bMap = {};
        for (let i = 0; i < names.length; i += 300) {
            const batch = names.slice(i, i + 300);
            const { data } = await supabase.from('b2c_order_easycom')
                .select('reference_code, courier_name, shipping_pincode, shipping_state, shipping_city, awb_number, customer_phone').in('reference_code', batch);
            (data || []).forEach(b => { bMap[norm(b.reference_code)] = b; });
        }
        // 2b. Shopify line items → SKU details for the expand view.
        const itemsMap = {};
        for (let i = 0; i < names.length; i += 300) {
            const batch = names.slice(i, i + 300);
            const { data } = await supabase.from('enriched_orders_ecom')
                .select('name, line_items').in('name', batch.flatMap(n => [n, '#' + n]));
            (data || []).forEach(e => {
                if (!Array.isArray(e.line_items)) return;
                itemsMap[norm(e.name)] = e.line_items.map(li => ({
                    sku: li.sku || null,
                    name: li.title || li.name || null,
                    variant: li.variant_title && li.variant_title !== 'Default Title' ? li.variant_title : null,
                    qty: li.quantity || li.qty || 1,
                }));
            });
        }

        const statusF = String(req.query.status || '').toLowerCase().split(',').map(s => s.trim()).filter(s => s && s !== 'all');
        const payF = (req.query.payment || 'all').toLowerCase();
        const q = (req.query.search || '').trim().toLowerCase();
        const dFrom = String(req.query.dfrom || '').trim();          // delivered-date range (YYYY-MM-DD, IST)
        const dTo = String(req.query.dto || '').trim();
        const custQ = String(req.query.customer || '').trim().toLowerCase();

        const seenId = new Set();
        const uniqueRows = drows.filter(d => { const k = norm(d.partner_order_id); if (!k || seenId.has(k)) return false; seenId.add(k); return true; });
        let orders = uniqueRows.map(d => {
            const n = norm(d.partner_order_id), b = bMap[n] || {};
            const st = (d.order_status || '').toLowerCase();
            const scanArr = Array.isArray(d.scans) ? d.scans : [];
            // Last (most recent) scan timestamp — the fallback "close date" when a precise delivered/RTO date isn't set.
            const lastScanAt = scanArr.reduce((m, s) => (s && s.at && (!m || s.at > m)) ? s.at : m, null);
            const deliveredAt = st === 'delivered' ? (d.delivered_date || lastScanAt) : null;
            const rtoAt = st === 'rto' ? (d.rto_at || lastScanAt) : null;
            const closeIso = deliveredAt || rtoAt || lastScanAt || null;   // delivered → delivered date, RTO → RTO date, lost/other → last scan
            const o = {
                order: n, customer: d.customer_name || null,
                order_status: st, outcome: st,
                payment_type: d.payment_type || null,
                value: d.order_value != null ? Math.round(Number(d.order_value)) : null,
                orderDate: istDate(d.order_date), deliveredDate: istDate(d.delivered_date),
                closeDate: istDate(closeIso),
                awb: d.awb || b.awb_number || null, courier: b.courier_name || 'DocPharma',
                tracking_url: d.tracking_url || null, reason: d.reason || null,
                dest_state: d.dest_state || b.shipping_state || null, dest_city: d.dest_city || b.shipping_city || null, dest_pincode: d.dest_pincode || b.shipping_pincode || null,
                phone: b.customer_phone || null, cod_amount: null,
                ts: { order: d.order_date || null, dispatched: d.dispatched_at || null, delivered: deliveredAt, rto: rtoAt, edd: d.eta || null, last: lastScanAt },
                scans: scanArr,
                items: itemsMap[n] || [],
                hasStatus: true,
            };
            const c = computeCharges(o, rc);
            return { ...o, ...c };
        });

        // filters
        if (statusF.length) orders = orders.filter(o => statusF.includes(bucket(o)));
        if (payF !== 'all') orders = orders.filter(o => payF === 'cod' ? o.isCOD : !o.isCOD);
        if (dFrom) orders = orders.filter(o => o.closeDate && o.closeDate >= dFrom);
        if (dTo) orders = orders.filter(o => o.closeDate && o.closeDate <= dTo);
        if (custQ) orders = orders.filter(o => (o.customer || '').toLowerCase().includes(custQ));
        if (q) orders = orders.filter(o => (o.order || '').toLowerCase().includes(q) || (o.awb || '').toLowerCase().includes(q) || (o.customer || '').toLowerCase().includes(q) || (o.courier || '').toLowerCase().includes(q));

        orders.sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));

        res.json({ success: true, range: { from: fromStr, to: toStr }, rateCard: rc, kpis: summarize(orders), orders: orders.slice(0, 5000), truncated: orders.length > 5000, total: orders.length });
    } catch (e) { console.error('[DocPharmaRecon]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

function emptyKpis() { return { orders: 0, delivered: 0, rto: 0, rejected: 0, cancelled: 0, lost: 0, nonBillable: 0, confirmedTotal: 0, serviceTotal: 0, rtoTotal: 0, codTotal: 0, codOrders: 0, gmvDelivered: 0 }; }
function summarize(orders) {
    const k = emptyKpis();
    orders.forEach(o => {
        const bk = bucket(o);
        if (bk === 'delivered') { k.delivered++; k.gmvDelivered += o.value || 0; }
        else if (bk === 'rto') k.rto++;
        else if (bk === 'rejected') k.rejected++;
        else if (bk === 'cancelled') k.cancelled++;
        else if (bk === 'lost') k.lost++;
        // "DocPharma orders" count excludes rejected/cancelled — those were never real fulfilled orders.
        const real = bk !== 'rejected' && bk !== 'cancelled';
        if (real) { k.orders++; if (o.isCOD) k.codOrders++; }
        if (!BILLABLE.has(bk)) k.nonBillable++;
        k.serviceTotal += o.service; k.rtoTotal += o.rto; k.codTotal += o.cod; k.confirmedTotal += o.total;
    });
    ['confirmedTotal', 'serviceTotal', 'rtoTotal', 'codTotal', 'gmvDelivered'].forEach(f => k[f] = Math.round(k[f]));
    k.gst = Math.round(k.confirmedTotal * 0.18);          // DocPharma bills 18% IGST on charges
    k.totalWithGst = k.confirmedTotal + k.gst;
    return k;
}

// GET current rate card
router.get('/docpharma-recon/settings', async (req, res) => {
    try { res.json({ success: true, rateCard: await getActiveRateCard() }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST new rate card — deactivate old active, insert new active, log the change.
router.post('/docpharma-recon/settings', async (req, res) => {
    try {
        const flat = Number(req.body.flat_service_charge) || 0;
        const rto = Number(req.body.rto_charge) || 0;
        const cod = Number(req.body.cod_collection_charge) || 0;
        const by = (req.body.updated_by || 'ui').toString().slice(0, 120);
        const prev = await getActiveRateCard();
        await supabase.from('docpharma_rate_card').update({ is_active: false }).eq('is_active', true);
        const { data, error } = await supabase.from('docpharma_rate_card')
            .insert({ flat_service_charge: flat, rto_charge: rto, cod_collection_charge: cod, updated_by: by, is_active: true })
            .select().single();
        if (error) throw new Error(error.message);
        await supabase.from('docpharma_recon_log').insert({
            event_type: 'settings_change', source: 'ui', rate_card_id: data.id,
            rate_card_snapshot: { flat_service_charge: flat, rto_charge: rto, cod_collection_charge: cod },
            message: `Rate card updated by ${by}: service ₹${flat}, RTO ₹${rto}, COD ₹${cod} (was service ₹${prev.flat_service_charge}, RTO ₹${prev.rto_charge}, COD ₹${prev.cod_collection_charge})`,
        });
        res.json({ success: true, rateCard: data });
    } catch (e) { console.error('[DocPharmaRecon settings]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// POST snapshot — freeze the current computed charges of every in-window order into the log (billing record).
router.post('/docpharma-recon/snapshot', async (req, res) => {
    try {
        const orders = Array.isArray(req.body.orders) ? req.body.orders : [];
        const rc = await getActiveRateCard();
        if (!orders.length) return res.json({ success: true, logged: 0 });
        const rows = orders.slice(0, 5000).map(o => ({
            event_type: 'recon_snapshot', order_name: o.order || null, awb: o.awb || null,
            outcome: o.outcome || null, payment_mode: o.payment_mode || null, cod_amount: o.cod_amount != null ? o.cod_amount : null,
            service_charge: o.service || 0, rto_charge: o.rto || 0, cod_charge: o.cod || 0, total_charge: o.total || 0,
            rate_card_id: rc.id, rate_card_snapshot: { flat_service_charge: rc.flat_service_charge, rto_charge: rc.rto_charge, cod_collection_charge: rc.cod_collection_charge },
            source: 'ui', message: `snapshot ${o.statusLabel || o.outcome || 'pending'}`,
        }));
        for (let i = 0; i < rows.length; i += 500) await supabase.from('docpharma_recon_log').insert(rows.slice(i, i + 500));
        res.json({ success: true, logged: rows.length });
    } catch (e) { console.error('[DocPharmaRecon snapshot]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// POST refresh one order straight from the DocPharma portal (single source) + log it.
router.post('/docpharma-recon/fetch/:order', async (req, res) => {
    try {
        const order = norm(req.params.order);
        const status = await syncDocpharmaOrderFromPortal(order);
        if (!status) return res.json({ success: false, error: 'not found in DocPharma portal' });
        await supabase.from('docpharma_recon_log').insert({
            event_type: 'api_fetch', order_name: order, outcome: status, source: 'ui',
            message: `Portal refresh → ${status}`,
        });
        res.json({ success: true, outcome: status });
    } catch (e) { console.error('[DocPharmaRecon fetch]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// POST CSV upload — parse DocPharma's export and upsert into docpharma_orders (dedup by order id, so a
// re-upload never creates duplicates). Body is the raw CSV text (Content-Type text/plain).
router.post('/docpharma-recon/import', express.text({ type: () => true, limit: '30mb' }), async (req, res) => {
    try {
        const text = typeof req.body === 'string' ? req.body : '';
        if (!text.trim()) return res.status(400).json({ success: false, error: 'empty file' });
        let parsed;
        try { parsed = parseDocpharmaCsv(text); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        const records = parsed.records;
        if (!records.length) return res.json({ success: true, imported: 0, message: 'no data rows found' });

        const stamp = new Date().toISOString();
        let saved = 0;
        for (let i = 0; i < records.length; i += 500) {
            const chunk = records.slice(i, i + 500).map(r => ({ ...r, imported_at: stamp }));
            // onConflict on the primary key upserts in place → no duplicate rows ever created.
            const { error } = await supabase.from('docpharma_orders').upsert(chunk, { onConflict: 'partner_order_id' });
            if (error) throw new Error(error.message);
            saved += chunk.length;
        }
        const dist = {};
        records.forEach(r => { const s = r.order_status || '(blank)'; dist[s] = (dist[s] || 0) + 1; });
        await supabase.from('docpharma_recon_log').insert({ event_type: 'status_update', source: 'ui', message: `CSV upload: ${saved} DocPharma orders upserted (${parsed.dataRows} rows read)` }).then(() => {}).catch(() => {});
        res.json({ success: true, imported: saved, rowsRead: parsed.dataRows, statusDist: dist });
    } catch (e) { console.error('[DocPharmaRecon import]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
