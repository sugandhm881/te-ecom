// Email OTP for 2FA login (all accounts). The OTP is generated here, kept ONLY as an
// HMAC-SHA256 hash in a short-lived in-memory store (single pm2 instance; a restart just
// voids pending OTPs), and mailed via the shared sendMail — so it goes out from the sender
// configured in Settings → Email (digital@theelement.skin), with .env EMAIL_* as fallback.
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const config = require('../config');
const { getEmailConfig, sendMail } = require('./api/email_settings');

const TTL_MS = 5 * 60 * 1000;      // OTP validity
const MAX_ATTEMPTS = 5;            // wrong tries before the OTP is voided
const RESEND_GAP_MS = 25 * 1000;   // server-side resend throttle (UI cooldown is 30s)
const OTP_SUBJECT_TAG = 'is your Ecom Central login OTP';   // constant part of the subject — used to find OTP mails in Sent

const _store = new Map();          // email -> { hash, exp, attempts, lastSentAt }

const hmac = otp => crypto.createHmac('sha256', String(config.SECRET_KEY)).update(String(otp)).digest('hex');

// 2FA is active whenever the portal can send mail at all.
async function configured() { try { return !!(await getEmailConfig()); } catch (_) { return false; } }

async function sendOtp(email, opts = {}) {
    const now = Date.now();
    const cur = _store.get(email);
    if (cur && now - cur.lastSentAt < RESEND_GAP_MS) {
        // A duplicate /login within the gap (double-submit, second tab) reuses the OTP already
        // in flight instead of erroring — the user just typed the code they received.
        if (opts.reuseIfRecent && now < cur.exp) return 'reused';
        throw new Error('Please wait a few seconds before requesting another OTP.');
    }
    if (_store.size > 500) for (const [k, v] of _store) if (v.exp < now) _store.delete(k);
    const otp = String(crypto.randomInt(100000, 1000000));
    _store.set(email, { hash: hmac(otp), exp: now + TTL_MS, attempts: 0, lastSentAt: now });
    try {
        await sendMail({
            to: [email],
            cc: [],   // OTPs go to the recipient ONLY — never the default report CC from Settings
            subject: `${otp} ${OTP_SUBJECT_TAG}`,
            html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
                <div style="margin:0 0 4px">
                    <img src="${config.DASHBOARD_URL}/static/assets/ecom-logo.png" width="34" height="34" alt="" style="border-radius:8px;vertical-align:middle;margin-right:10px">
                    <span style="font-size:20px;font-weight:bold;color:#4338ca;vertical-align:middle">Ecom Central</span>
                </div>
                <p style="color:#475569;font-size:14px;margin:8px 0">Use this one-time password to finish signing in:</p>
                <div style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#1e293b;text-align:center;padding:16px 0">${otp}</div>
                <p style="color:#64748b;font-size:12px;margin:8px 0 0">Valid for 5 minutes and usable once. If you didn't try to sign in to Ecom Central, ignore this email and consider changing your password.</p>
            </div>`,
            text: `Your Ecom Central login OTP is ${otp}. It is valid for 5 minutes and usable once. If you didn't try to sign in, ignore this email.`,
            // Logo is a HOSTED image (served by the dashboard VPS), NOT an attachment — so Gmail shows
            // no "ecom-logo.png" chip in the inbox list and there is nothing to click/preview. Trade-off:
            // if the dashboard server is unreachable the logo simply doesn't render (text stays intact).
        });
    } catch (e) {
        _store.delete(email);       // send failed → no live OTP lingering
        throw e;
    }
    // Once this OTP has expired, wipe its copy from the sender's Sent folder.
    setTimeout(() => sweepOtpSent('scheduled'), TTL_MS + 15 * 1000).unref();
    return true;
}

// Delete expired OTP emails from the sender mailbox (digital@theelement.skin): find them in
// Sent by the constant subject tag, move to Trash, then expunge them from Trash (permanent).
// Gmail note: a plain \Deleted+expunge in Sent only archives — the Trash round-trip is required.
let _sweeping = false;
async function sweepOtpSent(reason, olderThanMs = TTL_MS) {
    if (_sweeping) return; _sweeping = true;
    try {
        const cfg = await getEmailConfig(); if (!cfg) return;
        const host = process.env.IMAP_HOST || String(cfg.host).replace(/^smtp\./i, 'imap.');
        const client = new ImapFlow({ host, port: 993, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
        await client.connect();
        try {
            const boxes = await client.list();
            const sent = (boxes.find(b => b.specialUse === '\\Sent') || {}).path || '[Gmail]/Sent Mail';
            const trash = (boxes.find(b => b.specialUse === '\\Trash') || {}).path || '[Gmail]/Trash';
            const cutoff = Date.now() - olderThanMs;
            let moved = 0;
            let lock = await client.getMailboxLock(sent);
            try {
                const uids = await client.search({ subject: OTP_SUBJECT_TAG }, { uid: true });
                const expired = [];
                if (uids && uids.length) {
                    // two-phase (collect, then act) — never mutate inside an active fetch iterator
                    for await (const msg of client.fetch(uids, { internalDate: true }, { uid: true })) {
                        if (msg.internalDate && new Date(msg.internalDate).getTime() < cutoff) expired.push(msg.uid);
                    }
                    if (expired.length) { await client.messageMove(expired, trash, { uid: true }); moved = expired.length; }
                }
            } finally { lock.release(); }
            if (moved) {
                // Best-effort permanent expunge — Gmail occasionally rejects this transiently;
                // the mail is already out of Sent either way (Trash auto-purges in 30 days).
                try {
                    lock = await client.getMailboxLock(trash);
                    try {
                        const uids = await client.search({ subject: OTP_SUBJECT_TAG }, { uid: true });
                        if (uids && uids.length) await client.messageDelete(uids, { uid: true });
                    } finally { lock.release(); }
                } catch (e) { console.warn('[2FA] Trash expunge failed (mail already out of Sent):', e.message); }
                console.log(`[2FA] purged ${moved} expired OTP email(s) from ${cfg.from} Sent (${reason})`);
            }
        } finally { await client.logout().catch(() => {}); }
    } catch (e) { console.warn('[2FA] OTP sent-mail purge failed:', e.message); }
    finally { _sweeping = false; }
}

// Startup sweeps — catch OTP mails whose scheduled purge was lost to a server restart.
setTimeout(() => sweepOtpSent('startup'), 60 * 1000).unref();
setTimeout(() => sweepOtpSent('startup-late'), TTL_MS + 90 * 1000).unref();

function verifyOtp(email, otp) {
    const rec = _store.get(email);
    if (!rec) return false;
    if (Date.now() > rec.exp) { _store.delete(email); return false; }
    rec.attempts++;
    if (rec.attempts > MAX_ATTEMPTS) { _store.delete(email); return false; }
    const a = Buffer.from(rec.hash, 'hex'), b = Buffer.from(hmac(String(otp).trim()), 'hex');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (ok) _store.delete(email);   // single use
    return ok;
}

module.exports = { configured, sendOtp, verifyOtp, sweepOtpSent };
