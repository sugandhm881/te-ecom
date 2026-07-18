// Ecom Central — EasyEcom Session Sync (MV3 service worker)
// Reads the EasyEcom panel cookies from your logged-in browser and POSTs them to the dashboard,
// so the "Change warehouse" session never goes stale. Runs on a timer + on cookie change.

const ENDPOINT = 'https://dashboard.theelement.skin:8443/api/webhook/ee-session';
const SYNC_MINUTES = 20;

async function getToken() {
  const { token } = await chrome.storage.local.get('token');
  return (token || '').trim();
}
async function setStatus(text) {
  await chrome.storage.local.set({ status: text, statusAt: Date.now() });
}

// Read all EasyEcom cookies the extension can access. Query by domain (catches app./www./.easyecom.io),
// falling back to a url query — more reliable than a single url filter.
async function readEeCookies() {
  // Merge a domain query + a url query + an explicit PHPSESSID lookup, deduped — maximizes capture
  // (some cookies like PHPSESSID come back from only one of the filters).
  const byDomain = await chrome.cookies.getAll({ domain: 'easyecom.io' });
  const byUrl = await chrome.cookies.getAll({ url: 'https://app.easyecom.io/' });
  const map = new Map();
  for (const c of [...(byDomain || []), ...(byUrl || [])]) map.set(c.name + '|' + c.domain, c);
  // Belt-and-braces: explicitly fetch PHPSESSID for the exact host if not already present.
  if (![...map.values()].some(c => /PHPSESSID/i.test(c.name))) {
    const php = await chrome.cookies.get({ url: 'https://app.easyecom.io/', name: 'PHPSESSID' });
    if (php) map.set(php.name + '|' + php.domain, php);
  }
  return [...map.values()];
}

async function pushCookie(reason) {
  const token = await getToken();
  if (!token) { await setStatus('⚠️ No sync token set — paste it and click Save token.'); return; }

  const cookies = await readEeCookies();
  const hasSession = cookies.some(c => /laravel_session/i.test(c.name));
  if (!hasSession) {
    const names = cookies.map(c => c.name).slice(0, 8).join(', ') || 'none';
    await setStatus(`Can't see the session cookie. Found ${cookies.length} easyecom cookie(s): ${names}. Make sure you're logged into app.easyecom.io in THIS Chrome, then Sync now.`);
    return;
  }
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const hasPhp = /PHPSESSID=/i.test(cookieStr);

  try {
    const res = await fetch(`${ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: cookieStr }),
    });
    if (res.ok) await setStatus(`✅ Synced (${reason}) · ${cookies.length} cookies · PHPSESSID: ${hasPhp ? '✓' : '✗ still missing'} · ${new Date().toLocaleTimeString()}`);
    else if (res.status === 401) await setStatus('❌ Token rejected (401) — the extension token must match the server .env value.');
    else if (res.status === 503) await setStatus('❌ Server has no EE_SESSION_PUSH_TOKEN set (503) — add it to the server .env + restart.');
    else await setStatus(`❌ Server responded ${res.status} (${reason}) — is the new code deployed?`);
  } catch (e) {
    await setStatus('❌ Push failed: ' + e.message + ' (is the dashboard reachable?)');
  }
}

// Periodic sync (alarms survive service-worker restarts).
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('ee-sync', { periodInMinutes: SYNC_MINUTES });
  pushCookie('installed');
});
chrome.runtime.onStartup.addListener(() => pushCookie('startup'));
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'ee-sync') pushCookie('timer'); });

// Push soon after a fresh login (the session cookie changing), throttled so browsing EasyEcom
// doesn't spam the endpoint.
chrome.cookies.onChanged.addListener(async info => {
  if (!info.cookie || !/easyecom\.io$/i.test(info.cookie.domain)) return;
  if (!/laravel_session/i.test(info.cookie.name) || info.removed) return;
  const { lastChangePush } = await chrome.storage.local.get('lastChangePush');
  if (lastChangePush && Date.now() - lastChangePush < 5 * 60 * 1000) return; // ≤ once / 5 min
  await chrome.storage.local.set({ lastChangePush: Date.now() });
  pushCookie('login');
});

// "Sync now" button in the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg === 'sync-now') { pushCookie('manual').then(() => sendResponse({ ok: true })); return true; }
});
