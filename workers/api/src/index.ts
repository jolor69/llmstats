import { fetchActivity } from "../../../shared/openrouter";
import { parseAccounts } from "../../../shared/accounts";

export interface Env {
  DB: D1Database;
  API_SHARED_SECRET: string;
  OPENROUTER_ACCOUNTS: string; // JSON: [{"name":"neuralstocks.dev","key":"sk-or-..."}]
}

interface LatestKeyRow {
  account_name: string;
  key_label: string;
  key_hash: string;
  usage: number;
  limit_value: number | null;
  disabled: number;
  fetched_at: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "X-API-Key, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (req.headers.get("X-API-Key") !== env.API_SHARED_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api", "apps"]

    try {
      if (parts[0] !== "api") return json({ error: "not found" }, 404);

      if (parts.length === 2 && parts[1] === "apps") {
        return json(await getApps(env.DB));
      }

      if (parts.length === 4 && parts[1] === "apps" && parts[3] === "history") {
        const days = Number(url.searchParams.get("days") ?? "7");
        return json(await getKeyHistory(env.DB, decodeURIComponent(parts[2]), days));
      }

      if (parts.length === 4 && parts[1] === "apps" && parts[3] === "models") {
        const days = Number(url.searchParams.get("days") ?? "7");
        return json(await getKeyModels(env.DB, env.OPENROUTER_ACCOUNTS, decodeURIComponent(parts[2]), days));
      }

      if (parts.length === 2 && parts[1] === "account") {
        return json(await getAccounts(env.DB));
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function getApps(db: D1Database) {
  // Latest snapshot per (account_name, key_hash), via a self-join on max(fetched_at).
  const latest = await db
    .prepare(
      `SELECT ks.account_name, ks.key_label, ks.key_hash, ks.usage, ks.limit_value, ks.disabled, ks.fetched_at
       FROM key_snapshots ks
       INNER JOIN (
         SELECT account_name, key_hash, MAX(fetched_at) AS max_fetched_at
         FROM key_snapshots
         GROUP BY account_name, key_hash
       ) latest ON ks.account_name = latest.account_name
                AND ks.key_hash = latest.key_hash
                AND ks.fetched_at = latest.max_fetched_at`
    )
    .all<LatestKeyRow>();

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const apps = await Promise.all(
    (latest.results ?? []).map(async (row) => {
      const prior = await db
        .prepare(
          `SELECT usage FROM key_snapshots
           WHERE account_name = ? AND key_hash = ? AND fetched_at <= ?
           ORDER BY fetched_at DESC LIMIT 1`
        )
        .bind(row.account_name, row.key_hash, cutoff)
        .first<{ usage: number }>();

      return {
        account: row.account_name,
        label: row.key_label,
        hash: row.key_hash,
        usage: row.usage,
        limit: row.limit_value,
        disabled: !!row.disabled,
        fetched_at: row.fetched_at,
        delta_24h: prior ? row.usage - prior.usage : null,
      };
    })
  );

  return { apps };
}

async function getKeyHistory(db: D1Database, hash: string, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const points = await db
    .prepare(
      `SELECT usage, fetched_at FROM key_snapshots
       WHERE key_hash = ? AND fetched_at >= ?
       ORDER BY fetched_at ASC`
    )
    .bind(hash, since)
    .all<{ usage: number; fetched_at: string }>();

  const labelRow = await db
    .prepare(`SELECT key_label, account_name FROM key_snapshots WHERE key_hash = ? ORDER BY fetched_at DESC LIMIT 1`)
    .bind(hash)
    .first<{ key_label: string; account_name: string }>();

  return {
    hash,
    label: labelRow?.key_label ?? null,
    account: labelRow?.account_name ?? null,
    days,
    points: points.results ?? [],
  };
}

// OpenRouter's /activity endpoint only ever returns the last 30 completed UTC
// days of per-model rows (each tagged with its own `date`), regardless of query
// params. We can filter that window down (e.g. to 7 days) but never extend it.
const MAX_ACTIVITY_DAYS = 30;

async function getKeyModels(db: D1Database, accountsSecret: string, hash: string, days: number) {
  const labelRow = await db
    .prepare(`SELECT key_label, account_name FROM key_snapshots WHERE key_hash = ? ORDER BY fetched_at DESC LIMIT 1`)
    .bind(hash)
    .first<{ key_label: string; account_name: string }>();

  if (!labelRow) return { hash, label: null, account: null, models: [], days: 0 };

  const accounts = parseAccounts(accountsSecret);
  const account = accounts.find((a) => a.name === labelRow.account_name);
  if (!account) return { hash, label: labelRow.key_label, account: labelRow.account_name, models: [], days: 0 };

  const items = await fetchActivity(account.managementKey, { apiKeyHash: hash });

  const effectiveDays = Math.min(days, MAX_ACTIVITY_DAYS);
  const cutoff = new Date(Date.now() - effectiveDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const windowed = items.filter((item) => item.date >= cutoff);

  const byModel = new Map<string, { usage: number; requests: number; prompt_tokens: number; completion_tokens: number }>();
  for (const item of windowed) {
    const acc = byModel.get(item.model) ?? { usage: 0, requests: 0, prompt_tokens: 0, completion_tokens: 0 };
    acc.usage += item.usage;
    acc.requests += item.requests;
    acc.prompt_tokens += item.prompt_tokens;
    acc.completion_tokens += item.completion_tokens;
    byModel.set(item.model, acc);
  }

  const models = [...byModel.entries()]
    .map(([model, s]) => ({ model, ...s }))
    .sort((a, b) => b.usage - a.usage);

  return { hash, label: labelRow.key_label, account: labelRow.account_name, models, days: effectiveDays };
}

async function getAccounts(db: D1Database) {
  const latestPerAccount = await db
    .prepare(
      `SELECT acs.account_name, acs.total_credits, acs.total_usage, acs.balance, acs.fetched_at
       FROM account_snapshots acs
       INNER JOIN (
         SELECT account_name, MAX(fetched_at) AS max_fetched_at
         FROM account_snapshots GROUP BY account_name
       ) latest ON acs.account_name = latest.account_name AND acs.fetched_at = latest.max_fetched_at`
    )
    .all<{ account_name: string; total_credits: number; total_usage: number; balance: number; fetched_at: string }>();

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const accounts = await Promise.all(
    (latestPerAccount.results ?? []).map(async (row) => {
      const prior = await db
        .prepare(
          `SELECT total_usage FROM account_snapshots
           WHERE account_name = ? AND fetched_at <= ?
           ORDER BY fetched_at DESC LIMIT 1`
        )
        .bind(row.account_name, cutoff)
        .first<{ total_usage: number }>();

      return {
        name: row.account_name,
        total_credits: row.total_credits,
        total_usage: row.total_usage,
        balance: row.balance,
        fetched_at: row.fetched_at,
        delta_24h: prior ? row.total_usage - prior.total_usage : null,
      };
    })
  );

  const aggregate =
    accounts.length === 0
      ? null
      : accounts.reduce(
          (acc, a) => ({
            total_credits: acc.total_credits + a.total_credits,
            total_usage: acc.total_usage + a.total_usage,
            balance: acc.balance + a.balance,
            delta_24h: acc.delta_24h == null || a.delta_24h == null ? null : acc.delta_24h + a.delta_24h,
            fetched_at: acc.fetched_at > a.fetched_at ? acc.fetched_at : a.fetched_at,
          }),
          { total_credits: 0, total_usage: 0, balance: 0, delta_24h: 0 as number | null, fetched_at: "" }
        );

  return { accounts, aggregate };
}
