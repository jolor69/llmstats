const DISPLAY_TZ = "Asia/Singapore";

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatLocal(isoUtc: string): string {
  return new Date(isoUtc).toLocaleString("en-SG", {
    timeZone: DISPLAY_TZ,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
