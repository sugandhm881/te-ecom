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
| Email | Nodemailer (SMTP send) + imapflow/mailparser (IMAP reply reading); portal-configurable settings, AES-256-GCM-encrypted password |
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
        ├── auth_routes.js         # /login /signup /me + 2FA OTP (verify/resend) (+ rate limiting)
        ├── users.js               # Admin user management (/api/admin/users)
        ├── email_settings.js      # Portal SMTP settings + shared sendMail()
        ├── email_replies.js       # Escalation reply tracking: IMAP inbox poll, thread matching, AI scoring
        ├── cod_risk.js            # Shared pre-dispatch COD risk scorer (customer history + pincode RTO)
        ├── support_console.js     # Customer Support console API (queue/orders/calls/notes/contacts/team)
        ├── influencer_crm.js      # Influencer Marketing CRM API (/inf/* — discover/influencers/videos/lists/calendar/mentions/send-product)
        ├── crypto_util.js         # AES-256-GCM encrypt/decrypt for stored secrets
        ├── ai.js                  # AI client (Gemini native / OpenAI-compatible)
        ├── excel_report.js / pdf_generator.js
        ├── webhook_handler.js     # Inbound webhooks (RapidShyp / EasyEcom / DocPharma / DocPharma-NDR)
        ├── shipping.js / helpers.js / middleware.js
        └── docpharma_import_lib.js
