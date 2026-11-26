import { fetchAllKeys, fetchCredits } from "../../../shared/openrouter";
import { parseAccounts, type OpenRouterAccountConfig } from "../../../shared/accounts";
import { sendTelegramMessage } from "../../../shared/telegram";
import { nowIso, usd } from "../../../shared/format";

export interface Env {
  DB: D1Database;
  OPENROUTER_ACCOUNTS: string; // JSON: [{"name":"neuralstocks.dev","key":"sk-or-..."}]
  TELEGRAM_BOT_TOKEN?: string;
}

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Snapshot retention. Nothing reads further back than 30 days (dashboard max range,
// OpenRouter /activity cap); "all-time" figures come from OpenRouter's cumulative
// `usage` on the latest snapshot, not from history.
const RETENTION_DAYS = 90;
// Prune once a day, on the first poll cycle of this UTC hour.
const PRUNE_HOUR_UTC = 3;
// Cap rows deleted per table per run so a large backlog is spread over several days
// (each deleted row also deletes its index entries, which count as D1 rows written).
const PRUNE_BATCH_LIMIT = 5000;

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(poll(env, new Date(event.scheduledTime)));
  },
  async fetch(): Promise<Response> {
    return new Response("llmstats-poller: cron-only worker, no HTTP surface", { status: 404 });
  },
};

async function poll(env: Env, scheduledAt: Date): Promise<void> {
  const fetchedAt = nowIso();
  const accounts = parseAccounts(env.OPENROUTER_ACCOUNTS);

  const perAccountBalances: { name: string; balance: number }[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const account of accounts) {
    let keys, credits;
    try {
      [keys, credits] = await Promise.all([
        fetchAllKeys(account.managementKey),
        fetchCredits(account.managementKey),
      ]);
    } catch (err) {
      console.error(`OpenRouter poll failed for account "${account.name}", skipping it this cycle:`, err);
      continue;
    }

    const balance = credits.total_credits - credits.total_usage;
    perAccountBalances.push({ name: account.name, balance });

    for (const k of keys) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO key_snapshots (account_name, key_label, key_hash, usage, limit_value, disabled, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(account.name, k.label, k.hash, k.usage, k.limit, k.disabled ? 1 : 0, fetchedAt)
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO account_snapshots (account_name, total_credits, total_usage, balance, fetched_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(account.name, credits.total_credits, credits.total_usage, balance, fetchedAt)
    );
  }

  if (statements.length === 0) {
    console.error("All configured OpenRouter accounts failed this cycle, skipping D1 write.");
    return;
  }

  await env.DB.batch(statements);
  await maybeFireLowBalanceAlert(env, perAccountBalances, fetchedAt);

  // Only prune after a successful write, so a long poller outage can never age out
  // the last known snapshot and leave the dashboard/bot with no data at all.
  if (scheduledAt.getUTCHours() === PRUNE_HOUR_UTC && scheduledAt.getUTCMinutes() < 15) {
    await pruneOldSnapshots(env, scheduledAt);
  }
}

async function pruneOldSnapshots(env: Env, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const [keys, accounts] = await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM key_snapshots WHERE id IN (SELECT id FROM key_snapshots WHERE fetched_at < ? LIMIT ?)`
      ).bind(cutoff, PRUNE_BATCH_LIMIT),
      env.DB.prepare(
        `DELETE FROM account_snapshots WHERE id IN (SELECT id FROM account_snapshots WHERE fetched_at < ? LIMIT ?)`
      ).bind(cutoff, PRUNE_BATCH_LIMIT),
    ]);
    console.log(
      `Pruned snapshots older than ${cutoff}: ${keys.meta.changes} key rows, ${accounts.meta.changes} account rows`
    );
  } catch (err) {
    console.error("Snapshot prune failed (will retry tomorrow):", err);
  }
}

async function maybeFireLowBalanceAlert(
  env: Env,
  balances: { name: string; balance: number }[],
  fetchedAt: string
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const config = await env.DB.prepare(
    `SELECT chat_id, low_balance_threshold, last_low_balance_alert_at, enabled FROM telegram_config WHERE id = 1`
  ).first<{
    chat_id: string;
    low_balance_threshold: number;
    last_low_balance_alert_at: string | null;
    enabled: number;
  }>();

  if (!config || !config.enabled) return;

  const low = balances.filter((b) => b.balance < config.low_balance_threshold);
  if (low.length === 0) return;

  if (config.last_low_balance_alert_at) {
    const elapsed = Date.now() - new Date(config.last_low_balance_alert_at).getTime();
    if (elapsed < ALERT_COOLDOWN_MS) return;
  }

  const lines = low.map((b) => `${b.name}: ${usd(b.balance)}`).join("\n");

  try {
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      config.chat_id,
      `⚠️ <b>Low OpenRouter balance</b> (threshold: ${usd(config.low_balance_threshold)})\n${lines}`
    );
    await env.DB.prepare(`UPDATE telegram_config SET last_low_balance_alert_at = ? WHERE id = 1`)
      .bind(fetchedAt)
      .run();
  } catch (err) {
    console.error("Failed to send low-balance Telegram alert:", err);
  }
}
