# EasyEcom Session Sync — Chrome extension

Keeps the Ecom Central dashboard's EasyEcom **panel session** ("Change warehouse") fresh, so you
never manually paste a cookie again. Server-side auto-login is impossible (EasyEcom uses Google
SSO + 2FA), so this reads the cookie from **your** already-logged-in browser and syncs it to the
dashboard every 20 minutes (and right after you log in). No passwords are stored anywhere.

## One-time server setup
1. On the live server, add a shared secret to `.env` (generate one: `openssl rand -hex 24`):
   ```
   EE_SESSION_PUSH_TOKEN=<the-generated-value>
   ```
2. `pm2 restart dashboard` (with `--update-env` if the var is new to the process).

The receiver is `POST /api/webhook/ee-session` — disabled (503) until that token is set.

## Install the extension (Chrome)
1. Copy the `ee-session-extension` folder somewhere permanent on your PC (don't delete it — Chrome
   loads it from this location).
2. Chrome → `chrome://extensions` → toggle **Developer mode** (top-right) ON.
3. Click **Load unpacked** → select the `ee-session-extension` folder.
4. Pin it (puzzle-piece icon → pin), click it, paste the **same** `EE_SESSION_PUSH_TOKEN` value into
   the **Sync token** box → **Save token**.
5. Make sure you're logged into `app.easyecom.io` in this browser, then click **Sync now** →
   status should show **✅ Synced**.

That's it. From now on it syncs automatically every 20 min and right after each fresh EasyEcom login.
When EasyEcom eventually logs you out of the browser, just log in again — it resumes on its own.

## How it works
- Reads `laravel_session` + `PHPSESSID` (and any other `app.easyecom.io` cookies) via the `cookies`
  permission — this is why it works even though the cookie is HttpOnly (page scripts / bookmarklets
  can't read those).
- POSTs them to the dashboard, authenticated with your token; the server stores them AES-GCM
  encrypted (same as before).
- The dashboard's existing every-20-min keep-alive cron then holds each session open between syncs.
