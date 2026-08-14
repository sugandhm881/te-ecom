// ─────────────────────────────────────────────────────────────────────────────
// Influencer Marketing CRM — port of the standalone Influencer CRM dashboard.
// Reads/writes the SAME Supabase tables the original app used (influencers,
// influencer_videos, influencer_lists, influencer_list_members,
// influencer_activities, analysis_queue, brand_mention_scans, shopify_products)
// and invokes the SAME deployed edge functions (analyze-influencer,
// fetch-reel-metrics, refresh-recent-video-metrics, scan-brand-mentions,
// check-brand-scan, create-influencer-order, process-analysis-queue).
// Mounted at /api — all routes are under /inf/* and gated by _VIEW_PERMS
// (inf-* permission keys) in server.js.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { supabase } = require('../supabase');
const { sendMailAs, sendMail, getUserMailbox, getEmailConfig } = require('./email_settings');
const { aiComplete, isConfigured: aiConfigured, lastAiError: aiLastError } = require('./ai');

// Invoke a deployed Supabase edge function with the service-role key (passes verify_jwt).
async function invokeFn(slug, payload, timeout = 180000) {
    const r = await axios.post(`${config.SUPABASE_URL}/functions/v1/${slug}`, payload || {}, {
        headers: { Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
        timeout, validateStatus: () => true,
    });
    return r;
}

async function logActivity(influencerId, type, description) {
    try {
        await supabase.from('influencer_activities').insert({
            influencer_id: influencerId, activity_type: type, description: String(description || '').slice(0, 500),
        });
    } catch (_) { /* activity logging must never break the main operation */ }
}

const num = v => (v === '' || v === null || v === undefined) ? null : Number(v);
const cleanHandle = h => String(h || '').replace(/^@/, '').trim().toLowerCase();
// Collab-product quantities: a {productId: qty} map stored in `product_qty` (jsonb) alongside `product_ids`.
// Qty is clamped 1–100; anything unparseable or ≤0 is dropped, and a missing entry means 1 — so the map is
// purely additive and an absent/garbage value can never change which products are selected.
function sanitizeQtyMap(v) {
    const out = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, raw] of Object.entries(v)) {
            const n = parseInt(raw, 10);
            if (String(k).trim() && Number.isFinite(n) && n > 0) out[String(k)] = Math.min(n, 100);
        }
    }
    return out;
}
// Author label for activity/note descriptions — the user's real name (JWT `name` claim), not their email.
const actorName = req => (req && req.user && (req.user.name || req.user.sub)) || 'portal';

// Full outreach lifecycle — mirrors the statuses the original standalone Influencer CRM writes (the shared
// DB already contains declined / not_replying / hold rows), so the portal can display AND set them all.
const STATUSES = ['not_contacted', 'reached_out', 'in_discussion', 'partnered', 'not_replying', 'declined', 'rejected', 'hold', 'expensive_profile'];

