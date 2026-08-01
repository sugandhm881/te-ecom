# Tally Bridge Agent

Lets the **live** Ecom Central dashboard read from and write to Tally, even though Tally only listens on
`localhost:9000` of this PC.

## Why this exists

Tally's XML gateway has **no authentication at all** — anyone who can reach port 9000 can read and
rewrite your books. So we never expose it. Instead this agent runs *next to* Tally and reaches **out**
to the dashboard:

```
   this PC (Tally)                          VPS (Ecom Central)
   ┌──────────────┐                         ┌──────────────────┐
   │ Tally :9000  │◄──── localhost ────┐    │  /api/tally/     │
   └──────────────┘                    │    │     bridge/*     │
   ┌──────────────┐   HTTPS, outbound  └───►│  (X-Bridge-Key)  │
   │  agent.js    │───────────────────────► │                  │
   └──────────────┘                         └──────────────────┘
```

Nothing inbound is opened on this PC. **Never** put Tally behind ngrok/cloudflared instead.

## What it does

| Every | Action |
|---|---|
| 5 s | Heartbeat → the dashboard's "Tally connected" chip |
| 5 s | Claim approved vouchers → POST to Tally → report Tally's **raw** reply back |
| 15 min | Upload ledgers/groups/voucher types (so the entry form can validate ledger names) |
| 15 min | Upload trial balance + day book (so **Tally Books** works on the live dashboard) |

The agent never decides whether a post succeeded — it returns Tally's exact XML and the server parses
it. A bug here therefore cannot turn a failure into a "posted".

## Setup

1. **Turn on Tally's gateway** — in Tally: `F1` → Settings → Connectivity → Client/Server
   configuration → *Tally acts as:* **Both**, *Port:* **9000**. Keep the company open.
   Check it: open <http://localhost:9000> in a browser — you should get a Tally response, not an error.
2. `copy .env.example .env` and edit it. `BRIDGE_KEY` must match `TALLY_BRIDGE_KEY` in the server's
   `.env` exactly.
3. Test it in the foreground:
   ```
   node agent.js
   ```
   You should see `masters synced: {...}` and `books synced: ...` within a few seconds. In the
   dashboard, **Finance → Data Entry** should show a green *Bridge connected* chip.
4. Make it permanent (run PowerShell **as Administrator** in this folder):
   ```
   .\install-service.ps1
   ```
   That registers a Scheduled Task which starts the agent at logon and restarts it if it stops.
   Remove it with `.\install-service.ps1 -Uninstall`.

## Day to day

- **This PC must be on and Tally open** for vouchers to post and for the books to stay fresh.
- If it's off: entries still save fine in the dashboard, vouchers just queue. The chip turns amber and
  Tally Books shows an "as of" timestamp instead of pretending to be live. Everything drains when the
  agent comes back.
- Logs: `agent.log` in this folder (rotates at 5 MB).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `FATAL: BRIDGE_KEY is not set` | `.env` missing or empty |
| Every call returns 503 | `TALLY_BRIDGE_KEY` not set on the **server** |
| Every call returns 401 | The two keys don't match |
| `Tally unreachable` | Tally closed, gateway off, or wrong port |
| `Tally reports no open company` | Tally is running but no company is loaded |
| Chip green, but nothing posts | `TALLY_POST_ENABLED` is not `true` on the server |
