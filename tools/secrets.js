#!/usr/bin/env node
// Pravidhi secrets vault CLI — AES-256-GCM over the whole .env. See app/secrets.js for the format.
//
//   node tools/secrets.js init                 create ~/.pravidhi/master.key (once per machine)
//   node tools/secrets.js encrypt [--delete]   .env → .env.vault (keeps .env for local editing; --delete removes it: servers)
//   node tools/secrets.js decrypt [--to-file]  print the plaintext (or write .env back — for editing)
//   node tools/secrets.js get KEY              print one value
//   node tools/secrets.js set KEY VALUE        add/replace one value (re-seals the vault)
//   node tools/secrets.js unset KEY            remove one key
//   node tools/secrets.js list                 key NAMES only
//   node tools/secrets.js rotate               new master key + re-seal (old key file kept as .bak)
//   node tools/secrets.js check                where things stand (vault? key? openable? .env in sync?)
//
//   Local dev keeps a plaintext .env: it is the source of truth and the vault is re-sealed from it on
//   every boot. A server (VPS / Tally PC) keeps ONLY .env.vault.
//
//   --dir <folder>   operate on another folder's .env/.env.vault (e.g. --dir tally-bridge)
//   --key <hex|passphrase>  use this master secret instead of the key file (rotate: the NEW one)
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../app/secrets');

const argv = process.argv.slice(2);
const flags = {}; const args = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const nxt = argv[i + 1]; if (nxt !== undefined && !nxt.startsWith('--') && ['dir', 'key', 'file'].includes(k)) { flags[k] = nxt; i++; } else flags[k] = true; }
    else args.push(a);
}
const cmd = args.shift();
const dir = path.resolve(flags.dir || path.join(__dirname, '..'));
const secret = flags.key || undefined;

function die(msg, code = 1) { console.error(`✗ ${msg}`); process.exit(code); }
function ok(msg) { console.log(`✓ ${msg}`); }

function requirePlainOrVault() {
    const p = S.plainPath(dir), v = S.vaultPath(dir);
    if (!fs.existsSync(p) && !fs.existsSync(v)) die(`neither ${S.PLAIN_NAME} nor ${S.VAULT_NAME} found in ${dir}`);
}

