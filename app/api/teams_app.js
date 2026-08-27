// Teams app updater — Settings → "Teams bot app" card.
//
// Teams never offers an "Update" button for a bot installed in a team until its client happens to
// notice the org catalog changed (often a day later), and the manual alternative is remove → re-add
// → re-map in every team. This module does the same through Microsoft Graph in one click:
//   1. publish teams-app/Pravidhi.zip to the org catalog when the catalog is behind the package,
//   2. upgrade the installed copy in every team the signed-in admin belongs to.
// The App ID never changes, so channel history and the bot's stored serviceUrl are untouched.
//
// Auth is the same delegated Graph identity the listener uses (TEAMS_CLIENT_ID + rotating
// TEAMS_REFRESH_TOKEN in .env), but it needs FOUR scopes the listener's token was never consented
// for — so the card also carries a device-code sign-in that mints a refresh token with them:
//   Team.ReadBasic.All                    list the teams the admin is in
//   TeamsAppInstallation.ReadWriteForTeam read + upgrade the installed app (admin must be a team owner)
//   AppCatalog.ReadWrite.All              read the catalog version + publish the new package
//   User.Read / offline_access            identity + refresh token
// All four must ALSO be added to the app registration (Azure → App registrations → API permissions)
// with admin consent granted, or the sign-in fails with AADSTS65001 — the card says so in words.
//
// ⚠️ This tenant already gates part of Graph's Teams surface without notice (the channel-message read
// died with a bare 403 in 2026-08). The catalog / installation APIs are not in that protected group
// today; if they ever are, the status call will start returning 403 and the card reports it rather
// than pretending an update happened.
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { tokenRequired, requireAdmin } = require('../auth');
const { persistRefreshToken } = require('./teams_listener');

const router = express.Router();
const cfg = k => process.env[k] || config[k];
const TENANT = () => cfg('TEAMS_TENANT_ID');
const CLIENT = () => cfg('TEAMS_CLIENT_ID');
const APP_ID = () => cfg('TEAMS_BOT_APP_ID');
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'offline_access User.Read Team.ReadBasic.All TeamsAppInstallation.ReadWriteForTeam AppCatalog.ReadWrite.All';
const PKG_DIR = path.join(__dirname, '..', '..', 'teams-app');
const ZIP = path.join(PKG_DIR, 'Pravidhi.zip');

// ── package on disk ─────────────────────────────────────────────────────────────────────────────
function localPackage() {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'manifest.json'), 'utf8'));
        return { version: m.version, name: m.name && m.name.short, id: m.id, zip: fs.existsSync(ZIP) };
    } catch (e) { return { version: null, error: e.message, zip: fs.existsSync(ZIP) }; }
}
function cmpVer(a, b) {
    const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
}

// ── token (refresh-token flow with the WIDER scope) ─────────────────────────────────────────────
let accessToken = null, tokenExpiry = 0;
function scopesOf(token) {
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString()).scp || ''; } catch (_) { return ''; }
}
// Returns the token, or throws an Error with .needsSignin=true when the stored refresh token was
// never consented for these scopes (the listener's token predates them).
async function getToken() {
    if (accessToken && Date.now() < tokenExpiry - 120000) return accessToken;
    const rt = process.env.TEAMS_REFRESH_TOKEN || config.TEAMS_REFRESH_TOKEN;
    if (!rt) { const e = new Error('No Microsoft sign-in stored yet.'); e.needsSignin = true; throw e; }
    const res = await axios.post(`https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/token`,
        new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT(), refresh_token: rt, scope: SCOPE }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true, timeout: 15000 });
    if (res.status !== 200) {
        const desc = String((res.data && res.data.error_description) || '');
        const e = new Error(/AADSTS65001|consent/i.test(desc) ? 'The app registration has not been granted these permissions yet (AADSTS65001).' : `Microsoft sign-in refresh failed (${(res.data && res.data.error) || res.status}).`);
        e.needsSignin = true; e.detail = desc.slice(0, 300);
        throw e;
    }
    const scp = scopesOf(res.data.access_token);
    const missing = ['Team.ReadBasic.All', 'TeamsAppInstallation.ReadWriteForTeam', 'AppCatalog.ReadWrite.All'].filter(s => !scp.split(/\s+/).includes(s));
    if (missing.length) {
        const e = new Error(`The stored sign-in lacks ${missing.join(', ')} — sign in again to grant them.`);
        e.needsSignin = true; throw e;
    }
    accessToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
    if (res.data.refresh_token) persistRefreshToken(res.data.refresh_token);
    return accessToken;
}
async function g(method, url, token, data, headers) {
    const r = await axios({ method, url: url.startsWith('http') ? url : GRAPH + url, data,
        headers: { Authorization: `Bearer ${token}`, ...(headers || {}) }, validateStatus: () => true, timeout: 30000 });
    if (r.status >= 400) {
        const msg = (r.data && r.data.error && r.data.error.message) || `HTTP ${r.status}`;
        const e = new Error(`${method.toUpperCase()} ${url.replace(GRAPH, '')} → ${r.status}: ${msg}`); e.status = r.status; throw e;
    }
    return r.data;
}

