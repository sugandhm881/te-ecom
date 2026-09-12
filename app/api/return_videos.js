// RTO / RETURN VIDEOS (user, 2026-09-12: "make a new dashboard for upload video with note … due to short goods
// received when shipment is RTO & Return … permission based … whenever we need we download that video and make
// sure no max storage use for video and quality of video should be also maintained").
//
// One row per video in return_videos_ecom; the file itself lives in the PRIVATE `return-videos` bucket.
//   · upload is TWO steps — the metadata row first (so a failed upload leaves a traceable row, swept nightly),
//     then the file itself as a raw body. The browser re-encodes to 720p first, so a minute of video is
//     ~10-15 MB instead of 100-150 MB.
//   · download hands out a SIGNED URL valid for two minutes — never a public link (the bucket is private).
//   · videos older than RETENTION_MONTHS are deleted nightly, file and row together (user: 6 months).
// Everything here is gated by the `return-videos` permission (admins always) — in server.js and again below.
const express = require('express');
const { supabase } = require('../supabase');
const { requirePermission } = require('../auth');

const router = express.Router();
const BUCKET = 'return-videos';
const TABLE = 'return_videos_ecom';
const MARKETS = 'return_video_marketplaces_ecom';
const RETENTION_MONTHS = 6;
const MAX_BYTES = 200 * 1024 * 1024;     // matches the bucket's own limit — refused here too, before the body is read
const EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/3gpp': '3gp' };
const who = (req) => (req.user && (req.user.sub || req.user.email)) || null;
const clean = (s, n) => { const t = String(s == null ? '' : s).trim(); return t ? t.slice(0, n) : null; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

router.use('/return-videos', requirePermission('return-videos'));

// ── the list + the dropdown ───────────────────────────────────────────────────────────────────────
router.get('/return-videos', async (req, res) => {
    try {
        const [rows, mkts] = await Promise.all([
            supabase.from(TABLE).select('*').order('created_at', { ascending: false }).limit(500),
            supabase.from(MARKETS).select('name').order('name'),
        ]);
        if (rows.error) throw rows.error;
        if (mkts.error) throw mkts.error;
        res.json({
            success: true,
            videos: rows.data || [],
            marketplaces: (mkts.data || []).map(m => m.name),
            retention_months: RETENTION_MONTHS,
            max_mb: Math.round(MAX_BYTES / 1048576),
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/return-videos/marketplaces', async (req, res) => {
    try {
        const name = clean((req.body || {}).name, 40);
        if (!name) return res.status(400).json({ success: false, error: 'Enter a marketplace name' });
        const { error } = await supabase.from(MARKETS).upsert({ name, added_by: who(req) }, { onConflict: 'name', ignoreDuplicates: true });
        if (error) throw error;
        res.json({ success: true, name });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── step 1: the row ───────────────────────────────────────────────────────────────────────────────
router.post('/return-videos', async (req, res) => {
    try {
        const b = req.body || {};
        const marketplace = clean(b.marketplace, 40);
        if (!marketplace) return res.status(400).json({ success: false, error: 'Choose a marketplace' });
        const { data, error } = await supabase.from(TABLE).insert({
            marketplace,
            order_name: clean(String(b.order_name || '').replace(/^#/, ''), 40),
            awb: clean(b.awb, 60),
            short_qty: num(b.short_qty),
            short_value: num(b.short_value),
            note: clean(b.note, 2000),
            original_size: num(b.original_size),
            compressed: !!b.compressed,
            uploaded_by: who(req),
        }).select('id').single();
        if (error) throw error;
        res.json({ success: true, id: data.id });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── step 2: the file (raw body — see the express.raw mount in server.js) ──────────────────────────
router.post('/return-videos/upload/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ success: false, error: 'No video received' });
        if (buf.length > MAX_BYTES) return res.status(413).json({ success: false, error: `Video is larger than ${Math.round(MAX_BYTES / 1048576)} MB` });
        const { data: row } = await supabase.from(TABLE).select('id, file_path, created_at').eq('id', id).maybeSingle();
        if (!row) return res.status(404).json({ success: false, error: 'That upload was not started — reload and try again' });
        if (row.file_path) return res.status(409).json({ success: false, error: 'This video was already uploaded' });
        const mime = String(req.get('content-type') || 'video/webm').split(';')[0].toLowerCase();
        const d = new Date(row.created_at);
        const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${id}.${EXT[mime] || 'bin'}`;
        const up = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: mime, upsert: true });
        if (up.error) throw up.error;
        const { error } = await supabase.from(TABLE).update({ file_path: path, file_size: buf.length, mime, status: 'ready' }).eq('id', id);
        if (error) throw error;
        console.log(`[ReturnVideos] #${id} stored ${(buf.length / 1048576).toFixed(1)} MB by ${who(req) || '(unknown)'}`);
        res.json({ success: true, id, size: buf.length });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── download: streamed THROUGH us, like the call recordings ──────────────────────────────────────
// Not a redirect to Supabase: the dashboard's CSP is connect-src 'self', so the browser may not fetch from
// *.supabase.co, and a plain <a> navigation would carry no Authorization header. The signed URL is made and
// used server-side only (two minutes, private bucket), and the bytes are piped straight through — the video
// is never buffered whole in memory, and no storage link ever reaches the browser.
router.get('/return-videos/:id/download', async (req, res) => {
    try {
        const { data: row } = await supabase.from(TABLE).select('file_path, marketplace, order_name, mime').eq('id', req.params.id).maybeSingle();
        if (!row || !row.file_path) return res.status(404).json({ success: false, error: 'No video on this entry' });
        const name = [row.marketplace, row.order_name, req.params.id].filter(Boolean).join('_').replace(/[^A-Za-z0-9_.-]/g, '') + '.' + (EXT[row.mime] || 'webm');
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.file_path, 120);
        if (error) throw error;
        const r = await fetch(data.signedUrl);
        if (!r.ok || !r.body) return res.status(502).json({ success: false, error: 'storage ' + r.status });
        res.set('Content-Type', row.mime || 'video/webm');
        res.set('Content-Disposition', `attachment; filename="${name}"`);
        const len = r.headers.get('content-length'); if (len) res.set('Content-Length', len);
        require('stream').Readable.fromWeb(r.body).pipe(res);
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/return-videos/:id', async (req, res) => {
    try {
        // DELETING A VIDEO IS ADMIN ONLY (user, 2026-09-12: "delete option give only admin, no other user had
        // delete video option"). The page hides the button for everyone else, but a hidden button is only a
        // hidden button — this is the rule that actually holds. Uploading and downloading stay with the
        // return-videos permission; only destroying evidence is reserved.
        const admin = req.user && (req.user.role === 'admin' || (req.user.permissions || []).includes('*'));
        if (!admin) return res.status(403).json({ success: false, error: 'Only an admin can delete a video' });
        const { data: row } = await supabase.from(TABLE).select('file_path').eq('id', req.params.id).maybeSingle();
        if (!row) return res.status(404).json({ success: false, error: 'Already gone' });
        if (row.file_path) await supabase.storage.from(BUCKET).remove([row.file_path]);
        const { error } = await supabase.from(TABLE).delete().eq('id', req.params.id);
        if (error) throw error;
        console.log(`[ReturnVideos] #${req.params.id} deleted by ${who(req) || '(unknown)'}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── nightly: 6-month retention, plus rows whose upload never finished ────────────────────────────
// The file goes first: a row without its file is visible and fixable, an orphaned file is invisible and
// billed forever. Storage is freed either way — that is what keeps this feature inside the included 100 GB.
async function purgeOldVideos() {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
    const stale = new Date(Date.now() - 24 * 3600 * 1000);
    const { data: old, error } = await supabase.from(TABLE).select('id, file_path').lt('created_at', cutoff.toISOString());
    if (error) throw error;
    const paths = (old || []).map(r => r.file_path).filter(Boolean);
    for (let i = 0; i < paths.length; i += 100) await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (old && old.length) await supabase.from(TABLE).delete().in('id', old.map(r => r.id));
    const { data: never } = await supabase.from(TABLE).select('id').is('file_path', null).lt('created_at', stale.toISOString());
    if (never && never.length) await supabase.from(TABLE).delete().in('id', never.map(r => r.id));
    const msg = `[ReturnVideos] purge: ${(old || []).length} older than ${RETENTION_MONTHS} months, ${(never || []).length} unfinished uploads`;
    console.log(msg);
    return msg;
}

module.exports = { router, purgeOldVideos, RETENTION_MONTHS, MAX_BYTES, BUCKET };