const commands = {
    init() {
        const file = flags.file || S.keyFilePath();
        if (fs.existsSync(file) && !flags.force) die(`master key already exists at ${file}. It protects every vault on this machine — run with --force only if you mean to replace it.`);
        const hex = S.generateMasterKey();
        S.writeMasterKeyFile(hex, { file, force: !!flags.force });
        ok(`master key written to ${file}`);
        console.log('  Back this file up somewhere that is NOT this machine (password manager). Without it the vault cannot be opened.');
        console.log('  The server finds it automatically; on a different path set PRAVIDHI_MASTER_KEY_FILE (or PRAVIDHI_MASTER_KEY) in the process environment.');
    },
    encrypt() {
        const p = S.plainPath(dir);
        if (!fs.existsSync(p)) die(`no ${S.PLAIN_NAME} in ${dir} to encrypt`);
        if (!secret && !S.readMasterSecret()) die('no master key — run: node tools/secrets.js init');
        const text = fs.readFileSync(p, 'utf8');
        const out = S.sealVault(dir, text, secret);
        // Prove the round trip before touching the plaintext: what we can't read back, we don't delete.
        const back = S.openVault(dir, secret).text;
        if (back !== text) die('round-trip mismatch — vault written but .env NOT removed');
        ok(`sealed ${Object.keys(require('dotenv').parse(text)).length} keys into ${out}`);
        if (flags.delete) { fs.unlinkSync(p); ok(`deleted plaintext ${p} — this folder now runs vault-only`); }
        else console.log(`  kept ${p} for local editing (it stays the source of truth; the vault is re-sealed from it at every boot).\n  On a SERVER run with --delete so only the encrypted copy remains.`);
    },
    decrypt() {
        const { text } = S.openVault(dir, secret);
        if (flags['to-file']) {
            const p = S.plainPath(dir);
            if (fs.existsSync(p) && !flags.force) die(`${p} already exists (use --force to overwrite)`);
            fs.writeFileSync(p, text, { mode: 0o600 });
            ok(`wrote ${p} — edit it freely; the vault is re-sealed from it at every boot (or run "encrypt")`);
        } else process.stdout.write(text);
    },
    get() {
        const key = args[0]; if (!key) die('usage: get KEY');
        const parsed = require('dotenv').parse(S.openVault(dir, secret).text);
        if (!(key in parsed)) die(`${key} is not in the vault`, 2);
        process.stdout.write(parsed[key] + '\n');
    },
    // set/unset edit whichever is the source of truth: the plaintext .env in dev (then re-seal), the
    // vault alone on a server. Editing only the vault in dev would be undone by the next boot's re-seal.
    _edit(mutate, what) {
        const p = S.plainPath(dir);
        const dev = fs.existsSync(p);
        const text = dev ? fs.readFileSync(p, 'utf8') : S.openVault(dir, secret).text;
        const next = mutate(text);
        if (dev) fs.writeFileSync(p, next);
        S.sealVault(dir, next, secret);
        ok(`${what} in ${dev ? S.PLAIN_NAME + ' and ' : ''}${S.VAULT_NAME}`);
    },
    set() {
        const [key, ...rest] = args; const value = rest.join(' ');
        if (!key || value === undefined || value === '') die('usage: set KEY VALUE');
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) die(`"${key}" is not an env key name`);
        commands._edit(t => S.upsertLine(t, key, value), `${key} updated`);
    },
    unset() {
        const key = args[0]; if (!key) die('usage: unset KEY');
        commands._edit(t => S.removeLine(t, key), `${key} removed`);
    },
    list() {
        const parsed = require('dotenv').parse(S.openVault(dir, secret).text);
        Object.keys(parsed).sort().forEach(k => console.log(k));
        console.log(`(${Object.keys(parsed).length} keys)`);
    },
    rotate() {
        const { text } = S.openVault(dir);                      // old key (env/file)
        const file = S.keyFilePath();
        const newHex = flags.key || S.generateMasterKey();
        if (fs.existsSync(file)) { fs.copyFileSync(file, file + '.bak'); console.log(`  old key saved as ${file}.bak — delete it once every vault on this machine has been rotated`); }
        S.writeMasterKeyFile(newHex, { file, force: true });
        S.sealVault(dir, text, newHex);
        ok(`vault in ${dir} re-sealed with a new master key at ${file}`);
        console.log('  If tally-bridge/ (or any other folder) has its own vault on this machine, run: rotate --dir tally-bridge --key <the new key>');
    },
    check() {
        const st = S.status(dir);
        console.log(`folder      : ${st.dir}`);
        console.log(`vault       : ${st.vault ? S.VAULT_NAME + (st.openable ? ` (openable, ${st.keys} keys, sealed ${st.updated_at})` : ` (NOT openable: ${st.error})`) : 'none'}`);
        console.log(`plaintext   : ${st.plain ? S.PLAIN_NAME + (st.vault ? (st.inSync ? '  (local dev copy — in sync with the vault)' : '  (local dev copy — vault will be re-sealed from it at next boot / encrypt)') : '  ⚠ secrets unencrypted — run: encrypt') : 'none (vault-only — server mode)'}`);
        console.log(`master key  : ${st.keyFound ? `found (${st.keySource})` : `NOT found (expected ${st.keyFile}) — run: init`}`);
        const healthy = st.vault && st.openable;
        console.log(healthy ? (st.plain ? '✓ encrypted copy current (dev: plaintext .env kept on purpose)' : '✓ encrypted at rest (vault-only)') : '✗ not protected yet');
        process.exit(healthy ? 0 : 1);
    },
};

if (!cmd || !commands[cmd]) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 1 : 0);
}
try { if (cmd !== 'init' && cmd !== 'check') requirePlainOrVault(); commands[cmd](); }
catch (e) { die(e.message); }
