// Admin-only user management. Mounted at /api/admin. Every route requires a valid token AND role=admin.
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabase');
const { tokenRequired, requireAdmin, hashPassword } = require('../auth');

router.use(tokenRequired, requireAdmin);

const norm = e => String(e || '').toLowerCase().trim();
const MOBILE_RX = /^[6-9]\d{9}$/;                                  // Indian 10-digit mobile
const cleanMobile = m => String(m || '').replace(/\D/g, '').slice(-10);

// List all users.
router.get('/users', async (req, res) => {
    const { data, error } = await supabase.from('app_users_ecom')
        .select('id, email, name, mobile, role, status, permissions, created_by, created_at')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    res.json({ success: true, users: data || [] });
});

// Update a user's status / role / permissions (approve, disable, re-scope).
router.post('/users/:id', async (req, res) => {
    const { status, role, permissions, mobile, name } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (status && ['pending', 'active', 'disabled'].includes(status)) patch.status = status;
    if (role && ['admin', 'user'].includes(role)) patch.role = role;
    if (Array.isArray(permissions)) patch.permissions = permissions;
    if (name !== undefined) patch.name = String(name || '').trim().slice(0, 80) || null;   // display name (welcome splash)
    if (mobile !== undefined) {
        const m = cleanMobile(mobile);
        if (!MOBILE_RX.test(m)) return res.status(400).json({ message: 'A valid 10-digit mobile number is required.' });
        patch.mobile = m;
    }
    const { error } = await supabase.from('app_users_ecom').update(patch).eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ success: true });
});

// Admin creates a user directly (active immediately). Mobile is mandatory.
router.post('/users', async (req, res) => {
    const email = norm(req.body && req.body.email);
    const password = (req.body && req.body.password) || '';
    const mobile = cleanMobile(req.body && req.body.mobile);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80) || null;
    const permissions = Array.isArray(req.body && req.body.permissions) ? req.body.permissions : [];
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: 'Please enter a valid email.' });
    if (!MOBILE_RX.test(mobile)) return res.status(400).json({ message: 'A valid 10-digit mobile number is required.' });
    if (String(password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    const { error } = await supabase.from('app_users_ecom').insert({
        email, name, password_hash: hashPassword(password), mobile, role: 'user', status: 'active', permissions, created_by: req.user.sub
    });
    if (error) return res.status(409).json({ message: 'That email already exists.' });
    res.json({ success: true });
});

// Reset a user's password.
router.post('/users/:id/password', async (req, res) => {
    const password = (req.body && req.body.password) || '';
    if (String(password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    const { error } = await supabase.from('app_users_ecom').update({ password_hash: hashPassword(password), updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ success: true });
});

router.delete('/users/:id', async (req, res) => {
    const { error } = await supabase.from('app_users_ecom').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ success: true });
});

module.exports = router;
