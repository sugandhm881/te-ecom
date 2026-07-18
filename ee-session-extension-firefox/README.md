# EasyEcom Warehouse Router — Firefox extension

Solves the AWS-WAF problem: EasyEcom's panel blocks the VPS's datacenter IP, so the server can't run
warehouse changes itself. This extension runs them **from your Firefox** (a residential IP the WAF
trusts). The dashboard on the VPS just detects DocPharma-rejected orders and hands them to the
extension to execute. No passwords stored — it uses your already-logged-in EasyEcom session.

## What it does
- **Runs pending routes:** fetches the DocPharma-rejected orders the dashboard has queued and, for
  each, POSTs `UpdateVendor` to EasyEcom from your browser → routes them to Shifupro.
- **Keeps the session fresh:** syncs your EasyEcom cookie to the dashboard each cycle.
- **Triggers:** automatically every ~20 min while Firefox is open, **and** on demand via the
  **Run pending routes** button. (Your "one click a day" = open Firefox, click the button.)

## One-time server setup (if not already done)
1. In the VPS `.env`, set the shared secret (same one the extension uses):
   ```
   EE_SESSION_PUSH_TOKEN=<a-random-value>     # generate: openssl rand -hex 24
   ```
2. `git pull` the new endpoints, then `pm2 restart dashboard`.
   Endpoints (all off/503 until the token is set): `/api/webhook/ee-routes`, `/api/webhook/ee-route-result`, `/api/webhook/ee-session`.

## Install in Firefox
1. Firefox → address bar → `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** → pick the **`manifest.json`** inside this folder.
   *(Temporary add-ons unload when Firefox restarts. To make it permanent, the folder needs to be
   packaged/signed via addons.mozilla.org — ask and I'll walk you through it.)*
3. Click the extension's icon (toolbar puzzle piece) → paste the same `EE_SESSION_PUSH_TOKEN` →
   **Save token**.
4. Make sure you're logged into `app.easyecom.io` in this Firefox, then click **Run pending routes**.

## How it clears the firewall
Your browser holds a valid `aws-waf-token` (from passing EasyEcom's check on your residential IP).
The extension's `UpdateVendor` request uses `credentials: 'include'`, so Firefox attaches that token
+ your `laravel_session`/`PHPSESSID` automatically, and the request leaves *your* IP — so the WAF
treats it exactly like your normal EasyEcom clicks. The VPS never touches EasyEcom directly.
