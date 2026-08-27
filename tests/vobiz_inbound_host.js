// ─────────────────────────────────────────────────────────────────────────────
// LOCAL host for a REAL incoming Vobiz call — only the bridge, no full server, no crons.
// Pair it with a public tunnel (cloudflared) and link the Vobiz number's Voice App to:
//     <tunnel>/api/vobiz/answer?token=<VOBIZ_WEBHOOK_TOKEN>
// Run:  set VOBIZ_PUBLIC_BASE=<tunnel-url> then  node tests/vobiz_inbound_host.js
// The caller must be on MSG91_COD_ALLOWLIST; order context pins to VOBIZ_INBOUND_TEST_ORDER.
// ─────────────────────────────────────────────────────────────────────────────
require('../app/secrets').load();   // .env.vault (AES-256-GCM) or plaintext .env
const express = require('express');
const http = require('http');
const bridge = require('../app/api/vobiz_bridge');

const PORT = Number(process.env.VOBIZ_HOST_PORT || 4545);
const app = express();
app.use(express.json());
app.use('/api', bridge.router);
app.get('/healthz', (_q, r) => r.json({ ok: true }));
const server = http.createServer(app);
bridge.attachVobizWs(server);
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[inbound-host] listening on :${PORT}`);
    console.log(`[inbound-host] public base: ${process.env.VOBIZ_PUBLIC_BASE || '(NOT SET — set VOBIZ_PUBLIC_BASE to the tunnel URL)'}`);
    console.log(`[inbound-host] test order: ${process.env.VOBIZ_INBOUND_TEST_ORDER || '(none pinned)'}`);
    console.log(`[inbound-host] answer URL to link in the Vobiz console:`);
    console.log(`    ${(process.env.VOBIZ_PUBLIC_BASE || 'https://<tunnel>')}/api/vobiz/answer?token=${String(process.env.VOBIZ_WEBHOOK_TOKEN || '').trim()}`);
});
