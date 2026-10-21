import { invoke } from '@tauri-apps/api/core';

// Types and invoke wrappers for the guide commands (src-tauri/src/commands/epg.rs).
// Fields are snake_case as serde sends them; times are RFC 3339 strings in UTC.

/** One programme. `description` is always null inside a `NowNext`. */
export interface Programme {
  title: string;
  description: string | null;
  start: string;
  stop: string;
}

/** What a channel shows now and next; the backend never sends both null. */
export interface NowNext {
  now: Programme | null;
  next: Programme | null;
}

export type SourceOrigin = 'manual' | 'xtream' | 'm3u_header';
export type LastResult = 'ok' | 'partial' | 'error' | 'never';

/** How a source's times are read, then how far they are moved (multiples of 30 min). */
export interface TimePolicy {
  interpret: 'as_written' | 'local_zone';
  shift_minutes: number;
}

/** One guide source as Settings shows it. Built in Rust: no URL here carries credentials. */
export interface EpgSource {
  id: number;
  origin: SourceOrigin;
  playlist_id: number | null;
  label: string;
  display_url: string | null;
  enabled: boolean;
  priority: number;
  policy: TimePolicy;
  policy_pending: boolean;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_result: LastResult;
  last_error: string | null;
  programme_count: number;
  channel_count: number;
  unknown_zone_count: number;
  unknown_zone_sample: string | null;
  decode_replacements: number;
  has_cached_feed: boolean;
  refreshing: boolean;
  /** A re-read under a changed time policy is queued or running. */
  applying: boolean;
}

export interface MatchCounts {
  by_id: number;
  by_tvg_name: number;
  by_name: number;
  manual: number;
  unmatched_with_id: number;
  ambiguous_names: number;
}

/** The guide's status for the active profile (`get_epg_status`, `epg-status`). */
export interface EpgStatus {
  sources: EpgSource[];
  programme_count: number;
  guide_downloaded: boolean;
  next_auto_refresh: string | null;
  matches: MatchCounts | null;
}

/**
 * `match`: a playlist's channels were matched again after an import, refresh
 * or upgrade, or one channel's match was set or cleared by hand.
 */
export type RefreshReason = 'ingest' | 'reingest' | 'source_changed' | 'profile_switch' | 'match';

/** The `epg-refreshed` payload: cached now/next and guide data is stale. */
export interface EpgRefreshed {
  reason: RefreshReason;
  source_id: number | null;
  /** Channels whose guide key the preceding match changed; above 0, re-read the keys. */
  matches_changed: number;
}

/** A guide channel `search_epg_channels` found. */
export interface EpgChannelHit {
  /** The guide key a channel is matched to when this hit is chosen. */
  key: string;
  /** The display name that matched best; null when the feed names the channel nowhere. */
  name: string | null;
  source_id: number;
  /** "Your provider's guide", "From the playlist", or the host of a URL added by hand. */
  source_label: string;
}

/** A live channel matched to a guide channel by hand. */
export interface ManualMatch {
  channel_id: number;
  channel_name: string;
  key: string;
  /** The guide's name for the key; null when it has none or no programmes now. */
  guide_name: string | null;
  /** False once the key has no programmes left: the match stays, the card shows nothing. */
  has_programmes: boolean;
}

/**
 * What the channel list does not carry about a playlist's matches. Every
 * other live channel with an `epg_id` was matched by its id.
 */
export interface MatchDetails {
  /** By channel name. */
  manual: ManualMatch[];
  /** Ids of the channels matched by name. */
  by_name: number[];
}

/** Fields of a source to change; the ones left out stay. `url` only for a URL added by hand. */
export interface EpgSourcePatch {
  enabled?: boolean;
  priority?: number;
  url?: string;
}

/** Event names as the backend emits them. */
export const EPG_REFRESHED_EVENT = 'epg-refreshed';
export const EPG_STATUS_EVENT = 'epg-status';

/** Keys per `get_epg_now_next` request (the backend accepts 500; the grid never needs more). */
export const NOW_NEXT_BATCH = 100;

