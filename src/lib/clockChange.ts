import { formatClockAt } from './epgTime';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The zone's offset at an instant, as `Date.getTimezoneOffset` gives it. */
export type OffsetAt = (t: number) => number;

/** This computer's offset at `t`. */
export const localOffset: OffsetAt = (t) => new Date(t).getTimezoneOffset();

/**
 * The next instant after `from` (epoch ms) at which the clock changes,
 * to the minute: `offsetAt` is sampled once a day for `days` days, and the
 * day it differs on is narrowed down by halving. Null when the offset is
 * the same throughout (a zone without daylight saving time).
 */
export function nextClockChange(
  from: number,
  offsetAt: OffsetAt = localOffset,
  days = 365
): number | null {
  const before = offsetAt(from);
  let lo = from;
  for (let day = 1; day <= days; day++) {
    let hi = from + day * DAY_MS;
    if (offsetAt(hi) === before) {
      lo = hi;
      continue;
    }
    while (hi - lo > MINUTE_MS) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (offsetAt(mid) === before) lo = mid;
      else hi = mid;
    }
    // Changes fall on whole minutes: the minute `hi` is in is the change.
    return hi - (hi % MINUTE_MS);
  }
  return null;
}

/** "20:12 (Europe/Stockholm, CEST)": this computer's clock, its zone and the zone's short name. */
export function describeClock(now: number): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const abbr = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value;
  const names = [zone, abbr && abbr !== zone ? abbr : null].filter(Boolean).join(', ');
  return names ? `${formatClockAt(now)} (${names})` : formatClockAt(now);
}

/** The date of the next clock change in the user's locale, or null when there is none. */
export function nextClockChangeText(now: number, offsetAt: OffsetAt = localOffset): string | null {
  const change = nextClockChange(now, offsetAt);
  if (change === null) return null;
  return new Date(change).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
