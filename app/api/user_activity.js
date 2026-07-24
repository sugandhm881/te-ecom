// User activity feed + admin User Analytics.
//  • record router (mounted at /api, gated by the global token check): POST /activity logs a login/view.
//  • admin router (mounted at /api/admin, admin-only): GET /user-analytics + /user-analytics/user aggregate it.
// "Est. active time" is approximated from the gaps between a user's consecutive events (idle gaps capped).
const express = require('express');
const { supabase } = require('../supabase');
const { tokenRequired, requireAdmin } = require('../auth');

const IST_DATE = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD IST
const SESSION_GAP = 30 * 60 * 1000;   // > 30 min between events = a new session (idle time not counted)
const MAX_DWELL = 15 * 60 * 1000;     // cap a single view's attributed time at 15 min
const MIN_DWELL = 30 * 1000;          // tail dwell for the last event of a session

// ── Record route (any signed-in user logs their OWN activity) ───────────────────────────────────────
const router = express.Router();
router.post('/activity', async (req, res) => {
    try {
        const b = req.body || {};
        const event = b.event === 'login' ? 'login' : 'view';
        const view = b.view ? String(b.view).slice(0, 60) : null;
        // Email is taken from the token, never the body — a user can only log activity as themselves.
        await supabase.from('user_activity_ecom').insert({ email: req.user.sub, event, view });
        res.json({ ok: true });
    } catch (e) { res.status(200).json({ ok: false }); }   // never block the UI on a logging failure
});

// ── Admin analytics ─────────────────────────────────────────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(tokenRequired, requireAdmin);

function resolveRange(q) {
    const now = new Date();
    const to = q.to ? new Date(q.to) : now;
    const from = q.from ? new Date(q.from) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
    const fromISO = new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString();
    const toISO = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59).toISOString();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { fromISO, toISO, fromLabel: fmt(from), toLabel: fmt(to) };
}

async function fetchEvents(fromISO, toISO, email) {
    const rows = []; const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
        let q = supabase.from('user_activity_ecom').select('email, event, view, created_at')
            .gte('created_at', fromISO).lte('created_at', toISO);
        if (email) q = q.eq('email', email);
        const { data, error } = await q.order('created_at', { ascending: true }).range(offset, offset + PAGE - 1);
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return rows;
}

// Walk one user's chronological events; attribute dwell time to the "from" view of each gap.
function attributeDwell(userEvents, onView) {
    for (let i = 0; i < userEvents.length; i++) {
        const e = userEvents[i];
        if (e.event !== 'view' || !e.view) continue;
        let dwell;
        if (i + 1 < userEvents.length) {
            const gap = new Date(userEvents[i + 1].created_at) - new Date(e.created_at);
            dwell = gap <= SESSION_GAP ? Math.min(gap, MAX_DWELL) : MIN_DWELL;
        } else dwell = MIN_DWELL;
        onView(e.view, dwell);
    }
}

async function userMap() {
    const { data } = await supabase.from('app_users_ecom').select('email, name, role');
    const m = {};
    (data || []).forEach(u => { m[String(u.email).toLowerCase()] = { name: u.name || null, role: u.role || 'user' }; });
    return m;
}

adminRouter.get('/user-analytics', async (req, res) => {
    try {
        const rg = resolveRange(req.query);
        const [events, umap] = await Promise.all([fetchEvents(rg.fromISO, rg.toISO), userMap()]);
        // group by user
        const byUser = {};
        events.forEach(e => { (byUser[e.email] = byUser[e.email] || []).push(e); });
        const globalView = {};   // view -> { count, ms }
        const byDay = {};        // date -> count
        events.forEach(e => { const d = IST_DATE(e.created_at); byDay[d] = (byDay[d] || 0) + 1; });

        const users = Object.entries(byUser).map(([email, evs]) => {
            const views = evs.filter(e => e.event === 'view' && e.view);
            const logins = evs.filter(e => e.event === 'login').length;
            const days = new Set(evs.map(e => IST_DATE(e.created_at)));
            const viewCount = {}; let ms = 0;
            attributeDwell(evs, (v, d) => {
                ms += d;
                viewCount[v] = (viewCount[v] || 0) + 1;
                globalView[v] = globalView[v] || { count: 0, ms: 0 };
                globalView[v].count++; globalView[v].ms += d;
            });
            const topView = Object.entries(viewCount).sort((a, b) => b[1] - a[1])[0];
            const meta = umap[String(email).toLowerCase()] || {};
            return {
                email, name: meta.name || null, role: meta.role || 'user',
                lastActive: evs[evs.length - 1].created_at,
                activeDays: days.size, pageViews: views.length, logins,
                estMinutes: Math.round(ms / 60000), topView: topView ? topView[0] : null,
            };
        }).sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));

        const byView = Object.entries(globalView)
            .map(([view, v]) => ({ view, count: v.count, minutes: Math.round(v.ms / 60000) }))
            .sort((a, b) => b.count - a.count);
        const totalMin = users.reduce((a, u) => a + u.estMinutes, 0);

        res.json({
            success: true, range: { from: rg.fromLabel, to: rg.toLabel },
            totals: {
                activeUsers: users.length,
                pageViews: users.reduce((a, u) => a + u.pageViews, 0),
                logins: users.reduce((a, u) => a + u.logins, 0),
                estMinutes: totalMin,
            },
            byView, byDay: Object.keys(byDay).sort().map(d => ({ date: d, count: byDay[d] })), users,
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

adminRouter.get('/user-analytics/user', async (req, res) => {
    try {
        const email = String(req.query.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ success: false, error: 'email required' });
        const rg = resolveRange(req.query);
        const [evs, umap] = await Promise.all([fetchEvents(rg.fromISO, rg.toISO, email), userMap()]);
        const viewCount = {}, viewMs = {}, byDay = {};
        evs.forEach(e => { const d = IST_DATE(e.created_at); byDay[d] = (byDay[d] || 0) + 1; });
        attributeDwell(evs, (v, d) => { viewCount[v] = (viewCount[v] || 0) + 1; viewMs[v] = (viewMs[v] || 0) + d; });
        const byView = Object.keys(viewCount)
            .map(v => ({ view: v, count: viewCount[v], minutes: Math.round(viewMs[v] / 60000) }))
            .sort((a, b) => b.count - a.count);
        const views = evs.filter(e => e.event === 'view' && e.view);
        const meta = umap[email] || {};
        res.json({
            success: true, email, name: meta.name || null, role: meta.role || 'user',
            totals: {
                pageViews: views.length,
                logins: evs.filter(e => e.event === 'login').length,
                estMinutes: Math.round(byView.reduce((a, v) => a + v.minutes, 0)),
                activeDays: new Set(evs.map(e => IST_DATE(e.created_at))).size,
                lastActive: evs.length ? evs[evs.length - 1].created_at : null,
            },
            byView, byDay: Object.keys(byDay).sort().map(d => ({ date: d, count: byDay[d] })),
            recent: evs.slice(-60).reverse().map(e => ({ event: e.event, view: e.view, at: e.created_at })),
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = { router, adminRouter };
