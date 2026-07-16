# Ecom Central — Project Documentation

**Company:** Shifupro Technologies Pvt Ltd · Brand: **The Element** (D2C skincare)
**Application:** Internal e-commerce operations & analytics dashboard
**Version:** 1.0.0 · **Runtime:** Node.js (Express) · **Database:** Supabase (PostgreSQL)
**Production:** `http://72.60.97.42:5002` (pm2-managed)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Tech Stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [Repository Structure](#4-repository-structure)
5. [Dashboards & Features](#5-dashboards--features)
6. [Authentication & Authorization](#6-authentication--authorization)
7. [API Reference](#7-api-reference)
8. [Database Schema](#8-database-schema)
9. [Scheduled Jobs (Crons)](#9-scheduled-jobs-crons)
10. [External Integrations](#10-external-integrations)
11. [Reports & Notifications](#11-reports--notifications)
12. [Environment Variables](#12-environment-variables)
13. [Frontend Build](#13-frontend-build)
14. [Deployment & Operations](#14-deployment--operations)
15. [CLI & Maintenance Utilities](#15-cli--maintenance-utilities)
16. [Security](#16-security)

---

## 1. Overview

Ecom Central is a single-server operations hub that unifies order management, shipping/courier tracking, delivery-performance analytics, warehouse operations, marketing analytics, and automated reporting for The Element's D2C business.

**Core responsibilities:**

- Aggregate orders from **Shopify** and enrich them with courier tracking from **RapidShyp** (primary 3PL aggregator) and **DocPharma** (secondary shipping platform).
- Track every shipment's full journey (dispatch → attempts → NDR → delivered/RTO) and compute delivery KPIs: FASR (First-Attempt Strike Rate), RTO rate, NDR recovery, TAT.
- Detect and escalate courier problems: silent RTOs (returned with no delivery attempt → freight claims), late deliveries (promise date broken), fake delivery attempts (manually flagged, AI-polished escalation emails).
- Run scheduled warehouse/ops reports into **Microsoft Teams** channels (native Adaptive Cards) with inbound keyword triggers via Microsoft Graph.
- Automate **Amazon review requests** with a human yes/no approval loop in Teams.
- Provide marketing analytics (Meta ad sets / ads / ranking) and profitability views.
- Multi-user access with per-dashboard, server-enforced permissions.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express 4 |
| Database | Supabase (PostgreSQL 17) via `@supabase/supabase-js` (service-role key, server-side only) |
| Frontend | Single-page vanilla JS (`app/static/app.js`) + one HTML template (`app/templates/index.html`) |
| Styling | Tailwind CSS **3.4** — statically compiled (no CDN/JIT at runtime) |
| Charts | Chart.js (self-hosted at `app/static/vendor/chart.min.js`) |
| Auth | JWT (`jsonwebtoken`), scrypt password hashing (Node crypto, no external dep) |
| Email | Nodemailer (SMTP; portal-configurable settings, AES-256-GCM-encrypted password) |
| Scheduling | node-cron (all times **Asia/Kolkata**) |
| AI | Google Gemini (native `generateContent`) or any OpenAI-compatible provider — used for escalation-email polish |
| Reports/Exports | ExcelJS, PDFKit |
| Process manager | pm2 (production) |

---

## 3. Architecture

```
                      ┌────────────────────────────────────────────────┐
                      │                 server.js (Express)            │
                      │  auth gate → RBAC gate → routers → crons       │
                      └────────────────────────────────────────────────┘
                         │            │             │            │
        ┌────────────────┤            │             │            └───────────────┐
        ▼                ▼            ▼             ▼                            ▼
  app/templates/   app/api/*.js   node-cron   app/api/teams.js         app/api/teams_listener.js
  index.html       (routers +     (scheduled  (outbound Adaptive       (inbound keyword triggers
  app/static/*     business       reports &   Cards via Power           via MS Graph delegated
  (SPA frontend)   logic)         syncs)      Automate webhooks)        token, 20s poll)
        │                │
        ▼                ▼
   Browser SPA      Supabase (PostgreSQL)  ◄── single source of truth
                         ▲
     ┌───────────────────┼──────────────────────┬───────────────┐
     ▼                   ▼                      ▼               ▼
  Shopify API      RapidShyp API          DocPharma API    EasyEcom API
  (orders)         (track_order,          (fetch-details,  (B2C orders,
                   shipment_details,      partner portal)  on-hold)
                   serviceability)
```

**Design principles**

- **DB-first reads:** dashboards read from synced Supabase tables; live courier APIs are called only to fill gaps (then cached back).
- **Single journey pipeline:** `app/api/delivery_journey.js` is the one parser/writer for `shipment_journey_ecom`; webhooks, backfills and crons all flow through it.
- **Server-enforced permissions:** UI hiding is cosmetic; every view-specific API group is gated by middleware in `server.js`.
- **Fail-safe reporting:** report dedup lists abort the run when unreadable (never re-spam), and Slack posting is code-disabled (Teams-only) unless explicitly re-enabled.

---

## 4. Repository Structure

```
ecom-central-Staging/
├── server.js                  # Express app: mounts, auth/RBAC gates, all cron schedules
├── config.js                  # Central config — every env var is read here
├── package.json
├── tailwind.config.js         # Tailwind content scan (templates + static JS)
├── tw-input.css               # Tailwind input file (@tailwind base/components/utilities)
├── cron_job.js                # Standalone: adset-performance PDF report emailer
├── data_fetcher.js            # Standalone: bulk data sync utility (npm run sync)
├── cod_confirmation.js        # Standalone: COD confirmation processing
├── docpharma_import.js        # Standalone: DocPharma order import
├── docpharma_timeline_backfill.js
├── debug_easyecom.js          # Dev helper
├── Caddyfile.example          # Reverse-proxy (HTTPS) reference config
├── supabase/                  # SQL migrations + edge functions
│   ├── *.sql                  # table definitions (serviceability, dp_rejected_handled, …)
│   └── functions/             # rapidshyp-webhook, msg91-cod-webhook (Deno edge functions)
└── app/
    ├── auth.js                # JWT issue/verify, scrypt hashing, requireAdmin/requirePermission
    ├── supabase.js            # Supabase service-role client singleton
    ├── templates/index.html   # The single-page app shell (all views)
    ├── static/
    │   ├── app.js             # Entire frontend logic (~6.5k lines)
    │   ├── tailwind.css       # COMPILED Tailwind output (rebuild after UI changes!)
    │   └── vendor/chart.min.js
    └── api/                   # One module per domain
        ├── orders.js              # Shopify orders + enrichment
        ├── delivery_journey.js    # Journey parser/writer + freight sync + backfills (CLI)
        ├── delivery_reports.js    # Delivery-perf API + Silent-RTO/Late/Overdue + marks + critical email
        ├── warehouse_slack_report.js  # Warehouse/DocPharma-rejected/On-Hold reports (Teams)
        ├── teams.js               # Outbound Teams Adaptive Cards (Power Automate webhooks)
        ├── teams_listener.js      # Inbound Teams keyword triggers (MS Graph delegated)
        ├── amazon_auto_review.js  # Auto review-request flow + Teams yes/no approval
        ├── amazon_review.js / amazon.js / amazon_reports.js / amazon_fba.js / amazon_inbound.js
        ├── easyecom.js            # EasyEcom OMS integration
        ├── fulfillment_ops.js     # Fulfillment operations + status sync
        ├── ops_control.js         # Ops Control dashboard
        ├── serviceability.js      # Pincode serviceability / EDD estimates
        ├── docpharma_*.js         # DocPharma recon, invoices, ledger, overview, inventory, portal
        ├── ad_performance.js / adset_performance.js  # Meta ads analytics
        ├── auth_routes.js         # /login /signup /me (+ rate limiting)
        ├── users.js               # Admin user management (/api/admin/users)
        ├── email_settings.js      # Portal SMTP settings + shared sendMail()
        ├── crypto_util.js         # AES-256-GCM encrypt/decrypt for stored secrets
        ├── ai.js                  # AI client (Gemini native / OpenAI-compatible)
        ├── excel_report.js / pdf_generator.js
        ├── webhook_handler.js     # Inbound webhooks (RapidShyp / EasyEcom)
        ├── shipping.js / helpers.js / middleware.js
        └── docpharma_import_lib.js
```

---

## 5. Dashboards & Features

Navigation is permission-gated per user (see §6). Permission keys in parentheses.

### Operations
| Dashboard | Key | Description |
|---|---|---|
| Orders Dashboard | `orders-dashboard` | All Shopify orders, enriched with tracking, COD/repeat flags, EDD; progressive-rendered table |
| Fulfillment Ops | `fulfillment-ops` | Fulfillment pipeline operations, AWB fetch, label download |
| Delivery Performance | `delivery-perf` | KPIs (FASR/RTO/NDR-recovery/TAT), status partition, FASR trend, NDR funnel, RTO-by-courier, **FASR vs NDR Prepaid-vs-COD**, **🚩 Likely-Fake tracking insight**, shipment explorer (sortable, filterable, expandable rows with date/scan logs, **Promise date column**, per-order actions: *mark likely-fake*, *send critical email*) |
| Silent-RTO & SLA | `claims-sla` | 3 tabs: **Silent-RTO Claims** (RTO with zero attempts + claimable freight/invoice value), **Late Deliveries** (delivered after promise date), **In-transit · Overdue** (promise passed, still moving). All tabs: KPIs, DD-MM-YYYY dates, sortable columns, shared filters (search/platform/payment/courier/zone), expandable rows, admin email-send buttons |
| Ops Control | `ops-control` | Operational control actions |
| DocPharma Recon | `docpharma-recon` | DocPharma reconciliation: invoices, ledger, payments, rate card, stock |
| Amazon FBA | `amazon-fba` | FBA insights, inventory, forecast, by-location |

### Analytics
| Dashboard | Key |
|---|---|
| Order Insights | `order-insights` |
| Profitability | `profitability` |
| Customer Segments | `customer-segments` |
| Returns Analysis | `returns-analysis` |

### Marketing
| Dashboard | Key |
|---|---|
| Ad Ranking | `ad-ranking` |
| Ad Set Breakdown | `adset-breakdown` |
| Ad Analysis | `ad-analysis` |

### System
| Dashboard | Key | Description |
|---|---|---|
| Reports | `reports-view` | Excel/PDF report downloads |
| Amazon Review | `amazon-review` | Review-request eligibility, bulk send, history |
| Serviceability | `serviceability` | Pincode serviceability + EDD lookup |
| Settings | `settings` | Connected accounts + **Email & Reports** card (admin-only: SMTP host/port/password, From, To/CC, RapidShyp claims recipient; test-send) |
| Users | *(admin only)* | Approve signups, grant per-dashboard permissions, reset passwords |

### Notable feature mechanics

- **Freight & invoice value in DB:** every final RapidShyp shipment is priced via the `shipment_details` API (`final_freights` → `freight_total/forward/rto`, `shipment_value`, `applied_weight`) — backfilled for ~12k shipments, kept current by a nightly cron.
- **Likely-Fake workflow:** any Delivery-Performance user can flag an order (🚩) → stored in `order_marks_ecom` → insight card computes **marked → delivered conversion %** (delivered after being flagged = proven fake attempt) by joining live journey outcomes. Admins escalate single orders or all marked orders via **AI-polished critical email** to RapidShyp; sends are logged (`critical_mail_sent`) and badged (✉️).
- **DocPharma limitations (by API design):** DocPharma's `fetch-details` returns **no scan log** and no granular NDR history — only status milestones, `eta`, and a public `tracking_url`. The UI synthesizes a milestone timeline and links out ("Track on DocPharma ↗"). DocPharma journeys derive attempts from `reattempt_count` only.

---

## 6. Authentication & Authorization

- **Login:** `POST /api/login` — checks the `.env` bootstrap admin first (never lockable), then `app_users_ecom` (scrypt-hashed passwords). Returns a 1-day JWT with `{ sub, role, permissions[] }`.
- **Signup:** `POST /api/signup` — open signup creates a **pending** account; an admin must approve and grant dashboard permissions.
- **Rate limiting:** per-IP (`req.ip`, trust-proxy aware) + per-account (10 attempts / 15 min); bootstrap admin exempt from the account limit.
- **RBAC:**
  - Admin (`role=admin` or permission `*`) → everything.
  - Users hold an array of dashboard keys (see §5).
  - **Server-side enforcement** (`server.js`): a path-prefix middleware maps API groups → required permission, e.g. `/delivery-performance` → `delivery-perf`, `/silent-rto-claims|late-deliveries|intransit-late` → `claims-sla`, `/order-marks|likely-fake-insight` → `delivery-perf`, `/docpharma` → `docpharma-recon`, `/fba/` → `amazon-fba`, `/ops-control` → `ops-control`. The shared shipment-detail endpoint accepts *either* `delivery-perf` or `claims-sla`. Mount-level `requirePermission` guards `/api/amazon` and `/api/fulfillment-ops`. `/api/admin/*` requires `role=admin`.
- **JWT secret hygiene:** the app refuses to boot with a missing/weak `JWT_SECRET` (<32 chars or known-default).

---

## 7. API Reference

All endpoints require `Authorization: Bearer <JWT>` unless noted. Base path `/api`.

### Auth & Admin
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/login` | public (rate-limited) | Issue JWT |
| POST | `/signup` | public (rate-limited) | Create pending account |
| GET | `/me` | user | Current user + permissions |
| GET/POST | `/admin/users`, `/admin/users/:id`, `/admin/users/:id/password` | admin | User management |
| GET/POST | `/admin/email-settings` | admin | Read/write portal SMTP settings (password write-only, stored encrypted) |
| POST | `/admin/email-settings/test` | admin | Send a test email |

### Delivery Performance & Claims
| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/delivery-performance?from&to&source&payment&zone&state&order_type&compare` | delivery-perf | Full dashboard payload: kpis, statusBreakdown, tat, zones, fasrTrend, ndrFunnel, rtoByCourier, `byPayment` (Prepaid-vs-COD), shipments[] (with `edd`, `pastPromise`, `marked_fake`, `mail_sent`) |
| GET | `/delivery-performance/shipment/:awb` | delivery-perf **or** claims-sla | One shipment's journey + scan log (DB-cached, live-fallback; DocPharma → synthesized milestones + `dp` info) |
| GET | `/silent-rto-claims?from&to` | claims-sla | Silent-RTO rows + freight/value summary |
| POST | `/silent-rto-claims/send` | admin | Email the claim list to the configured RapidShyp address |
| GET | `/late-deliveries?from&to` | claims-sla | Delivered-late rows (both platforms) + summary |
| POST | `/late-deliveries/send` | admin | Email the late report to default recipients |
| GET | `/intransit-late?from&to` | claims-sla | Overdue in-transit rows + summary |
| POST | `/intransit-late/send` | admin | Email the chase list |
| POST | `/order-marks` `{order_name, awb, mark_type}` | delivery-perf | **Toggle** a manual mark (default `likely_fake`) |
| GET | `/order-marks?type=` | delivery-perf | List marks |
| GET | `/likely-fake-insight` | delivery-perf | Marked-orders outcome split + delivered-conversion % |
| POST | `/critical-email/compose` `{awbs[]}` | admin | Build an AI-polished escalation draft (template fallback) |
| POST | `/critical-email/send` `{subject, body, to?, tableHtml, orders[]}` | admin | Send + log `critical_mail_sent` marks |

### Other domains (mounted routers)
- `/api/orders…` — Shopify orders + enrichment (shared across dashboards, not view-gated)
- `/api/easyecom/*`, `/api/fulfillment-ops/*`, `/api/serviceability/*`
- `/api/amazon/*` — review requests (perm `amazon-review`)
- `/api/fba/*` — FBA dashboards (perm `amazon-fba`)
- `/api/docpharma*` — recon/invoices/ledger/overview/inventory (perm `docpharma-recon`)
- `/api/ops-control/*`, `/api/adset*`, `/api/ad*`, Excel/PDF report endpoints
- `/api/webhook/*` — inbound webhooks (token-validated, public)
- `/api/teams/test?target=` — Teams webhook smoke test

---

## 8. Database Schema

> The Supabase project also hosts tables owned by a sibling data platform (Meta/Google/GA4/CRM/influencer syncs). Tables **owned by this app** end in `_ecom` (plus a few DocPharma tables). All tables have RLS enabled; the server uses the service-role key.

### Core tables (this app)

| Table | Purpose |
|---|---|
| `shipment_journey_ecom` (~14k) | **Heart of delivery analytics.** One row per AWB: source (`rapidshyp`/`docpharma`), outcome (`delivered/rto/lost/ndr_pending/in_transit`), attempts, `ndr_count`, `first_attempt_success`, `rto_no_attempt` (silent RTO), timestamps (order/dispatched/OFD/delivered/RTO), `first_edd` (promise date — DB trigger keeps earliest), zone/dest, payment mode, order type, raw scan cache, **freight columns** (`freight_total/forward/rto`, `cod_charges`, `shipment_value`, `applied_weight`, `charges_fetched_at`) |
| `enriched_orders_ecom` (~33k) | Shopify orders enriched for dashboards |
| `rapidshyp_tracking_ecom` (~26k) | RapidShyp status cache for EasyEcom-shipped orders |
| `b2c_order_easycom` (~27k) | Synced EasyEcom B2C orders |
| `order_marks_ecom` | Manual per-order marks: `likely_fake` (toggle) + `critical_mail_sent` (audit log) — unique per (order_name, mark_type) |
| `app_users_ecom` | Portal users: email, scrypt hash, role, status (pending/active/disabled), permissions[] |
| `app_email_settings` | Single-row portal SMTP config; `smtp_password_enc` is AES-256-GCM encrypted, never returned to clients |
| `dp_rejected_handled_ecom` | Dedup ledger: DocPharma-rejected orders already reported → never re-reported |
| `docpharma_check_ecom` | "Not-in-DocPharma" check cache (TTL) to avoid re-hitting their rate-limited API |
| `serviceability_edd_ecom` | Pincode serviceability / EDD estimates |
| `amazon_review_requests` | Review-request send history |
| `fba_fc_snapshot_ecom`, `fba_inbound_ecom` | FBA stock snapshots / inbound |
| `docpharma_orders`, `docpharma_invoices`, `docpharma_goods_*`, `docpharma_charge_*`, `docpharma_payments`, `docpharma_rate_card`, `docpharma_recon_log`, `docpharma_*_stock` | DocPharma reconciliation domain |
| `ops_actions_ecom`, `order_awb_ecom`, `awb_cache_ecom`, `shipment_cache_ecom`, `api_logs_ecom`, `cod_confirmations_*` | Support/ops tables |

### Key invariants
- `shipment_journey_ecom.outcome='delivered'` **must** have `delivered_at`. A `/deliver/`-regex bug once mis-marked out-for-delivery orders as delivered in **both** parsers (DocPharma fixed 2026-07-14, RapidShyp fixed 2026-07-16 — 344 rows repaired); both classifiers now require `\bdelivered\b` and exclude "not delivered"/"undelivered" phrasings. Never reintroduce a bare `/deliver/` status test.
- Silent RTO ≡ `outcome='rto' AND rto_no_attempt=true`.
- `first_edd` is preserved to the **earliest** promised date by DB trigger (RapidShyp EDD or DocPharma `eta`).

---

## 9. Scheduled Jobs (Crons)

All schedules run in **Asia/Kolkata** inside the server process (`server.js` unless noted).

| Schedule | Job |
|---|---|
| `45 */6 * * *` | Journey gap-fill — refresh non-final shipments (webhooks are primary) |
| `15 3 * * *` | **RapidShyp charges sync** — price newly-final shipments (freight + value + EDD backfill), batches of 2500 |
| `40 */3 * * *` | DocPharma portal ingest (they have no webhooks) + once ~40s after boot |
| `30 2 * * *` | New/Repeat order-type + destination refresh (SQL RPCs) + once after boot |
| `0 */2 * * *` | RapidShyp sync — last 7 days (skips 16:00 slot) |
| `0 16 * * *` | RapidShyp sync — full month-to-date |
| `30 8 * * *` | Warehouse Ops report (cutoff −2) → Teams |
| `30 17 * * *` | Warehouse Ops report (cutoff −1) → Teams |
| `0 20 * * *` | Full RapidShyp cache refresh **then** Warehouse Ops report (−1) → Teams |
| `0 8-19 * * *` | DocPharma-rejected → Warehouse Action report (hourly, deduped via handled-list) → Teams |
| `0 11 * * *` | EasyEcom On-Hold report → Teams |
| `30 9 * * 1` | **Silent-RTO weekly claim email → RapidShyp** (previous 7 days, freight + invoice value) |
| `45 9 * * 1` | **Late-deliveries weekly email** (last 30 days, delivered-only) |
| `20 */3 * * *` | RapidShyp cache sync for EasyEcom orders + once ~15s after boot |
| `0 10 * * *` | Amazon auto-review check (`AUTO_REVIEW_CRON`, in `amazon_auto_review.js`) |
| `30 6 * * *` | FBA locations sync (`amazon_fba.js`) |
| every 20 s | Teams keyword listener poll (`teams_listener.js`) — not a cron, an interval |

---

## 10. External Integrations

| Service | Usage | Module |
|---|---|---|
| **Shopify** | Orders, fulfillments, customers, tags (GraphQL/REST) | `orders.js`, sync scripts |
| **RapidShyp** | `track_order` (scan timelines), `shipment_details` (freight/`final_freights`, invoice value, EDD — lookup by AWB), serviceability; inbound webhook (Supabase edge function) | `delivery_journey.js`, `shipping.js`, `serviceability.js` |
| **DocPharma** | `POST /fetch-details` (status milestones only — **no scan log**), partner portal ingest (auto-login), invoices/ledger recon. Heavily rate-limited — all checks are cached | `helpers.js`, `docpharma_*.js` |
| **EasyEcom** | B2C order sync, on-hold report, JWT-auth API | `easyecom.js` |
| **Amazon SP-API** | Orders, review-request eligibility ("Request a Review"), FBA stock/inbound | `amazon*.js` |
| **Meta (Facebook) Ads** | Ad set / ad performance metrics | `adset_performance.js`, `ad_performance.js` |
| **Microsoft Teams (outbound)** | 4 Power Automate Workflow webhooks post **native Adaptive Cards** (warehouse-ops, dp-to-mwh, easyecom-hold, amazon-review). Payload: `{ card: JSON.stringify(adaptiveCard) }` | `teams.js` |
| **Microsoft Teams (inbound)** | Graph **delegated** auth (device-code → rotating refresh token, persisted to `.env`): polls channels; `"rejected"` in DP channel → runs the DP report; `"yes"/"no"` in Amazon channel → approve/cancel pending review batch; posts "🔄 Got it" ack | `teams_listener.js` |
| **Slack** | **Decommissioned (2026-07).** Posting + keyword trigger hard-disabled in code unless `SLACK_ENABLED=true` | `warehouse_slack_report.js` |
| **AI (Gemini / OpenAI-compatible)** | Critical-email polish. Auto-detects Gemini URLs → native `generateContent` with `thinkingBudget: 0` (compat endpoint returns empty for thinking models); otherwise standard `chat/completions`. Always falls back to a built-in template | `ai.js` |
| **SMTP (Gmail)** | All report emails via shared `sendMail()` — portal settings override `.env` defaults | `email_settings.js` |
| **MSG91** | COD-confirmation webhook (Supabase edge function) | `supabase/functions/` |

---

## 11. Reports & Notifications

### Teams channel reports (Adaptive Cards)
1. **Warehouse Ops** — pending Confirmed / Ready-for-Pickup / Unfulfillable orders, grouped by category with order IDs (3×/day).
2. **DocPharma Rejected → Warehouse Action** — orders with no RapidShyp tracking that DocPharma cancelled/rejected (hourly 8-19). **Dedup:** each reported order is written to `dp_rejected_handled_ecom` and never re-reported; if that ledger can't be read the run **aborts** (fail-safe, no re-spam).
3. **EasyEcom On-Hold** — daily 11:00.
4. **Amazon Review** — pending review batch with a Teams `yes`/`no` approval loop.

### Emails (via portal-configured SMTP)
| Email | Recipient | Trigger |
|---|---|---|
| Silent-RTO claim (order/AWB/courier/date/**shipping cost**/**invoice value** + totals) | RapidShyp address from Settings | Mon 09:30 weekly + dashboard button |
| Late deliveries (promised vs delivered vs days late) | Default recipients | Mon 09:45 weekly + dashboard button |
| In-transit overdue chase list | Default recipients | Dashboard button |
| Critical escalation (AI-polished; single order or all marked-fake; shipment table auto-attached) | RapidShyp (or typed recipient) | Per-order / batch buttons (admin) |
| Adset performance PDFs (MTD + last month) | Default recipients | `cron_job.js` (external scheduler) |

---

## 12. Environment Variables

Defined in `.env` (git-ignored — **never commit**), read exclusively through `config.js`.

| Group | Variables |
|---|---|
| Server | `PORT` (5002), `JWT_SECRET` (≥32 chars, enforced), `DASHBOARD_URL` |
| Bootstrap admin | `APP_USER_EMAIL`, `APP_USER_PASSWORD` |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |
| Shopify | `SHOPIFY_TOKEN`, `SHOPIFY_SHOP_URL` |
| RapidShyp | `RAPIDSHYP_API_KEY`, `RAPIDSHYP_API_URL` |
| DocPharma | `DOCPHARMA_API_KEY`, `DP_PORTAL_EMAIL`, `DP_PORTAL_PASSWORD`, `DP_PORTAL_TOKEN`, `DP_TRIGGER_WORD` |
| EasyEcom | `EASYECOM_BASE_URL`, `EASYECOM_API_KEY`, `EASYECOM_WH_KEY`, `EASYECOM_JWT`, `EASYECOM_EMAIL`, `EASYECOM_PASSWORD`, `EASYECOM_WEBHOOK_TOKEN` |
| Amazon SP-API | `AWS_ACCESS_KEY`, `AWS_SECRET_KEY`, `AWS_REGION`, `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, `REFRESH_TOKEN`, `MARKETPLACE_ID`, `BASE_URL` |
| Meta Ads | `FACEBOOK_AD_ACCOUNT_ID`, `FACEBOOK_ACCESS_TOKEN` |
| Email | `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASSWORD`, `RECIPIENT_EMAIL`, `EMAIL_ENC_KEY` (optional 64-hex AES key; falls back to key derived from `JWT_SECRET` — **don't change after passwords are stored**) |
| AI | `AI_API_KEY`, `AI_API_URL` (`https://generativelanguage.googleapis.com` for Gemini), `AI_MODEL` (`gemini-flash-latest`) |
| Teams outbound | `TEAMS_WEBHOOK_WAREHOUSE`, `TEAMS_WEBHOOK_DP`, `TEAMS_WEBHOOK_HOLD`, `TEAMS_WEBHOOK_AMAZON` |
| Teams inbound | `TEAMS_TENANT_ID`, `TEAMS_CLIENT_ID`, `TEAMS_REFRESH_TOKEN` (auto-rotated — run the listener in ONE process only), `TEAMS_TEAM_ID`, `TEAMS_CHANNEL_DP`, `TEAMS_CHANNEL_AMAZON`, `TEAMS_LISTENER_DRYRUN` |
| Slack (legacy, off) | `SLACK_ENABLED` (must be `true` to re-enable), `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` |
| Misc | `PICKUP_PINCODE`, `AUTO_REVIEW_CRON`, `CACHE_DIR`, `GOOGLE_CREDENTIALS` |

---

## 13. Frontend Build

Tailwind is **statically compiled** (no runtime CDN — CSP forbids it):

```bash
node_modules/.bin/tailwindcss -i tw-input.css -o app/static/tailwind.css --minify
```

**Run this after ANY change that adds/removes CSS utility classes** in `app/templates/index.html` or `app/static/app.js`, and commit the rebuilt `app/static/tailwind.css`. The scan config lives in `tailwind.config.js` (no safelist — the content scan is sufficient).

Shared UI conventions: `.filter-select` / `.filter-input` / `.filter-btn` (38px, custom chevron, indigo focus ring) for all filter rows; DD-MM-YYYY (IST) date display on newer dashboards; progressive/chunked table rendering with `requestAnimationFrame` for large lists; `escapeHtml`/`ecEsc` on all user-content sinks.

---

## 14. Deployment & Operations

### Standard deploy
```bash
# on the server
cd <app-dir>
git pull
npm install            # only if package.json changed
node_modules/.bin/tailwindcss -i tw-input.css -o app/static/tailwind.css --minify   # only if not committed
pm2 restart <app-name>
pm2 logs <app-name> --lines 50   # verify clean boot
```

### Boot checklist (log lines to expect)
- `Server running on port 5002`
- `[TeamsListener] started — watching Amazon + DP channels every 20s`
- `[AutoReview] Cron scheduled`
- `[DP Trigger] Slack keyword trigger disabled (Teams-only)` ← expected; Slack is off

### `.env` sync
`.env` is not in git. When new variables are introduced (see §12 — most recently `AI_*`, `EMAIL_ENC_KEY`, `TEAMS_*`), copy them to the server's `.env` manually before restart.

### HTTPS
Currently served over plain HTTP behind the VPS IP. `Caddyfile.example` documents the intended reverse-proxy setup — **pending item**.

---

## 15. CLI & Maintenance Utilities

Run from the repo root (they load `.env` themselves):

| Command | Purpose |
|---|---|
| `node app/api/delivery_journey.js backfill [days] [conc] [olderThanDays]` | Re-resolve journeys for a window |
| `node app/api/delivery_journey.js charges-backfill [conc] [pageSize]` | Price all final RapidShyp shipments (freight/value/EDD); safe to re-run |
| `node app/api/delivery_journey.js tat-backfill [days] [conc]` | Fill missing dispatch TAT / zones |
| `node app/api/delivery_journey.js fix-intransit [days] [conc]` | Re-check stuck in-transit rows |
| `node app/api/delivery_journey.js reprocess-final [days] [conc] [outcome] [source]` | Re-parse final rows with current classifier |
| `node app/api/delivery_journey.js fix-docpharma [conc] [all]` | Re-fetch/re-classify DocPharma rows (use conc ≤ 2 — DP rate-limits hard) |
| `node app/api/warehouse_slack_report.js [offset] [dry]` | Warehouse report (add `dry` to preview without posting) |
| `node app/api/warehouse_slack_report.js dp [dry]` | DocPharma-rejected report |
| `node app/api/warehouse_slack_report.js hold [dry]` | EasyEcom On-Hold report |
| `node cron_job.js` | Adset PDF email report |
| `npm run sync` (`data_fetcher.js`) | Bulk data sync |
| `POST /api/teams/test?target=warehouse\|dp\|hold\|amazon` | Teams webhook smoke test |

---

## 16. Security

Hardening completed in the 2026-07 security audit:

- **Transport of secrets:** `.env` git-ignored; all secrets flow through `config.js`.
- **Auth:** scrypt hashing (timing-safe compare), strong-JWT-secret enforcement, 1-day token expiry, per-IP + per-account login rate limiting.
- **AuthZ:** server-side per-dashboard permission gates (path-prefix middleware + mount-level `requirePermission`) — UI hiding is never the only control.
- **CSP:** `script-src 'self' 'unsafe-inline'`, no external CDNs (Tailwind compiled, Chart.js self-hosted), `object-src/base-uri/frame-ancestors/form-action` locked, `connect-src 'self'`.
- **XSS:** `escapeHtml`/`ecEsc` applied to customer-data render sinks in the SPA.
- **Injection:** PostgREST filter injection fixed (`.or(name.eq.X)` → `.in()`), webhook IDs validated (`/^[\w-]+$/`).
- **Secrets at rest:** portal SMTP password AES-256-GCM encrypted (`crypto_util.js`, versioned format `v1$iv$tag$ct`, tamper-detected); `app_email_settings` and `order_marks_ecom` are RLS-locked with no client policies (service-role only).
- **Fail-safe messaging:** Slack hard-disabled (`SLACK_ENABLED` opt-in); report dedup aborts on ledger read failure instead of re-spamming.

**Known open items**
1. **HTTPS** — still plain HTTP; deploy the Caddy reverse proxy (`Caddyfile.example`).
2. `.env` contains live credentials on developer machines — rotate any credential suspected of exposure.

---

*Document generated 2026-07-16. Keep this file updated when adding dashboards, tables, crons, or environment variables.*
