// Builds the EcomBot Teams app package: manifest.json + the two icons Teams requires.
//
// The icons are generated rather than checked in as binaries so the brand colour and the App ID live
// in ONE place (here and .env) — a mismatch between the manifest's botId and the real Azure app is
// the single most confusing install failure, because Teams accepts the package and the bot then
// silently never responds.
//
// No image library: Teams wants a 192x192 colour icon and a 32x32 transparent outline, both of which
// are flat shapes. A ~30-line PNG encoder over zlib is far less weight than adding sharp/jimp and an
// npm install on the VPS.
//
// Run:  node teams-app/build.js      then zip the folder contents (see the printed instructions).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── minimal RGBA PNG encoder ─────────────────────────────────────────────────────────────────────
function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = c ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
    // Each scanline is prefixed with filter byte 0 (None) — no filtering needed for flat art.
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
    ]);
}
function canvas(w, h, fill) {
    const b = Buffer.alloc(w * h * 4);
    if (fill) for (let i = 0; i < w * h; i++) { b[i * 4] = fill[0]; b[i * 4 + 1] = fill[1]; b[i * 4 + 2] = fill[2]; b[i * 4 + 3] = fill[3]; }
    return b;
}
function rect(buf, w, x0, y0, rw, rh, c) {
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) {
        const i = (y * w + x) * 4;
        buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
    }
}

