const jwt = require('jsonwebtoken');
const config = require('../config');

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

function generateToken(email) {
    try {
        return jwt.sign(
            { sub: email },
            assertStrongSecret(),
            { expiresIn: '1d' }
        );
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

module.exports = { generateToken, tokenRequired };