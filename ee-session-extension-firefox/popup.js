const $ = id => document.getElementById(id);

async function refresh() {
  const { token, status, statusAt } = await chrome.storage.local.get(['token', 'status', 'statusAt']);
  $('token').value = token || '';
  let s = status || 'Not run yet.';
  if (statusAt) s += `\n(${new Date(statusAt).toLocaleString()})`;
  $('status').textContent = s;
  // Show the NEXT automatic run. Until now the only way to tell the 20-minute timer had stopped was to
  // notice the status still said "(manual)" from the last button press — which nobody does.
  chrome.runtime.sendMessage('alarm-info', info => {
    const el = $('next'); if (!el) return;
    el.textContent = (info && info.scheduledTime)
      ? `Auto-runs every ${info.periodInMinutes || 20} min · next at ${new Date(info.scheduledTime).toLocaleTimeString()}`
      : 'Timer not scheduled — reopening this popup restores it.';
  });
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
