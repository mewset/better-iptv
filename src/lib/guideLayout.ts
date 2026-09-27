import type { Channel } from '../types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The guide asks the backend for at most this many channels (its limit too). */
export const GUIDE_CHANNEL_CAP = 100;

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
 * The guide's rows: the first 100 channels with a non-blank `epg_id`. The
 * backend rejects a request with any blank id, so a blank one never gets
 * this far.
 */
export function guideChannels(channels: Channel[]): Channel[] {
  const rows: Channel[] = [];
  for (const channel of channels) {
    if (!channel.epg_id?.trim()) continue;
    rows.push(channel);
    if (rows.length === GUIDE_CHANNEL_CAP) break;
  }
  return rows;
}
