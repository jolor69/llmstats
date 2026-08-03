import { sendTelegramMessage } from "../../../shared/telegram";
import { usd } from "../../../shared/format";
import { handleCommand } from "./commands";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  OPENROUTER_ACCOUNTS: string; // JSON: [{"name":"neuralstocks.dev","key":"sk-or-..."}]
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response("ok");

    let update: any;
    try {
      update = await req.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const message = update.message;
    if (!message || typeof message.text !== "string") return new Response("ok");

    const chatId: string = String(message.chat.id);

    const config = await env.DB.prepare(`SELECT chat_id FROM telegram_config WHERE id = 1`).first<{
      chat_id: string;
    }>();

    if (!config || chatId !== config.chat_id) {
      // Unauthorized chat: silently ignore. Do not reveal existence of the bot's data.
      return new Response("ok");
    }

    const reply = await handleCommand(message.text, env);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);

    return new Response("ok");
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDailySummary(env));
  },
};

async function sendDailySummary(env: Env): Promise<void> {
  const config = await env.DB.prepare(
    `SELECT chat_id, enabled FROM telegram_config WHERE id = 1`
  ).first<{ chat_id: string; enabled: number }>();

  if (!config || !config.enabled) return;

  const latestAccounts = await env.DB.prepare(
    `SELECT acs.account_name, acs.total_usage, acs.balance, acs.fetched_at
     FROM account_snapshots acs
     INNER JOIN (
       SELECT account_name, MAX(fetched_at) AS max_fetched_at FROM account_snapshots GROUP BY account_name
     ) latest ON acs.account_name = latest.account_name AND acs.fetched_at = latest.max_fetched_at`
  ).all<{ account_name: string; total_usage: number; balance: number; fetched_at: string }>();

  const accounts = latestAccounts.results ?? [];
  if (accounts.length === 0) {
    console.error("No account snapshots for daily summary, skipping.");
    return;
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const balanceLines: string[] = [];
  let combinedSpend = 0;
  let combinedBalance = 0;

  for (const acc of accounts) {
    const prior = await env.DB.prepare(
      `SELECT total_usage FROM account_snapshots WHERE account_name = ? AND fetched_at <= ? ORDER BY fetched_at DESC LIMIT 1`
    )
      .bind(acc.account_name, cutoff)
      .first<{ total_usage: number }>();

    const spend = prior ? acc.total_usage - prior.total_usage : null;
    if (spend != null) combinedSpend += spend;
    combinedBalance += acc.balance;

    balanceLines.push(`${acc.account_name}: ${usd(acc.balance)} balance, ${spend != null ? usd(spend) : "n/a"} spent`);
  }

  const keyRows = await env.DB.prepare(
    `SELECT ks.key_label, ks.account_name, ks.key_hash, ks.usage
     FROM key_snapshots ks
     INNER JOIN (
       SELECT account_name, key_hash, MAX(fetched_at) AS max_fetched_at
       FROM key_snapshots GROUP BY account_name, key_hash
     ) latest ON ks.account_name = latest.account_name
              AND ks.key_hash = latest.key_hash
              AND ks.fetched_at = latest.max_fetched_at`
  ).all<{ key_label: string; account_name: string; key_hash: string; usage: number }>();

  let topSpender = "n/a";
  let topDelta = -Infinity;
  for (const row of keyRows.results ?? []) {
    const prior = await env.DB.prepare(
      `SELECT usage FROM key_snapshots WHERE key_hash = ? AND fetched_at <= ? ORDER BY fetched_at DESC LIMIT 1`
    )
      .bind(row.key_hash, cutoff)
      .first<{ usage: number }>();
    const d = prior ? row.usage - prior.usage : 0;
    if (d > topDelta) {
      topDelta = d;
      topSpender = `${row.key_label} [${row.account_name}]`;
    }
  }

  const text =
    `<b>Daily summary</b>\n` +
    `${balanceLines.join("\n")}\n\n` +
    `Combined balance: ${usd(combinedBalance)}\n` +
    `Combined spend (24h): ${usd(combinedSpend)}\n` +
    `Top spender: ${topSpender}${topDelta > -Infinity ? ` (${usd(topDelta)})` : ""}`;

  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, config.chat_id, text);
}
