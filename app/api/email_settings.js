// Portal-managed email/SMTP settings + the shared mail sender used by the report features.
// Settings live in app_email_settings (single row); the SMTP password is stored AES-256-GCM encrypted.
// Any field left blank falls back to the .env EMAIL_* config, so the app still works before it's set.
const express = require('express');
const nodemailer = require('nodemailer');
const router = express.Router();
const config = require('../../config');
const { supabase } = require('../supabase');
const { tokenRequired, requireAdmin } = require('../auth');
const { encrypt, decrypt } = require('./crypto_util');

const splitList = s => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);

// Resolve the effective mail config: DB settings over .env defaults, password decrypted. Read fresh on
// each send so portal edits take effect immediately (sends are infrequent). Returns null if unusable.
async function getEmailConfig() {
    let s = {};
    try {
        const { data } = await supabase.from('app_email_settings').select('*').eq('id', 1).single();
        s = data || {};
    } catch (_) { s = {}; }
    const host = s.smtp_host || config.EMAIL_HOST;
    // The From address doubles as the SMTP login (most providers require from == authenticated user).
    const user = s.smtp_user || s.from_email || config.EMAIL_USER;
    const pass = decrypt(s.smtp_password_enc) || config.EMAIL_PASSWORD;
    const port = parseInt(s.smtp_port || config.EMAIL_PORT || 587, 10);
    const from = s.from_email || s.smtp_user || user;
    const to = s.to_emails ? splitList(s.to_emails) : splitList(config.RECIPIENT_EMAIL);
    const cc = splitList(s.cc_emails);
    const rapidshyp = (s.rapidshyp_email || '').trim() || null;
    // Per-platform recipient sets — the delivery reports send ONE email per platform to its own people:
    //   RapidShyp rows → RapidShyp recipients, DocPharma rows → DocPharma recipients.
    // RapidShyp To = the general To list (or the single RapidShyp claims email as a fallback). DocPharma
    // To = its own list. Each platform's CC defaults to the shared cc_emails so the internal team is copied.
    const docTo = splitList(s.docpharma_to_emails);
    const docCc = s.docpharma_cc_emails ? splitList(s.docpharma_cc_emails) : cc;
    const rsTo = to.length ? to : (rapidshyp ? [rapidshyp] : []);
    const platforms = {
        rapidshyp: { to: rsTo, cc },
        docpharma: { to: docTo, cc: docCc },
    };
    if (!host || !user || !pass) return null;     // not enough to send
    return { host, port, user, pass, from, to, cc, rapidshyp, platforms };
}

// Recipients for a given platform ('rapidshyp' | 'docpharma'). Returns { to:[], cc:[] } (may be empty).
async function recipientsFor(platform) {
    const cfg = await getEmailConfig();
    const p = cfg && cfg.platforms && cfg.platforms[platform];
    return p || { to: [], cc: [] };
}

// Send an email through the resolved config. opts: { subject, html, text, to?, cc?, attachments? }.
// `to`/`cc` override the configured defaults when provided. Returns { ok, messageId } or throws.
async function sendMail(opts = {}) {
    const cfg = await getEmailConfig();
    if (!cfg) throw new Error('Email is not configured — set SMTP host/user/password in Settings.');
    const to = (Array.isArray(opts.to) ? opts.to : opts.to ? splitList(opts.to) : cfg.to);
    const cc = (Array.isArray(opts.cc) ? opts.cc : opts.cc ? splitList(opts.cc) : cfg.cc);
    if (!to || !to.length) throw new Error('No recipient — set a "To" address in Settings or pass one.');
    const transporter = nodemailer.createTransport({
        host: cfg.host, port: cfg.port, secure: cfg.port === 465,
        auth: { user: cfg.user, pass: cfg.pass },
    });
    const info = await transporter.sendMail({
        from: cfg.from, to, cc: cc && cc.length ? cc : undefined,
        subject: opts.subject || '(no subject)',
        text: opts.text || undefined, html: opts.html || undefined,
        attachments: opts.attachments || undefined,
    });
    return { ok: true, messageId: info.messageId, to, cc };
}

// ── Admin-only settings API (mounted under /api/admin) ──────────────────────────────────────────────
router.use(tokenRequired, requireAdmin);

// Return current settings WITHOUT the password (only whether one is set), plus which .env fallbacks exist.
router.get('/email-settings', async (req, res) => {
    let s = {};
    try { const { data } = await supabase.from('app_email_settings').select('*').eq('id', 1).single(); s = data || {}; } catch (_) {}
    res.json({
        success: true,
        settings: {
            from_email: s.from_email || '', to_emails: s.to_emails || '', cc_emails: s.cc_emails || '',
            docpharma_to_emails: s.docpharma_to_emails || '', docpharma_cc_emails: s.docpharma_cc_emails || '',
            rapidshyp_email: s.rapidshyp_email || '', smtp_host: s.smtp_host || '',
            smtp_port: s.smtp_port || '', smtp_user: s.smtp_user || '',
            password_set: !!s.smtp_password_enc, updated_at: s.updated_at || null, updated_by: s.updated_by || null,
        },
        env_fallback: {   // shown as placeholders so the admin knows what's used if a field is left blank
            smtp_host: config.EMAIL_HOST || '', smtp_port: config.EMAIL_PORT || '',
            smtp_user: config.EMAIL_USER || '', recipient: config.RECIPIENT_EMAIL || '',
            password_set: !!config.EMAIL_PASSWORD,
        },
    });
});

