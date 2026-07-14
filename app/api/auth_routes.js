const express = require('express');
const router = express.Router();
const config = require('../../config');
const { supabase } = require('../supabase');
const { generateToken, tokenRequired, hashPassword, verifyPassword } = require('../auth');

const norm = e => String(e || '').toLowerCase().trim();

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

router.post('/login', rateLimit, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required!' });

    // 1) .env bootstrap admin — always works, so the admin can never be locked out.
    if (config.APP_USER_EMAIL && config.APP_USER_PASSWORD && norm(email) === norm(config.APP_USER_EMAIL) && password === config.APP_USER_PASSWORD) {
        return res.json({ token: generateToken({ email: norm(email), role: 'admin', permissions: ['*'] }) });
    }

    // 2) Database user.
    try {
        const { data: u } = await supabase.from('app_users_ecom').select('*').eq('email', norm(email)).single();
        if (u) {
            if (u.status === 'pending') return res.status(403).json({ message: 'Your account is pending admin approval.' });
            if (u.status === 'disabled') return res.status(403).json({ message: 'Your account has been disabled.' });
            if (u.status === 'active' && verifyPassword(password, u.password_hash)) {
                return res.json({ token: generateToken({ email: u.email, role: u.role, permissions: u.permissions || [] }) });
            }
        }
    } catch (_) {}
    return res.status(401).json({ message: 'Invalid credentials!' });
});

// Open signup → creates a PENDING account with no access. Admin must approve + grant dashboards.
router.post('/signup', rateLimit, async (req, res) => {
    const email = norm(req.body && req.body.email);
    const password = (req.body && req.body.password) || '';
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: 'Please enter a valid email.' });
    if (String(password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    if (config.APP_USER_EMAIL && email === norm(config.APP_USER_EMAIL)) return res.status(409).json({ message: 'This email is reserved.' });
    try {
        const { data: existing } = await supabase.from('app_users_ecom').select('id').eq('email', email).single();
        if (existing) return res.status(409).json({ message: 'An account with this email already exists.' });
    } catch (_) {}
    const { error } = await supabase.from('app_users_ecom').insert({
        email, password_hash: hashPassword(password), role: 'user', status: 'pending', permissions: [], created_by: 'signup'
    });
    if (error) return res.status(500).json({ message: 'Could not create the account. Try again.' });
    return res.json({ ok: true, message: 'Account created — an admin will review and grant access.' });
});

// Who am I (from the token) — used by the frontend to gate the nav.
router.get('/me', tokenRequired, (req, res) => {
    res.json({ email: req.user.sub, role: req.user.role || 'user', permissions: req.user.permissions || [] });
});

module.exports = router;
