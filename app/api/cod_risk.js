// COD Risk scoring — powers the Ops Control "Pre-dispatch risk" queue (/ops-control/risk).
// Scores every not-yet-dispatched pipeline order for RTO risk BEFORE it ships, so ops can verify /
// convert-to-prepaid / hold the risky ones. Signals (all in-house, no external APIs):
//   • customer's OWN history (this phone/email's past RTOs vs deliveries)  ← strongest signal
//   • pincode-level RTO rate (city fallback), pincode serviceability gate
//   • COD vs prepaid, first-time buyer, high order value, incomplete address, slow/single-courier lanes
const { supabase } = require('../supabase');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const last10 = p => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const normEmail = e => String(e || '').trim().toLowerCase();

// ── Customer history: phone/email → { rto, delivered } from final journeys × enriched orders ────────
// Cached 10 min — two paged scans (journeys ~13k, orders ~34k×3cols) are too heavy per request.
let _custCache = { t: 0, phone: null, email: null };
async function getCustomerHistory() {
    if (_custCache.phone && Date.now() - _custCache.t < 10 * 60 * 1000) return _custCache;
    const outcomes = {};   // order name (no '#') → 'delivered' | 'rto'
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('shipment_journey_ecom')
            .select('order_name, outcome').eq('is_final', true).in('outcome', ['delivered', 'rto'])
            .range(off, off + 999);
        if (error) break;
        (data || []).forEach(r => { if (r.order_name) outcomes[String(r.order_name).replace('#', '').trim()] = r.outcome; });
        if (!data || data.length < 1000) break;
    }
    const phone = new Map(), email = new Map();
    const bump = (map, key, oc) => {
        if (!key) return;
        let s = map.get(key); if (!s) map.set(key, s = { rto: 0, delivered: 0 });
        s[oc === 'rto' ? 'rto' : 'delivered']++;
    };
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('enriched_orders_ecom')
            .select('name, phone, email').range(off, off + 999);
        if (error) break;
        (data || []).forEach(o => {
            const oc = outcomes[String(o.name || '').replace('#', '').trim()];
            if (!oc) return;
            bump(phone, last10(o.phone), oc);
            bump(email, normEmail(o.email), oc);
        });
        if (!data || data.length < 1000) break;
    }
    _custCache = { t: Date.now(), phone, email };
    return _custCache;
}

// Score contribution from the customer's own track record. Phone match is authoritative; email backs it up.
function customerSignal(hist, phoneRaw, emailRaw) {
    const s = hist.phone.get(last10(phoneRaw)) || hist.email.get(normEmail(emailRaw)) || null;
    if (!s) return { pts: 0, reasons: [], known: false };
    if (s.rto >= 2) return { pts: 45, reasons: [`🚨 Customer RTO'd ${s.rto} previous orders`], known: true };
    if (s.rto === 1) return { pts: 30, reasons: [`Customer RTO'd 1 previous order${s.delivered ? ` (${s.delivered} delivered)` : ''}`], known: true };
    if (s.delivered >= 2) return { pts: -25, reasons: [`✓ Proven customer — ${s.delivered} delivered, 0 RTO`], known: true };
    return { pts: 0, reasons: [], known: true };
}

