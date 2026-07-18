// Ecom Central — EasyEcom Warehouse Router (Firefox MV3 background)
// Two jobs, both from YOUR browser (a residential IP the EasyEcom WAF trusts):
//   1. Sync the EasyEcom panel cookie to the dashboard (session freshness).
//   2. Run pending warehouse routes: the VPS can't call EasyEcom (its datacenter IP is WAF-blocked),
//      so it hands us the pending DocPharma-rejected orders and we POST UpdateVendor from here.
// chrome.* is aliased to browser.* in Firefox, so this file is cross-browser.

const DASH = 'https://dashboard.theelement.skin:8443';
const SESSION_ENDPOINT = DASH + '/api/webhook/ee-session';
const ROUTES_ENDPOINT  = DASH + '/api/webhook/ee-routes';
const RESULT_ENDPOINT  = DASH + '/api/webhook/ee-route-result';
const EE_UPDATEVENDOR  = 'https://app.easyecom.io/Orders/UpdateVendor';
const SYNC_MINUTES = 20;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getToken() { const { token } = await chrome.storage.local.get('token'); return (token || '').trim(); }
async function setStatus(text) { await chrome.storage.local.set({ status: text, statusAt: Date.now() }); }

// ── 1. Cookie sync ───────────────────────────────────────────────────────────
async function readEeCookies() {
  const byDomain = await chrome.cookies.getAll({ domain: 'easyecom.io' });
  const byUrl = await chrome.cookies.getAll({ url: 'https://app.easyecom.io/' });
  const map = new Map();
  for (const c of [...(byDomain || []), ...(byUrl || [])]) map.set(c.name + '|' + c.domain, c);
  if (![...map.values()].some(c => /PHPSESSID/i.test(c.name))) {
    const php = await chrome.cookies.get({ url: 'https://app.easyecom.io/', name: 'PHPSESSID' });
    if (php) map.set(php.name + '|' + php.domain, php);
  }
  return [...map.values()];
}

async function pushCookie(reason) {
  const token = await getToken();
  if (!token) { await setStatus('⚠️ No sync token set — paste it and Save.'); return; }
  const cookies = await readEeCookies();
  if (!cookies.some(c => /laravel_session/i.test(c.name))) {
    await setStatus('Not logged into EasyEcom in Firefox yet — log in once.');
    return;
  }
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  try {
    const res = await fetch(`${SESSION_ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie: cookieStr }),
    });
    if (!res.ok) await setStatus(`Cookie sync failed (${res.status}).`);
  } catch (e) { await setStatus('Cookie sync error: ' + e.message); }
}

// ── 2. Run pending warehouse routes (the whole point) ────────────────────────
async function runPendingRoutes(reason) {
  const token = await getToken();
  if (!token) { await setStatus('⚠️ No token set.'); return; }

  let routes = [];
  try {
    const res = await fetch(`${ROUTES_ENDPOINT}?token=${encodeURIComponent(token)}`);
    if (!res.ok) { await setStatus(`Route list failed (${res.status}) — is the token/deploy right?`); return; }
    routes = (await res.json()).routes || [];
  } catch (e) { await setStatus('Route list error: ' + e.message); return; }

  if (!routes.length) { await setStatus(`No pending routes (${reason}) · ${new Date().toLocaleTimeString()}`); return; }

  await setStatus(`Routing ${routes.length}…`);
  let routed = 0, failed = 0;
  for (const r of routes) {
    let ok = false, message = '';
    try {
      const body = `invoice_id=${encodeURIComponent(r.invoiceId)}&vendor_c_id=${encodeURIComponent(r.targetCid)}&c_id=${encodeURIComponent(r.cId)}`;
      const resp = await fetch(EE_UPDATEVENDOR, {
        method: 'POST',
        credentials: 'include',   // sends app.easyecom.io cookies incl. session + AWS-WAF token, from your IP
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body,
      });
      const raw = await resp.text();
      ok = resp.status === 200 && raw.trim() === '0';
      if (!ok) {
        if (/Human Verification|awsWaf|gokuProps/i.test(raw)) message = 'WAF challenge (are you logged into EasyEcom in this browser?)';
        else { try { message = (JSON.parse(raw).message) || raw.slice(0, 120); } catch (_) { message = raw.slice(0, 120); } }
      }
    } catch (e) { message = e.message; }

    try {
      await fetch(`${RESULT_ENDPOINT}?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderName: r.orderName, ok, currentCid: r.currentCid, message }),
      });
    } catch (_) {}
    if (ok) routed++; else failed++;
    await sleep(1500);   // gentle — one order at a time, never bursts
  }
  await setStatus(`✅ Routed ${routed}${failed ? `, ${failed} failed` : ''} of ${routes.length} (${reason}) · ${new Date().toLocaleTimeString()}`);
}

// One full cycle = refresh cookie, then run any pending routes.
async function cycle(reason) { await pushCookie(reason); await runPendingRoutes(reason); }

// ── Triggers ─────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('ee-cycle', { periodInMinutes: SYNC_MINUTES }); cycle('installed'); });
chrome.runtime.onStartup.addListener(() => cycle('startup'));
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'ee-cycle') cycle('auto'); });

// Popup buttons.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg === 'run-now') { runPendingRoutes('manual').then(() => sendResponse({ ok: true })); return true; }
  if (msg === 'sync-now') { pushCookie('manual').then(() => runPendingRoutes('manual')).then(() => sendResponse({ ok: true })); return true; }
});