// ── Graph reads ─────────────────────────────────────────────────────────────────────────────────
async function catalogEntry(token) {
    const d = await g('get', `/appCatalogs/teamsApps?$filter=externalId eq '${APP_ID()}'&$expand=appDefinitions`, token);
    const app = (d.value || [])[0];
    if (!app) return null;
    const defs = (app.appDefinitions || []).slice().sort((a, b) => cmpVer(b.version, a.version));
    return { id: app.id, displayName: app.displayName, version: defs[0] ? defs[0].version : null, publishingState: defs[0] ? defs[0].publishingState : null };
}
async function teamsWithApp(token) {
    const teams = (await g('get', '/me/joinedTeams', token)).value || [];
    const out = [];
    for (const t of teams) {
        let inst = null, err = null;
        try {
            const d = await g('get', `/teams/${t.id}/installedApps?$expand=teamsApp,teamsAppDefinition&$filter=teamsApp/externalId eq '${APP_ID()}'`, token);
            inst = (d.value || [])[0] || null;
        } catch (e) { err = e.message; }
        out.push({ id: t.id, name: t.displayName, installed: !!inst, installation_id: inst ? inst.id : null,
            installed_version: inst && inst.teamsAppDefinition ? inst.teamsAppDefinition.version : null, error: err });
    }
    return out;
}

// ── routes (admin only) ─────────────────────────────────────────────────────────────────────────
router.get('/teams/app/status', tokenRequired, requireAdmin, async (_req, res) => {
    const pkg = localPackage();
    if (!TENANT() || !CLIENT() || !APP_ID()) return res.json({ success: true, configured: false, package: pkg, error: 'TEAMS_TENANT_ID / TEAMS_CLIENT_ID / TEAMS_BOT_APP_ID are not all set.' });
    try {
        const token = await getToken();
        const [catalog, teams] = await Promise.all([catalogEntry(token), teamsWithApp(token)]);
        const stale = teams.filter(t => t.installed && catalog && cmpVer(t.installed_version, catalog.version) < 0);
        res.json({ success: true, configured: true, signed_in: true, package: pkg, catalog, teams,
            catalog_behind: !!(catalog && pkg.version && cmpVer(pkg.version, catalog.version) > 0),
            stale_teams: stale.length });
    } catch (e) {
        if (e.needsSignin) return res.json({ success: true, configured: true, signed_in: false, package: pkg, error: e.message, detail: e.detail || null });
        res.status(502).json({ success: false, package: pkg, error: e.message });
    }
});

