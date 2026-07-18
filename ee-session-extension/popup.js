const $ = id => document.getElementById(id);

async function refresh() {
  const { token, status, statusAt } = await chrome.storage.local.get(['token', 'status', 'statusAt']);
  $('token').value = token || '';
  let s = status || 'Not synced yet.';
  if (statusAt) s += `\n(${new Date(statusAt).toLocaleString()})`;
  $('status').textContent = s;
}

$('save').onclick = async () => {
  await chrome.storage.local.set({ token: $('token').value.trim() });
  $('status').textContent = 'Token saved. Click "Sync now" to test.';
};

$('now').onclick = async () => {
  await chrome.storage.local.set({ token: $('token').value.trim() }); // save first so "sync now" uses it
  $('status').textContent = 'Syncing…';
  chrome.runtime.sendMessage('sync-now', () => setTimeout(refresh, 900));
};

refresh();
