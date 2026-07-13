const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

// --- Password hashing (Node built-in scrypt; no external dependency) ---
function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    return 'scrypt$' + salt + '$' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
    try {
        const [scheme, salt, hash] = String(stored).split('$');
        if (scheme !== 'scrypt' || !salt || !hash) return false;
        const a = Buffer.from(hash, 'hex');
        const b = crypto.scryptSync(String(pw), salt, 64);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) { return false; }
}

// Refuse to operate with a missing or weak/guessable signing secret.
// A weak secret lets anyone forge valid tokens, which is equivalent to no auth.
const WEAK_SECRETS = new Set(['you-should-really-change-this', 'secret', 'changeme', '']);

function assertStrongSecret() {
    const s = config.SECRET_KEY;
    if (!s || WEAK_SECRETS.has(s) || s.length < 32) {
        throw new Error(
            'JWT_SECRET is missing or weak. Set a strong, random JWT_SECRET (>=32 chars) in .env.'
        );
    }
    return s;
}

// Accepts an email string (legacy/env-admin bootstrap → admin) or a { email, role, permissions } object.
function generateToken(user) {
    try {
        const claims = typeof user === 'string'
            ? { sub: user, role: 'admin', permissions: ['*'] }
            : { sub: user.email, role: user.role || 'user', permissions: user.permissions || [] };
        return jwt.sign(claims, assertStrongSecret(), { expiresIn: '1d' });
    } catch (e) {
        console.error('[Auth] Cannot generate token:', e.message);
        return null;
    }
}

function tokenRequired(req, res, next) {
    let token = req.headers['authorization'];

    if (token && token.startsWith('Bearer ')) {
        token = token.slice(7, token.length);
    } else if (token && token.includes(' ')) {
        // Handle "Bearer <token>" manually if format varies
        token = token.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ message: 'Authentication token is missing!' });
    }

    try {
        const decoded = jwt.verify(token, assertStrongSecret());
        req.user = decoded; // Attach user to request
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token has expired! Please log in again.' });
        }
        return res.status(401).json({ message: 'Token is invalid!' });
    }
}

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') return next();
    return res.status(403).json({ message: 'Admin access required.' });
}

module.exports = { generateToken, tokenRequired, requireAdmin, hashPassword, verifyPassword };