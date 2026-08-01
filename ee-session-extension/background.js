// Ecom Central — EasyEcom Session Sync (MV3 service worker)
// Reads the EasyEcom panel cookies from your logged-in browser and POSTs them to the dashboard,
// so the "Change warehouse" session never goes stale. Runs on a timer + on cookie change.

const ENDPOINT = 'https://dashboard.theelement.skin:8443/api/webhook/ee-session';
const EE_URL = 'https://app.easyecom.io';
const SYNC_MINUTES = 20;

async function getToken() {
  const { token } = await chrome.storage.local.get('token');
  return (token || '').trim();
}
async function setStatus(text) {
  await chrome.storage.local.set({ status: text, statusAt: Date.now() });
}

async function pushCookie(reason) {
  const token = await getToken();
  if (!token) { await setStatus('⚠️ No sync token set — open the popup and paste it.'); return; }

  const cookies = await chrome.cookies.getAll({ url: EE_URL });
  if (!cookies.some(c => /laravel_session/i.test(c.name))) {
    await setStatus('Not logged into EasyEcom in this browser yet — log in once.');
    return;
  }
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  try {
    const res = await fetch(`${ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: cookieStr }),
    });
    if (res.ok) await setStatus(`✅ Synced (${reason}) at ${new Date().toLocaleTimeString()}`);
    else if (res.status === 401) await setStatus('❌ Token rejected (401) — check it matches the server.');
    else await setStatus(`❌ Server responded ${res.status} (${reason}).`);
  } catch (e) {
    await setStatus('❌ Push failed: ' + e.message);
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
