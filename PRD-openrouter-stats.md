# PRD: LLM Usage Stats Dashboard + Telegram Bot

**Project codename:** llmstats (internal), domain `openrouterstats.neulab.xyz`
**Owner:** Neulab (Eri Adrian)
**Stack:** Cloudflare Workers + D1 + Cron Triggers + Cloudflare Pages, Telegram Bot API, OpenRouter Management API

---

## 1. Problem

Neulab runs 13+ products, each with its own dedicated OpenRouter API key. There is currently no single place to see live spend/usage per app, no historical trend, and no proactive alert if account credit balance runs low. OpenRouter's own dashboard only shows aggregate account activity, not a Neulab-branded per-app breakdown, and has no push-alert mechanism.

## 2. Goals

1. A web dashboard at `openrouterstats.neulab.xyz` showing, per app: current usage, per-key limit (if set), spend trend over time, and account-wide total balance/used.
2. A Telegram bot that can be queried on-demand for balance/usage/per-key stats, and that pushes a daily summary automatically.
3. Single source of truth for "am I about to run out of OpenRouter credit."

## 3. Non-goals

- Not replacing OpenRouter's own dashboard for debugging individual requests (no per-request/per-model log — see constraint below).
- Not a billing/invoicing system.
- Not multi-user — single operator (Neulab), single authorized Telegram chat ID.

## 4. Key constraint (read this before building)

OpenRouter's public API does **not** expose a per-request historical activity log. The only usage signals available are point-in-time snapshots:

- `GET /api/v1/keys` (requires a **Management API key**, not a regular key) — lists all API keys on the account, each with `label`/`name`, `limit`, `usage` (cumulative), `disabled`.
- `GET /api/v1/credits` (requires the Management key or any account key) — account-level total credits purchased vs. total used.
- `GET /api/v1/key` — same info as one row of `/api/v1/keys`, but scoped to whichever key authenticates the call (not needed if using Management API — kept here for reference only).

**Implication:** "live" and "trend" in this product are built entirely by polling these snapshot endpoints on a schedule and diffing against our own stored history in D1. There is no way to get OpenRouter to hand us a ledger of what happened between two points in time — we reconstruct it ourselves via `usage_at_T2 - usage_at_T1`.

## 5. Credentials model (security-critical)

- Create **one** OpenRouter Management API key (openrouter.ai/settings/management-keys). This key can list/manage key metadata but **cannot** make inference calls — leaking it is low blast-radius.
- Do **NOT** copy any of the 13 product API keys into this project. The Worker only ever needs the Management key.
- Confirm each of the 13 existing product keys has a clear `label` in the OpenRouter dashboard matching its app name (e.g. `irama`, `wandr`, `applyedge`, `neural-stocks`, `case-file`, `indolearn`, `linkdeck`, `visapath`, `racketfit`, `doublefit`, `waveshift`, `digitdestiny`, `neutok`, `nutriscan`). This label is the only mapping between an OpenRouter key and "which app is this." If any key is unlabeled or ambiguously labeled, fix that in the OpenRouter dashboard before writing any code — this is a 5-minute task that the entire rest of the project depends on.

## 6. Architecture

```
Cloudflare account: (recommend ai.neulab.inc, matches MCP/DNS scope)

Worker A: llmstats-poller
  - Cron Trigger, every 15 min
  - Calls GET /api/v1/keys (paginate via offset if >100 keys — not expected yet)
  - Calls GET /api/v1/credits
  - Writes one row per key + one account row into D1 (see schema)

Worker B: llmstats-api
  - HTTP API consumed by the dashboard frontend
  - Reads from D1 only (never calls OpenRouter directly — keeps dashboard fast and avoids rate-limit risk)
  - Endpoints: /api/apps, /api/apps/:label/history, /api/account

Worker C: llmstats-telegram
  - Telegram webhook handler
  - Commands read from D1 (fast, ~15 min max staleness) EXCEPT /balance, which calls
    GET /api/v1/credits live, since balance is the one number where staleness is unacceptable
  - Separate Cron Trigger (daily, fixed time e.g. 08:00 Asia/Singapore) pushes summary
    proactively to the authorized chat ID

Pages: llmstats-dashboard
  - Static frontend calling Worker B
  - Custom domain: openrouterstats.neulab.xyz
```

Rationale for splitting poller / api / telegram into three Workers rather than one monolith: the poller must run reliably on cron regardless of dashboard or Telegram traffic; keeping the Telegram webhook isolated means a bug in bot command parsing can't take down the dashboard API, and vice versa. This is a small project so the split costs little and buys isolation.

## 7. D1 schema

```sql
CREATE TABLE key_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_label TEXT NOT NULL,
  key_hash TEXT NOT NULL,        -- OpenRouter's key identifier, for stable joins if label ever changes
  usage REAL NOT NULL,           -- cumulative usage in credits (USD) as reported by OpenRouter
  limit_value REAL,              -- nullable, per-key limit if set
  disabled INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL       -- ISO 8601 UTC
);
CREATE INDEX idx_key_snapshots_label_time ON key_snapshots (key_label, fetched_at);

CREATE TABLE account_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  total_credits REAL NOT NULL,   -- total purchased
  total_usage REAL NOT NULL,     -- total used
  balance REAL NOT NULL,         -- derived: total_credits - total_usage
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_account_snapshots_time ON account_snapshots (fetched_at);

CREATE TABLE telegram_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- single row, single operator
  chat_id TEXT NOT NULL,
  daily_alert_hour_utc INTEGER NOT NULL DEFAULT 0,  -- store in UTC, convert for display only
  low_balance_threshold REAL NOT NULL DEFAULT 10.0,
  enabled INTEGER NOT NULL DEFAULT 1
);
```