// ── Full pipeline risk list (moved from ops_control.js, extended with the customer signal) ──────────
async function computeRiskList() {
    // 1. Historical RTO rate per city / pincode (views) + serviceability.
    const { data: cityRows } = await supabase.from('journey_city_rto').select('city, resolved, rto');
    const cityRto = {};
    (cityRows || []).forEach(c => { if (c.city && c.resolved >= 15) cityRto[c.city] = pct(c.rto, c.resolved); });
    const { data: pinRows } = await supabase.from('journey_pincode_rto').select('pincode, resolved, rto');
    const pinRto = {};
    (pinRows || []).forEach(p => { if (p.pincode && p.resolved >= 10) pinRto[String(p.pincode)] = pct(p.rto, p.resolved); });
    const svc = {};
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('serviceability_edd_ecom')
            .select('delivery_pincode, serviceable, courier_count, slowest_days').range(off, off + 999);
        if (error) break;
        (data || []).forEach(s => { if (s.delivery_pincode) svc[String(s.delivery_pincode)] = s; });
        if (!data || data.length < 1000) break;
    }

    // 2. Not-yet-dispatched, non-cancelled pipeline orders (recent).
    const PIPELINE = ['Open', 'Confirmed', 'Printed', 'Ready to dispatch', 'Assigned', 'On Hold'];
    const since = new Date(Date.now() - 20 * 86400000).toISOString();
    const orders = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('b2c_order_easycom')
            .select('reference_code, order_status, payment_mode, order_total, shipping_city, shipping_state, shipping_pincode, order_date, raw_data')
            .ilike('reference_code', 'TE%').in('order_status', PIPELINE).gte('order_date', since)
            .range(off, off + 999);
        if (error) throw new Error(error.message);
        orders.push(...(data || []));
        if (!data || data.length < 1000) break;
    }

    // 3. New-vs-Repeat + contact details from enriched orders (one batched query serves both).
    const names = [...new Set(orders.map(o => o.reference_code))];
    const repeat = new Set(), contact = {};
    for (let i = 0; i < names.length; i += 300) {
        const batch = names.slice(i, i + 300);
        const { data } = await supabase.from('enriched_orders_ecom').select('name, tags, phone, email').in('name', batch.flatMap(n => ['#' + n, n]));
        (data || []).forEach(e => {
            const key = String(e.name).replace('#', '');
            if (/(^|,)\s*repeat\s*(,|$)/i.test(e.tags || '')) repeat.add(key);
            contact[key] = { phone: e.phone || null, email: e.email || null };
        });
    }
    const hist = await getCustomerHistory();

    // 4. Score each order.
    return orders.map(o => {
        const city = String(o.shipping_city || (o.raw_data && o.raw_data.city) || '').trim().toUpperCase();
        const pin = String(o.shipping_pincode || (o.raw_data && (o.raw_data.pincode || o.raw_data.pin_code || o.raw_data.zip)) || '').trim();
        const isCOD = /cod/i.test(o.payment_mode || '');
        const pr = (pin && pinRto[pin] != null) ? pinRto[pin] : null;
        const cr = pr != null ? pr : (cityRto[city] != null ? cityRto[city] : null);
        const rtoLbl = pr != null ? `Pincode RTO ${pr}%` : null;
        const s = pin ? svc[pin] : null;
        const c = contact[o.reference_code] || {};
        let score = 0; const reasons = []; let block = false;
        // Customer's own track record — the strongest predictor, so it goes first in the reasons.
        const cust = customerSignal(hist, c.phone, c.email);
        score += cust.pts; reasons.push(...cust.reasons);
        // A customer with ANY history isn't first-time, whatever the Shopify tag says.
        const isNew = !repeat.has(o.reference_code) && !cust.known;
        if (isCOD) { score += 40; reasons.push('COD'); }
        if (isNew) { score += 20; reasons.push('First-time buyer'); }
        if (cr != null) {
            if (cr >= 30) { score += 30; reasons.push(rtoLbl || `High-RTO city ${cr}%`); }
            else if (cr >= 20) { score += 20; reasons.push(rtoLbl || `Elevated-RTO city ${cr}%`); }
            else if (cr >= 12) { score += 10; reasons.push(rtoLbl || `City RTO ${cr}%`); }
        }
        if (s && s.serviceable === false) { score += 50; block = true; reasons.unshift('🛑 Pincode NOT serviceable — hold'); }
        else if (s && s.courier_count != null && s.courier_count <= 1) { score += 15; reasons.push('Only 1 courier serves this pincode'); }
        if (s && s.slowest_days != null && s.slowest_days >= 8) { score += 10; reasons.push(`Slow lane (~${s.slowest_days}d)`); }
        const val = o.order_total != null ? Math.round(Number(o.order_total)) : null;
        if (val != null && val >= 1500) { score += 10; reasons.push(`High value ₹${val.toLocaleString('en-IN')}`); }
        if (!city && !pin) { score += 15; reasons.push('Incomplete address'); }
        score = Math.max(0, score);
        const band = block ? 'High' : score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';
        return {
            order: o.reference_code, status: o.order_status, payment: o.payment_mode || null,
            value: val, isCOD,
            city: o.shipping_city || (o.raw_data && o.raw_data.city) || '—', state: o.shipping_state || (o.raw_data && o.raw_data.state) || '—',
            pincode: pin || null, serviceable: s ? s.serviceable : null, courierCount: s ? (s.courier_count != null ? s.courier_count : null) : null, block,
            type: isNew ? 'new' : 'repeat', cityRto: cr, score, band, reasons,
            phone: c.phone || null,
        };
    });
}

module.exports = { computeRiskList, getCustomerHistory };
