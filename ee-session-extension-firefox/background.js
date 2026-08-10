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
  let routed = 0;
  const failedList = [];
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
      // EasyEcom's UpdateVendor answers with a BARE NUMBER: "0" or "200" (padded with blank lines, hence
      // trim). Both mean the vendor was changed.
      // ⚠️ "200" used to be rejected here on the assumption it was an odd echo, which made every genuine
      // route report as failed. Proven otherwise on TE25-41231 (2026-08-10): the extension was the only
      // caller that reached UpdateVendor — the VPS cron hit the WAF ("Human Verification", HTTP 405) on
      // every hourly attempt for a day — it got "200" twice, and the order's EasyEcom location duly
      // changed to "Shifupro Technologies Pvt. Ltd.". A rejected success is not harmless: the order is
      // never marked routed and gets re-POSTed on every run.
      // Anything else is still a failure — the WAF page is HTML and a business error is JSON with a
      // message, so neither can be mistaken for these two short numeric bodies.
      const reply = raw.trim();   // `body` above is the POST payload
      // Mirror of callUpdateVendor() in app/api/easyecom.js — the same shipment must not be judged
      // routed by one path and failed by the other.
      let j = {}; try { const p = JSON.parse(reply); if (p && typeof p === 'object') j = p; } catch (_) {}
      ok = resp.status === 200
        && (reply === '0' || reply === '200' || j.code === 200 || j.status === true || j.success === true)
        && j.code !== 400;
      if (!ok) {
        if (/Human Verification|awsWaf|gokuProps/i.test(raw)) message = 'WAF challenge (are you logged into EasyEcom in this browser?)';
        else { try { message = (JSON.parse(raw).message) || raw.slice(0, 120); } catch (_) { message = raw.slice(0, 120); } }
      }
    } catch (e) { message = e.message; }

    try {
      await fetch(`${RESULT_ENDPOINT}?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderName: r.orderName, ok, currentCid: r.currentCid, targetCid: r.targetCid, message }),
      });
    } catch (_) {}
    if (ok) routed++;
    else failedList.push(`${r.orderName}${message ? ` (${String(message).replace(/\s+/g, ' ').trim().slice(0, 40)})` : ''}`);
    await sleep(1500);   // gentle — one order at a time, never bursts
  }
  const failed = failedList.length;
  // Name the failed orders + a cleaned message so "1 failed" isn't a mystery to debug.
  await setStatus(`✅ Routed ${routed}${failed ? ` · ${failed} failed → ${failedList.join('; ')}` : ''} of ${routes.length} (${reason}) · ${new Date().toLocaleTimeString()}`);
}

// One full cycle = refresh cookie, then run any pending routes.
async function cycle(reason) { await pushCookie(reason); await runPendingRoutes(reason); }

// ── Triggers ─────────────────────────────────────────────────────────────────
// ⚠️ THE ALARM MUST BE RE-ASSERTED ON EVERY BACKGROUND START, not just onInstalled.
// It used to be created in the onInstalled listener alone. onInstalled fires exactly once per
// install/update, so if the alarm was ever lost — a temporary add-on load, a profile that dropped it, an
// early failure in create() — nothing ever recreated it and the 20-minute cycle silently never ran again.
// The only clue was the status line still reading "(manual)" from the last button press.
// alarms.create() with an existing name just replaces it, so asserting it repeatedly is free and this
// self-heals: the next time anything wakes the background (popup, browser start, cookie change) the
// schedule is restored.
async function ensureAlarm() {
    try {
        const existing = await chrome.alarms.get('ee-cycle');
        if (existing) return existing;
        // delayInMinutes gives a first run shortly after wake instead of waiting a full period.
        await chrome.alarms.create('ee-cycle', { delayInMinutes: 1, periodInMinutes: SYNC_MINUTES });
        return await chrome.alarms.get('ee-cycle');
    } catch (e) { await setStatus('⚠️ Could not schedule the timer: ' + e.message); return null; }
}
ensureAlarm();   // top level — runs on every background start, including an alarm-triggered wake

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); cycle('installed'); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); cycle('startup'); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'ee-cycle') cycle('auto'); });

// Popup buttons.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg === 'run-now') { runPendingRoutes('manual').then(() => sendResponse({ ok: true })); return true; }
  if (msg === 'sync-now') { pushCookie('manual').then(() => runPendingRoutes('manual')).then(() => sendResponse({ ok: true })); return true; }
  // The popup asks for the alarm so "is the timer actually running?" has an answer on screen instead of
  // being inferred from whether the status happens to say (auto) — which is how this went unnoticed.
  if (msg === 'alarm-info') { ensureAlarm().then(al => sendResponse({ ok: true, scheduledTime: al && al.scheduledTime, periodInMinutes: al && al.periodInMinutes })); return true; }
});
