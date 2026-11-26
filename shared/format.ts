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

// Poller runs every 15 min; 4 missed cycles means something is wrong.
const STALE_AFTER_MS = 60 * 60 * 1000;

function humanAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 120) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Returns a warning line (with trailing blank line) when the newest D1 snapshot is older than
 * STALE_AFTER_MS, else "". Prepend to any message built from D1 snapshots so a dead poller
 * can't silently serve frozen numbers.
 */
export function staleWarning(latestIsoUtc: string | null | undefined, now: number = Date.now()): string {
  if (!latestIsoUtc) return "";
  const age = now - new Date(latestIsoUtc).getTime();
  if (age < STALE_AFTER_MS) return "";
  return (
    `⚠️ <b>Stale data</b> — last poller sync ${humanAge(age)} ago (${formatLocal(latestIsoUtc)}). ` +
    `Figures below may be out of date; /balance is live.\n\n`
  );
}
