import type { Channel } from '../types';
import type { Programme } from './epgIpc';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Days the guide offers: today and the next four. */
export const GUIDE_DAY_COUNT = 5;

const weekdayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

/**
 * The day chips: "Today", then "Fri 25"-style labels for the next
 * `GUIDE_DAY_COUNT - 1` local calendar days, built from calendar fields so a
 * DST change never repeats or skips a day.
 */
export function guideDayLabels(now: number): string[] {
  const base = new Date(now);
  return Array.from({ length: GUIDE_DAY_COUNT }, (_, i) => {
    if (i === 0) return 'Today';
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    return `${weekdayShort.format(d)} ${d.getDate()}`;
  });
}

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

/** A guide row's lane: 0 holds the main sequence, 1 what overlaps it. */
export type Lane = 0 | 1;

/** A row's programmes placed in lanes, from `layoutLanes`. */
export interface LaneLayout {
  /** Every placed programme with its lane, in start order. */
  blocks: Array<{ programme: Programme; lane: Lane }>;
  /** 2 when any programme sits in lane 1. */
  laneCount: 1 | 2;
  /** Programmes left out because both lanes were taken at their start. */
  dropped: number;
}

/**
 * Places a row's programmes in at most two lanes, so a programme nested in
 * another (a film inside a "movie night" block) is drawn below it instead of
 * on top of it. In start order (the longer of two with one start first),
 * a programme goes to lane 0 unless it starts before the last lane-0
 * programme ends; then to lane 1 unless that is taken too; then it is
 * dropped and counted. A programme starting exactly when another stops
 * follows it in the same lane. Programmes with unusable times are left out
 * uncounted, as `blockGeometry` would draw nothing for them.
 */
export function layoutLanes(programmes: readonly Programme[]): LaneLayout {
  const timed: Array<{ programme: Programme; start: number; stop: number }> = [];
  for (const programme of programmes) {
    const start = Date.parse(programme.start);
    const stop = Date.parse(programme.stop);
    if (Number.isNaN(start) || Number.isNaN(stop) || stop <= start) continue;
    timed.push({ programme, start, stop });
  }
  timed.sort((a, b) => a.start - b.start || b.stop - a.stop);

  const blocks: LaneLayout['blocks'] = [];
  let laneZeroEnd = -Infinity;
  let laneOneEnd = -Infinity;
  let dropped = 0;
  for (const { programme, start, stop } of timed) {
    if (start >= laneZeroEnd) {
      blocks.push({ programme, lane: 0 });
      laneZeroEnd = stop;
    } else if (start >= laneOneEnd) {
      blocks.push({ programme, lane: 1 });
      laneOneEnd = stop;
    } else {
      dropped += 1;
    }
  }
  return { blocks, laneCount: laneOneEnd === -Infinity ? 1 : 2, dropped };
}

/**
 * An EPG id in the form the backend stores and returns: trimmed and lower
 * case with Unicode case mapping (`epg_domain::key::channel_key`). The Rust
 * side trims exactly what `trim()` trims here, so both give one key per id.
 */
export function normalizeEpgId(id: string): string {
  return id.trim().toLowerCase();
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