router.post('/teams/app/update', tokenRequired, requireAdmin, async (req, res) => {
    const pkg = localPackage();
    const steps = [];
    try {
        const token = await getToken();
        let catalog = await catalogEntry(token);
        if (!catalog) throw new Error('The bot is not in the org app catalog yet — upload the package once in Teams admin center, then this button can keep it current.');
        // 1. catalog behind the package on disk → publish the zip as a new app definition.
        if (pkg.version && cmpVer(pkg.version, catalog.version) > 0) {
            if (!pkg.zip) throw new Error('teams-app/Pravidhi.zip is missing — run `node teams-app/build.js` and zip it first.');
            await g('post', `/appCatalogs/teamsApps/${catalog.id}/appDefinitions`, token, fs.readFileSync(ZIP), { 'Content-Type': 'application/zip' });
            steps.push({ step: 'publish', ok: true, from: catalog.version, to: pkg.version });
            // Graph publishes asynchronously; re-read until the new version shows (bounded).
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 1500));
                catalog = await catalogEntry(token);
                if (catalog && cmpVer(catalog.version, pkg.version) >= 0) break;
            }
        } else steps.push({ step: 'publish', ok: true, skipped: true, version: catalog.version });
        // 2. every team with an older copy → upgrade in place (same App ID, nothing to re-map).
        const teams = await teamsWithApp(token);
        for (const t of teams) {
            if (!t.installed) { steps.push({ step: 'upgrade', team: t.name, skipped: true, reason: 'not installed here' }); continue; }
            if (cmpVer(t.installed_version, catalog.version) >= 0) { steps.push({ step: 'upgrade', team: t.name, skipped: true, reason: `already ${t.installed_version}` }); continue; }
            try {
                await g('post', `/teams/${t.id}/installedApps/${t.installation_id}/upgrade`, token, {}, { 'Content-Type': 'application/json' });
                steps.push({ step: 'upgrade', team: t.name, ok: true, from: t.installed_version, to: catalog.version });
            } catch (e) { steps.push({ step: 'upgrade', team: t.name, ok: false, error: e.message }); }
        }
        const failed = steps.filter(s => s.ok === false).length;
        console.log(`[TeamsApp] update by ${req.user && req.user.sub}: ${JSON.stringify(steps)}`);
        res.json({ success: failed === 0, steps, catalog });
    } catch (e) {
        if (e.needsSignin) return res.status(401).json({ success: false, needs_signin: true, error: e.message, steps });
        res.status(502).json({ success: false, error: e.message, steps });
    }
});

// ── device-code sign-in (mints a refresh token carrying the wider scope) ────────────────────────
// The browser never sees the device_code: it gets an opaque handle and polls us; we poll Microsoft.
const pending = new Map();   // handle → { device_code, interval, expires }
router.post('/teams/app/signin', tokenRequired, requireAdmin, async (_req, res) => {
    try {
        const r = await axios.post(`https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/devicecode`,
            new URLSearchParams({ client_id: CLIENT(), scope: SCOPE }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true, timeout: 15000 });
        if (r.status !== 200) return res.status(502).json({ success: false, error: (r.data && (r.data.error_description || r.data.error)) || `devicecode ${r.status}` });
        const handle = crypto.randomBytes(12).toString('hex');
        pending.set(handle, { device_code: r.data.device_code, interval: (r.data.interval || 5) * 1000, expires: Date.now() + (r.data.expires_in || 900) * 1000, last: 0 });
        res.json({ success: true, handle, user_code: r.data.user_code, verification_uri: r.data.verification_uri, expires_in: r.data.expires_in });
    } catch (e) { res.status(502).json({ success: false, error: e.message }); }
});
router.get('/teams/app/signin/:handle', tokenRequired, requireAdmin, async (req, res) => {
    const p = pending.get(req.params.handle);
    if (!p) return res.status(404).json({ success: false, status: 'unknown' });
    if (Date.now() > p.expires) { pending.delete(req.params.handle); return res.json({ success: false, status: 'expired' }); }
    if (Date.now() - p.last < p.interval) return res.json({ success: true, status: 'pending' });
    p.last = Date.now();
    try {
        const r = await axios.post(`https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/token`,
            new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT(), device_code: p.device_code }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true, timeout: 15000 });
        if (r.status === 200) {
            pending.delete(req.params.handle);
            if (r.data.refresh_token) persistRefreshToken(r.data.refresh_token);
            accessToken = r.data.access_token; tokenExpiry = Date.now() + (r.data.expires_in || 3600) * 1000;
            return res.json({ success: true, status: 'done', scopes: scopesOf(r.data.access_token) });
        }
        const err = r.data && r.data.error;
        if (err === 'authorization_pending' || err === 'slow_down') { if (err === 'slow_down') p.interval += 5000; return res.json({ success: true, status: 'pending' }); }
        pending.delete(req.params.handle);
        res.json({ success: false, status: 'error', error: (r.data && r.data.error_description) || err || `token ${r.status}` });
    } catch (e) { res.status(502).json({ success: false, status: 'error', error: e.message }); }
});

module.exports = { router, cmpVer, localPackage };
