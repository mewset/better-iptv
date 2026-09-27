const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** SQLite's CURRENT_TIMESTAMP form: UTC, but with a space and no zone. */
const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * Parses RFC 3339, and SQLite's "YYYY-MM-DD HH:MM:SS" explicitly as UTC -
 * `new Date` would read that form as local time and shift it by the offset.
 */
function parseTimestamp(value: string): Date {
  const sqlite = SQLITE_UTC.exec(value);
  return new Date(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : value);
}

/**
 * Whole local calendar days between an RFC 3339 (or SQLite UTC) instant and now, so 23:50
 * yesterday and 00:10 today are one day apart rather than zero. `null` when
 * `iso` is missing or unparsable.
 */
export function daysSince(iso: string | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;

  const then = parseTimestamp(iso);
  if (Number.isNaN(then.getTime())) return null;

  const dayDiffMs = startOfDay(new Date(now)) - startOfDay(then);
  return Math.round(dayDiffMs / 86_400_000);
}

/**
 * Wording for how long ago a playlist was last refreshed, in whole local
 * calendar days rather than 24-hour spans, so 23:50 yesterday and 00:10
 * today read as "yesterday", not "today".
 */
export function refreshedAgo(iso: string | undefined, now: number = Date.now()): string {
  const days = daysSince(iso, now);
  if (days === null) return '';

  if (days <= 0) return 'Refreshed today';
  if (days === 1) return 'Refreshed yesterday';
  return `Refreshed ${days} days ago`;
}