/** Keys per `get_epg_guide` request (the backend's GUIDE_MAX_IDS). */
export const GUIDE_BATCH = 5000;

/** Hits per `search_epg_channels` request (the backend's maximum). */
export const GUIDE_SEARCH_LIMIT = 50;

/** A shorter `search_epg_channels` query finds nothing (the backend's MIN_QUERY_CHARS). */
export const GUIDE_SEARCH_MIN_CHARS = 2;

/**
 * Now and next per key, keyed as sent; a key the guide has nothing for is
 * left out. At most 500 keys.
 */
export async function getEpgNowNext(keys: string[]): Promise<Record<string, NowNext>> {
  return await invoke('get_epg_now_next', { keys });
}

/**
 * Programmes overlapping `from`-`to` (RFC 3339, at most 48 hours) per key,
 * in start order. Every key sent is in the answer. At most 5,000 keys.
 */
export async function getEpgGuide(
  keys: string[],
  from: string,
  to: string
): Promise<Record<string, Programme[]>> {
  return await invoke('get_epg_guide', { keys, from, to });
}

/**
 * Keys whose stored guide (first start to last stop) touches `from`-`to`
 * (at most seven days). For the guide's five-day range that is the same as
 * "has a programme in it"; for a short range a channel with a gap over the
 * whole range is listed too.
 */
export async function getEpgGuideKeys(from: string, to: string): Promise<string[]> {
  return await invoke('get_epg_guide_keys', { from, to });
}

/**
 * `[channel id, guide key]` of the playlist's live channels that are matched
 * to the guide. A live channel left out has no key.
 */
export async function getChannelEpgKeys(playlistId: number): Promise<Array<[number, string]>> {
  return await invoke('get_channel_epg_keys', { playlistId });
}

/**
 * Match a live channel to a guide key by hand, or with null clear its
 * manual match and match it automatically again. A key without programmes
 * in the channel's profile is refused with `InvalidInput`. A change arrives
 * as `epg-refreshed` (`match`) and `epg-status`.
 */
export async function setChannelEpgMatch(channelId: number, key: string | null): Promise<void> {
  await invoke('set_channel_epg_match', { channelId, key });
}

/**
 * Guide channels of the active profile whose name or key contains `query`,
 * best first, at most `limit` (1 to 50). A query under
 * `GUIDE_SEARCH_MIN_CHARS` characters finds nothing.
 */
export async function searchEpgChannels(
  query: string,
  limit: number = GUIDE_SEARCH_LIMIT
): Promise<EpgChannelHit[]> {
  return await invoke('search_epg_channels', { query, limit });
}

/** The playlist's channels matched by hand, and the ids of those matched by name. */
export async function getChannelMatchDetails(playlistId: number): Promise<MatchDetails> {
  return await invoke('get_channel_match_details', { playlistId });
}

export async function getEpgStatus(): Promise<EpgStatus> {
  return await invoke('get_epg_status');
}

/** Add a guide URL for every profile; its first download starts at once. */
export async function addEpgSource(url: string): Promise<EpgSource> {
  return await invoke('add_epg_source', { url });
}

export async function updateEpgSource(id: number, patch: EpgSourcePatch): Promise<void> {
  await invoke('update_epg_source', { id, patch });
}

/** Remove a URL added by hand, with its programmes. */
export async function removeEpgSource(id: number): Promise<void> {
  await invoke('remove_epg_source', { id });
}

/**
 * Download one source, or every enabled source of the active profile, now.
 * Returns at once; progress arrives as `epg-status` events.
 */
export async function refreshEpg(sourceId: number | null = null): Promise<void> {
  await invoke('refresh_epg', { sourceId });
}

/** Set how a source's times are read. Returns at once; a cached feed is re-read in the background. */
export async function setEpgTimePolicy(sourceId: number, policy: TimePolicy): Promise<void> {
  await invoke('set_epg_time_policy', { sourceId, policy });
}
