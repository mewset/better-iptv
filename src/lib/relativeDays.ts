const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Whole local calendar days between an RFC 3339 instant and now, so 23:50
 * yesterday and 00:10 today are one day apart rather than zero. `null` when
 * `iso` is missing or unparsable.
 */
export function daysSince(iso: string | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;

  const then = new Date(iso);
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
