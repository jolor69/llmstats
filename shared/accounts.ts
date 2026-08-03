export interface OpenRouterAccountConfig {
  name: string;
  managementKey: string;
}

/**
 * OPENROUTER_ACCOUNTS secret is a JSON array: [{"name":"neuralstocks.dev","key":"sk-or-..."}, ...]
 * `name` is a short human label for the OpenRouter account (not the app) — shown in the
 * dashboard/bot to disambiguate which account a key/balance belongs to.
 */
export function parseAccounts(raw: string): OpenRouterAccountConfig[] {
  const parsed = JSON.parse(raw) as { name: string; key: string }[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("OPENROUTER_ACCOUNTS must be a non-empty JSON array of {name, key}");
  }
  return parsed.map((a) => ({ name: a.name, managementKey: a.key }));
}