// Upsert settings. Password only changes when a non-empty smtp_password is sent (blank = keep existing).
router.post('/email-settings', async (req, res) => {
    const b = req.body || {};
    const patch = {
        id: 1,
        from_email: (b.from_email || '').trim() || null,
        to_emails: (b.to_emails || '').trim() || null,
        cc_emails: (b.cc_emails || '').trim() || null,
        docpharma_to_emails: (b.docpharma_to_emails || '').trim() || null,
        docpharma_cc_emails: (b.docpharma_cc_emails || '').trim() || null,
        rapidshyp_email: (b.rapidshyp_email || '').trim() || null,
        smtp_host: (b.smtp_host || '').trim() || null,
        smtp_port: b.smtp_port ? parseInt(b.smtp_port, 10) || null : null,
        smtp_user: (b.smtp_user || b.from_email || '').trim() || null,   // login = From address
        updated_at: new Date().toISOString(),
        updated_by: req.user.sub,
    };
    if (typeof b.smtp_password === 'string' && b.smtp_password.trim() !== '') {
        patch.smtp_password_enc = encrypt(b.smtp_password.trim());
    }
    const { error } = await supabase.from('app_email_settings').upsert(patch, { onConflict: 'id' });
    if (error) return res.status(500).json({ message: error.message });
    res.json({ success: true });
});

