const $ = id => document.getElementById(id);

async function refresh() {
  const { token, status, statusAt } = await chrome.storage.local.get(['token', 'status', 'statusAt']);
  $('token').value = token || '';
  let s = status || 'Not run yet.';
  if (statusAt) s += `\n(${new Date(statusAt).toLocaleString()})`;
  $('status').textContent = s;
}

$('save').onclick = async () => {
  await chrome.storage.local.set({ token: $('token').value.trim() });
  $('status').textContent = 'Token saved.';
};

$('run').onclick = async () => {
  await chrome.storage.local.set({ token: $('token').value.trim() }); // save first so the run uses it
  $('status').textContent = 'Working…';
  chrome.runtime.sendMessage('sync-now', () => setTimeout(refresh, 1200));
};

refresh();
