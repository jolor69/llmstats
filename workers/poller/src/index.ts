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

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(poll(env));
  },
  async fetch(): Promise<Response> {
    return new Response("llmstats-poller: cron-only worker, no HTTP surface", { status: 404 });
  },
};

async function poll(env: Env): Promise<void> {
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
