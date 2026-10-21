import type { NowNext } from './epgIpc';

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
 * When a now/next entry stops describing the present, in epoch ms: the end
 * of its current programme, or for an off-air entry the start of its next
 * one. Null without a usable time.
 */
export function nowNextBoundary(entry: NowNext): number | null {
  const boundary = entry.now ? entry.now.stop : entry.next?.start;
  if (!boundary) return null;
  const t = Date.parse(boundary);
  return Number.isNaN(t) ? null : t;
}

/**
 * Whether a cached now/next entry no longer describes the present: its
 * current programme has ended, or, for an off-air entry, its next
 * programme has begun.
 */
export function isNowNextStale(entry: NowNext, now: number = Date.now()): boolean {
  const boundary = nowNextBoundary(entry);
  return boundary !== null && boundary <= now;
}

/**
 * The entry as cards and the dock show it at `now`: hidden once stale, so an
 * ended programme is never shown as on now while its refetch is on its way.
 */
export function shownNowNext(entry: NowNext | undefined, now: number): NowNext | undefined {
  return entry && isNowNextStale(entry, now) ? undefined : entry;
}

/**
 * A channel card's guide props at `now`: the entry it shows and the rounded
 * progress of the programme on now (null without one). Both change only
 * when the card's output does, so the 30 s clock re-renders only the cards
 * whose progress line moved or whose programme ended.
 */
export function cardEpg(
  entry: NowNext | undefined,
  now: number
): { epg: NowNext | undefined; progress: number | null } {
  const epg = shownNowNext(entry, now);
  const current = epg?.now;
  return { epg, progress: current ? progressPercent(current.start, current.stop, now) : null };
}
