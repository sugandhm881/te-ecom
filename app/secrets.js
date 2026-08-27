// Secrets vault — every credential the app reads from `.env` lives AES-256-GCM encrypted in
// `.env.vault`, and this module is the ONLY door to it.
//
//   • `load()`      decrypts the vault at boot and returns the parsed key/value map (config.js keeps
//                   its "the file beats a stale pm2 env" rule by reading that map first).
//   • `persist()`   is how runtime code writes a rotated credential back (TEAMS_REFRESH_TOKEN) — it
//                   re-encrypts the vault; it never creates a plaintext file.
//   • `read()`      one key for build scripts that run outside the server.
//
// Master key — the one secret that cannot itself be encrypted — is looked for, in order:
//   1. PRAVIDHI_MASTER_KEY        (64 hex chars = raw 32-byte key, or any passphrase → scrypt)
//   2. PRAVIDHI_MASTER_KEY_FILE   (path to a file holding the same)
//   3. ~/.pravidhi/master.key     (default; created by `node tools/secrets.js init`, mode 600)
// It deliberately lives OUTSIDE the repo folder so a copied/zipped/leaked project directory carries
// only ciphertext. Lose the key and the vault is gone: back it up somewhere that is not this machine.
//
// Vault format (JSON, one object, greppable header):
//   { v:1, alg:'aes-256-gcm', kdf:'raw'|'scrypt', salt?, iv, tag, ct, updated_at }
// The ciphertext is the WHOLE dotenv text, so key NAMES are hidden too, not just values.
//
// Two ways to run:
//   • DEV (this PC): a plaintext `.env` is present and is the SOURCE OF TRUTH — you edit it directly.
//     At every boot the vault is re-sealed from it, so `.env.vault` is always a current encrypted copy
//     ready to ship. `persist()` writes both.
//   • SERVER (VPS, Tally PC): only `.env.vault` exists; it is decrypted at boot. A vault that cannot be
//     opened (no key / wrong key) is a LOUD boot failure, never a silent fall-through.
// `.env` without any vault still works (warned about, so a server can never quietly run unsealed).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const VAULT_NAME = '.env.vault';
const PLAIN_NAME = '.env';
const DEFAULT_KEY_FILE = path.join(os.homedir(), '.pravidhi', 'master.key');
const SCRYPT_N = 1 << 15;

// ── master key ──────────────────────────────────────────────────────────────────────────────────
function keyFilePath() { return process.env.PRAVIDHI_MASTER_KEY_FILE || DEFAULT_KEY_FILE; }

// Returns { raw: string, source } or null. Never throws.
function readMasterSecret() {
    const env = (process.env.PRAVIDHI_MASTER_KEY || '').trim();
    if (env) return { raw: env, source: 'env:PRAVIDHI_MASTER_KEY' };
    const file = keyFilePath();
    try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (raw) return { raw, source: `file:${file}` };
    } catch (_) { /* no key file */ }
    return null;
}

// A 64-hex secret is used verbatim; anything else is a passphrase stretched with scrypt against the
// vault's own random salt (so the same passphrase yields a different key per vault).
function deriveKey(raw, saltHex) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return { key: Buffer.from(raw, 'hex'), kdf: 'raw' };
    const salt = Buffer.from(saltHex, 'hex');
    return { key: crypto.scryptSync(raw, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), kdf: 'scrypt' };
}

function generateMasterKey() { return crypto.randomBytes(32).toString('hex'); }

// Write a new master key file (refuses to overwrite unless force). Returns the path.
function writeMasterKeyFile(hex, { file = keyFilePath(), force = false } = {}) {
    if (fs.existsSync(file) && !force) throw new Error(`master key already exists at ${file} (use --force to replace — that orphans every vault encrypted with the old key)`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, hex + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows: ACLs, not modes */ }
    return file;
}

// ── vault primitives (pure: text ⇄ vault object) ────────────────────────────────────────────────
function encryptText(plain, rawSecret) {
    const salt = crypto.randomBytes(16).toString('hex');
    const { key, kdf } = deriveKey(rawSecret, salt);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return {
        v: 1, alg: 'aes-256-gcm', kdf, salt: kdf === 'scrypt' ? salt : undefined,
        iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ct: ct.toString('hex'),
        updated_at: new Date().toISOString(),
    };
}

