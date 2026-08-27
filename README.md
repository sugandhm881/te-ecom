# Ecom Central

Internal e-commerce operations & analytics dashboard for **The Element** (Shifupro Technologies Pvt Ltd).

Unifies Shopify orders, RapidShyp/DocPharma shipment tracking, delivery-performance analytics (FASR · RTO · NDR · TAT), silent-RTO freight claims, escalation emails with AI-scored reply tracking, a customer-support console (call queue · notes · escalation contacts), warehouse reports to Microsoft Teams, Amazon review automation, and marketing analytics — behind a multi-user, permission-gated portal.

## Quick start

```bash
npm install
cp .env.example .env        # fill in credentials (see docs §12)
node tools/secrets.js init  # once per machine → ~/.pravidhi/master.key (back it up!)
npm run secrets:encrypt     # .env → .env.vault (AES-256-GCM). Locally .env stays and is the file you edit;
                            # on a server add --delete so only the encrypted copy remains
npm start                    # → http://localhost:5002
```

`.env.vault` is the encrypted copy (re-sealed from `.env` at every boot in dev); `npm run secrets -- get|set|list|decrypt|rotate|check` manages it (docs §17).

Rebuild CSS after any UI change:

```bash
node_modules/.bin/tailwindcss -i tw-input.css -o app/static/tailwind.css --minify
```

## Deploy (production)

```bash
git pull && pm2 restart ecom-central
```

## Documentation

**→ [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md)** — full reference: architecture, dashboards, API, database schema, cron schedules, integrations, environment variables, operations runbook, and security notes.

## Stack

Node.js/Express · Supabase (PostgreSQL) · Vanilla JS SPA + Tailwind (static build) · node-cron · Microsoft Teams (Adaptive Cards + Graph) · Nodemailer · Gemini AI