Notes:
- Store all timestamps in UTC in D1; convert to Asia/Singapore (or whatever Neulab's local TZ is) only at display/formatting time, in the dashboard and bot.
- `key_hash` (not just label) is the real join key — labels are human-editable and could theoretically change; hash should not.
- Spend-since-last-snapshot ("delta") is always computed at read time as `usage_at_T - usage_at_T-1` for the same `key_hash`, never stored — storing it would create a second source of truth that can drift from the raw snapshots.

## 8. Worker A: llmstats-poller

- Trigger: Cron `*/15 * * * *`
- Secrets: `OPENROUTER_MANAGEMENT_KEY`
- Logic:
  1. `GET https://openrouter.ai/api/v1/keys` with Management key, paginate with `offset` until response has fewer than 100 rows
  2. For each key: insert row into `key_snapshots`
  3. `GET https://openrouter.ai/api/v1/credits`
  4. Insert row into `account_snapshots`
  5. If `balance < telegram_config.low_balance_threshold` AND no alert already sent in the last 6 hours (track via a KV flag or a `last_low_balance_alert_at` column — add this to `telegram_config` if you want threshold alerts, separate from the daily push), fire an immediate Telegram message via Worker C's send function (or duplicate the minimal send logic here to avoid a cross-Worker call — your call, but duplicating ~10 lines is simpler than a service binding for a project this size)
- Error handling: if OpenRouter API call fails (5xx, timeout), log and skip this cycle — do not write partial/garbage snapshots. Next cron run 15 min later will catch up. No need for retry logic at this scale.

## 9. Worker B: llmstats-api

Read-only JSON API, no auth needed if you're comfortable with the domain being unlisted/obscure; otherwise gate behind a simple shared-secret header checked against a Worker secret, since this data is your company's cost structure.

- `GET /api/apps` → latest snapshot per `key_label`, plus 24h delta (join against the snapshot closest to now-24h)
- `GET /api/apps/:label/history?days=7` → time series of `usage` for charting
- `GET /api/account` → latest `account_snapshots` row + 24h delta

## 10. Worker C: llmstats-telegram

- Telegram webhook URL registered via `setWebhook` (one-time setup, done manually or via a small bash/curl step — not part of the Worker itself)
- Secrets: `TELEGRAM_BOT_TOKEN`, `OPENROUTER_MANAGEMENT_KEY` (needed for the live `/balance` call only)
- **Authorization check on every incoming update: reject/ignore any message where `chat.id` does not match `telegram_config.chat_id`.** This is not optional — without it, anyone who finds the bot username can query your company's spend data.
- Commands:
  - `/balance` — live call to `GET /api/v1/credits`, reply with balance, total used, total purchased
  - `/keys` — latest `key_snapshots` per label, one line each: `label: $usage / $limit (or "no limit")`
  - `/key <name>` — fuzzy match `key_label` (simple `LIKE '%name%'`), reply with usage/limit/disabled + 24h delta
  - `/total` — latest `account_snapshots.total_usage`
  - `/top` — top 3 `key_label` by 24h delta, descending
  - `/help` — list commands
- Daily push: separate Cron Trigger (e.g. `0 0 * * *` UTC, adjust for desired local send time), reads `telegram_config.enabled` and `chat_id`, sends: current balance, yesterday's total account delta, top spender of the day
- Threshold alert (optional, from section 8): triggered by the poller, not this Worker's cron — Worker C just needs a reusable `sendTelegramMessage(chatId, text)` function importable by both if you split it into a shared module, or duplicated if not

## 11. Dashboard (Pages)

- Static site, calls Worker B endpoints client-side
- Sections:
  - Header: account balance (large number), total used, last-updated timestamp
  - Grid of app cards: label, current usage, limit (or "unlimited"), 24h delta, disabled-state badge if applicable
  - Click into an app card → line chart of usage over selected range (7/30/90 days) using the `/history` endpoint
- No auth requirement specified by you — if this ever needs to be shared beyond you, add basic auth (Cloudflare Access is the simplest option on a Cloudflare-native stack, zero code required) rather than building your own login

## 12. Domain / naming decision (flagging again, your call)

`openrouterstats.neulab.xyz` implies OpenRouter affiliation you don't have. Not a hard blocker, but if you want to avoid any brand-confusion risk, `llmstats.neulab.xyz` or `usage.neulab.xyz` is cleaner. Proceeding with your stated domain below unless you want to change it — flag to Claude Code explicitly which one to wire up.

## 13. Open decisions Claude Code should confirm with you before/while building

- [ ] Confirm all 13 OpenRouter key labels are set and unambiguous (Section 5) — do this manually first, it's outside the code
- [ ] Confirm Cloudflare account to deploy under (recommend `ai.neulab.inc`, matches your DNS/MCP scope pattern)
- [ ] Confirm local timezone for daily alert display (poller/D1 stays UTC regardless)
- [ ] Confirm low-balance threshold default ($10 used as placeholder above)
- [ ] Confirm whether Worker B needs a shared-secret header or can stay open given an obscure domain
- [ ] Final domain: `openrouterstats.neulab.xyz` as requested, or a renamed alternative

## 14. Explicitly out of scope for v1

- Per-model or per-request cost breakdown (not available from OpenRouter's API at all — would require you to route every app's calls through your own logging proxy instead of hitting OpenRouter directly, which is a materially bigger project; not requested, not included)
- Multi-user access / roles
- Editing OpenRouter key limits from this dashboard (read-only tool, not a management console — the Management API *can* do writes, but that's a different, riskier feature not asked for here)