// Send a test email to verify the config end-to-end.
router.post('/email-settings/test', async (req, res) => {
    const to = (req.body && req.body.to) || undefined;
    try {
        const r = await sendMail({
            to,
            subject: 'Ecom Central — test email ✓',
            html: '<p>This is a test email from <b>Ecom Central</b> Settings. If you received it, your SMTP configuration works.</p>',
            text: 'This is a test email from Ecom Central Settings. If you received it, your SMTP configuration works.',
        });
        res.json({ success: true, message: `Sent to ${r.to.join(', ')}` });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});


// ── Per-user sending mailboxes (app_user_smtp_ecom) ───────────────────────────────────────────────
// The shared config above is the BRAND mailbox used by the automated reports. Person-to-person mail —
// influencer outreach — must instead leave from the address of whoever is logged in, so replies land in
// that person's inbox and the influencer sees a human, not a reports alias.
//
// A mapping is REQUIRED for that: we deliberately do NOT silently fall back to the shared mailbox,
// because sending "from" someone who has no credentials either fails SPF/DMARC at the provider or
// quietly misattributes the mail. No mapping → a clear error naming the fix.

// Resolve one user's sending mailbox. Returns null when unmapped or deactivated.
async function getUserMailbox(userEmail) {
    const key = String(userEmail || '').trim().toLowerCase();
    if (!key) return null;
    let s = null;
    try { const { data } = await supabase.from('app_user_smtp_ecom').select('*').eq('user_email', key).maybeSingle(); s = data; } catch (_) { s = null; }
    if (!s || s.active === false) return null;
    const pass = decrypt(s.smtp_password_enc);
    if (!pass) return null;                       // mapped but no usable password — treat as unmapped
    const from_email = (s.from_email || key).trim();
    return {
        user_email: key,
        from_name: (s.from_name || '').trim() || null,
        from_email,
        host: (s.smtp_host || config.EMAIL_HOST || 'smtp.gmail.com').trim(),
        port: parseInt(s.smtp_port || config.EMAIL_PORT || 587, 10),
        // Most providers require the authenticated user to equal the From address.
        user: (s.smtp_user || from_email).trim(),
        pass,
    };
}

// Send AS a specific portal user. opts: { to, cc, subject, html, text, replyTo }.
// Throws a user-facing error when the sender has no mailbox mapped.
async function sendMailAs(userEmail, opts = {}) {
    const mb = await getUserMailbox(userEmail);
    if (!mb) {
        const err = new Error(`No sending mailbox is mapped for ${userEmail || 'your account'}. Ask an admin to add one under Settings → Email & Reports → Sending mailboxes.`);
        err.code = 'NO_USER_MAILBOX';
        throw err;
    }
    const to = Array.isArray(opts.to) ? opts.to : splitList(opts.to);
    if (!to.length) throw new Error('No recipient.');
    const cc = Array.isArray(opts.cc) ? opts.cc : splitList(opts.cc);
    const transporter = nodemailer.createTransport({
        host: mb.host, port: mb.port, secure: mb.port === 465,
        auth: { user: mb.user, pass: mb.pass },
    });
    const from = mb.from_name ? `"${mb.from_name.replace(/"/g, '')}" <${mb.from_email}>` : mb.from_email;
    const info = await transporter.sendMail({
        from, to, cc: cc.length ? cc : undefined,
        replyTo: opts.replyTo || mb.from_email,
        subject: opts.subject || '(no subject)',
        text: opts.text || undefined, html: opts.html || undefined,
    });
    return { ok: true, messageId: info.messageId, to, cc, from: mb.from_email, fromName: mb.from_name };
}

// ── Admin: list / upsert / delete per-user mailboxes ──────────────────────────────────────────────
// Every portal user is returned, mapped or not, so the admin sees who still needs one. Passwords are
// never returned — only whether one is stored.
router.get('/user-mailboxes', async (req, res) => {
    try {
        const [{ data: users }, { data: boxes }] = await Promise.all([
            supabase.from('app_users_ecom').select('email, name, role, status').order('email'),
            supabase.from('app_user_smtp_ecom').select('user_email, from_name, from_email, smtp_host, smtp_port, smtp_user, smtp_password_enc, active, updated_by, updated_at'),
        ]);
        const by = {};
        (boxes || []).forEach(b => { by[b.user_email] = b; });
        const rows = (users || []).map(u => {
            const key = String(u.email || '').toLowerCase();
            const b = by[key];
            return {
                user_email: key, name: u.name || '', role: u.role || '', status: u.status || '',
                mapped: !!b,
                from_name: b ? (b.from_name || '') : '',
                from_email: b ? (b.from_email || '') : '',
                smtp_host: b ? (b.smtp_host || '') : '',
                smtp_port: b ? (b.smtp_port || '') : '',
                smtp_user: b ? (b.smtp_user || '') : '',
                password_set: !!(b && b.smtp_password_enc),
                active: b ? b.active !== false : false,
                updated_by: b ? (b.updated_by || null) : null,
                updated_at: b ? (b.updated_at || null) : null,
            };
        });
        // A mailbox whose portal user was deleted still needs to be visible so it can be cleaned up.
        const known = new Set(rows.map(r => r.user_email));
        (boxes || []).filter(b => !known.has(b.user_email)).forEach(b => rows.push({
            user_email: b.user_email, name: '(no portal user)', role: '', status: 'orphan', mapped: true,
            from_name: b.from_name || '', from_email: b.from_email || '', smtp_host: b.smtp_host || '',
            smtp_port: b.smtp_port || '', smtp_user: b.smtp_user || '', password_set: !!b.smtp_password_enc,
            active: b.active !== false, updated_by: b.updated_by || null, updated_at: b.updated_at || null,
        }));
        res.json({ success: true, mailboxes: rows });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/user-mailboxes', async (req, res) => {
    const b = req.body || {};
    const key = String(b.user_email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return res.status(400).json({ message: 'A valid portal user email is required.' });
    const from_email = String(b.from_email || key).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from_email)) return res.status(400).json({ message: 'A valid From address is required.' });
    const patch = {
        user_email: key,
        from_name: (b.from_name || '').trim() || null,
        from_email,
        smtp_host: (b.smtp_host || '').trim() || null,
        smtp_port: b.smtp_port ? parseInt(b.smtp_port, 10) || null : null,
        smtp_user: (b.smtp_user || from_email).trim() || null,
        active: b.active !== false,
        updated_by: req.user.sub,
        updated_at: new Date().toISOString(),
    };
    // Blank password on an edit = keep the stored one (same rule as the shared settings form).
    if (typeof b.smtp_password === 'string' && b.smtp_password.trim() !== '') patch.smtp_password_enc = encrypt(b.smtp_password.trim());
    const { error } = await supabase.from('app_user_smtp_ecom').upsert(patch, { onConflict: 'user_email' });
    if (error) return res.status(500).json({ message: error.message });
    // A mapping with no password can never send — say so now rather than at send time.
    const { data: after } = await supabase.from('app_user_smtp_ecom').select('smtp_password_enc').eq('user_email', key).maybeSingle();
    res.json({ success: true, password_set: !!(after && after.smtp_password_enc) });
});

router.delete('/user-mailboxes/:email', async (req, res) => {
    const key = String(req.params.email || '').trim().toLowerCase();
    const { error } = await supabase.from('app_user_smtp_ecom').delete().eq('user_email', key);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ success: true });
});

// Verify one user's mailbox end-to-end by sending them a test email from their OWN address.
router.post('/user-mailboxes/test', async (req, res) => {
    const key = String((req.body && req.body.user_email) || '').trim().toLowerCase();
    const to = (req.body && req.body.to) || key;
    try {
        const r = await sendMailAs(key, {
            to,
            subject: 'Ecom Central — sending mailbox test ✓',
            text: `This test was sent from ${key}'s mapped mailbox. If you received it, outreach email will send from this address.`,
            html: `<p>This test was sent from <b>${key}</b>'s mapped mailbox. If you received it, outreach email will send from this address.</p>`,
        });
        res.json({ success: true, message: `Sent to ${r.to.join(', ')} from ${r.from}` });
    } catch (e) { res.status(e.code === 'NO_USER_MAILBOX' ? 400 : 500).json({ message: e.message }); }
});

module.exports = { router, getEmailConfig, sendMail, sendMailAs, getUserMailbox, recipientsFor };
