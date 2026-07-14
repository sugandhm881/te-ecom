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
    if (!host || !user || !pass) return null;     // not enough to send
    return { host, port, user, pass, from, to, cc, rapidshyp };
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

module.exports = { router, getEmailConfig, sendMail };
