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

const STATUSES = ['not_contacted', 'reached_out', 'in_discussion', 'partnered', 'rejected'];

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
        };
        const { data, error } = await supabase.from('influencers').insert(row).select('id').single();
        if (error) throw new Error(error.message);
        await logActivity(data.id, 'note', `Added to CRM${b.source ? ' via ' + b.source : ''} by ${req.user && req.user.sub || 'portal'}`);
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
        res.json({
            success: true, influencer: inf.data, videos: vids.data || [], activities: acts.data || [],
            lists: (memb.data || []).map(m => m.influencer_lists).filter(Boolean),
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
        let statusChanged = null;
        if (b.outreach_status !== undefined) {
            if (!STATUSES.includes(b.outreach_status)) return res.status(400).json({ success: false, error: 'Invalid outreach status.' });
            const { data: cur } = await supabase.from('influencers').select('outreach_status').eq('id', id).single();
            if (cur && cur.outreach_status !== b.outreach_status) statusChanged = b.outreach_status;
            patch.outreach_status = b.outreach_status;
        }
        const { error } = await supabase.from('influencers').update(patch).eq('id', id);
        if (error) throw new Error(error.message);
        if (statusChanged) await logActivity(id, 'status_change', `Status changed to ${statusChanged.replace(/_/g, ' ')} by ${req.user && req.user.sub || 'portal'}`);
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
                influencer_id: i, activity_type: 'status_change', description: `Status changed to ${status.replace(/_/g, ' ')} (bulk) by ${req.user && req.user.sub || 'portal'}`,
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
        await logActivity(b.influencer_id, 'video_added', `Video added${row.expected_date ? ' (expected ' + row.expected_date + ')' : ''} by ${req.user && req.user.sub || 'portal'}`);
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
            await logActivity(before.influencer_id, 'payment', `Payment marked ${patch.payment_status} by ${req.user && req.user.sub || 'portal'}`);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/inf/videos/:id', async (req, res) => {
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
            description: `${String(description).trim().slice(0, 480)} — ${req.user && req.user.sub || 'portal'}`,
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Lists (campaigns) ────────────────────────────────────────────────────────
// Auto-detect a date range from the list name — "Diwali 2025" → Oct-Nov 2025, "March 2026" → that month.
const FESTIVAL_MONTHS = { diwali: [10, 11], holi: [3, 3], rakhi: [8, 8], christmas: [12, 12], valentine: [2, 2], newyear: [1, 1] };
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function detectRange(name) {
    const s = String(name || '').toLowerCase();
    const yearM = s.match(/20\d{2}/);
    if (!yearM) return null;
    const year = Number(yearM[0]);
    for (const [fest, [m1, m2]] of Object.entries(FESTIVAL_MONTHS)) {
        if (s.includes(fest)) return { from: `${year}-${String(m1).padStart(2, '0')}-01`, to: new Date(year, m2, 0).toISOString().slice(0, 10), label: fest + ' ' + year };
    }
    for (let i = 0; i < 12; i++) {
        if (s.includes(MONTH_NAMES[i]) || s.includes(MONTH_NAMES[i].slice(0, 3))) {
            return { from: `${year}-${String(i + 1).padStart(2, '0')}-01`, to: new Date(year, i + 1, 0).toISOString().slice(0, 10), label: MONTH_NAMES[i] + ' ' + year };
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
            const [infs, vids] = await Promise.all([
                supabase.from('influencers').select('id, instagram_handle, name, follower_count, niche, outreach_status, profile_image_url').in('id', ids),
                supabase.from('influencer_videos').select('influencer_id, views, live_date, quoted_price, final_price, gst_applicable, payment_status').in('influencer_id', ids),
            ]);
            const vidsBy = {};
            (vids.data || []).forEach(v => { (vidsBy[v.influencer_id] = vidsBy[v.influencer_id] || []).push(v); });
            members = (infs.data || []).map(i => {
                const all = vidsBy[i.id] || [];
                const inRange = range ? all.filter(v => v.live_date && v.live_date >= range.from && v.live_date <= range.to) : all;
                const views = inRange.reduce((s, v) => s + (v.views || 0), 0);
                const quoted = all.reduce((s, v) => s + (Number(v.quoted_price) || 0), 0);
                const finalP = all.reduce((s, v) => s + (Number(v.final_price) || Number(v.quoted_price) || 0), 0);
                const gst = all.reduce((s, v) => s + (v.gst_applicable ? 0.18 * (Number(v.final_price) || Number(v.quoted_price) || 0) : 0), 0);
                const spend = finalP + gst;
                totals.quoted += quoted; totals.final += finalP; totals.gst += gst; totals.spend += spend; totals.views += views;
                return { ...i, videos: all.length, views_in_range: views, quoted, final: finalP, gst: Math.round(gst), spend: Math.round(spend), cpm: views > 0 ? Math.round((spend / views) * 1000) : null };
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
        const to = new Date(year, month, 0).toISOString().slice(0, 10);
        const { data: vids, error } = await supabase.from('influencer_videos')
            .select('id, influencer_id, expected_date, live_date, payment_status, video_url')
            .or(`and(expected_date.gte.${from},expected_date.lte.${to}),and(live_date.gte.${from},live_date.lte.${to})`);
        if (error) throw new Error(error.message);
        const ids = [...new Set((vids || []).map(v => v.influencer_id))];
        let handles = {};
        if (ids.length) {
            for (let i = 0; i < ids.length; i += 300) {
                const { data } = await supabase.from('influencers').select('id, instagram_handle, name').in('id', ids.slice(i, i + 300));
                (data || []).forEach(x => { handles[x.id] = { handle: x.instagram_handle, name: x.name }; });
            }
        }
        res.json({ success: true, from, to, videos: (vids || []).map(v => ({ ...v, influencer: handles[v.influencer_id] || null })) });
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
            .select('id, shopify_product_id, shopify_variant_id, product_title, variant_title, sku, price, image_url, inventory_quantity, product_status')
            .eq('product_status', 'active').order('product_title');
        if (error) throw new Error(error.message);
        res.json({ success: true, products: data || [] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/inf/send-product', async (req, res) => {
    try {
        const b = req.body || {};
        if (!b.videoId || !b.influencerId) return res.status(400).json({ success: false, error: 'videoId and influencerId required' });
        if (!b.address1 || !b.pincode || !b.phone) return res.status(400).json({ success: false, error: 'Address line 1, pincode and phone are required.' });
        if (!Array.isArray(b.productIds) || !b.productIds.length) return res.status(400).json({ success: false, error: 'Pick at least one product.' });
        const r = await invokeFn('create-influencer-order', {
            videoId: b.videoId, influencerId: b.influencerId,
            address1: b.address1, address2: b.address2 || '', city: b.city || '', state: b.state || '',
            pincode: b.pincode, phone: b.phone, email: b.email || undefined, name: b.name || 'Influencer',
            productIds: b.productIds.map(String),
        }, 120000);
        if (r.status >= 400) return res.status(502).json({ success: false, error: (r.data && (r.data.error || r.data.details)) || `create-order returned ${r.status}` });
        // persist the shipping address back onto the influencer for next time + log
        supabase.from('influencers').update({
            address1: b.address1, address2: b.address2 || null, city: b.city || null, state: b.state || null,
            pincode: b.pincode, phone: b.phone, updated_at: new Date().toISOString(),
        }).eq('id', b.influencerId).then(() => {}).catch(() => {});
        await logActivity(b.influencerId, 'product_sent', `Product sent — Shopify draft order ${r.data.draftOrderId} (${b.productIds.length} item${b.productIds.length > 1 ? 's' : ''}) by ${req.user && req.user.sub || 'portal'}`);
        res.json({ success: true, draftOrderId: r.data.draftOrderId, draftOrderUrl: r.data.draftOrderUrl });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
