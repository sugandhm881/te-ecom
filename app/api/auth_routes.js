const express = require('express');
const router = express.Router();
const config = require('../../config');
const { generateToken } = require('../auth');

router.post('/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required!' });
    }

    const validEmail = config.APP_USER_EMAIL;
    const validPassword = config.APP_USER_PASSWORD;

    // Security Check
    if (!validEmail || !validPassword) {
        console.error("--- [SECURITY WARNING] Login attempt failed: APP_USER_EMAIL or APP_USER_PASSWORD not set. ---");
        return res.status(500).json({ message: 'Server configuration error. Cannot process login.' });
    }

    if (email === validEmail && password === validPassword) {
        const token = generateToken(email);
        return res.json({ token });
    }

    return res.status(401).json({ message: 'Invalid credentials!' });
});

router.get('/get-login-details', (req, res) => {
    // In Express, check NODE_ENV for debug mode equivalent
    if (process.env.NODE_ENV !== 'production') {
        return res.json({
            email: config.APP_USER_EMAIL || '',
            password: config.APP_USER_PASSWORD || ''
        });
    } else {
        return res.status(404).json({ error: 'This endpoint is not available in production.' });
    }
});

module.exports = router;