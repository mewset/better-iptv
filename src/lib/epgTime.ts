const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Local HH:MM for an RFC 3339 time, or '' when it cannot be parsed. */
export function formatClock(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : clock.format(t);
}

/** Percent of the programme that has aired, 0..100, or null without usable times. */
export function progressPercent(
  startIso: string,
  endIso: string,
  now: number = Date.now()
): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return Math.min(100, Math.max(0, Math.round(((now - start) / (end - start)) * 100)));
}

/** Whole minutes until the end, rounded up, never negative; null without a usable time. */
export function minutesLeft(endIso: string, now: number = Date.now()): number | null {
  const end = Date.parse(endIso);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now) / 60000));
}

/**
 * Whether a cached EPG entry no longer describes the present: its current
 * programme has ended, or, for an off-air entry, its next programme has begun.
 */
export function isEpgEntryStale(
  entry: { current?: string; currentEnd?: string; next?: string; nextStart?: string },
  now: number = Date.now()
): boolean {
  const boundary = entry.current ? entry.currentEnd : entry.nextStart;
  if (!boundary) return false;
  const t = Date.parse(boundary);
  return !Number.isNaN(t) && t <= now;
}
