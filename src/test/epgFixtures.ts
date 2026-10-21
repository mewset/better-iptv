import type { EpgSource, EpgStatus, NowNext, Programme } from '../lib/epgIpc';

/** One guide source in the `get_epg_status` shape; enabled and downloaded unless overridden. */
export function epgSource(overrides: Partial<EpgSource> = {}): EpgSource {
  return {
    id: 1,
    origin: 'xtream',
    playlist_id: 1,
    label: 'Home',
    display_url: null,
    enabled: true,
    priority: 30,
    policy: { interpret: 'as_written', shift_minutes: 0 },
    policy_pending: false,
    last_attempt_at: '2026-10-21T10:00:00+00:00',
    last_success_at: '2026-10-21T10:00:00+00:00',
    last_result: 'ok',
    last_error: null,
    programme_count: 10,
    channel_count: 2,
    unknown_zone_count: 0,
    unknown_zone_sample: null,
    decode_replacements: 0,
    has_cached_feed: true,
    refreshing: false,
    applying: false,
    ...overrides,
  };
}

/**
 * A status with one enabled source, or (`hasSource` false) none: the guide's
 * empty state.
 */
export function epgStatus(hasSource = true, overrides: Partial<EpgStatus> = {}): EpgStatus {
  const sources = hasSource ? [epgSource()] : [];
  return {
    sources,
    programme_count: hasSource ? 10 : 0,
    guide_downloaded: hasSource,
    next_auto_refresh: null,
    matches: null,
    ...overrides,
  };
}

/** A programme from `start` to `stop` (RFC 3339). */
export function programme(
  title: string,
  start: string,
  stop: string,
  description: string | null = null
): Programme {
  return { title, description, start, stop };
}

/** A now/next entry, either part optional. */
export function nowNext(now: Programme | null, next: Programme | null = null): NowNext {
  return { now, next };
}
