# Ecom Central

Internal e-commerce operations & analytics dashboard for **The Element** (Shifupro Technologies Pvt Ltd).

Unifies Shopify orders, RapidShyp/DocPharma shipment tracking, delivery-performance analytics (FASR · RTO · NDR · TAT), silent-RTO freight claims, warehouse reports to Microsoft Teams, Amazon review automation, and marketing analytics — behind a multi-user, permission-gated portal.

## Quick start

```bash
npm install
cp .env.example .env        # fill in credentials (see docs §12) — .env is git-ignored
npm start                    # → http://localhost:5002
```

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