```

---

## 5. Dashboards & Features

Navigation is permission-gated per user (see §6). Permission keys in parentheses.

### Operations
| Dashboard | Key | Description |
|---|---|---|
| Orders Dashboard | `orders-dashboard` | **Shopify orders only** (Amazon excluded 2026-07; EasyEcom-only orders — Flipkart `OD…` etc. — excluded 2026-07-17; EasyEcom data still mapped for hold/unhold/warehouse) enriched with tracking, COD-confirmation & repeat flags. Filters: status, date, COD-status, **Hold-status (On Hold / Not Held)**, platform (Shopify), **source RapidShyp/DocPharma**. Hold marks (`ee_hold`) are reconciled by **actual courier pickup** — an order stays holdable any time BEFORE pickup (including Ready-To-Ship with an AWB assigned; Shopify marks those "fulfilled"→'Shipped' but they're still holdable). "Picked up" is decided from the real **tracking signal** (`orders.tracking_status` / RapidShyp cache raw_status: IN TRANSIT / OUT FOR DELIVERY / DELIVERED / RTO / RETURN / REACHED / UNDELIVERED / PICKUP COMPLETED / LOST), NOT the AWB or EasyEcom `order_status` (neither reflects hold — the old parse wrongly wiped active holds each sync). Server sets `order.holdable`; the ⏸ Hold button shows only when `holdable`, and a mark is auto-cleared only once picked up. **Hold is detected from EITHER a local `ee_hold` mark OR EasyEcom's synced `order_status='On Hold'`** (orders held directly in the EasyEcom panel — a dedicated held-query, not the capped rows, so it's complete). **Held orders are ALWAYS shown even if outside the 500-row table cap** (fetched by name and appended — held orders need action). **Held orders surface on every dashboard**: Orders `eeHold` + the ⏸ HOLD chip on Ops Control / Delivery Performance / Claims-SLA / Customer Support, via `/api/ee-hold-marks` (which merges local marks + EasyEcom "On Hold"). (via EasyEcom `location` = `shipPlatform`, tag fallback). **DocPharma-rejected orders** (from `dp_rejected_handled_ecom`) show a red **DP Rejected** tag + rose row tint when un-actioned, flipping to green **DP Rejected → MWH** once auto-routed/handled (`routed_at`) or logged-moved. Date presets include **Last 30 Days**. `/get-orders?days=N` is **date-aware** (default 30, clamp 1–90): the table returns the most-recent ≤500 rows in the window (kept small for a snappy render; date change shows an instant branded loader + guards overlapping fetches), but the **KPI cards use accurate server-side count queries over the full window** (`{ orders, kpis, total, shown, truncated }`) — so 7-day vs 30-day show genuinely different numbers (e.g. 1,125 vs 5,159 total) even though the table is capped (shows a "most recent N shown" hint). Changing the date preset RE-FETCHES (server window); other filters (status/COD/hold/source/search) filter the loaded set client-side. **KPI cards are filter-aware**: with no filter they show the accurate server full-window counts; once any filter is active they recompute from the filtered set (subtext "matching current filters") so the numbers track what's shown. Progressive-render + **lazy expanded details** show item **SKUs**, EasyEcom workflow (Approve, ⏸ Hold/▶ Unhold), and **🏬 Change warehouse** — shown ONLY for DocPharma orders (never Shifupro/RapidShyp); disabled "✓ Moved · from → to" once routed |
| Fulfillment Ops | `fulfillment-ops` | Fulfillment pipeline operations, AWB fetch, label download |
| Delivery Performance | `delivery-perf` | KPIs (FASR/RTO/NDR-recovery/TAT), status partition, FASR trend, NDR funnel, RTO-by-courier, **FASR vs NDR Prepaid-vs-COD**, **🚩 Likely-Fake tracking insight** (marked → delivered conversion %), shipment explorer (sortable, filterable, expandable rows with date/scan logs, **Promise date column**, per-order actions: *mark likely-fake*, *send critical email* → becomes *View email & replies* with the **escalation mail thread auto-loaded** (sender/receiver format, AI reply scores + next-action), *🔁 NDR action* on NDR-pending rows) |
| Silent-RTO & SLA | `claims-sla` | 3 tabs: **Silent-RTO Claims** (RTO with zero attempts + claimable freight/invoice value), **Late Deliveries** (delivered after promise date), **In-transit · Overdue** (promise passed, still moving). All tabs: KPIs, DD-MM-YYYY dates, sortable columns, shared filters (search/platform/payment/courier/zone), expandable rows, admin email-send buttons |
| Ops Control | `ops-control` | Action queues: **NDR queue** (aged failed-delivery orders — call/WhatsApp customer, one-click status actions, **🔁 NDR action** modal firing RapidShyp reattempt/return with corrected phone+address; customer conversations are logged in the Customer Support console's notes/call-log, not here), **Pre-dispatch Risk** (COD risk scores from `cod_risk.js` incl. the customer's own RTO history, 📱 WhatsApp-verify, verify/hold/→prepaid actions), courier scorecard, exceptions & claims, cost views |
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

### Customer Support (port of the standalone Support Console)
| Dashboard | Key | Description |
|---|---|---|
| Support Dashboard | `support-dashboard` | KPIs (orders/calls/delivered/pending/MSG91-confirmed) + 8 clickable bucket tiles |
| Call Queue | `support-queue` | 3 tabs — Repeat customers (COD repeat pre-dispatch), Undelivered, Status-changed; note/age filters, notes dialog, RapidShyp sync button |
| Support Orders | `support-orders` | Full order search (bucket/partner/courier/status/free-text), 50/page, order-detail modal (MSG91 column/filter removed 2026-07-16; detail modal shows MSG91 thread with template-variable JSON rendered as plain text) |
| Call Logs | `support-calls` | My calls (admin: all), outcome stats, follow-ups |
| Escalation Contacts | `support-contacts` | Courier/region/pincode escalation directory (admin CRUD) — powers "Whom to call" in order detail |

Backend: `app/api/support_console.js` reads the `order_buckets` **view** + `order_notes`, `call_logs`, `escalation_contacts`, `undelivered_tracking`, `msg91_messages`, `tracking_run_lock`, `profiles`. Portal agents are bridged to Supabase auth via shadow users (`auth.admin.createUser`) because `call_logs.agent_id`/`profiles.user_id` FK to `auth.users`.

### Influencer Marketing (port of the standalone Influencer CRM — added 2026-07-17)
| Dashboard | Key | Description |
|---|---|---|
| Influencer Dashboard | `inf-dashboard` | Pipeline KPI tiles (total/partnered/in-discussion/reached-out/lists, clickable) + recent-activity feed + quick actions |
| Discover | `inf-discover` | AI-vet any @handle (`analyze-influencer` edge fn: Apify profile+reels scrape → Gemini via Lovable AI Gateway; AI-only fallback) — result card with recommendation/pros/cons/brand-fit/conversion-potential, **Add to CRM** + add-to-list; analysis history (from `analysis_queue`); "Process pending queue" drains brand-scan discoveries |
| Influencers | `inf-influencers` | Full CRM table (1,200+ creators): search, status/niche/follower-bucket (nano<10K/micro/macro/mega>1M)/contact filters, sortable headers, chunked render; multi-select **bulk actions** (status change, add to list); CSV export; **Refresh last 10 days** bulk reel-metric re-scrape with live progress bar (polls `metrics_fetched_at`); add-influencer modal; row → full **detail modal**: profile sidebar (contact/address/deal terms/bio/notes, edit modal), status select, 💬 DM (ig.me + auto reached_out), Videos tab (cards with views/likes/comments/shares, payment-status select, GST, fetch-metrics with poll, edit/delete, **Send product** → Shopify draft order via `create-influencer-order` edge fn with address prefill+saveback, draft-order link, **printable invoice** — Shifupro Technologies, optional 18% GST), Activity tab (timeline, notes highlighted, add note) |
| Lists & Campaigns | `inf-lists` | Campaign lists: create/delete, member counts; auto-detected date range from list name (month or festival + year, e.g. "Diwali 2026" → Oct-Nov); detail: financial rollups (views-in-range, quoted, final, GST, spend, blended CPM) per member + totals, add/remove members |
| Video Calendar | `inf-calendar` | Month grid of deliverables — green live / amber expected / red overdue badges per day, click → influencer detail |
| Brand Mentions | `inf-mentions` | Scan a brand @handle for tagging creators (`scan-brand-mentions` → Apify tagged-post scraper; auto-polls `check-brand-scan` every 8s); new handles auto-queued into `analysis_queue` for AI vetting; scan history with found/queued/skipped + queued handles |

Backend: `app/api/influencer_crm.js` (all routes `/api/inf/*`) reads/writes `influencers`, `influencer_videos`, `influencer_lists`, `influencer_list_members`, `influencer_activities`, `analysis_queue`, `brand_mention_scans`, `shopify_products` — the SAME tables the standalone app used (1,209 influencers, 224 videos live at port time) — and invokes the already-deployed edge functions (`analyze-influencer`, `fetch-reel-metrics`, `refresh-recent-video-metrics`, `scan-brand-mentions`, `check-brand-scan`, `create-influencer-order`, `process-analysis-queue`) with the service-role key (passes their `verify_jwt`). Activity logging (status_change/video_added/payment/product_sent/note) attributes the portal user. Influencer deletes remove children first (no FK cascade). The standalone app's own Users page was NOT ported — portal RBAC (`inf-*` keys) governs access instead. NOTE: actual schema differs from the old app's doc — `follower_count` (not `followers`), `profile_image_url` (not `profile_pic_url`), flat variant-level `shopify_products` rows.

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
- **2FA (added 2026-07-16 for admins; switched from MSG91 SMS to EMAIL OTP and extended to ALL accounts 2026-07-17):** when the portal can send mail (Settings → Email / `app_email_settings`, sender `digital@theelement.skin`, falling back to `.env` `EMAIL_*`), `/login` for any user does not return a token — `app/otp_mail.js` generates a 6-digit OTP, stores only its HMAC-SHA256 hash in a 5-minute in-memory record (max 5 wrong attempts, single-use, 25s server-side resend throttle — a duplicate `/login` inside the gap **reuses** the in-flight OTP instead of erroring; a pm2 restart just voids pending OTPs), emails it via the shared `sendMail`, and `/login` returns `{ otp_required, otp_token (5-min pre-auth JWT, stage:'otp2fa', no permissions), email_hint }`. The client then calls `POST /api/login/verify-otp { otp_token, otp }` → real JWT (role/permissions re-fetched fresh from DB, never trusted from the pre-auth token), or `POST /api/login/resend-otp`. Both are public + rate-limited. OTP mails carry **no CC** (`cc: []` — the default report CC from Settings is explicitly excluded), and after expiry each OTP email is **auto-purged from the sender's Sent folder** over IMAP (moved to `[Gmail]/Trash` + expunged; a plain expunge in Sent would only archive on Gmail) — scheduled at send-time +5m15s, plus startup sweeps at +60s/+6.5m to catch purges lost to a restart. If email/SMTP isn't configured, logins fall back to password-only with a server-side warning — never a lockout. **Emergency 2FA off-switch:** blank the SMTP settings (or fix SMTP) — there is no separate 2FA env var. The OTP email shows the Ecom Central logo as a hosted image (`DASHBOARD_URL/static/assets/ecom-logo.png`, not an attachment — no Gmail attachment chip).
- **Signup:** `POST /api/signup` — open signup creates a **pending** account; an admin must approve and grant dashboard permissions. **Mobile (Indian 10-digit) is mandatory** on signup, admin add-user, and editable per-user (`POST /admin/users/:id { mobile }`).
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
| POST | `/login` | public (rate-limited) | Issue JWT, or start 2FA (`otp_required` + `otp_token`) — all accounts |
| POST | `/login/verify-otp` | public (rate-limited) | 2FA step 2: pre-auth token + OTP → real JWT |
| POST | `/login/resend-otp` | public (rate-limited) | Re-email the 2FA OTP (new code, 25s throttle) |
| POST | `/signup` | public (rate-limited) | Create pending account (mobile mandatory) |
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
| POST | `/critical-email/send` `{subject, body, to?, tableHtml, orders[]}` | admin | Send + log `critical_mail_sent` marks + record the thread for reply tracking |
| POST | `/critical-email/polish` `{subject, body, tone}` | admin | AI-rewrite the (hand-edited) draft in a chosen tone: polite / direct / formal |
| GET | `/escalation-emails?awb=\|order=` | delivery-perf or claims-sla | Mail thread(s): sent escalation + replies with `direction` (outbound/inbound) + AI score/status/suggestion |
| GET | `/escalation-emails/recent` · POST `/escalation-emails/poll` | delivery-perf | Latest replies (order-labeled) · manual inbox poll |
| POST | `/ndr-action` `{awb, action: RE_ATTEMPT\|RETURN, phone?, address1?, address2?, order?}` | ops-control or delivery-perf | Fire RapidShyp's NDR action (auto-retries the alternate action spelling on rejection); logs to `ops_actions_ecom` |
| POST | `/easyecom/hold-order` `{orderName, reason}` · `/easyecom/unhold-order` | user | Hold/release in EasyEcom (keyed by invoice_id); writes/clears the `ee_hold` live-state mark; "already held/unheld" counts as success |
| GET/POST | `/easyecom/warehouses` · `/easyecom/change-warehouse` `{orderName, targetCid}` · `/easyecom/session` (admin GET/POST) · `/easyecom/session/check` (live health) | user (session admin) | **Warehouse routing via panel-session cookie replay** (added 2026-07-17). `/Orders/UpdateVendor` refuses the API JWT (needs the interactive panel session) but accepts the browser `laravel_session`+`PHPSESSID` cookie replayed from our server (verified live: TE25-36487 moved DP Bangalore→Shifupro; success body = literal `0`). Admin pastes the EasyEcom Cookie (DevTools → Cookie header) in the "🏬 Change warehouse" modal → stored **AES-GCM encrypted** (`crypto_util`) in `easyecom_panel_session` → replayed against `app.easyecom.io/Orders/UpdateVendor` with `invoice_id&vendor_c_id=<target>&c_id=<company>`. `session/check` pings with `invoice_id=0` and drives a **healthy / expired** badge in the modal. Expired → `needSession:true`. **Constraint:** only before a shipment/AWB is assigned. Warehouses `EE_WAREHOUSES`: Shifupro 257282, DP Bangalore 271096 (sub), Amazon FBA 288922/288927. **Auto-route:** detection (cron :47) reports + records rejections; a SEPARATE gentle pass `autoRouteHandledRejections()` (cron :56, 9 min later) moves not-yet-routed ones to Shifupro (skips already-Shifupro / AWB-assigned; `dp_rejected_handled_ecom.routed_at` marks done, ~1 order/1.5s so it never bursts). **Keep-alive cron** (`*/20`) pings the session so the cookie rarely needs re-pasting. All logged to `api_logs_ecom` (`easyecom_change_warehouse` / `easyecom_autoroute_warehouse`). (Old JWT/location-token path — `EASYECOM_WH2_KEY`, `mintTokenForLocation` — unused; kept for reference.) |
| GET/POST | `/support/*` (summary, queue, orders, order/:id, notes, calls, contacts, team, refresh-tracking) | any `support-*` perm (writes: notes/calls any agent; contacts & team admin) | Customer Support console API (see §5) |
| GET/POST/DELETE | `/inf/*` (summary, influencers CRUD+bulk, influencer/:id, videos CRUD + :id/metrics, refresh-videos + refresh-progress, activities, lists CRUD + members, calendar, discover + history + process-queue, mentions + scan + check, products, send-product) | any `inf-*` perm | Influencer Marketing CRM API (see §5) |
| GET | `/ee-hold-marks` | any authenticated user | Live EasyEcom-hold marks (`order_marks_ecom` type `ee_hold`) — powers the **⏸ HOLD chip on every dashboard** (added 2026-07-17): Ops Control (NDR queue/exceptions/prepaid-risk), Delivery Performance table, Claims/SLA (all 3 tabs), Customer Support (queue/orders/order modal) fetch it at load (60s client cache, busted instantly on hold/unhold) and decorate rows client-side; the Orders dashboard keeps its baked-in `eeHold` from `/get-orders`. Client-side decoration deliberately bypasses the 5-min ops response cache so hold status is always fresh. |

### Other domains (mounted routers)
- `/api/orders…` — Shopify orders + enrichment (shared across dashboards, not view-gated)
- `/api/easyecom/*`, `/api/fulfillment-ops/*`, `/api/serviceability/*`
- `/api/amazon/*` — review requests (perm `amazon-review`)
- `/api/fba/*` — FBA dashboards (perm `amazon-fba`)
- `/api/docpharma*` — recon/invoices/ledger/overview/inventory (perm `docpharma-recon`)
- `/api/ops-control/*`, `/api/adset*`, `/api/ad*`, Excel/PDF report endpoints
- `/api/webhook/*` — inbound webhooks (public): `/rapidshyp`, `/easyecom`, `/docpharma` (order journey), **`/docpharma-ndr`** (NDR logs → `docpharma_ndr_logs`; optional `DOCPHARMA_NDR_TOKEN` via `?token=`/`x-webhook-token`; accepts single/array/`{records|data|orders}` payloads; extracts order/awb/status/ndr_reason/attempt/courier/ndr_at + full `raw`)
  - **HTTPS variant (for external partners):** Supabase Edge Function **`docpharma-ndr-webhook`** = same logic as `/api/webhook/docpharma-ndr` but always-on HTTPS. Public URL to hand to DocPharma: `https://urtwdqmiypjhnduspmwk.supabase.co/functions/v1/docpharma-ndr-webhook` (health probe: `?health=1`; optional `DOCPHARMA_NDR_SECRET` function-secret enforced via `?token=`/`x-webhook-token`; `verify_jwt=false`). Mirrors the `easyecom-b2c-webhook` edge-function pattern.
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
| `app_users_ecom` | Portal users: email, mobile (mandatory, kept on profile), scrypt hash, role, status (pending/active/disabled), permissions[] |
| `app_email_settings` | Single-row portal SMTP config; `smtp_password_enc` is AES-256-GCM encrypted, never returned to clients |
| `escalation_emails_ecom` | Escalation mail threads: every SENT critical email (RFC Message-ID) + every REPLY pulled via IMAP, with AI resolution score/status/suggestion |
| `easyecom_token_cache` | Shared EasyEcom JWT (single row id=1) — one login per ~90 days instead of per process |
| `order_buckets` (**view**) + `order_notes`, `call_logs`, `escalation_contacts`, `undelivered_tracking`, `msg91_messages`, `tracking_run_lock`, `profiles`, `user_roles` | Customer Support console data layer (shared with the original standalone console; portal agents bridged via shadow auth users) |
| `influencers`, `influencer_videos`, `influencer_lists`, `influencer_list_members`, `influencer_activities`, `analysis_queue`, `brand_mention_scans`, `shopify_products` | Influencer Marketing CRM data layer (shared with the original standalone CRM app) |
| `easyecom_panel_session` (id=1) | EasyEcom panel session cookie (AES-GCM encrypted) for warehouse-change routing via `/Orders/UpdateVendor` |
| `dp_rejected_handled_ecom` | Dedup ledger: DocPharma-rejected orders already reported → never re-reported |
| `docpharma_check_ecom` | "Not-in-DocPharma" check cache (TTL) to avoid re-hitting their rate-limited API |
| `serviceability_edd_ecom` | Pincode serviceability / EDD estimates |
| `amazon_review_requests` | Review-request send history |
| `fba_fc_snapshot_ecom`, `fba_inbound_ecom` | FBA stock snapshots / inbound |
| `docpharma_orders`, `docpharma_invoices`, `docpharma_goods_*`, `docpharma_charge_*`, `docpharma_payments`, `docpharma_rate_card`, `docpharma_recon_log`, `docpharma_*_stock` | DocPharma reconciliation domain |
| `docpharma_ndr_logs` | DocPharma NDR (Non-Delivery Report) events received via the `/api/webhook/docpharma-ndr` webhook (order/awb/status/ndr_reason/attempt/courier/ndr_at + raw jsonb) |
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
| `47 8-19 * * *` | DocPharma-rejected **detection** (at :47, deduped via handled-list) → Teams report + records to `dp_rejected_handled_ecom` |
| `56 8-19 * * *` | Warehouse **auto-route** pass (at :56, 9 min after detection) — gently moves not-yet-routed rejections to Shifupro (cookie-based, ~1 order/1.5s, `routed_at` marks done). Kept separate + slow so it never bursts/crashes |
| `0 11 * * *` | EasyEcom On-Hold report → Teams |
| `*/20 * * * *` | EasyEcom panel-session keep-alive ping (extends the warehouse-routing cookie's session) |
| `30 9 * * 1` | **Silent-RTO weekly claim email → RapidShyp** (previous 7 days, freight + invoice value) |
| `45 9 * * 1` | **Late-deliveries weekly email** (last 30 days, delivered-only) |
| `*/10 * * * *` | **Escalation reply poll** — IMAP inbox scan, match replies to sent threads (whole-chain In-Reply-To + subject), AI-score inbound replies, retry unscored |
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
| **Microsoft Teams (outbound)** | 4 Power Automate Workflow webhooks post **native Adaptive Cards** (warehouse-ops, dp-to-mwh, easyecom-hold, amazon-review). Payload: `{ card: JSON.stringify(adaptiveCard) }`. The **EasyEcom On-Hold** and **Warehouse Ops** reports additionally send `{ text: <html>, attachments: [<card>] }` so their flows can post as a **reply into a specific thread** via "Reply with a message in a channel" (Adaptive Cards can't be channel replies). `postTeams(url, payload, {text})`: `text` is a verbatim HTML string, or `true` to auto-generate HTML from the Slack blocks via `slackToHtml()` (header→bold, section→text, fields→stacked lines, order IDs→`<code>` chips). On-Hold uses a hand-built string → `TEAMS_WEBHOOK_WAREHOUSE_HOLD` (workflow `fdac450e`, thread `1784287243826`); Warehouse uses `text:true` → `TEAMS_WEBHOOK_WAREHOUSE` (thread `1784291816658`). The single-element `attachments` array makes each flow's `For each` (over `attachments`) run exactly once → one reply. Other reports omit `text`/`attachments`. | `teams.js`, `warehouse_slack_report.js` |
| **Microsoft Teams (inbound)** | Graph **delegated** auth (device-code → rotating refresh token, persisted to `.env`): polls channels; `"rejected"` in DP channel → runs the DP report; `"yes"/"no"` in Amazon channel → approve/cancel pending review batch; posts "🔄 Got it" ack | `teams_listener.js` |
| **Slack** | **Decommissioned (2026-07).** Posting + keyword trigger hard-disabled in code unless `SLACK_ENABLED=true` | `warehouse_slack_report.js` |
| **AI (Gemini / OpenAI-compatible)** | Critical-email polish. Auto-detects Gemini URLs → native `generateContent` with `thinkingBudget: 0` (compat endpoint returns empty for thinking models); otherwise standard `chat/completions`. Always falls back to a built-in template | `ai.js` |
| **SMTP (Gmail)** | All report emails via shared `sendMail()` — portal settings override `.env` defaults | `email_settings.js` |
| **IMAP (same mailbox)** | Reads the inbox every 10 min for replies to sent escalations (imapflow + mailparser; two-phase fetch — never download inside an active fetch stream). Replies matched via In-Reply-To across the whole thread chain, then AI-scored | `email_replies.js` |
| **RapidShyp NDR action** | `POST /ndr/action` — reattempt (with corrected phone/address) or return. Vendor docs contradict themselves on the action value (`REATTEMPT` vs `RE_ATTEMPT`); the wrapper tries the curl-example spelling first and falls back only on an invalid-action rejection. **Never live-test** — it acts on real shipments | `ops_control.js` |
| **EasyEcom hold/unhold** | `PUT /orders/holdOrders` / `unholdOrders` keyed by **invoice_id** (from `b2c_order_easycom.raw_data`) — endpoint discovered from their official Postman collection (not in public docs). JWT cached in `easyecom_token_cache` (DB) so logins happen ~90-daily, not per process | `easyecom.js` |
| **EasyEcom change-warehouse** | Panel-internal `POST app.easyecom.io/Orders/UpdateVendor {invoice_id, vendor_c_id, c_id}` ("vendor"=warehouse). API JWT refused (needs panel session) → we **replay the admin's browser session cookie** (`laravel_session`+`PHPSESSID`, stored AES-GCM in `easyecom_panel_session`). Proven working from our server IP (no XSRF header, not IP-locked). Only before shipment/AWB assigned. Cookie expires → admin re-pastes | `easyecom.js` |
| **MSG91** | COD-confirmation webhook (Supabase edge function) | `supabase/functions/` |
| **Apify** (Instagram scraping) | Influencer CRM: profile/reels/tagged-post scrapers — key lives as a Supabase edge-function secret (`APIFY_API_KEY`), invoked via `analyze-influencer` / `fetch-reel-metrics` / `refresh-recent-video-metrics` / `scan-brand-mentions` | Supabase edge functions |
| **Lovable AI Gateway** (Gemini) | Influencer AI vetting inside `analyze-influencer` — key is the `LOVABLE_API_KEY` edge-function secret | Supabase edge functions |
| **Shopify Admin API** (influencer draft orders) | `create-influencer-order` edge fn (secrets `SHOPIFY_STORE_DOMAIN`/`SHOPIFY_ADMIN_API_TOKEN`) — barter draft orders tagged `influencer-shipment` | Supabase edge functions |

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

**Reply tracking:** every sent critical escalation is logged as a thread (`escalation_emails_ecom`); the inbox is IMAP-polled every 10 minutes, replies are matched to their thread (In-Reply-To across the whole chain, subject fallback), stored, and **AI-scored** (0–100 resolution + status + suggested next action — inbound replies only). Threads render inside the order's expanded row on Delivery Performance in sender/receiver format (THE ELEMENT ↔ RAPIDSHYP).

---

## 12. Environment Variables

Defined in `.env` (git-ignored — **never commit**), read exclusively through `config.js`.

| Group | Variables |
|---|---|
| Server | `PORT` (5002), `JWT_SECRET` (≥32 chars, enforced), `DASHBOARD_URL` |
| Bootstrap admin | `APP_USER_EMAIL`, `APP_USER_PASSWORD` (2FA OTP — all accounts — is emailed to the login address; no extra env vars, activates whenever SMTP is usable) |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |
| Shopify | `SHOPIFY_TOKEN`, `SHOPIFY_SHOP_URL` |
| RapidShyp | `RAPIDSHYP_API_KEY`, `RAPIDSHYP_API_URL` |
| DocPharma | `DOCPHARMA_API_KEY`, `DP_PORTAL_EMAIL`, `DP_PORTAL_PASSWORD`, `DP_PORTAL_TOKEN`, `DP_TRIGGER_WORD` |
| EasyEcom | `EASYECOM_BASE_URL`, `EASYECOM_API_KEY`, `EASYECOM_WH_KEY` (Shifupro location key), `EASYECOM_WH2_KEY` (DocPharma/DP Bangalore location key — for change-warehouse routing), `EASYECOM_JWT`, `EASYECOM_EMAIL`, `EASYECOM_PASSWORD`, `EASYECOM_WEBHOOK_TOKEN` |
| Amazon SP-API | `AWS_ACCESS_KEY`, `AWS_SECRET_KEY`, `AWS_REGION`, `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, `REFRESH_TOKEN`, `MARKETPLACE_ID`, `BASE_URL` |
| Meta Ads | `FACEBOOK_AD_ACCOUNT_ID`, `FACEBOOK_ACCESS_TOKEN` |
| Email | `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASSWORD`, `RECIPIENT_EMAIL`, `EMAIL_ENC_KEY` (optional 64-hex AES key; falls back to key derived from `JWT_SECRET` — **don't change after passwords are stored**) |
| AI | `AI_API_KEY`, `AI_API_URL` (`https://generativelanguage.googleapis.com` for Gemini), `AI_MODEL` (`gemini-flash-latest`), `AI_MODEL_FALLBACK` (optional, default `gemini-flash-lite-latest` — used automatically on 503/429) |
| IMAP | `IMAP_HOST` (optional — defaults to the SMTP host with `smtp.` → `imap.`) |
| Teams outbound | `TEAMS_WEBHOOK_WAREHOUSE`, `TEAMS_WEBHOOK_DP`, `TEAMS_WEBHOOK_HOLD`, `TEAMS_WEBHOOK_AMAZON`, `TEAMS_WEBHOOK_WAREHOUSE_HOLD` (newer On-Hold flow that replies into the Ops/Daily Reports thread — `_teamsUrlFor(HOLD_CHANNEL)` prefers it over `_HOLD`, which stays as fallback) |
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

Shared UI conventions: `.filter-select` / `.filter-input` / `.filter-btn` (38px, custom chevron, indigo focus ring) for all filter rows; DD-MM-YYYY (IST) date display on newer dashboards; progressive/chunked table rendering with `requestAnimationFrame` for large lists; `escapeHtml`/`ecEsc` on all user-content sinks; **every loading state uses the branded logo loader** — `brandLoader(label)` (large, tables/KPIs/modals) or `brandLoaderSm(label)` (compact panels), never plain "Loading…" text.

---

## 14. Deployment & Operations

### Standard deploy
```bash
# on the server
cd <app-dir>
git pull
npm install            # required when package.json changed (2026-07: added imapflow + mailparser)
node_modules/.bin/tailwindcss -i tw-input.css -o app/static/tailwind.css --minify   # only if not committed
pm2 restart <app-name>
pm2 logs <app-name> --lines 50   # verify clean boot
```

### Boot checklist (log lines to expect)
- `Server running on port 5002`
- `[TeamsListener] started — watching Amazon + DP channels every 20s`
- `[AutoReview] Cron scheduled`
- `[DP Trigger] Slack keyword trigger disabled (Teams-only)` ← expected; Slack is off

### Engineering gotcha — router-level response caches
`ops_control.js` and `amazon_fba.js` keep 5-minute GET response caches via `router.use(...)`. Because those routers are mounted at `/api`, an **unscoped** `use()` runs for every `/api` request that falls through them and silently caches *other routers'* GET responses (this once froze all `/support/*` reads for 5 minutes — "DB changed but dashboard shows old data"). Both middlewares are now path-guarded (`/ops-control`, `/fba`) — never widen those guards, and scope any future `router.use()` middleware to its own path prefix.

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