// Throws on wrong key / tamper / unknown format — the caller decides how loud to be.
function decryptVault(vault, rawSecret) {
    if (!vault || vault.v !== 1 || vault.alg !== 'aes-256-gcm') throw new Error('unrecognised vault format');
    const { key } = deriveKey(rawSecret, vault.salt || '');
    if (vault.kdf === 'scrypt' && /^[0-9a-fA-F]{64}$/.test(rawSecret)) throw new Error('vault was sealed with a passphrase, but a raw hex key was supplied');
    if (vault.kdf === 'raw' && !/^[0-9a-fA-F]{64}$/.test(rawSecret)) throw new Error('vault was sealed with a raw hex key, but a passphrase was supplied');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(vault.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(vault.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(vault.ct, 'hex')), decipher.final()]).toString('utf8');
}

// ── files ───────────────────────────────────────────────────────────────────────────────────────
function vaultPath(dir) { return path.join(dir, VAULT_NAME); }
function plainPath(dir) { return path.join(dir, PLAIN_NAME); }

function readVaultFile(dir) {
    const p = vaultPath(dir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Atomic write: temp file + rename, so a crash mid-write can never leave a half vault behind.
function writeVaultFile(dir, vault) {
    const p = vaultPath(dir);
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(vault, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch (_) { /* Windows */ }
    return p;
}

// Read the vault's plaintext, or throw with a reason. `secret` may be passed by the CLI.
function openVault(dir, secret) {
    const vault = readVaultFile(dir);
    if (!vault) throw Object.assign(new Error(`no ${VAULT_NAME} in ${dir}`), { code: 'NO_VAULT' });
    const ms = secret ? { raw: secret, source: 'arg' } : readMasterSecret();
    if (!ms) throw Object.assign(new Error(`${VAULT_NAME} exists but no master key was found (PRAVIDHI_MASTER_KEY, PRAVIDHI_MASTER_KEY_FILE, or ${DEFAULT_KEY_FILE})`), { code: 'NO_KEY' });
    try { return { text: decryptVault(vault, ms.raw), source: ms.source, vault }; }
    catch (e) { throw Object.assign(new Error(`${VAULT_NAME} could not be opened with the key from ${ms.source}: ${e.message}`), { code: 'BAD_KEY' }); }
}

function sealVault(dir, text, secret) {
    const ms = secret ? { raw: secret } : readMasterSecret();
    if (!ms) throw Object.assign(new Error(`no master key — run: node tools/secrets.js init`), { code: 'NO_KEY' });
    return writeVaultFile(dir, encryptText(text, ms.raw));
}

// ── dotenv text editing (keeps comments/order; only the one line changes) ───────────────────────
function upsertLine(text, key, value) {
    const safe = String(value);
    const needsQuote = /[\s#"'\\]/.test(safe) || safe === '';
    const line = `${key}=${needsQuote ? JSON.stringify(safe) : safe}`;
    const re = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
    if (re.test(text)) return text.replace(re, line);
    return text.replace(/\n?$/, '\n') + line + '\n';
}
function removeLine(text, key) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*\\n?`, 'm');
    return text.replace(re, '');
}

// ── public: load at boot ────────────────────────────────────────────────────────────────────────
// Returns { parsed, mode: 'dev'|'vault'|'plain'|'none', source, warnings[], resealed } and applies
// `parsed` to process.env (without overriding vars that are already set — same contract as dotenv,
// so the caller can still prefer the file map explicitly, as config.js does).
//   dev   = plaintext .env present AND a vault: .env is the source, the vault is re-sealed from it
//   vault = vault only (server)
//   plain = .env only, no vault yet (warned)
let _loaded = null;
function load({ dir = path.join(__dirname, '..'), quiet = false, override = false } = {}) {
    if (_loaded && _loaded.dir === dir) return _loaded;
    const warnings = [];
    let parsed = {}, mode = 'none', source = null, resealed = false;
    const hasVault = fs.existsSync(vaultPath(dir));
    const hasPlain = fs.existsSync(plainPath(dir));

    if (hasPlain) {
        const text = fs.readFileSync(plainPath(dir), 'utf8');
        parsed = dotenv.parse(text); source = plainPath(dir);
        if (hasVault) {
            mode = 'dev';
            // Keep the encrypted copy current — but only re-seal when the content actually changed, so
            // a boot that touched nothing leaves the vault (and its timestamp) alone.
            try {
                let current = null;
                try { current = openVault(dir).text; } catch (_) { /* unreadable → re-seal below */ }
                if (current !== text) { sealVault(dir, text); resealed = true; }
            } catch (e) { warnings.push(`${PLAIN_NAME} in use, but ${VAULT_NAME} could not be re-sealed: ${e.message}`); }
        } else {
            mode = 'plain';
            warnings.push(`secrets are UNENCRYPTED on disk — run: node tools/secrets.js init && node tools/secrets.js encrypt`);
        }
    } else if (hasVault) {
        try {
            const v = openVault(dir);
            parsed = dotenv.parse(v.text); mode = 'vault'; source = v.source;
        } catch (e) { const err = new Error(`[secrets] ${e.message}`); err.code = e.code; throw err; }
    }
    for (const [k, val] of Object.entries(parsed)) {
        if (override || process.env[k] === undefined) process.env[k] = val;
    }
    if (!quiet) {
        for (const w of warnings) console.warn(`[secrets] ${w}`);
        if (mode === 'dev' && resealed) console.log(`[secrets] local ${PLAIN_NAME} in use — ${VAULT_NAME} re-sealed from it`);
    }
    _loaded = { dir, parsed, mode, source, warnings, resealed };
    return _loaded;
}

// ── public: write one key back (rotated tokens) ─────────────────────────────────────────────────
// Dev: edit `.env` in place AND re-seal the vault from it. Server: decrypt → edit → re-encrypt →
// atomic rename. Also updates process.env and the cached parsed map so the running process sees
// the new value immediately.
function persist(key, value, { dir = path.join(__dirname, '..') } = {}) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`refusing to persist non-env key name "${key}"`);
    const hasVault = fs.existsSync(vaultPath(dir));
    const hasPlain = fs.existsSync(plainPath(dir));
    let where;
    if (hasPlain) {
        const text = upsertLine(fs.readFileSync(plainPath(dir), 'utf8'), key, value);
        fs.writeFileSync(plainPath(dir), text);
        if (hasVault) { sealVault(dir, text); where = 'dev'; } else where = 'plain';
    } else if (hasVault) {
        const { text } = openVault(dir);
        sealVault(dir, upsertLine(text, key, value));
        where = 'vault';
    } else {
        throw new Error(`no ${VAULT_NAME} or ${PLAIN_NAME} in ${dir} to persist ${key} into`);
    }
    process.env[key] = String(value);
    if (_loaded && _loaded.dir === dir) _loaded.parsed[key] = String(value);
    return where;
}

// ── public: one key, for scripts that run outside the server ────────────────────────────────────
function read(key, opts) { return load({ quiet: true, ...(opts || {}) }).parsed[key]; }

// ── status for the CLI / health line (never returns a value, only shapes) ───────────────────────
function status(dir = path.join(__dirname, '..')) {
    const out = { dir, vault: fs.existsSync(vaultPath(dir)), plain: fs.existsSync(plainPath(dir)), keyFile: keyFilePath(), keyFound: !!readMasterSecret(), keySource: (readMasterSecret() || {}).source || null, openable: false, keys: 0, updated_at: null, inSync: null };
    if (out.vault) {
        try {
            const v = openVault(dir); out.openable = true; out.keys = Object.keys(dotenv.parse(v.text)).length; out.updated_at = v.vault.updated_at;
            if (out.plain) out.inSync = fs.readFileSync(plainPath(dir), 'utf8') === v.text;
        } catch (e) { out.error = e.message; }
    }
    return out;
}

module.exports = {
    load, persist, read, status,
    // building blocks (CLI + tests)
    encryptText, decryptVault, openVault, sealVault, upsertLine, removeLine,
    generateMasterKey, writeMasterKeyFile, readMasterSecret, keyFilePath,
    vaultPath, plainPath, VAULT_NAME, PLAIN_NAME, DEFAULT_KEY_FILE,
    _reset() { _loaded = null; },
};
