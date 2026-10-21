import type { EpgSource, EpgStatus, MatchCounts, TimePolicy } from './epgIpc';
import { formatClockAt } from './epgTime';

// Wording for the Settings EPG tab, kept apart from the components so it
// can be tested without rendering.

/** The time-correction stepper moves in steps of this many minutes. */
export const SHIFT_STEP_MINUTES = 30;
/** The backend's bounds for a shift (−12 h..+14 h). */
export const SHIFT_MIN_MINUTES = -720;
export const SHIFT_MAX_MINUTES = 840;

/** How often the background loop looks for due sources (the backend's poll). */
const AUTO_POLL_MINUTES = 15;

const MINUS = '−';

export function clampShift(minutes: number): number {
  return Math.min(SHIFT_MAX_MINUTES, Math.max(SHIFT_MIN_MINUTES, minutes));
}

export function samePolicy(a: TimePolicy, b: TimePolicy): boolean {
  return a.interpret === b.interpret && a.shift_minutes === b.shift_minutes;
}

/** A shift as the stepper shows it: "none", "−2 h", "+30 min", "+1 h 30 min". */
export function formatShift(minutes: number): string {
  if (minutes === 0) return 'none';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  const parts = [hours ? `${hours} h` : '', rest ? `${rest} min` : ''].filter(Boolean);
  return `${minutes < 0 ? MINUS : '+'}${parts.join(' ')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "A programme the guide lists at 20:00 shows at 18:00" for a shift of −120. */
export function shiftPreview(minutes: number): string {
  const listed = 20 * 60;
  const shown = listed + minutes;
  const day = Math.floor(shown / 1440);
  const wall = ((shown % 1440) + 1440) % 1440;
  const when = day < 0 ? ' the day before' : day > 0 ? ' the next day' : '';
  return `A programme the guide lists at 20:00 shows at ${pad(Math.floor(wall / 60))}:${pad(wall % 60)}${when}`;
}

/**
 * The name a source goes by in Settings. A provider's guide is never shown
 * by its address (it carries the account's password); a URL added by hand
 * is shown as the backend masked it.
 */
export function sourceTitle(source: EpgSource): string {
  switch (source.origin) {
    case 'xtream':
      return "Your provider's guide · signed in with your account";
    case 'm3u_header':
      return 'From the playlist (url-tvg)';
    case 'manual':
      return source.display_url ?? source.label;
  }
}

/** "12 min ago", "3 h ago", "2 days ago"; null without a usable time. */
export function agoText(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const minutes = Math.floor((now - t) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function joined(...parts: Array<string | null>): string {
  return parts.filter(Boolean).join(' ');
}

/** The one status line under a source's name. */
export function statusLine(source: EpgSource, now: number): string {
  if (source.refreshing) return 'Updating…';
  switch (source.last_result) {
    case 'never':
      return 'Never updated';
    case 'ok':
      return `${joined('Updated', agoText(source.last_success_at, now))} · ${count(
        source.programme_count,
        'programme',
        'programmes'
      )}`;
    case 'partial':
      return `${joined(
        'Partial update',
        agoText(source.last_success_at ?? source.last_attempt_at, now)
      )}: the download broke off; programmes read so far were kept`;
    case 'error': {
      const failed = joined('Failed', agoText(source.last_attempt_at, now));
      return source.last_error ? `${failed}: ${source.last_error}` : failed;
    }
  }
}

/**
 * What the last read of the feed could not use, for the status line's
 * tooltip; null when everything was read.
 */
export function statusDetails(source: EpgSource): string | null {
  const lines: string[] = [];
  if (source.unknown_zone_count > 0) {
    const sample = source.unknown_zone_sample ? ` (such as "${source.unknown_zone_sample}")` : '';
    lines.push(
      `${count(source.unknown_zone_count, 'programme time names', 'programme times name')} a time zone the app does not know${sample}. Time correction can fix ${source.unknown_zone_count === 1 ? 'it' : 'them'}.`
    );
  }
  if (source.decode_replacements > 0) {
    lines.push(
      `${count(source.decode_replacements, 'character', 'characters')} in the guide could not be read and ${source.decode_replacements === 1 ? 'was' : 'were'} replaced.`
    );
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * The "Channel matching" line: "1,287 channels matched (1,250 by id,
 * 30 by name, 7 set by hand) · 13,137 channels have an id the guide does
 * not know". Parts that are 0 are left out; with one way of matching only,
 * it is named without brackets. `null` (no guide channel yet) reads
 * "Guide not downloaded yet".
 */
export function matchingText(matches: MatchCounts | null): string {
  if (matches === null) return 'Guide not downloaded yet';
  const byName = matches.by_tvg_name + matches.by_name;
  const ways: Array<[number, string, string]> = [
    [matches.by_id, 'by id', 'by id'],
    [byName, 'by name', 'by name'],
    [matches.manual, 'set by hand', 'by hand'],
  ];
  const used = ways.filter(([n]) => n > 0);
  const total = used.reduce((sum, [n]) => sum + n, 0);
  let matched: string;
  if (total === 0) {
    matched = 'No channel matched';
  } else if (used.length === 1) {
    matched = `${count(total, 'channel', 'channels')} matched ${used[0][2]}`;
  } else {
    const parts = used.map(([n, label]) => `${n.toLocaleString('en-US')} ${label}`);
    matched = `${count(total, 'channel', 'channels')} matched (${parts.join(', ')})`;
  }
  const unknown = matches.unmatched_with_id;
  if (unknown === 0) return matched;
  return `${matched} · ${count(unknown, 'channel has', 'channels have')} an id the guide does not know`;
}

/** The matching line's tooltip: names the guide gives to two channels; null when none. */
export function matchingDetails(matches: MatchCounts | null): string | null {
  const n = matches?.ambiguous_names ?? 0;
  if (n === 0) return null;
  return `${count(n, 'name', 'names')} in the guide ${n === 1 ? 'belongs' : 'belong'} to more than one guide channel and ${n === 1 ? 'matches' : 'match'} no channel.`;
}

/** "Next automatic update around 14:30", or why there is none. */
export function nextUpdateText(status: EpgStatus, now: number): string {
  if (!status.sources.some((s) => s.enabled)) {
    return 'No source is enabled, so nothing is updated automatically';
  }
  const next = status.next_auto_refresh ? Date.parse(status.next_auto_refresh) : NaN;
  if (Number.isNaN(next)) return 'No automatic update is planned';
  if (next <= now) return `Next automatic update within ${AUTO_POLL_MINUTES} minutes`;
  const sameDay = new Date(next).toDateString() === new Date(now).toDateString();
  return `Next automatic update around ${formatClockAt(next)}${sameDay ? '' : ' tomorrow'}`;
}

/** A rejected command's message: the backend's `details`, or the error as text. */
export function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'details' in err) {
    const details = (err as { details: unknown }).details;
    if (typeof details === 'string' && details) return details;
  }
  return String(err);
}
