// Real-time order feed — upserts a Shopify order payload into the `orders` (+ `order_line_items` +
// `order_shipping_addresses`) tables that the dashboard reads via the `order_buckets` view. The main
// order-sync is a SEPARATE app that lags (~30 min); the orders/create webhook calls this so new orders
// (and their auto-hold state) appear on Support Orders / Call Queue instantly. Idempotent — upsert on
// `id` for orders/line-items, delete+insert children — so it coexists with the external sync (whoever
// writes last wins with the same data; no duplicates). Only writes fields we can map from the payload;
// everything else stays null until the full sync reconciles.
const { supabase } = require('../supabase');
const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
const bool = v => (v === null || v === undefined) ? null : !!v;

async function upsertShopifyOrder(o) {
    if (!o || !o.id) return { ok: false, error: 'no order id' };
    const oid = String(o.id);
    const now = new Date().toISOString();
    const ship = o.shipping_address || {};
    const phone = o.phone || (o.customer && o.customer.phone) || ship.phone || null;

    const orderRow = {
        id: oid, order_number: (o.order_number === undefined ? null : o.order_number), name: o.name || null,
        email: o.email || (o.customer && o.customer.email) || null, phone,
        created_at: o.created_at || now, updated_at: o.updated_at || o.created_at || now,
        closed_at: o.closed_at || null, cancelled_at: o.cancelled_at || null, cancel_reason: o.cancel_reason || null,
        financial_status: o.financial_status || null, fulfillment_status: o.fulfillment_status || null,
        currency: o.currency || null, total_price: num(o.total_price), subtotal_price: num(o.subtotal_price),
        total_tax: num(o.total_tax), total_discounts: num(o.total_discounts),
        total_shipping: num(o.total_shipping_price_set && o.total_shipping_price_set.shop_money && o.total_shipping_price_set.shop_money.amount),
        total_weight: (o.total_weight === undefined ? null : o.total_weight), taxes_included: bool(o.taxes_included),
        confirmed: bool(o.confirmed), test: bool(o.test), token: o.token || null, gateway: o.gateway || null,
        source_name: o.source_name || null, tags: o.tags || null, note: o.note || null,
        order_status_url: o.order_status_url || null, cart_token: o.cart_token || null, checkout_token: o.checkout_token || null,
        buyer_accepts_marketing: bool(o.buyer_accepts_marketing), synced_at: now,
    };
    const { error: eo } = await supabase.from('orders').upsert(orderRow, { onConflict: 'id' });
    if (eo) return { ok: false, error: 'orders upsert: ' + eo.message };

    // Shipping address — delete+insert (id is a serial PK; dashboard reads it by order_id, so a new id is fine).
    if (ship && (ship.address1 || ship.city || ship.zip)) {
        await supabase.from('order_shipping_addresses').delete().eq('order_id', oid).then(() => {}).catch(() => {});
        await supabase.from('order_shipping_addresses').insert({
            order_id: oid, first_name: ship.first_name || null, last_name: ship.last_name || null, company: ship.company || null,
            address1: ship.address1 || null, address2: ship.address2 || null, city: ship.city || null,
            province: ship.province || null, province_code: ship.province_code || null, country: ship.country || null,
            country_code: ship.country_code || null, zip: ship.zip || null, phone: ship.phone || null,
            name: ship.name || ([ship.first_name, ship.last_name].filter(Boolean).join(' ') || null),
            latitude: (ship.latitude === undefined ? null : ship.latitude), longitude: (ship.longitude === undefined ? null : ship.longitude), synced_at: now,
        }).then(() => {}).catch(() => {});
    }

    // Line items — delete+insert.
    const items = o.line_items || [];
    if (items.length) {
        await supabase.from('order_line_items').delete().eq('order_id', oid).then(() => {}).catch(() => {});
        await supabase.from('order_line_items').insert(items.map(li => ({
            id: String(li.id), order_id: oid,
            product_id: li.product_id ? String(li.product_id) : null, variant_id: li.variant_id ? String(li.variant_id) : null,
            title: li.title || null, variant_title: li.variant_title || null, sku: li.sku || null, vendor: li.vendor || null,
            quantity: (li.quantity === undefined ? null : li.quantity), price: num(li.price), total_discount: num(li.total_discount),
            fulfillment_status: li.fulfillment_status || null, requires_shipping: bool(li.requires_shipping),
            taxable: bool(li.taxable), gift_card: bool(li.gift_card), name: li.name || null,
            properties: li.properties || [], tax_lines: li.tax_lines || [], synced_at: now,
        }))).then(() => {}).catch(() => {});
    }
    return { ok: true };
}

module.exports = { upsertShopifyOrder };
