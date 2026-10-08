import type { Channel } from '../types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Days the guide offers: today and the next four. */
export const GUIDE_DAY_COUNT = 5;

/**
 * The guide's time window in epoch ms.
 *
 * Today: from local `now` floored to the half hour, minus 30 minutes, for
 * three hours (20:12 -> 19:30-22:30). A later day: 18:00-21:00 local on that
 * day, built from calendar fields so a DST change that day stays correct.
 */
export function guideWindow(now: number, dayOffset: number): { from: number; to: number } {
  if (dayOffset === 0) {
    const d = new Date(now);
    d.setMinutes(d.getMinutes() >= 30 ? 30 : 0, 0, 0);
    const from = d.getTime() - 30 * MINUTE;
    return { from, to: from + 3 * HOUR };
  }
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate() + dayOffset;
  return { from: new Date(y, m, day, 18, 0).getTime(), to: new Date(y, m, day, 21, 0).getTime() };
}

/**
 * Where a programme sits in a track `width` wide showing `from`-`to`,
 * clamped to the window; null when it is entirely outside the window or its
 * times cannot be used.
 */
export function blockGeometry(
  startIso: string,
  endIso: string,
  from: number,
  to: number,
  width: number
): { left: number; width: number } | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start || to <= from) return null;
  if (end <= from || start >= to) return null;
  const span = to - from;
  const clampedStart = Math.max(start, from);
  const clampedEnd = Math.min(end, to);
  return {
    left: ((clampedStart - from) / span) * width,
    width: ((clampedEnd - clampedStart) / span) * width,
  };
}

/**
 * An EPG id in the form the backend stores and returns: trimmed, ASCII
 * lower case (`epg_domain::normalize_epg_id`). Only A-Z is lowered, as in Rust.
 */
export function normalizeEpgId(id: string): string {
  return id.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The span a channel needs programmes in to get a guide row: today 00:00
 * local to the same time `GUIDE_DAY_COUNT` calendar days later. Rows are the
 * same whichever day is shown.
 */
export function guideDataRange(now: number): { from: number; to: number } {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  return {
    from: new Date(y, m, day).getTime(),
    to: new Date(y, m, day + GUIDE_DAY_COUNT).getTime(),
  };
}

/**
 * The guide's rows: the channels whose normalized `epg_id` is in
 * `idsWithData`, in list order. `null` means the lookup is not available
 * (it failed): then every channel with a non-blank `epg_id` gets a row.
 */
export function guideChannels(channels: Channel[], idsWithData: Set<string> | null): Channel[] {
  return channels.filter((channel) => {
    const id = channel.epg_id ? normalizeEpgId(channel.epg_id) : '';
    if (id === '') return false;
    return idsWithData === null || idsWithData.has(id);
  });
}
