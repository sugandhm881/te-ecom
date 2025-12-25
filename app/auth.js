const jwt = require('jsonwebtoken');
const config = require('../config');

function generateToken(email) {
    try {
        return jwt.sign(
            { sub: email },
            config.SECRET_KEY,
            { expiresIn: '1d' }
        );
    } catch (e) {
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
        const decoded = jwt.verify(token, config.SECRET_KEY);
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