// ── PNG decode + downscale, so the real brand logo can be used as the colour icon ────────────────
// Teams wants exactly 192x192 and the source art is 1024x1024, so it has to be resampled. Decoding is
// the fiddly half: PNG stores each scanline with one of five filters applied, and they must be undone
// in order because most of them reference the row above.
function unfilter(raw, width, height, bpp) {
    const stride = width * bpp;
    const out = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const ft = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1, dst = y * stride, up = (y - 1) * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? out[dst + x - bpp] : 0;
            const b = y > 0 ? out[up + x] : 0;
            const c = (x >= bpp && y > 0) ? out[up + x - bpp] : 0;
            const v = raw[src + x];
            let val;
            switch (ft) {
                case 0: val = v; break;
                case 1: val = v + a; break;
                case 2: val = v + b; break;
                case 3: val = v + ((a + b) >> 1); break;
                case 4: {                                   // Paeth
                    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break;
                }
                default: throw new Error(`unsupported PNG filter ${ft}`);
            }
            out[dst + x] = val & 0xff;
        }
    }
    return out;
}
function decodePng(buf) {
    if (buf.slice(1, 4).toString() !== 'PNG') throw new Error('not a PNG');
    let p = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
    const idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p), tag = buf.slice(p + 4, p + 8).toString('ascii');
        const data = buf.slice(p + 8, p + 8 + len);
        if (tag === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            depth = data[8]; type = data[9]; interlace = data[12];
        } else if (tag === 'IDAT') idat.push(data);
        else if (tag === 'IEND') break;
        p += 12 + len;
    }
    if (depth !== 8) throw new Error(`only 8-bit PNGs supported (got ${depth})`);
    if (interlace) throw new Error('interlaced PNGs not supported');
    const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
    if (!ch) throw new Error(`unsupported colour type ${type} (palette PNGs not supported)`);
    const flat = unfilter(zlib.inflateSync(Buffer.concat(idat)), w, h, ch);
    // Normalise everything to RGBA so the resizer only has one case to handle.
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const s = i * ch, d = i * 4;
        if (type === 6) { rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = flat[s + 3]; }
        else if (type === 2) { rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = 255; }
        else if (type === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = flat[s + 1]; }
        else { rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = 255; }
    }
    return { width: w, height: h, rgba };
}
// Box-average downscale — averaging every source pixel that falls in a destination cell. Nearest
// neighbour on a 1024→192 reduction throws away 96% of the pixels and looks visibly ragged.
function resize(src, sw, sh, dw, dh) {
    const out = Buffer.alloc(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        const y0 = Math.floor(y * sh / dh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
        for (let x = 0; x < dw; x++) {
            const x0 = Math.floor(x * sw / dw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
                const i = (yy * sw + xx) * 4;
                r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
            }
            const d = (y * dw + x) * 4;
            out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = a / n;
        }
    }
    return out;
}

const INDIGO = [79, 70, 229, 255];      // #4F46E5 — the dashboard's accent
const WHITE = [255, 255, 255, 255];

// Colour icon: 192x192. Uses the real brand logo when one is available, falling back to a drawn "E"
// so the build never breaks just because artwork is missing.
//   teams-app/logo-source.png   ← drop a square PNG here to override
//   app/static/assets/ecom-logo.png ← otherwise the dashboard logo is used
let colour = null;
const SOURCES = [path.join(__dirname, 'logo-source.png'), path.join(__dirname, '..', 'app', 'static', 'assets', 'ecom-logo.png')];
for (const src of SOURCES) {
    if (!fs.existsSync(src)) continue;
    try {
        const img = decodePng(fs.readFileSync(src));
        const scaled = resize(img.rgba, img.width, img.height, 192, 192);
        // Flatten any transparency onto the accent colour. A Teams colour icon is shown on both light
        // and dark backgrounds, and a transparent logo reads as a floating smudge on one of them.
        for (let i = 0; i < 192 * 192; i++) {
            const d = i * 4, a = scaled[d + 3] / 255;
            if (a < 1) for (let k = 0; k < 3; k++) scaled[d + k] = Math.round(scaled[d + k] * a + INDIGO[k] * (1 - a));
            scaled[d + 3] = 255;
        }
        colour = scaled;
        console.log('colour icon: from ' + path.relative(path.join(__dirname, '..'), src) + ` (${img.width}x${img.height} → 192x192)`);
        break;
    } catch (e) { console.warn('could not use ' + path.basename(src) + ': ' + e.message); }
}
if (!colour) {
    colour = canvas(192, 192, INDIGO);
    rect(colour, 192, 56, 46, 26, 100, WHITE);   // spine
    rect(colour, 192, 56, 46, 84, 24, WHITE);    // top arm
    rect(colour, 192, 56, 84, 66, 22, WHITE);    // middle arm
    rect(colour, 192, 56, 122, 84, 24, WHITE);   // bottom arm
    console.log('colour icon: drawn fallback (no usable logo found)');
}

// Outline icon: 32x32, TRANSPARENT with a flat white glyph. Teams tints this one; a coloured or
// opaque-background outline icon renders as a grey box in the channel rail.
const outline = canvas(32, 32, null);
rect(outline, 32, 9, 7, 5, 18, WHITE);
rect(outline, 32, 9, 7, 15, 4, WHITE);
rect(outline, 32, 9, 14, 12, 4, WHITE);
rect(outline, 32, 9, 21, 15, 4, WHITE);

// ── manifest ─────────────────────────────────────────────────────────────────────────────────────
// botId MUST equal the Azure Bot's Microsoft App ID. Read from .env so the two cannot drift.
const envPath = path.join(__dirname, '..', '.env');
const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const appId = ((env.match(/^TEAMS_BOT_APP_ID=(.*)$/m) || [])[1] || '').trim();
if (!/^[0-9a-f-]{36}$/i.test(appId)) {
    console.error('TEAMS_BOT_APP_ID missing or not a GUID in .env — cannot build a valid manifest.');
    process.exit(1);
}

const manifest = {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
    manifestVersion: '1.16',
    version: '1.0.1',
    id: appId,
    packageName: 'skin.theelement.ecomcentral',
    developer: {
        name: 'The Element',
        websiteUrl: 'https://dashboard.theelement.skin',
        privacyUrl: 'https://dashboard.theelement.skin',
        termsOfUseUrl: 'https://dashboard.theelement.skin',
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    name: { short: 'EcomBot', full: 'Ecom Central Bot' },
    description: {
        short: 'Ops reports and approvals for Ecom Central.',
        full: 'Posts DocPharma, inventory and finance reports into Teams, and takes approvals back — reply yes, no or rejected to act on whatever is pending.',
    },
    accentColor: '#4F46E5',
    bots: [{
        botId: appId,
        scopes: ['team'],
        supportsFiles: false,
        isNotificationOnly: false,
        commandLists: [{
            scopes: ['team'],
            commands: [
                { title: 'rejected', description: 'Run the DocPharma → warehouse check now' },
                { title: 'yes', description: 'Approve whatever is pending (Amazon reviews / Tally push)' },
                { title: 'no', description: 'Reject whatever is pending' },
            ],
        }],
    }],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: ['dashboard.theelement.skin'],
};

fs.writeFileSync(path.join(__dirname, 'color.png'), png(192, 192, colour));
fs.writeFileSync(path.join(__dirname, 'outline.png'), png(32, 32, outline));
fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('Built teams-app/: manifest.json, color.png (192x192), outline.png (32x32)');
console.log(`botId matches .env TEAMS_BOT_APP_ID (${appId.slice(0, 8)}…)`);
console.log('\nZip it (the three files must be at the ROOT of the zip, not inside a folder):');
console.log('  Compress-Archive -Path "teams-app\\manifest.json","teams-app\\color.png","teams-app\\outline.png" -DestinationPath "teams-app\\EcomBot.zip" -Force');
