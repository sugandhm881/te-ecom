const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) {
    console.warn('[Supabase] SUPABASE_URL or SUPABASE_SERVICE_KEY not set in .env');
}

const supabase = createClient(
    config.SUPABASE_URL || '',
    config.SUPABASE_SERVICE_KEY || ''
);

/**
 * Fetch a complete order from Supabase including line items and shipping address.
 * @param {string} shopifyOrderId  - The Shopify numeric order ID (e.g. "5869437960411")
 * @returns {{ order, lineItems, shippingAddress } | null}
 */
async function getOrderFromSupabase(shopifyOrderId) {
    const id = String(shopifyOrderId);

    try {
        const [orderRes, lineItemsRes, shippingRes] = await Promise.all([
            supabase.from('orders').select('*').eq('id', id).single(),
            supabase.from('order_line_items').select('*').eq('order_id', id),
            supabase.from('order_shipping_addresses').select('*').eq('order_id', id).single()
        ]);

        if (orderRes.error && orderRes.error.code !== 'PGRST116') {
            console.error('[Supabase] orders fetch error:', orderRes.error.message);
        }

        return {
            order: orderRes.data || null,
            lineItems: lineItemsRes.data || [],
            shippingAddress: shippingRes.data || null
        };
    } catch (e) {
        console.error('[Supabase] getOrderFromSupabase error:', e.message);
        return { order: null, lineItems: [], shippingAddress: null };
    }
}

/**
 * Upsert a row in order_tracking to record EasyEcom push result.
 * @param {string} shopifyOrderId
 * @param {object} trackingData  - fields to upsert
 */
async function upsertOrderTracking(shopifyOrderId, trackingData) {
    const id = String(shopifyOrderId);
    try {
        // Check if row exists first
        const { data: existing } = await supabase
            .from('order_tracking')
            .select('id')
            .eq('order_id', id)
            .eq('source', 'easyecom')
            .single();

        if (existing) {
            await supabase
                .from('order_tracking')
                .update({ ...trackingData, updated_at: new Date().toISOString() })
                .eq('id', existing.id);
        } else {
            await supabase
                .from('order_tracking')
                .insert({ order_id: id, source: 'easyecom', ...trackingData });
        }
    } catch (e) {
        console.error('[Supabase] upsertOrderTracking error:', e.message);
    }
}

module.exports = { supabase, getOrderFromSupabase, upsertOrderTracking };
