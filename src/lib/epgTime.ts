/**
 * The app's one clock format: two-digit hours 0-23 and minutes, in the
 * user's locale, also where the locale writes 12-hour times. `hourCycle`
 * is the documented control for that; `hour12: false` leaves the cycle to
 * the engine, which may pick h24 and show midnight as 24:00.
 */
const CLOCK_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};

const clocks = new Map<string, Intl.DateTimeFormat>();

function clockFor(locale: string | undefined): Intl.DateTimeFormat {
  const id = locale ?? '';
  let format = clocks.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, CLOCK_OPTIONS);
    clocks.set(id, format);
  }
  return format;
}

/** Local HH:MM for a time in epoch ms; `locale` defaults to the user's. */
export function formatClockAt(t: number, locale?: string): string {
  return clockFor(locale).format(t);
}

/** Local HH:MM for an RFC 3339 time, or '' when it cannot be parsed. */
export function formatClock(iso: string, locale?: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : formatClockAt(t, locale);
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
