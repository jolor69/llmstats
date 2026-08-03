# llmstats

LLM usage stats dashboard + Telegram bot for Neulab's OpenRouter spend, per PRD-openrouter-stats.md.

## Layout

```
shared/              OpenRouter client, multi-account config parsing, Telegram sender, formatting — imported by all 3 Workers
d1/schema.sql         D1 schema (key_snapshots, account_snapshots, telegram_config) — fresh installs
d1/migrations/        Incremental migrations applied against the already-deployed DB
workers/poller/       Worker A — cron every 15min, polls OpenRouter, writes D1, fires low-balance alerts
workers/api/          Worker B — read-only JSON API for the dashboard (X-API-Key gated)
workers/telegram/     Worker C — Telegram webhook + daily summary cron
dashboard/            Cloudflare Pages static site + a Pages Function proxy at /api/*
```

The dashboard's `functions/api/[[path]].ts` proxies same-origin `/api/*` calls to Worker B and injects
the `X-API-Key` header server-side, so the shared secret never reaches the browser.

## One-time setup (you do this — needs your real credentials)

1. **D1 database**
   ```
   wrangler d1 create llmstats-db
   ```
   Copy the returned `database_id` into all three `d1_databases` blocks (`workers/poller/wrangler.jsonc`,
   `workers/api/wrangler.jsonc`, `workers/telegram/wrangler.jsonc`).

   Apply schema:
   ```
   wrangler d1 execute llmstats-db --remote --file=d1/schema.sql
   ```

2. **account_id** — replace `REPLACE_WITH_ai.neulab.inc_ACCOUNT_ID` in the four `wrangler.jsonc` files
   (poller, api, telegram, dashboard) with your `ai.neulab.inc` Cloudflare account ID
   (`wrangler whoami` or the dashboard URL shows it).

3. **telegram_config row** — insert your authorized chat ID and threshold once the schema is applied:
   ```
   wrangler d1 execute llmstats-db --remote --command \
     "INSERT INTO telegram_config (id, chat_id, daily_alert_hour_utc, low_balance_threshold, enabled) VALUES (1, '<YOUR_CHAT_ID>', 0, 2.0, 1)"
   ```
   (`daily_alert_hour_utc` is informational only — the actual push time is the Worker C cron below.)

4. **Secrets** (per Worker, `wrangler secret put <NAME>` from inside each `workers/*` dir):
   - `workers/poller`: `OPENROUTER_ACCOUNTS`, `TELEGRAM_BOT_TOKEN` (for low-balance alerts)
   - `workers/api`: `API_SHARED_SECRET` (pick any long random string)
   - `workers/telegram`: `TELEGRAM_BOT_TOKEN`, `OPENROUTER_ACCOUNTS`

   `OPENROUTER_ACCOUNTS` is a JSON array supporting one or more OpenRouter accounts, each with its own
   Management API key — the system polls all of them and tags every key/balance with which account it
   came from:
   ```json
   [{"name":"neuralstocks.dev","key":"sk-or-v1-..."},{"name":"jolor69","key":"sk-or-v1-..."}]
   ```
   Add a new account later by re-running `wrangler secret put OPENROUTER_ACCOUNTS` with an updated array
   on both `workers/poller` and `workers/telegram`, then redeploying both.

5. **Deploy the three Workers**
   ```
   npm run deploy:poller
   npm run deploy:api
   npm run deploy:telegram
   ```
   Note the `*.workers.dev` URL printed for `llmstats-api` — you need it in step 7.

6. **Register the Telegram webhook** (one-time, after `workers/telegram` is deployed):
   ```
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://llmstats-telegram.<subdomain>.workers.dev"
   ```

7. **Dashboard (Pages)**
   - In `dashboard/functions/api/[[path]].ts`'s Pages project settings, set env vars:
     - `API_BASE_URL` = the `llmstats-api` Worker URL from step 5
     - `API_SHARED_SECRET` = same value as Worker B's secret in step 4
   - Deploy:
     ```
     cd dashboard && wrangler pages deploy public --project-name=llmstats-dashboard
     ```
   - Attach custom domain `llmstats.neulab.xyz` to the Pages project in the Cloudflare dashboard.

## Decisions locked in (see PRD section 13)

- Cloudflare account: `ai.neulab.inc`
- Display timezone: Asia/Singapore (storage stays UTC)
- Low-balance alert threshold: $2
- Worker B auth: shared-secret header (`X-API-Key`), proxied server-side by the Pages Function
- Domain: `llmstats.neulab.xyz`
