const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const config = require('../../config');
const { supabase } = require('../supabase');
const { generateToken, tokenRequired, hashPassword, verifyPassword } = require('../auth');
const otpMail = require('../otp_mail');

const norm = e => String(e || '').toLowerCase().trim();
// Display name for the .env bootstrap admin: APP_USER_NAME if set, else the name saved on its Users-page
// row (so an admin who set their name in the portal sees it on the welcome screen without touching .env).
async function adminName(email) {
    if (config.APP_USER_NAME) return config.APP_USER_NAME;
    try { const { data } = await supabase.from('app_users_ecom').select('name').eq('email', email).single(); return (data && data.name) || null; }
    catch (_) { return null; }
}
const MOBILE_RX = /^[6-9]\d{9}$/;                                  // Indian 10-digit mobile
const cleanMobile = m => String(m || '').replace(/\D/g, '').slice(-10);
const emailHint = e => { const [u, d] = String(e).split('@'); return (u || '').slice(0, 2) + '******@' + (d || ''); };

// In-memory rate limit for auth endpoints — blunts brute-force / credential-stuffing.
const _attempts = new Map(); // ip -> { count, first }
const RL_MAX = 10, RL_WINDOW = 15 * 60 * 1000;
function rateLimit(req, res, next) {
    const now = Date.now();
    // Use Express-resolved req.ip (respects trust-proxy) instead of the raw, client-spoofable
    // X-Forwarded-For header. Also limit per-account, so brute force is blunted even if the attacker
    // rotates IPs — the env bootstrap admin is exempt from the account limit (it must never lock out).
    const ip = req.ip || 'unknown';
    const email = norm((req.body || {}).email);
    const keys = ['ip:' + ip];
    if (email && email !== norm(config.APP_USER_EMAIL)) keys.push('em:' + email);
    for (const key of keys) {
        let a = _attempts.get(key);
        if (!a || now - a.first > RL_WINDOW) { a = { count: 0, first: now }; _attempts.set(key, a); }
        a.count++;
        if (a.count > RL_MAX) return res.status(429).json({ message: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    if (_attempts.size > 5000) { for (const [k, v] of _attempts) if (now - v.first > RL_WINDOW) _attempts.delete(k); }
    next();
}

// ── 2FA (ALL accounts — admins + regular users, since 2026-07-17) ───────────────────
// Password OK → if the portal can send email, a 6-digit OTP is emailed to the login address
// (sender = Settings → Email) and the client must call /login/verify-otp before a real token
// is issued. If email isn't configured, login falls through to password-only (never a lockout),
// with a server-side warning.
async function issueOrChallenge(res, user) {   // user = { email, role, permissions }
    if (await otpMail.configured()) {
        try { await otpMail.sendOtp(user.email, { reuseIfRecent: true }); }
        catch (e) {
            console.error('[2FA] OTP email send failed for', user.email, '-', e.message);
            return res.status(503).json({ message: 'Could not send the OTP email right now. Please try again in a minute.' });
        }
        // Short-lived pre-auth token — proves the password step passed; carries NO permissions.
        const otp_token = jwt.sign({ stage: 'otp2fa', email: user.email }, config.SECRET_KEY, { expiresIn: '5m' });
        return res.json({ otp_required: true, otp_token, email_hint: emailHint(user.email) });
    }
    console.warn('[2FA] login without OTP — email/SMTP not configured (Settings → Email)');
    return res.json({ token: generateToken({ email: user.email, role: user.role, permissions: user.permissions || [], name: user.name || null }) });
}

router.post('/login', rateLimit, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required!' });

    // 1) .env bootstrap admin — always works, so the admin can never be locked out.
    if (config.APP_USER_EMAIL && config.APP_USER_PASSWORD && norm(email) === norm(config.APP_USER_EMAIL) && password === config.APP_USER_PASSWORD) {
        return issueOrChallenge(res, { email: norm(email), role: 'admin', permissions: ['*'], name: await adminName(norm(email)) });
    }

    // 2) Database user.
    try {
        const { data: u } = await supabase.from('app_users_ecom').select('*').eq('email', norm(email)).single();
        if (u) {
            if (u.status === 'pending') return res.status(403).json({ message: 'Your account is pending admin approval.' });
            if (u.status === 'disabled') return res.status(403).json({ message: 'Your account has been disabled.' });
            if (u.status === 'active' && verifyPassword(password, u.password_hash)) {
                return issueOrChallenge(res, { email: u.email, role: u.role, permissions: u.permissions || [], name: u.name || null });
            }
        }
    } catch (_) {}
    return res.status(401).json({ message: 'Invalid credentials!' });
});

// Step 2 of 2FA: pre-auth token + the OTP the user received → real session token.
router.post('/login/verify-otp', rateLimit, async (req, res) => {
    const { otp_token, otp } = req.body || {};
    if (!otp_token || !otp) return res.status(400).json({ message: 'OTP is required.' });
    let claims;
    try { claims = jwt.verify(otp_token, config.SECRET_KEY); } catch (_) { return res.status(401).json({ message: 'This OTP session has expired — please sign in again.' }); }
    if (claims.stage !== 'otp2fa') return res.status(401).json({ message: 'Invalid OTP session.' });
    if (!otpMail.verifyOtp(claims.email, otp)) return res.status(401).json({ message: 'Incorrect or expired OTP.' });
    // Issue the real token with FRESH role/permissions (never trusted from the pre-auth token).
    if (config.APP_USER_EMAIL && claims.email === norm(config.APP_USER_EMAIL)) {
        return res.json({ token: generateToken({ email: claims.email, role: 'admin', permissions: ['*'], name: await adminName(claims.email) }) });
    }
    try {
        const { data: u } = await supabase.from('app_users_ecom').select('*').eq('email', claims.email).single();
        if (u && u.status === 'active') return res.json({ token: generateToken({ email: u.email, role: u.role, permissions: u.permissions || [], name: u.name || null }) });
    } catch (_) {}
    return res.status(403).json({ message: 'Account is not active.' });
});

router.post('/login/resend-otp', rateLimit, async (req, res) => {
    const { otp_token } = req.body || {};
    let claims;
    try { claims = jwt.verify(otp_token, config.SECRET_KEY); } catch (_) { return res.status(401).json({ message: 'This OTP session has expired — please sign in again.' }); }
    if (claims.stage !== 'otp2fa') return res.status(401).json({ message: 'Invalid OTP session.' });
    try { await otpMail.sendOtp(claims.email); } catch (e) { return res.status(503).json({ message: e.message }); }
    res.json({ ok: true });
});

// Open signup → creates a PENDING account with no access. Admin must approve + grant dashboards.
router.post('/signup', rateLimit, async (req, res) => {
    const email = norm(req.body && req.body.email);
    const password = (req.body && req.body.password) || '';
    const mobile = cleanMobile(req.body && req.body.mobile);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80) || null;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
    if (!name) return res.status(400).json({ message: 'Please enter your name.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: 'Please enter a valid email.' });
    if (!MOBILE_RX.test(mobile)) return res.status(400).json({ message: 'A valid 10-digit mobile number is required.' });
    if (String(password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    if (config.APP_USER_EMAIL && email === norm(config.APP_USER_EMAIL)) return res.status(409).json({ message: 'This email is reserved.' });
    try {
        const { data: existing } = await supabase.from('app_users_ecom').select('id').eq('email', email).single();
        if (existing) return res.status(409).json({ message: 'An account with this email already exists.' });
    } catch (_) {}
    const { error } = await supabase.from('app_users_ecom').insert({
        email, name, password_hash: hashPassword(password), mobile, role: 'user', status: 'pending', permissions: [], created_by: 'signup'
    });
    if (error) return res.status(500).json({ message: 'Could not create the account. Try again.' });
    return res.json({ ok: true, message: 'Account created — an admin will review and grant access.' });
});

// Who am I (from the token) — used by the frontend to gate the nav.
router.get('/me', tokenRequired, (req, res) => {
    res.json({ email: req.user.sub, role: req.user.role || 'user', permissions: req.user.permissions || [], name: req.user.name || null });
});

module.exports = router;
