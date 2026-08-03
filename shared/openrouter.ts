export interface OpenRouterKeyRow {
  label: string;
  hash: string;
  usage: number;
  limit: number | null;
  disabled: boolean;
}

export interface OpenRouterCredits {
  total_credits: number;
  total_usage: number;
}

const BASE_URL = "https://openrouter.ai/api/v1";

export async function fetchAllKeys(managementKey: string): Promise<OpenRouterKeyRow[]> {
  const rows: OpenRouterKeyRow[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(`${BASE_URL}/keys?offset=${offset}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${managementKey}` },
    });
    if (!res.ok) {
      throw new Error(`OpenRouter /keys failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data: any[] };
    const page = body.data ?? [];
    for (const k of page) {
      rows.push({
        // OpenRouter's `name` field is the human label (e.g. "irama"); `label` is a masked
        // version of the key string itself and is always present, so it must not be preferred.
        label: k.name ?? k.label ?? "unlabeled",
        hash: k.hash,
        usage: k.usage ?? 0,
        limit: k.limit ?? null,
        disabled: !!k.disabled,
      });
    }
    if (page.length < limit) break;
    offset += limit;
  }

  return rows;
}

export interface OpenRouterActivityItem {
  date: string;
  model: string;
  provider_name: string;
  usage: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
}

/**
 * GET /api/v1/activity — usage grouped by model for the last 30 completed UTC days.
 * Requires a Management key. `apiKeyHash` scopes it to a single key (SHA-256 hex, as
 * returned by /keys); omit to get account-wide activity.
 */
export async function fetchActivity(
  managementKey: string,
  opts: { apiKeyHash?: string; date?: string } = {}
): Promise<OpenRouterActivityItem[]> {
  const params = new URLSearchParams();
  if (opts.apiKeyHash) params.set("api_key_hash", opts.apiKeyHash);
  if (opts.date) params.set("date", opts.date);

  const res = await fetch(`${BASE_URL}/activity?${params.toString()}`, {
    headers: { Authorization: `Bearer ${managementKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /activity failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: OpenRouterActivityItem[] };
  return body.data ?? [];
}

export async function fetchCredits(managementKey: string): Promise<OpenRouterCredits> {
  const res = await fetch(`${BASE_URL}/credits`, {
    headers: { Authorization: `Bearer ${managementKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /credits failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: OpenRouterCredits };
  return body.data;
}
