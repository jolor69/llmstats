import { fetchCredits } from "../../../shared/openrouter";
import { parseAccounts } from "../../../shared/accounts";
import { formatLocal, usd } from "../../../shared/format";
import type { Env } from "./index";

interface LatestKeyRow {
  account_name: string;
  key_label: string;
  key_hash: string;
  usage: number;
  limit_value: number | null;
  disabled: number;
  fetched_at: string;
}

async function latestPerKey(db: D1Database): Promise<LatestKeyRow[]> {
  const res = await db
    .prepare(
      `SELECT ks.account_name, ks.key_label, ks.key_hash, ks.usage, ks.limit_value, ks.disabled, ks.fetched_at
       FROM key_snapshots ks
       INNER JOIN (
         SELECT account_name, key_hash, MAX(fetched_at) AS max_fetched_at
         FROM key_snapshots
         GROUP BY account_name, key_hash
       ) latest ON ks.account_name = latest.account_name
                AND ks.key_hash = latest.key_hash
                AND ks.fetched_at = latest.max_fetched_at
       ORDER BY ks.key_label ASC`
    )
    .all<LatestKeyRow>();
  return res.results ?? [];
}

async function delta24h(db: D1Database, keyHash: string): Promise<number | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const current = await db
    .prepare(`SELECT usage FROM key_snapshots WHERE key_hash = ? ORDER BY fetched_at DESC LIMIT 1`)
    .bind(keyHash)
    .first<{ usage: number }>();
  const prior = await db
    .prepare(
      `SELECT usage FROM key_snapshots WHERE key_hash = ? AND fetched_at <= ? ORDER BY fetched_at DESC LIMIT 1`
    )
    .bind(keyHash, cutoff)
    .first<{ usage: number }>();
  if (!current) return null;
  return prior ? current.usage - prior.usage : null;
}

export async function handleCommand(text: string, env: Env): Promise<string> {
  const [cmd, ...rest] = text.trim().split(/\s+/);

  switch (cmd) {
    case "/balance":
      return cmdBalance(env);
    case "/keys":
      return cmdKeys(env);
    case "/key":
      return cmdKey(env, rest.join(" "));
    case "/total":
      return cmdTotal(env);
    case "/top":
      return cmdTop(env);
    case "/help":
    case "/start":
      return cmdHelp();
    default:
      return `Unknown command: ${cmd}\n\n${cmdHelp()}`;
  }
}

async function cmdBalance(env: Env): Promise<string> {
  try {
    const accounts = parseAccounts(env.OPENROUTER_ACCOUNTS);
    const results = await Promise.all(
      accounts.map(async (a) => ({ name: a.name, credits: await fetchCredits(a.managementKey) }))
    );

    const lines = results.map(
      ({ name, credits }) =>
        `<b>${name}</b>: ${usd(credits.total_credits - credits.total_usage)} balance ` +
        `(${usd(credits.total_usage)} used / ${usd(credits.total_credits)} purchased)`
    );

    const totalBalance = results.reduce((s, r) => s + (r.credits.total_credits - r.credits.total_usage), 0);

    return `<b>Balance (live)</b>\n${lines.join("\n")}\n\n<b>Combined balance: ${usd(totalBalance)}</b>`;
  } catch (err) {
    console.error(err);
    return "Failed to fetch live balance from OpenRouter. Try again shortly.";
  }
}

async function cmdKeys(env: Env): Promise<string> {
  const rows = await latestPerKey(env.DB);
  if (rows.length === 0) return "No key snapshots yet — poller hasn't run.";
  const lines = rows.map((r) => {
    const limit = r.limit_value != null ? usd(r.limit_value) : "no limit";
    const disabledTag = r.disabled ? " [DISABLED]" : "";
    return `${r.key_label} [${r.account_name}]: ${usd(r.usage)} / ${limit}${disabledTag}`;
  });
  return `<b>Keys</b>\n${lines.join("\n")}`;
}

async function cmdKey(env: Env, name: string): Promise<string> {
  if (!name) return "Usage: /key <name>";
  const rows = await latestPerKey(env.DB);
  const matches = rows.filter((r) => r.key_label.toLowerCase().includes(name.toLowerCase()));
  if (matches.length === 0) return `No key matching "${name}"`;

  const blocks = await Promise.all(
    matches.map(async (match) => {
      const delta = await delta24h(env.DB, match.key_hash);
      const limit = match.limit_value != null ? usd(match.limit_value) : "no limit";
      return (
        `<b>${match.key_label}</b> [${match.account_name}]\n` +
        `Usage: ${usd(match.usage)} / ${limit}\n` +
        `Disabled: ${match.disabled ? "yes" : "no"}\n` +
        `24h delta: ${delta != null ? usd(delta) : "n/a"}\n` +
        `Last updated: ${formatLocal(match.fetched_at)}`
      );
    })
  );

  return blocks.join("\n\n");
}

async function cmdTotal(env: Env): Promise<string> {
  const rows = await env.DB.prepare(
    `SELECT acs.account_name, acs.total_usage, acs.fetched_at
     FROM account_snapshots acs
     INNER JOIN (
       SELECT account_name, MAX(fetched_at) AS max_fetched_at FROM account_snapshots GROUP BY account_name
     ) latest ON acs.account_name = latest.account_name AND acs.fetched_at = latest.max_fetched_at`
  ).all<{ account_name: string; total_usage: number; fetched_at: string }>();

  const results = rows.results ?? [];
  if (results.length === 0) return "No account snapshots yet — poller hasn't run.";

  const lines = results.map((r) => `${r.account_name}: ${usd(r.total_usage)}`);
  const combined = results.reduce((s, r) => s + r.total_usage, 0);
  const lastSync = results.reduce((max, r) => (r.fetched_at > max ? r.fetched_at : max), results[0].fetched_at);

  return `<b>Total used</b>\n${lines.join("\n")}\n\nCombined: ${usd(combined)} (as of ${formatLocal(lastSync)})`;
}

async function cmdTop(env: Env): Promise<string> {
  const rows = await latestPerKey(env.DB);
  const withDeltas = await Promise.all(
    rows.map(async (r) => ({
      label: `${r.key_label} [${r.account_name}]`,
      delta: (await delta24h(env.DB, r.key_hash)) ?? 0,
    }))
  );
  const top = withDeltas.sort((a, b) => b.delta - a.delta).slice(0, 3);
  if (top.length === 0) return "No data yet.";
  return `<b>Top spenders (24h)</b>\n${top.map((t, i) => `${i + 1}. ${t.label}: ${usd(t.delta)}`).join("\n")}`;
}

function cmdHelp(): string {
  return (
    `<b>Commands</b>\n` +
    `/balance - live balance per account + combined\n` +
    `/keys - all keys across all accounts, latest usage/limit\n` +
    `/key &lt;name&gt; - detail for one key\n` +
    `/total - total usage per account + combined\n` +
    `/top - top 3 spenders in last 24h\n` +
    `/help - this message`
  );
}
