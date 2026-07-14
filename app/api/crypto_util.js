// AES-256-GCM helper for encrypting secrets at rest (currently the portal-managed SMTP password).
// Format: "v1$<iv_hex>$<authtag_hex>$<ciphertext_hex>". GCM gives us tamper-detection via the auth tag.
const crypto = require('crypto');
const config = require('../../config');

// Derive a stable 32-byte key. A dedicated 64-hex-char EMAIL_ENC_KEY is used verbatim; anything else
// (or the JWT_SECRET fallback) is stretched with scrypt against a fixed salt so it's deterministic.
function deriveKey() {
    const raw = config.EMAIL_ENC_KEY || config.SECRET_KEY;
    if (!raw) throw new Error('No EMAIL_ENC_KEY or JWT_SECRET set — cannot (de)crypt stored secrets.');
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    return crypto.scryptSync(String(raw), 'ecom-email-settings-v1', 32);
}

// Encrypt a plaintext string → tagged token, or null for empty input.
function encrypt(plain) {
    if (plain === null || plain === undefined || plain === '') return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1$${iv.toString('hex')}$${tag.toString('hex')}$${ct.toString('hex')}`;
}

// Decrypt a token produced by encrypt(); returns null on any tamper/parse/version mismatch.
function decrypt(stored) {
    if (!stored) return null;
    try {
        const [v, ivh, tagh, cth] = String(stored).split('$');
        if (v !== 'v1' || !ivh || !tagh || !cth) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivh, 'hex'));
        decipher.setAuthTag(Buffer.from(tagh, 'hex'));
        return Buffer.concat([decipher.update(Buffer.from(cth, 'hex')), decipher.final()]).toString('utf8');
    } catch (e) { console.error('[Crypto] decrypt failed:', e.message); return null; }
}

module.exports = { encrypt, decrypt };