// ── Dashboard summary ────────────────────────────────────────────────────────
router.get('/inf/summary', async (req, res) => {
    try {
        const B = () => supabase.from('influencers').select('id', { count: 'exact', head: true });
        const [total, partnered, discussion, reached, lists, acts] = await Promise.all([
            B(),
            B().eq('outreach_status', 'partnered'),
            B().eq('outreach_status', 'in_discussion'),
            B().eq('outreach_status', 'reached_out'),
            supabase.from('influencer_lists').select('id', { count: 'exact', head: true }),
            supabase.from('influencer_activities').select('id, influencer_id, activity_type, description, created_at')
                .order('created_at', { ascending: false }).limit(10),
        ]);
        // attach influencer names to the activity feed
        const ids = [...new Set((acts.data || []).map(a => a.influencer_id).filter(Boolean))];
        let names = {};
        if (ids.length) {
            const { data } = await supabase.from('influencers').select('id, name, instagram_handle').in('id', ids);
            (data || []).forEach(i => { names[i.id] = { name: i.name, handle: i.instagram_handle }; });
        }
        res.json({
            success: true,
            kpis: {
                total: total.count || 0, partnered: partnered.count || 0,
                in_discussion: discussion.count || 0, reached_out: reached.count || 0, lists: lists.count || 0,
            },
            activities: (acts.data || []).map(a => ({ ...a, influencer: names[a.influencer_id] || null })),
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Influencers table (full set — the frontend filters/sorts client-side like the original) ──
router.get('/inf/influencers', async (req, res) => {
    try {
        const out = [];
        for (let from = 0; ; from += 1000) {   // paginate past Supabase's 1000-row cap
            const { data, error } = await supabase.from('influencers')
                .select('id, instagram_handle, name, follower_count, niche, city, state, location, phone, email, outreach_status, engagement_rate, engagement_quality, profile_image_url, quoted_price, final_price, next_video_expected_date, created_at')
                .order('created_at', { ascending: false }).range(from, from + 999);
            if (error) throw new Error(error.message);
            out.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        res.json({ success: true, influencers: out });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Create (manual add / add-to-CRM from Discover)
router.post('/inf/influencers', async (req, res) => {
    try {
        const b = req.body || {};
        const handle = cleanHandle(b.instagram_handle);
        if (!handle) return res.status(400).json({ success: false, error: 'Instagram handle is required.' });
        const { data: existing } = await supabase.from('influencers').select('id').eq('instagram_handle', handle).maybeSingle();
        if (existing) return res.status(409).json({ success: false, error: '@' + handle + ' is already in the CRM.', id: existing.id });
        const row = {
            instagram_handle: handle,
            name: b.name || null, phone: b.phone || null, email: b.email || null,
            niche: b.niche || null, city: b.city || null, state: b.state || null, location: b.location || null,
            follower_count: num(b.follower_count), engagement_rate: num(b.engagement_rate),
            engagement_quality: b.engagement_quality || null,
            bio: b.bio || null, profile_image_url: b.profile_image_url || null,
            quoted_price: num(b.quoted_price), final_price: num(b.final_price),
            outreach_status: STATUSES.includes(b.outreach_status) ? b.outreach_status : 'not_contacted',
            notes: b.notes || null,
            product_ids: Array.isArray(b.product_ids) ? b.product_ids : null,
            product_qty: sanitizeQtyMap(b.product_qty),
        };
        const { data, error } = await supabase.from('influencers').insert(row).select('id').single();
        if (error) throw new Error(error.message);
        await logActivity(data.id, 'note', `Added to CRM${b.source ? ' via ' + b.source : ''} by ${actorName(req)}`);
        res.json({ success: true, id: data.id });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Full detail: influencer + videos + activity timeline + list memberships
router.get('/inf/influencer/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const [inf, vids, acts, memb] = await Promise.all([
            supabase.from('influencers').select('*').eq('id', id).single(),
            supabase.from('influencer_videos').select('*').eq('influencer_id', id).order('created_at', { ascending: false }),
            supabase.from('influencer_activities').select('*').eq('influencer_id', id).order('created_at', { ascending: false }).limit(100),
            supabase.from('influencer_list_members').select('list_id, influencer_lists(id, name)').eq('influencer_id', id),
        ]);
        if (inf.error || !inf.data) return res.status(404).json({ success: false, error: 'Influencer not found' });
        // Outreach-email state, so the detail panel can show the same ✓ / Send Email control as the
        // campaign list (same rule: partnered AND never emailed).
        const emailed = await emailedIds([Number(id)]);
        const email_sent = emailed.has(Number(id));
        res.json({
            success: true, influencer: inf.data, videos: vids.data || [], activities: acts.data || [],
            lists: (memb.data || []).map(m => m.influencer_lists).filter(Boolean),
            email_sent, can_email: inf.data.outreach_status === 'partnered' && !email_sent,
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Update (quick-edit sidebar / status transitions)
router.post('/inf/influencer/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const b = req.body || {};
        const patch = { updated_at: new Date().toISOString() };
        ['name', 'phone', 'email', 'niche', 'city', 'state', 'location', 'address1', 'address2', 'pincode',
         'bio', 'notes', 'engagement_quality', 'next_video_expected_date'].forEach(k => { if (b[k] !== undefined) patch[k] = b[k] || null; });
        ['follower_count', 'engagement_rate', 'quoted_price', 'final_price'].forEach(k => { if (b[k] !== undefined) patch[k] = num(b[k]); });
        if (b.product_ids !== undefined) patch.product_ids = Array.isArray(b.product_ids) ? b.product_ids : null;   // default collab products
        if (b.product_qty !== undefined) patch.product_qty = sanitizeQtyMap(b.product_qty);                          // {productId: qty} for those products
        let statusChanged = null;
        if (b.outreach_status !== undefined) {
            if (!STATUSES.includes(b.outreach_status)) return res.status(400).json({ success: false, error: 'Invalid outreach status.' });
            const { data: cur } = await supabase.from('influencers').select('outreach_status').eq('id', id).single();
            if (cur && cur.outreach_status !== b.outreach_status) statusChanged = b.outreach_status;
            patch.outreach_status = b.outreach_status;
        }
        const { error } = await supabase.from('influencers').update(patch).eq('id', id);
        if (error) throw new Error(error.message);
        if (statusChanged) {
            const noteTxt = String(b.note || '').trim().slice(0, 500);   // optional reason for the status change
            const desc = `Status changed to ${statusChanged.replace(/_/g, ' ')} by ${actorName(req)}` + (noteTxt ? ` — “${noteTxt}”` : '');
            await logActivity(id, 'status_change', desc);
        } else if (b.note && String(b.note).trim()) {
            // A standalone note (no status change) still gets logged to the activity feed.
            await logActivity(id, 'note', `${String(b.note).trim().slice(0, 500)} — by ${actorName(req)}`);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/inf/influencer/:id', async (req, res) => {
    try {
        const id = req.params.id;
        // children first — the original schema has no ON DELETE CASCADE
        await supabase.from('influencer_videos').delete().eq('influencer_id', id);
        await supabase.from('influencer_activities').delete().eq('influencer_id', id);
        await supabase.from('influencer_list_members').delete().eq('influencer_id', id);
        const { error } = await supabase.from('influencers').delete().eq('id', id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Bulk actions: status change / add to list
router.post('/inf/influencers/bulk', async (req, res) => {
    try {
        const { ids, action, status, listId } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids[] required' });
        if (action === 'status') {
            if (!STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });
            const { error } = await supabase.from('influencers').update({ outreach_status: status, updated_at: new Date().toISOString() }).in('id', ids);
            if (error) throw new Error(error.message);
            await supabase.from('influencer_activities').insert(ids.map(i => ({
                influencer_id: i, activity_type: 'status_change', description: `Status changed to ${status.replace(/_/g, ' ')} (bulk) by ${actorName(req)}`,
            })));
            return res.json({ success: true, updated: ids.length });
        }
        if (action === 'add-to-list') {
            if (!listId) return res.status(400).json({ success: false, error: 'listId required' });
            const { data: existing } = await supabase.from('influencer_list_members').select('influencer_id').eq('list_id', listId).in('influencer_id', ids);
            const have = new Set((existing || []).map(m => m.influencer_id));
            const fresh = ids.filter(i => !have.has(i));
            if (fresh.length) {
                const { error } = await supabase.from('influencer_list_members').insert(fresh.map(i => ({ list_id: listId, influencer_id: i })));
                if (error) throw new Error(error.message);
            }
            return res.json({ success: true, added: fresh.length, skipped: ids.length - fresh.length });
        }
        res.status(400).json({ success: false, error: 'Unknown action' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Videos (deliverables) ────────────────────────────────────────────────────
const VIDEO_FIELDS_TEXT = ['video_url', 'ad_code', 'caption', 'language', 'notes', 'reference_url', 'payment_status', 'thumbnail_url'];
const VIDEO_FIELDS_NUM = ['quoted_price', 'final_price', 'likes', 'comments', 'views', 'shares'];
const VIDEO_FIELDS_DATE = ['expected_date', 'live_date', 'payment_due_date', 'payment_date'];
const VIDEO_FIELDS_BOOL = ['gst_applicable', 'is_ad_run', 'email_sent', 'product_sent'];

function videoPatch(b) {
    const patch = {};
    VIDEO_FIELDS_TEXT.forEach(k => { if (b[k] !== undefined) patch[k] = b[k] || null; });
    VIDEO_FIELDS_NUM.forEach(k => { if (b[k] !== undefined) patch[k] = num(b[k]); });
    VIDEO_FIELDS_DATE.forEach(k => { if (b[k] !== undefined) patch[k] = b[k] || null; });
    VIDEO_FIELDS_BOOL.forEach(k => { if (b[k] !== undefined) patch[k] = !!b[k]; });
    if (b.product_ids !== undefined) patch.product_ids = Array.isArray(b.product_ids) ? b.product_ids : null;
    if (b.product_qty !== undefined) patch.product_qty = sanitizeQtyMap(b.product_qty);
    return patch;
}

router.post('/inf/videos', async (req, res) => {
    try {
        const b = req.body || {};
        if (!b.influencer_id) return res.status(400).json({ success: false, error: 'influencer_id required' });
        const row = { influencer_id: b.influencer_id, ...videoPatch(b) };
        if (!row.payment_status) row.payment_status = 'pending';
        const { data, error } = await supabase.from('influencer_videos').insert(row).select('id').single();
        if (error) throw new Error(error.message);
        await logActivity(b.influencer_id, 'video_added', `Video added${row.expected_date ? ' (expected ' + row.expected_date + ')' : ''} by ${actorName(req)}`);
        res.json({ success: true, id: data.id });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/inf/videos/:id', async (req, res) => {   // used to poll metrics_fetched_at after a fetch
    const { data, error } = await supabase.from('influencer_videos').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ success: false, error: 'Video not found' });
    res.json({ success: true, video: data });
});

router.post('/inf/videos/:id', async (req, res) => {
    try {
        const patch = videoPatch(req.body || {});
        if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: 'Nothing to update' });
        const { data: before } = await supabase.from('influencer_videos').select('influencer_id, payment_status').eq('id', req.params.id).single();
        const { error } = await supabase.from('influencer_videos').update(patch).eq('id', req.params.id);
        if (error) throw new Error(error.message);
        if (before && patch.payment_status && patch.payment_status !== before.payment_status) {
            await logActivity(before.influencer_id, 'payment', `Payment marked ${patch.payment_status} by ${actorName(req)}`);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/inf/videos/:id', async (req, res) => {
    // If this video had a product order, PRESERVE the order reference on the influencer (orphan_orders)
    // so it stays trackable after the video is gone — otherwise the order is orphaned in Shopify.
    try {
        const { data: v } = await supabase.from('influencer_videos')
            .select('influencer_id, shopify_draft_order_id, shopify_draft_order_url, product_sent_at')
            .eq('id', req.params.id).maybeSingle();
        if (v && v.shopify_draft_order_id) {
            const { data: inf } = await supabase.from('influencers').select('orphan_orders').eq('id', v.influencer_id).maybeSingle();
            const list = Array.isArray(inf && inf.orphan_orders) ? inf.orphan_orders : [];
            if (!list.some(o => String(o.order_id) === String(v.shopify_draft_order_id))) {
                const { data: ord } = await supabase.from('orders').select('name').eq('id', String(v.shopify_draft_order_id)).maybeSingle();
                list.push({ order_id: String(v.shopify_draft_order_id), order_name: (ord && ord.name) || null, order_url: v.shopify_draft_order_url || null, at: v.product_sent_at || new Date().toISOString() });
                await supabase.from('influencers').update({ orphan_orders: list }).eq('id', v.influencer_id);
            }
        }
    } catch (e) { console.error('[inf] preserve order on video delete failed:', e.message); }
    const { error } = await supabase.from('influencer_videos').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true });
});

// Fetch metrics for one reel (Apify, async server-side — poll GET /inf/videos/:id for metrics_fetched_at)
router.post('/inf/videos/:id/metrics', async (req, res) => {
    try {
        const { data: v } = await supabase.from('influencer_videos').select('id, video_url').eq('id', req.params.id).single();
        if (!v || !v.video_url) return res.status(400).json({ success: false, error: 'Video has no URL to fetch.' });
        const r = await invokeFn('fetch-reel-metrics', { url: v.video_url, videoId: v.id }, 30000);
        if (r.status >= 400) return res.status(502).json({ success: false, error: (r.data && r.data.error) || `fetch-reel-metrics returned ${r.status}` });
        res.json({ success: true, status: 'processing' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Bulk refresh recent reel metrics ("Refresh Last N Days") — returns how many were scheduled
router.post('/inf/refresh-videos', async (req, res) => {
    try {
        const b = req.body || {};
        const payload = {};
        if (b.scope === 'all') payload.scope = 'all';
        if (b.influencerId) payload.influencerId = b.influencerId;
        if (b.days) payload.days = Number(b.days);
        const r = await invokeFn('refresh-recent-video-metrics', payload, 30000);
        if (r.status >= 400) return res.status(502).json({ success: false, error: (r.data && r.data.error) || `refresh returned ${r.status}` });
        res.json({ success: true, scheduled: (r.data && r.data.scheduled) || 0, startedAt: new Date().toISOString() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Progress for the bulk refresh: how many in-scope videos have metrics_fetched_at AFTER startedAt
router.get('/inf/refresh-progress', async (req, res) => {
    try {
        const since = req.query.since;
        if (!since) return res.status(400).json({ success: false, error: 'since required' });
        let q = supabase.from('influencer_videos').select('id', { count: 'exact', head: true }).gte('metrics_fetched_at', since);
        if (req.query.influencerId) q = q.eq('influencer_id', req.query.influencerId);
        const { count, error } = await q;
        if (error) throw new Error(error.message);
        res.json({ success: true, done: count || 0 });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Add a note to the timeline
router.post('/inf/activities', async (req, res) => {
    try {
        const { influencer_id, description } = req.body || {};
        if (!influencer_id || !String(description || '').trim()) return res.status(400).json({ success: false, error: 'influencer_id and description required' });
        await supabase.from('influencer_activities').insert({
            influencer_id, activity_type: 'note',
            description: `${String(description).trim().slice(0, 480)} — ${actorName(req)}`,
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Lists (campaigns) ────────────────────────────────────────────────────────
// Auto-detect a date range from the list name — "Diwali 2025" → Oct-Nov 2025, "March 2026" → that month.
// Last day of a month (1-based) as a plain YYYY-MM-DD string. Do NOT use
// `new Date(year, month, 0).toISOString().slice(0,10)` — that builds LOCAL midnight of the last day, and
// toISOString() shifts it back to UTC (−5:30 in IST), landing on the PREVIOUS day, which silently drops
// anything on the last day of the month (e.g. a 31-Jul next-video vanished from the calendar). getDate()
// reads the local day-of-month with no timezone conversion.
const monthEnd = (year, month) => `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
const FESTIVAL_MONTHS = { diwali: [10, 11], holi: [3, 3], rakhi: [8, 8], christmas: [12, 12], valentine: [2, 2], newyear: [1, 1] };
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function detectRange(name) {
    const s = String(name || '').toLowerCase();
    const yearM = s.match(/20\d{2}/);
    if (!yearM) return null;
    const year = Number(yearM[0]);
    for (const [fest, [m1, m2]] of Object.entries(FESTIVAL_MONTHS)) {
        if (s.includes(fest)) return { from: `${year}-${String(m1).padStart(2, '0')}-01`, to: monthEnd(year, m2), label: fest + ' ' + year };
    }
    for (let i = 0; i < 12; i++) {
        if (s.includes(MONTH_NAMES[i]) || s.includes(MONTH_NAMES[i].slice(0, 3))) {
            return { from: `${year}-${String(i + 1).padStart(2, '0')}-01`, to: monthEnd(year, i + 1), label: MONTH_NAMES[i] + ' ' + year };
        }
    }
    return null;
}

router.get('/inf/lists', async (req, res) => {
    try {
        const [lists, members] = await Promise.all([
            supabase.from('influencer_lists').select('*').order('created_at', { ascending: false }),
            supabase.from('influencer_list_members').select('list_id'),
        ]);
        const counts = {};
        (members.data || []).forEach(m => { counts[m.list_id] = (counts[m.list_id] || 0) + 1; });
        res.json({ success: true, lists: (lists.data || []).map(l => ({ ...l, member_count: counts[l.id] || 0, range: detectRange(l.name) })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/inf/lists', async (req, res) => {
    try {
        const { name, description } = req.body || {};
        if (!String(name || '').trim()) return res.status(400).json({ success: false, error: 'Name is required.' });
        const { data, error } = await supabase.from('influencer_lists').insert({ name: String(name).trim(), description: description || null }).select('id').single();
        if (error) throw new Error(error.message);
        res.json({ success: true, id: data.id });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/inf/lists/:id', async (req, res) => {
    try {
        await supabase.from('influencer_list_members').delete().eq('list_id', req.params.id);
        const { error } = await supabase.from('influencer_lists').delete().eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// List detail: members with per-influencer rollups (views in range, spend, CPM) + totals
router.get('/inf/lists/:id', async (req, res) => {
    try {
        const { data: list, error: le } = await supabase.from('influencer_lists').select('*').eq('id', req.params.id).single();
        if (le || !list) return res.status(404).json({ success: false, error: 'List not found' });
        const range = detectRange(list.name);
        const { data: memb } = await supabase.from('influencer_list_members').select('influencer_id, added_at').eq('list_id', req.params.id);
        const ids = (memb || []).map(m => m.influencer_id);
        let members = [], totals = { quoted: 0, final: 0, gst: 0, spend: 0, views: 0 };
        if (ids.length) {
            const [infs, vids, emailed] = await Promise.all([
                supabase.from('influencers').select('id, instagram_handle, name, follower_count, niche, outreach_status, profile_image_url, email').in('id', ids),
                supabase.from('influencer_videos').select('id, created_at, influencer_id, views, likes, comments, shares, live_date, expected_date, quoted_price, final_price, gst_applicable, payment_status, product_sent, email_sent, is_ad_run, payment_due_date, payment_date').in('influencer_id', ids),
                emailedIds(ids),   // sent-log ∪ legacy per-video flag — see the outreach-email section below
            ]);
            const vidsBy = {};
            (vids.data || []).forEach(v => { (vidsBy[v.influencer_id] = vidsBy[v.influencer_id] || []).push(v); });
            members = (infs.data || []).map(i => {
                const all = vidsBy[i.id] || [];
                const inRange = range ? all.filter(v => v.live_date && v.live_date >= range.from && v.live_date <= range.to) : all;
                const sum = (arr, k) => arr.reduce((s, v) => s + (Number(v[k]) || 0), 0);
                const views = sum(inRange, 'views');
                const quoted = all.reduce((s, v) => s + (Number(v.quoted_price) || 0), 0);
                const finalP = all.reduce((s, v) => s + (Number(v.final_price) || Number(v.quoted_price) || 0), 0);
                const gst = all.reduce((s, v) => s + (v.gst_applicable ? 0.18 * (Number(v.final_price) || Number(v.quoted_price) || 0) : 0), 0);
                const spend = finalP + gst;
                // PAYMENT = the LATEST deliverable's own status, not an all-videos roll-up. An influencer paid
                // for January and unpaid for July is UNPAID; the old roll-up reported that as "partial", which
                // both hid the outstanding amount and collided with 'partial' — a real per-video status a single
                // video can hold. It also read `all[0]` while the `.find()` had matched a different video, and
                // `all` comes back in no guaranteed order, so the fallback status was effectively arbitrary.
                // Recency: live_date → expected_date → created_at, id as the final tiebreak.
                const _recency = v => v.live_date || v.expected_date || String(v.created_at || '').slice(0, 10) || '';
                const latest = all.length
                    ? all.slice().sort((a, b) => (_recency(a) < _recency(b) ? -1 : _recency(a) > _recency(b) ? 1 : (a.id || 0) - (b.id || 0))).pop()
                    : null;
                const payment = latest ? String(latest.payment_status || 'pending').toLowerCase() : null;
                const _latestPaid = payment === 'paid';
                // Booleans stay "any deliverable" — product/email/ad are one-off milestones, not per-video money.
                totals.quoted += quoted; totals.final += finalP; totals.gst += gst; totals.spend += spend; totals.views += views;
                return {
                    ...i, videos: all.length, views_in_range: views, quoted, final: finalP,
                    gst: Math.round(gst), spend: Math.round(spend), cpm: views > 0 ? Math.round((spend / views) * 1000) : null,
                    likes: sum(inRange, 'likes'), comments: sum(inRange, 'comments'), shares: sum(inRange, 'shares'),
                    final_price: finalP, payment,
                    // Dates come from that SAME video, so the badge and the date underneath can't disagree.
                    payment_date: _latestPaid ? (latest.payment_date || null) : null,
                    payment_due_date: !_latestPaid && latest ? (latest.payment_due_date || null) : null,
                    product_sent: all.some(v => v.product_sent === true),
                    // Emailed = ever, by anyone: our send log OR the legacy per-video flag. Once true the UI
                    // shows a tick and never offers Send again, whatever the status becomes later.
                    email_sent: emailed.has(i.id),
                    // `can_email` drives the button: partnered AND never emailed. The send endpoint re-checks
                    // both, so this is a UI hint, not the guard.
                    can_email: i.outreach_status === 'partnered' && !emailed.has(i.id),
                    email: i.email || null,
                    ad_run: all.some(v => v.is_ad_run === true),
                };
            }).sort((a, b) => (b.views_in_range - a.views_in_range));
        }
        totals.gst = Math.round(totals.gst); totals.spend = Math.round(totals.spend);
        totals.cpm = totals.views > 0 ? Math.round((totals.spend / totals.views) * 1000) : null;
        res.json({ success: true, list, range, members, totals });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/inf/lists/:id/members', async (req, res) => {
    try {
        const { influencerId } = req.body || {};
        if (!influencerId) return res.status(400).json({ success: false, error: 'influencerId required' });
        const { data: dup } = await supabase.from('influencer_list_members').select('id').eq('list_id', req.params.id).eq('influencer_id', influencerId).maybeSingle();
        if (dup) return res.status(409).json({ success: false, error: 'Already in this list.' });
        const { error } = await supabase.from('influencer_list_members').insert({ list_id: req.params.id, influencer_id: influencerId });
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/inf/lists/:id/members/:influencerId', async (req, res) => {
    const { error } = await supabase.from('influencer_list_members').delete().eq('list_id', req.params.id).eq('influencer_id', req.params.influencerId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true });
});

// ── Video calendar (one month of expected/live videos) ──────────────────────
router.get('/inf/calendar', async (req, res) => {
    try {
        const year = Number(req.query.year), month = Number(req.query.month);   // month 1-12
        if (!year || !month) return res.status(400).json({ success: false, error: 'year & month required' });
        const from = `${year}-${String(month).padStart(2, '0')}-01`;
        const to = monthEnd(year, month);   // last day as YYYY-MM-DD — see monthEnd note (no TZ shift)
        const { data: vids, error } = await supabase.from('influencer_videos')
            .select('id, influencer_id, expected_date, live_date, payment_status, video_url')
            .or(`and(expected_date.gte.${from},expected_date.lte.${to}),and(live_date.gte.${from},live_date.lte.${to})`);
        if (error) throw new Error(error.message);
        // Also surface each influencer's planned NEXT video (influencers.next_video_expected_date) as an
        // "expected" entry — that's the source of the calendar's upcoming markers (influencer_videos rarely
        // carries a forward expected_date). Rendered amber (expected) or red (overdue, if past) by the frontend.
        const { data: nexts, error: nErr } = await supabase.from('influencers')
            .select('id, next_video_expected_date')
            .gte('next_video_expected_date', from).lte('next_video_expected_date', to);
        if (nErr) throw new Error(nErr.message);
        // Suppress a next-expected marker once the influencer has actually delivered: if they have any live
        // video on/after their expected date they've posted, so a stale next_video_expected_date must NOT read
        // as overdue nor duplicate the green 'live' pill on the same day. Only undelivered dates stay expected/overdue.
        const nextIds = [...new Set((nexts || []).map(n => n.id))];
        const lastLive = {};
        for (let i = 0; i < nextIds.length; i += 300) {
            const { data: lrs } = await supabase.from('influencer_videos')
                .select('influencer_id, live_date').in('influencer_id', nextIds.slice(i, i + 300)).not('live_date', 'is', null);
            (lrs || []).forEach(r => { if (r.live_date && (!lastLive[r.influencer_id] || r.live_date > lastLive[r.influencer_id])) lastLive[r.influencer_id] = r.live_date; });
        }
        const nextEntries = (nexts || [])
            .filter(inf => !(lastLive[inf.id] && lastLive[inf.id] >= inf.next_video_expected_date))
            .map(inf => ({
                id: `next-${inf.id}`, influencer_id: inf.id, expected_date: inf.next_video_expected_date,
                live_date: null, payment_status: null, video_url: null, source: 'next_expected',
            }));
        const allVids = [...(vids || []), ...nextEntries];
        const ids = [...new Set(allVids.map(v => v.influencer_id))];
        let handles = {};
        if (ids.length) {
            for (let i = 0; i < ids.length; i += 300) {
                const { data } = await supabase.from('influencers').select('id, instagram_handle, name').in('id', ids.slice(i, i + 300));
                (data || []).forEach(x => { handles[x.id] = { handle: x.instagram_handle, name: x.name }; });
            }
        }
        res.json({ success: true, from, to, videos: allVids.map(v => ({ ...v, influencer: handles[v.influencer_id] || null })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Discover (AI analysis via analyze-influencer edge fn) ────────────────────
router.post('/inf/discover', async (req, res) => {
    try {
        const handle = cleanHandle((req.body || {}).handle);
        if (!handle) return res.status(400).json({ success: false, error: 'Handle is required.' });
        const r = await invokeFn('analyze-influencer', { handle }, 240000);   // Apify scrape (60s×2) + AI can take a while
        if (r.status >= 400) return res.status(502).json({ success: false, error: (r.data && r.data.error) || `analyze-influencer returned ${r.status}` });
        res.json({ success: true, result: r.data });   // full analysis, or {queued:true, queue_id} if scrapers timed out
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/inf/discover/history', async (req, res) => {
    try {
        const { data, error } = await supabase.from('analysis_queue')
            .select('id, handle, status, source, source_brand, error_message, created_at, completed_at, result')
            .order('created_at', { ascending: false }).limit(60);
        if (error) throw new Error(error.message);
        // trim the heavy recent_posts array out of list payloads
        const rows = (data || []).map(r => {
            if (r.result && typeof r.result === 'object') { const { recent_posts, ...rest } = r.result; return { ...r, result: rest }; }
            return r;
        });
        res.json({ success: true, rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Drain pending analysis_queue rows (brand-scan discoveries) via the worker edge fn
router.post('/inf/discover/process-queue', async (req, res) => {
    try {
        const r = await invokeFn('process-analysis-queue', {}, 30000);
        if (r.status >= 400) return res.status(502).json({ success: false, error: (r.data && r.data.error) || `process-analysis-queue returned ${r.status}` });
        res.json({ success: true, result: r.data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Brand mention scans ──────────────────────────────────────────────────────
router.get('/inf/mentions', async (req, res) => {
    try {
        const { data, error } = await supabase.from('brand_mention_scans').select('*').order('created_at', { ascending: false }).limit(50);
        if (error) throw new Error(error.message);
        res.json({ success: true, scans: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/inf/mentions/scan', async (req, res) => {
    try {
        const b = req.body || {};
        const brandHandle = cleanHandle(b.brandHandle);
        if (!brandHandle) return res.status(400).json({ success: false, error: 'Brand handle is required.' });
        const r = await invokeFn('scan-brand-mentions', {
            brandHandle, maxPosts: Number(b.maxPosts) || 10,
            minComments: Number(b.minComments) || 0, minViews: Number(b.minViews) || 0,
            filterMode: b.filterMode === 'any' ? 'any' : 'all',
        }, 60000);
        if (r.status >= 400) return res.status(502).json({ success: false, error: (r.data && r.data.error) || `scan returned ${r.status}` });
        res.json({ success: true, scanId: r.data && r.data.scanId, status: 'running' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/inf/mentions/check', async (req, res) => {
    try {
        const { scanId } = req.body || {};
        if (!scanId) return res.status(400).json({ success: false, error: 'scanId required' });
        const r = await invokeFn('check-brand-scan', { scanId }, 120000);
        if (r.status >= 400) return res.status(502).json({ success: false, error: (r.data && r.data.error) || `check returned ${r.status}` });
        res.json({ success: true, ...r.data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Products & Send Product (Shopify draft order via edge fn) ────────────────
router.get('/inf/products', async (req, res) => {
    try {
        const { data, error } = await supabase.from('shopify_products')
            .select('id, shopify_product_id, shopify_variant_id, product_title, variant_title, sku, price, compare_at_price, product_type, tags, image_url, inventory_quantity, product_status')
            .eq('product_status', 'active').order('product_title');
        if (error) throw new Error(error.message);
        // Title lookup across ALL statuses so a previously-saved product_id that's now archived / drafted /
        // filtered-out still resolves to a name in the picker chips (instead of showing the raw numeric id).
        const { data: allNames } = await supabase.from('shopify_products').select('shopify_product_id, product_title, sku');
        const names = {};
        (allNames || []).forEach(p => { const k = String(p.shopify_product_id || ''); if (k && !names[k]) names[k] = p.product_title || (p.sku ? 'SKU ' + p.sku : null); });
        res.json({ success: true, products: data || [], names });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/inf/send-product', async (req, res) => {
    try {
        const b = req.body || {};
        if (!b.videoId || !b.influencerId) return res.status(400).json({ success: false, error: 'videoId and influencerId required' });
        if (!b.address1 || !b.pincode || !b.phone) return res.status(400).json({ success: false, error: 'Address line 1, pincode and phone are required.' });
        if (!Array.isArray(b.productIds) || !b.productIds.length) return res.status(400).json({ success: false, error: 'Pick at least one product.' });
        const payload = {
            videoId: b.videoId, influencerId: b.influencerId,
            address1: b.address1, address2: b.address2 || '', city: b.city || '', state: b.state || '',
            pincode: b.pincode, phone: b.phone, email: b.email || undefined, name: b.name || 'Influencer',
            handle: b.handle || undefined,               // → INFLUENCER @handle company line on label/invoice
        };
        // Prefer the EXACT representative variant the picker showed (Pack-of-1 for solo / Combo Pack for combo).
        // Without it the edge fn re-resolves each product to its FIRST in-stock variant, shipping the wrong pack
        // size (chose BDR1 → shipped BDR4). Fall back to productIds only if no variant ids came through.
        const variantIds = Array.isArray(b.productVariantIds) ? b.productVariantIds.filter(Boolean).map(String) : [];
        if (variantIds.length === b.productIds.length) payload.productVariantIds = variantIds;   // 1:1 cover → use exact variants
        else payload.productIds = b.productIds.map(String);                                       // incomplete → let the edge fn resolve
        // Per-product quantity, index-aligned with productIds/productVariantIds. Clamped 1–100 and padded to
        // full length so a short/absent array can never mis-align the line items (missing → 1, the old behaviour).
        const qClamp = v => Math.max(1, Math.min(100, parseInt(v, 10) || 1));
        payload.quantities = b.productIds.map((_, i) => qClamp(Array.isArray(b.quantities) ? b.quantities[i] : 1));
        const units = payload.quantities.reduce((a, c) => a + c, 0);
        const r = await invokeFn('create-influencer-order', payload, 120000);
        if (r.status >= 400) return res.status(502).json({ success: false, error: (r.data && (r.data.error || r.data.details)) || `create-order returned ${r.status}` });
        // persist the shipping address back onto the influencer for next time + log
        supabase.from('influencers').update({
            address1: b.address1, address2: b.address2 || null, city: b.city || null, state: b.state || null,
            pincode: b.pincode, phone: b.phone, updated_at: new Date().toISOString(),
        }).eq('id', b.influencerId).then(() => {}).catch(() => {});
        const orderName = r.data.orderName || r.data.orderId || r.data.draftOrderId;
        await logActivity(b.influencerId, 'product_sent', `Prepaid order ${orderName} created (${b.productIds.length} item${b.productIds.length > 1 ? 's' : ''}${units !== b.productIds.length ? `, ${units} units` : ''}) by ${actorName(req)}`);
        res.json({ success: true, orderId: r.data.orderId || r.data.draftOrderId, orderName, orderUrl: r.data.orderUrl || r.data.draftOrderUrl });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Track an influencer order's courier status — reads OUR tracking data (no Shopify admin redirect).
// Matches the video's Shopify order id → `orders` mirror (AWB/courier/tracking_status) → `shipment_journey_ecom`
// (milestone timeline). Returns a compact tracking object the CRM renders as a customer-style timeline.
router.get('/inf/order-tracking', async (req, res) => {
    try {
        const videoId = req.query.videoId;
        // Track by an explicit orderId (preserved orphan orders from deleted videos) OR by videoId.
        let orderId = req.query.orderId ? String(req.query.orderId) : null;
        let vid = null;   // outer scope — the response below reads vid.shopify_draft_order_url
        if (!orderId) {
            if (!videoId) return res.status(400).json({ success: false, error: 'videoId or orderId required' });
            const vr = await supabase.from('influencer_videos')
                .select('shopify_draft_order_id, shopify_draft_order_url, product_sent').eq('id', videoId).maybeSingle();
            vid = vr.data;
            orderId = vid && vid.shopify_draft_order_id;
        }
        if (!orderId) return res.json({ success: true, tracking: null });

        const { data: ord } = await supabase.from('orders')
            .select('id, name, awb_number, courier_name, tracking_status, fulfillment_status, cancelled_at, created_at')
            .eq('id', String(orderId)).maybeSingle();
        const awb = ord && ord.awb_number;

        let j = null;
        if (awb) {
            const { data } = await supabase.from('shipment_journey_ecom')
                .select('awb, courier, outcome, dispatched_at, out_for_delivery_at, delivered_at, rto_at, first_edd, attempts, ndr_reasons, dest_city, dest_state')
                .eq('awb', awb).maybeSingle();
            j = data || null;
        }

        const cancelled = !!(ord && ord.cancelled_at);
        const outcome = String((j && j.outcome) || '').toLowerCase();     // journey's classified outcome (delivered/rto/in_transit…)
        const ts = String((ord && ord.tracking_status) || '');            // raw courier string (loose — e.g. "delivery delayed")
        // Precise matches: "delivery delayed" / "out for delivery" / "undelivered" are NOT "delivered".
        const _isDeliveredStr = s => /\bdelivered\b/i.test(s) && !/undelivered/i.test(s);
        const _isRtoStr = s => /\brto\b|\breturn/i.test(s);
        // Prefer the journey outcome; only fall back to the raw tracking_status string when there's no journey.
        const isRto = outcome ? outcome.includes('rto') : _isRtoStr(ts);
        const isDelivered = outcome ? outcome === 'delivered' : _isDeliveredStr(ts);
        let status = 'Processing';
        if (cancelled) status = 'Cancelled';
        else if (isRto) status = 'RTO';
        else if (isDelivered) status = 'Delivered';
        else if (awb) status = 'In Transit';

        const closeAt = isRto ? (j && j.rto_at) : (j && j.delivered_at);
        const hasAwb = !!awb;
        // `done` reflects the STATUS, not merely whether a timestamp exists — so a Delivered/RTO order shows
        // the final milestone completed even when the journey is missing delivered_at/rto_at (was: the badge
        // said "Delivered" while the timeline still showed "Out for delivery" as the last completed step).
        const milestones = [
            { key: 'ordered', label: 'Order placed', at: (ord && ord.created_at) || null, done: !!(ord && ord.created_at) },
            { key: 'dispatched', label: 'Dispatched', at: (j && j.dispatched_at) || null, done: !!((j && j.dispatched_at) || (j && j.out_for_delivery_at) || hasAwb || isDelivered || isRto) },
            { key: 'ofd', label: 'Out for delivery', at: (j && j.out_for_delivery_at) || null, done: !!((j && j.out_for_delivery_at) || isDelivered || isRto) },
            { key: isRto ? 'rto' : 'delivered', label: isRto ? 'Returned (RTO)' : 'Delivered', at: closeAt || null, done: !!(isRto || isDelivered) },
        ];

        res.json({
            success: true,
            tracking: {
                orderId: String(orderId), orderName: ord && ord.name || `#${orderId}`,
                status, cancelled, awb: awb || null,
                courier: (ord && ord.courier_name) || (j && j.courier) || null,
                eta: (j && j.first_edd) || null,
                dest: [j && j.dest_city, j && j.dest_state].filter(Boolean).join(', ') || null,
                attempts: (j && j.attempts) != null ? j.attempts : null,
                ndr: (j && j.ndr_reasons) || null,
                shopifyUrl: (vid && vid.shopify_draft_order_url) || null,
                milestones,
            },
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Collaboration outreach email — draft → (optional AI polish) → send → ✓
//
// Gating rule (product decision, 2026-08-04): the Send Email button appears ONLY while the influencer
// is `partnered`, and NEVER again once an email has gone out — regardless of what the status later
// becomes. That is enforced HERE, not only in the UI, so a stale tab or a hand-made request can't
// double-send. `emailedIds()` is the single source of truth for "already emailed" and is shared by the
// list endpoint that renders the tick.
// ─────────────────────────────────────────────────────────────────────────────────────────────────


// Who is allowed to send outreach, and from which mailbox. ONE definition, used by the draft endpoint
// (to show it up front and disable the button) and by the send endpoint (to enforce it).
//
//   mode 'user'   — the logged-in user has their own mapped mailbox: sends as themselves, so the
//                   influencer's reply lands in their inbox. This is the normal path.
//   mode 'master' — an ADMIN with no personal mailbox: falls back to the shared brand mailbox. Not a
//                   silent fallback — it is admin-only, and the compose panel names the exact address.
//   otherwise     — refused. A non-admin without a mapping cannot send at all.
//
// Reading a thread is deliberately NOT gated this way: any user with influencer access can open the
// thread and read the replies. Only SENDING is restricted.
async function outreachSender(req) {
    const email = (req.user && req.user.sub) || '';
    const isMaster = !!(req.user && (req.user.role === 'admin' || (Array.isArray(req.user.permissions) && req.user.permissions.includes('*'))));
    const mb = await getUserMailbox(email);
    if (mb) return { canSend: true, mode: 'user', from: mb.from_email, fromName: mb.from_name, isMaster };
    if (isMaster) {
        const cfg = await getEmailConfig();
        if (cfg && cfg.from) return { canSend: true, mode: 'master', from: cfg.from, fromName: null, isMaster };
        return { canSend: false, isMaster, reason: 'No mailbox is mapped for your account and the shared brand mailbox is not configured — set SMTP under Settings → Email & Reports.' };
    }
    return {
        canSend: false, isMaster,
        reason: `No sending mailbox is mapped for ${email || 'your account'}. Ask an admin to add one under Settings → Email & Reports → Sending mailboxes.`,
    };
}

// Which of these influencers have already been emailed? Union of the new send log and the LEGACY
// influencer_videos.email_sent flag — the old standalone CRM wrote 188 of those and they must keep
// their tick. Returns a Set of influencer_id.
async function emailedIds(ids) {
    const out = new Set();
    if (!ids || !ids.length) return out;
    const [logged, legacy] = await Promise.all([
        supabase.from('influencer_emails_ecom').select('influencer_id').in('influencer_id', ids),
        supabase.from('influencer_videos').select('influencer_id').in('influencer_id', ids).eq('email_sent', true),
    ]);
    (logged.data || []).forEach(r => out.add(r.influencer_id));
    (legacy.data || []).forEach(r => out.add(r.influencer_id));
    return out;
}

// Fixed by the brand — every outreach email carries this exact subject line.
const OUTREACH_SUBJECT = 'Collaboration opportunity with theelement.skin';
const inr = n => (n == null || n === '' || !Number.isFinite(Number(n))) ? null : '₹' + Number(n).toLocaleString('en-IN');

// The house collaboration pitch. Variables are filled from the influencer's saved profile and their
// latest deliverable; anything genuinely unknown becomes a VISIBLE blank (₹______) rather than an
// invented number — a made-up fee in an outbound email is far worse than an obvious gap to fill in.
function collabEmailTemplate({ name, price, sender }) {
    const fee = price ? inr(price) : '₹______';
    return `Hi ${name},

I hope you're doing well!

I'm ${sender}, from theelement.skin, a brand rooted in purity, efficacy, and clean skincare. We've been following your inspiring work on Instagram and are genuinely impressed by your creativity, authenticity, and the strong connection you have with your community.

We believe your style and values align beautifully with ours, and we'd love to explore a collaboration with you for an upcoming video on your Instagram channel.

Here's a quick outline of what we're proposing:

Collaboration Duration: A 3 to 6-month partnership where we work together to create content that integrates our skincare range in a natural, relatable way.

Content Format: We're open to ideas — be it a skincare routine, product demo, daily ritual, or any other engaging concept that feels true to your style and voice.

Flexibility: While we're aiming for a three to six-month collaboration initially, we understand that circumstances may change, and the duration of our partnership might be subject to company discretion and the performance of the video content. We believe in fostering long-term relationships, and we're open to adapting our approach based on mutual satisfaction and success.

Commercials: As discussed, we'll be offering ${fee} for the reel + story set. Payments will be processed within 15-30 days from the invoice date once the content goes live and the partnership ad code is provided. We will also require content rights and raw footage, and we're open to running collab ads to extend the reach. The same reel will need to be posted on Facebook as well.

We're excited about the potential to co-create content that feels authentic, adds value to your audience, and reflects the essence of theelement.skin.

Looking forward to hearing your thoughts!

Warm regards,
${sender}`;
}

// Load the influencer + the deliverable whose fee the email should quote (the LATEST one, same recency
// rule the Payment column uses: live_date → expected_date → created_at, id as tiebreak).
async function loadEmailContext(influencerId) {
    const { data: inf } = await supabase.from('influencers')
        .select('id, name, instagram_handle, email, outreach_status, quoted_price, final_price').eq('id', influencerId).maybeSingle();
    if (!inf) return null;
    const { data: vids } = await supabase.from('influencer_videos')
        .select('id, created_at, live_date, expected_date, quoted_price, final_price').eq('influencer_id', influencerId);
    const rec = v => v.live_date || v.expected_date || String(v.created_at || '').slice(0, 10) || '';
    const latest = (vids || []).length
        ? vids.slice().sort((a, b) => (rec(a) < rec(b) ? -1 : rec(a) > rec(b) ? 1 : (a.id || 0) - (b.id || 0))).pop()
        : null;
    // Fee preference: the deliverable's agreed price first, then the profile's — final over quoted at each step.
    const price = (latest && (latest.final_price || latest.quoted_price)) || inf.final_price || inf.quoted_price || null;
    return { inf, latest, price };
}

// First name only — "Hi Dr. Preethi Nagaraj (drpreethiskintalks)," reads like a mail merge. Strips a
// trailing parenthetical handle, drops emoji, and keeps an honorific with the name that follows it.
function greetingName(inf) {
    let n = String(inf.name || '').replace(/\([^)]*\)/g, '').trim();
    n = n.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();
    if (!n) return '@' + (inf.instagram_handle || 'there');
    const parts = n.split(' ');
    if (/^(dr|mr|mrs|ms|prof)\.?$/i.test(parts[0]) && parts[1]) return `${parts[0]} ${parts[1]}`;
    return parts[0];
}

// ── GET /inf/email/draft?influencerId= — build the editable draft. No AI, no send. ──
router.get('/inf/email/draft', async (req, res) => {
    try {
        const id = req.query.influencerId;
        if (!id) return res.status(400).json({ success: false, error: 'influencerId required' });
        const ctx = await loadEmailContext(id);
        if (!ctx) return res.status(404).json({ success: false, error: 'Influencer not found' });
        const already = await emailedIds([Number(id)]);
        const sender = actorName(req) === 'portal' ? 'Anandita' : actorName(req);
        // Surface the sending mailbox up front — an unmapped user should learn that BEFORE writing the
        // email, not when they press Send.
        const who = await outreachSender(req);
        res.json({
            success: true,
            to: ctx.inf.email || '',
            subject: OUTREACH_SUBJECT,
            body: collabEmailTemplate({ name: greetingName(ctx.inf), price: ctx.price, sender }),
            videoId: ctx.latest ? ctx.latest.id : null,
            price: ctx.price, priceKnown: !!ctx.price,
            handle: ctx.inf.instagram_handle, name: ctx.inf.name,
            outreach_status: ctx.inf.outreach_status,
            alreadySent: already.has(Number(id)),
            sendFrom: who.canSend ? { email: who.from, name: who.fromName, mode: who.mode } : null,
            sendBlockedReason: who.canSend ? null : who.reason,
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /inf/email/polish — rewrite the draft with AI. Returns the ORIGINAL body if AI is off/failing,
//    with a `reason`, so the flow never blocks on the model. ──
router.post('/inf/email/polish', async (req, res) => {
    try {
        const body = String((req.body && req.body.body) || '').trim();
        const subject = String((req.body && req.body.subject) || '').trim();
        if (!body) return res.status(400).json({ success: false, error: 'Nothing to polish' });
        if (!aiConfigured()) return res.json({ success: true, body, subject, ai: false, reason: 'AI is not configured (set AI_API_KEY / AI_API_URL / AI_MODEL)' });
        const sys = 'You polish outbound brand-collaboration emails for an Indian skincare brand, theelement.skin. '
            + 'Rewrite for warmth, clarity and flow while keeping a professional tone. HARD RULES: keep every factual '
            + 'detail exactly as given (fee amount, durations, deliverables, rights, payment terms, the Facebook '
            + 'cross-post); never invent a number, a date, a name or a claim; keep the greeting name and the sign-off '
            + 'name unchanged; if the fee appears as a blank like ₹______ leave that blank exactly as it is; keep it '
            + 'roughly the same length and keep the labelled sections. The subject line is fixed brand copy — '
            + 'do NOT rewrite it. Reply with ONLY a JSON object: '
            + '{"body": "..."} and no commentary, no markdown fences.';
        // maxTokens must comfortably exceed the whole email: this pitch is ~1,800 chars and at 1,400 tokens
        // Gemini returned a reply cut off MID-STRING, so the JSON never closed and the polish silently failed.
        const out = await aiComplete([
            { role: 'system', content: sys },
            { role: 'user', content: `Current subject:\n${subject}\n\nCurrent body:\n${body}` },
        ], { temperature: 0.6, maxTokens: 3000 });
        if (!out) return res.json({ success: true, body, subject, ai: false, reason: aiLastError() || 'AI returned nothing' });
        const p = parseAiJsonEmail(out);
        if (!p.body) return res.json({ success: true, body, subject, ai: false, reason: 'AI reply could not be parsed — keeping your draft' });
        // Sanity gate. A truncated or gutted rewrite must never reach a real influencer, so the polish is
        // only accepted if it kept the sign-off, the commercials line and most of its length.
        const bad = p.body.length < body.length * 0.6 ? 'the rewrite came back truncated'
            : !/Warm regards/i.test(p.body) ? 'the sign-off went missing'
            : !/Commercials\s*:/i.test(p.body) ? 'the commercials line went missing'
            : null;
        if (bad) return res.json({ success: true, body, subject, ai: false, reason: `Kept your draft — ${bad}.` });
        // Subject is fixed brand copy — return it unchanged whatever the model suggested.
        res.json({ success: true, body: p.body, subject: OUTREACH_SUBJECT, ai: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Pull {subject, body} out of a model reply. Gemini wraps JSON in ``` fences, emits raw newlines inside
// strings (invalid JSON) and sometimes appends commentary — all three are handled here.
function parseAiJsonEmail(draft) {
    let s = String(draft || '').replace(/```json?/gi, '').replace(/```/g, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
    const escapeRawNewlines = t => {
        let out = '', inStr = false, prev = '';
        for (const c of t) {
            if (c === '"' && prev !== '\\') { inStr = !inStr; out += c; prev = c; continue; }
            if (inStr && (c === '\n' || c === '\r' || c === '\t')) { out += (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t'); prev = c; continue; }
            out += c; prev = c;
        }
        return out;
    };
    for (const cand of [s, escapeRawNewlines(s)]) {
        try { const j = JSON.parse(cand); if (j && (j.body != null || j.subject != null)) return { subject: j.subject || null, body: j.body || null }; } catch (_) {}
    }
    const unesc = t => t == null ? null : String(t).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    const sm = s.match(/"subject"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const bm = s.match(/"body"\s*:\s*"([\s\S]*?)"\s*\}\s*$/);
    return { subject: sm ? unesc(sm[1]) : null, body: bm ? unesc(bm[1]) : null };
}

// ── POST /inf/email/send — send it, tick the box, log it. ──
router.post('/inf/email/send', async (req, res) => {
    try {
        // WHO MAY SEND — authorize BEFORE validating anything, so a permission failure is never masked by
        // a 400 on the payload or a 409 on state. Exactly two ways in, nothing else:
        //   1. a user with their OWN mapped mailbox → sends as themselves, so the reply reaches them;
        //   2. a MASTER (admin) with no personal mailbox → sends from the shared brand mailbox.
        // Everyone else is refused. Reading a thread is open to the whole team; sending is not.
        const who = await outreachSender(req);
        if (!who.canSend) return res.status(403).json({ success: false, error: who.reason });

        const b = req.body || {};
        const influencerId = Number(b.influencerId);
        const to = String(b.to || '').trim();
        // The subject is FIXED brand copy, set here and not taken from the client — every outreach email
        // must carry the same line, and the AI polish step is explicitly not allowed to reword it.
        const subject = OUTREACH_SUBJECT;
        const body = String(b.body || '').trim();
        if (!influencerId) return res.status(400).json({ success: false, error: 'influencerId required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ success: false, error: 'A valid recipient email is required' });
        if (!body) return res.status(400).json({ success: false, error: 'Body is required' });

        const ctx = await loadEmailContext(influencerId);
        if (!ctx) return res.status(404).json({ success: false, error: 'Influencer not found' });
        // Server-side enforcement of the same two rules the UI shows — a stale tab must not be able to
        // re-send, and only a partnered influencer may be emailed in the first place.
        const already = await emailedIds([influencerId]);
        if (already.has(influencerId)) return res.status(409).json({ success: false, error: 'A collaboration email has already been sent to this influencer.' });
        if (ctx.inf.outreach_status !== 'partnered') return res.status(409).json({ success: false, error: `Only a partnered influencer can be emailed (this one is "${ctx.inf.outreach_status || 'unset'}").` });

        // Plain text is the source of truth; the HTML twin just preserves the paragraph breaks.
        const html = body.split(/\n/).map(l => escapeHtmlText(l) || '&nbsp;').join('<br>');
        let sent;
        try {
            sent = who.mode === 'user'
                ? await sendMailAs(req.user.sub, { to, subject, text: body, html })
                : await sendMail({ to, subject, text: body, html });
        }
        catch (e) {
            const unmapped = e.code === 'NO_USER_MAILBOX';
            return res.status(unmapped ? 400 : 502).json({ success: false, error: unmapped ? e.message : 'Send failed: ' + e.message });
        }

        const videoId = b.videoId ? Number(b.videoId) : (ctx.latest ? ctx.latest.id : null);
        const nowIso = new Date().toISOString();
        await supabase.from('influencer_emails_ecom').insert({
            influencer_id: influencerId, video_id: videoId || null, to_email: to,
            subject, body, ai_polished: !!b.aiPolished, message_id: sent.messageId || null,
            kind: 'sent', thread_subject: String(subject).toLowerCase().trim(),
            sent_by: actorName(req), from_email: sent.from || null, sent_at: nowIso,
        });
        // Keep the legacy per-video flag in step, so anything still reading it (exports, the old CRM) agrees.
        if (videoId) await supabase.from('influencer_videos').update({ email_sent: true, email_sent_at: nowIso }).eq('id', videoId);
        // Remember the address we actually used, so the next email is pre-filled.
        if (!ctx.inf.email) await supabase.from('influencers').update({ email: to, updated_at: nowIso }).eq('id', influencerId);
        await logActivity(influencerId, 'email_sent', `Collaboration email sent to ${to} by ${actorName(req)}`);
        res.json({ success: true, to, from: sent.from, messageId: sent.messageId || null, sent_at: nowIso });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Minimal HTML escape for the text→HTML twin (this module had no escaper of its own).
function escapeHtmlText(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── GET /inf/email/log?influencerId= — what was sent, when, by whom. ──
router.get('/inf/email/log', async (req, res) => {
    try {
        const id = req.query.influencerId;
        if (!id) return res.status(400).json({ success: false, error: 'influencerId required' });
        const { data } = await supabase.from('influencer_emails_ecom')
            .select('id, to_email, subject, body, ai_polished, sent_by, sent_at')
            .eq('influencer_id', id).order('sent_at', { ascending: false });
        res.json({ success: true, emails: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});


// ── Outreach reply tracking (IMAP) ───────────────────────────────────────────────────────────────
// Outreach leaves from the portal user's OWN mailbox, so the influencer's reply lands in THAT inbox —
// not the shared reports mailbox the escalation poller watches. So this connects per sender, using the
// credentials already stored in app_user_smtp_ecom (IMAP host derived from the SMTP host, same app
// password), and only ever looks at mailboxes we have actually sent outreach from.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const normSubject = s => String(s || '').replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, '').trim().toLowerCase();
const stripId = s => String(s || '').trim().replace(/^<|>$/g, '');

let _infPollRunning = false;
// Poll every sender mailbox for replies to outreach sent in the last `days` days.
// Safe to call often: it no-ops while a poll is in flight and skips messages already stored.
async function pollInfluencerReplies({ days = 60, sinceDays = 14 } = {}) {
    if (_infPollRunning) return { skipped: true };
    _infPollRunning = true;
    try {
        const sinceISO = new Date(Date.now() - days * 86400000).toISOString();
        const { data: sent } = await supabase.from('influencer_emails_ecom')
            .select('id, influencer_id, message_id, subject, thread_subject, to_email, from_email')
            .eq('kind', 'sent').gte('sent_at', sinceISO);
        const sentRows = (sent || []).filter(r => r.from_email);
        if (!sentRows.length) return { checked: 0, saved: 0, mailboxes: 0 };

        // Group the threads we're watching by the mailbox they were sent from.
        const byMailbox = new Map();
        sentRows.forEach(r => {
            const k = String(r.from_email).toLowerCase();
            if (!byMailbox.has(k)) byMailbox.set(k, []);
            byMailbox.get(k).push(r);
        });

        let checked = 0, saved = 0, boxes = 0;
        for (const [mailbox, rows] of byMailbox) {
            const mb = await getUserMailbox(mailbox);
            if (!mb) { console.warn('[InfMail] no usable mailbox for', mailbox, '— skipping'); continue; }
            const byMsgId = new Map(rows.filter(r => r.message_id).map(r => [stripId(r.message_id), r]));
            // NO subject matching. The outreach subject is FIXED brand copy, so EVERY influencer's
            // reply normalises to the same thread subject — a subject fallback attached 17 unrelated
            // people's replies to one thread on the first live run. Only exact keys are safe here.
            // The influencer's own address is the most reliable key: a reply from them belongs to their
            // thread even when the mail client drops In-Reply-To or rewrites the subject.
            const byTo = new Map(rows.filter(r => r.to_email).map(r => [String(r.to_email).toLowerCase(), r]));
            // A reply-to-a-reply references the previous reply, so map those Message-IDs back too.
            const { data: known } = await supabase.from('influencer_emails_ecom')
                .select('message_id, parent_id').eq('kind', 'reply').not('message_id', 'is', null);
            const parentById = new Map(rows.map(r => [r.id, r]));
            (known || []).forEach(k => { const p = parentById.get(k.parent_id); if (p && k.message_id) byMsgId.set(stripId(k.message_id), p); });

            const host = process.env.IMAP_HOST || String(mb.host || '').replace(/^smtp\./i, 'imap.');
            const client = new ImapFlow({ host, port: 993, secure: true, logger: false, auth: { user: mb.user, pass: mb.pass } });
            // An unhandled 'error' event (ECONNRESET etc.) would take the whole process down.
            client.on('error', e => console.warn('[InfMail] IMAP error (ignored):', e.message));
            try { await client.connect(); } catch (e) { console.warn('[InfMail] cannot connect', mailbox, '-', e.message); continue; }
            boxes++;
            const lock = await client.getMailboxLock('INBOX');
            try {
                const uids = await client.search({ since: new Date(Date.now() - sinceDays * 86400000) });
                // PHASE 1 — envelopes only. Issuing client.download() inside an active fetch iterator
                // deadlocks imapflow, so candidates are collected first (same trap as the escalation poller).
                const candidates = [];
                for await (const msg of client.fetch(uids, { envelope: true, uid: true })) {
                    checked++;
                    const env = msg.envelope || {};
                    const fromAddr = ((env.from && env.from[0] && env.from[0].address) || '').toLowerCase();
                    if (!fromAddr || fromAddr === mailbox) continue;              // our own copy
                    const inReplyTo = stripId(env.inReplyTo);
                    // Exact keys only: the In-Reply-To chain, or the address we actually wrote to.
                    const parent = (inReplyTo && byMsgId.get(inReplyTo)) || byTo.get(fromAddr) || null;
                    if (!parent) continue;
                    const msgId = stripId(env.messageId);
                    if (!msgId) continue;
                    candidates.push({ uid: msg.uid, env, fromAddr, inReplyTo, msgId, parent });
                }
                // PHASE 2 — download + store (the fetch stream is closed by now).
                for (const c of candidates) {
                    const { data: exists } = await supabase.from('influencer_emails_ecom')
                        .select('id').eq('message_id', c.msgId).maybeSingle();
                    if (exists) continue;
                    let text = '';
                    try {
                        const dl = await client.download(c.uid, undefined, { uid: true });
                        const parsed = await simpleParser(dl.content);
                        text = (parsed.text || parsed.html || '').toString();
                    } catch (_) { /* envelope-only fallback */ }
                    // Drop the quoted history — Gmail's "On … wrote:" header wraps across lines.
                    text = text.split(/\r?\n\s*(?:>|On [\s\S]{5,140}?wrote:)/)[0].trim().slice(0, 8000);
                    const { error } = await supabase.from('influencer_emails_ecom').insert({
                        kind: 'reply', influencer_id: c.parent.influencer_id, parent_id: c.parent.id,
                        message_id: c.msgId, in_reply_to: c.inReplyTo || null,
                        thread_subject: normSubject(c.env.subject), subject: c.env.subject || '',
                        from_email: c.fromAddr, to_email: mailbox, body: text,
                        sent_at: c.env.date ? new Date(c.env.date).toISOString() : new Date().toISOString(),
                    });
                    if (error) { if (!/duplicate/i.test(error.message)) console.error('[InfMail] save reply error:', error.message); continue; }
                    saved++;
                    console.log(`[InfMail] reply from ${c.fromAddr} — "${(c.env.subject || '').slice(0, 60)}"`);
                }
            } finally { lock.release(); }
            await client.logout().catch(() => {});
        }
        if (saved) console.log(`[InfMail] poll done — ${saved} new repl${saved === 1 ? 'y' : 'ies'} (${checked} checked, ${boxes} mailbox${boxes === 1 ? '' : 'es'})`);
        return { checked, saved, mailboxes: boxes };
    } catch (e) {
        console.error('[InfMail] poll error:', e.message);
        return { error: e.message };
    } finally { _infPollRunning = false; }
}

// ── GET /inf/email/thread?influencerId=&refresh=1 — the sent mail + its replies. ──
// `refresh=1` polls IMAP first so the panel can show a reply that arrived seconds ago.
router.get('/inf/email/thread', async (req, res) => {
    try {
        const id = Number(req.query.influencerId);
        if (!id) return res.status(400).json({ success: false, error: 'influencerId required' });
        let poll = null;
        if (String(req.query.refresh || '') === '1') poll = await pollInfluencerReplies({ sinceDays: 30 });
        const { data } = await supabase.from('influencer_emails_ecom')
            .select('id, kind, parent_id, to_email, from_email, subject, body, ai_polished, sent_by, sent_at')
            .eq('influencer_id', id).order('sent_at', { ascending: true });
        const rows = data || [];
        res.json({
            success: true,
            messages: rows,
            sentCount: rows.filter(r => r.kind === 'sent').length,
            replyCount: rows.filter(r => r.kind === 'reply').length,
            poll,
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── POST /inf/email/poll — manual/cron trigger for the reply poll. ──
router.post('/inf/email/poll', async (req, res) => {
    try { res.json({ success: true, ...(await pollInfluencerReplies({})) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
module.exports.pollInfluencerReplies = pollInfluencerReplies;

