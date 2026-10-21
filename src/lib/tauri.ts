import { invoke } from '@tauri-apps/api/core';
import type { Channel, Playlist, SeriesInfo, MergeResult, UpdateInfo } from '../types';
import { getEpgStatus } from './epgIpc';

// ========== MPV Commands ==========

export async function checkMpvInstalled(): Promise<boolean> {
  return await invoke('check_mpv_installed');
}

/** Plays a channel by id; the backend looks up its stream URL. */
export async function playChannel(channelId: number): Promise<void> {
  await invoke('play_channel', { channelId });
}

export async function stopPlayback(): Promise<void> {
  await invoke('stop_playback');
}

/** Whether MPV is still playing, and whether it stopped because the stream failed. */
export interface PlaybackStatus {
  playing: boolean;
  failed: boolean;
}

export async function getPlaybackStatus(): Promise<PlaybackStatus> {
  return await invoke('playback_status');
}

// ========== Playlist Commands ==========

export async function importPlaylist(name: string, source: string): Promise<Playlist> {
  return await invoke('import_playlist', { name, source });
}

export async function importXtreamPlaylist(
  name: string,
  serverUrl: string,
  username: string,
  password: string
): Promise<Playlist> {
  return await invoke('import_xtream_playlist', {
    name,
    serverUrl,
    username,
    password,
  });
}

export async function getPlaylists(): Promise<Playlist[]> {
  return await invoke('get_playlists');
}

export async function deletePlaylist(id: number): Promise<void> {
  await invoke('delete_playlist', { id });
}

/**
 * The Xtream subscription expiry for a playlist, RFC 3339, or null.
 *
 * Null covers an M3U playlist, an account with no expiry date, and a provider
 * that could not be reached with nothing stored from an earlier check.
 */
export async function getSubscriptionExpiry(playlistId: number): Promise<string | null> {
  return await invoke('get_subscription_expiry', { playlistId });
}

export async function refreshPlaylist(playlistId: number): Promise<MergeResult> {
  return await invoke('refresh_playlist', { playlistId });
}

export async function getStalePlaylistIds(): Promise<number[]> {
  return await invoke('get_stale_playlist_ids');
}

/**
 * Channel count per playlist, for the profile cards. A playlist with no
 * channels is absent from the map rather than mapped to 0.
 *
 * serde turns the Rust side's `HashMap<i64, i64>` keys into JSON object keys,
 * which are always strings, so the wire payload has string keys even though
 * they are playlist ids; this converts them back to numbers.
 */
export async function getPlaylistChannelCounts(): Promise<Record<number, number>> {
  const raw = await invoke<Record<string, number>>('get_playlist_channel_counts');
  return Object.fromEntries(Object.entries(raw).map(([id, count]) => [Number(id), count]));
}

// ========== Channel Commands ==========

export const LIVE_TYPES = ['live'] as const;
export const LIBRARY_TYPES = ['vod', 'series'] as const;

export async function getChannels(
  playlistId?: number,
  contentTypes?: ReadonlyArray<'live' | 'vod' | 'series'>
): Promise<Channel[]> {
  return await invoke('get_channels', { playlistId, contentTypes });
}

export async function toggleFavorite(channelId: number): Promise<void> {
  await invoke('toggle_favorite', { channelId });
}

export async function getChannelGroups(
  playlistId: number,
  contentType?: string
): Promise<string[]> {
  return await invoke('get_channel_groups', { playlistId, contentType });
}

// ========== Series Commands ==========

export interface PlaylistEpisode {
  id: string;
  title: string;
  extension: string;
}

/** The Xtream series id behind a series row, or null when its URL has none. */
export async function getXtreamSeriesId(channelId: number): Promise<number | null> {
  return await invoke('get_xtream_series_id', { channelId });
}

export async function getSeriesInfo(
  serverUrl: string,
  username: string,
  password: string,
  seriesId: number
): Promise<SeriesInfo> {
  return await invoke('get_series_info', {
    serverUrl,
    username,
    password,
    seriesId,
  });
}

export async function playEpisodeWithSeason(
  serverUrl: string,
  username: string,
  password: string,
  episodes: PlaylistEpisode[]
): Promise<void> {
  return await invoke('play_episode_with_season', {
    serverUrl,
    username,
    password,
    episodes,
  });
}

/** Seasons and episodes of an M3U series (grouped at import, stored locally). */
export async function getLocalSeriesInfo(channelId: number): Promise<SeriesInfo> {
  return await invoke('get_local_series_info', { channelId });
}

/** Queue stored M3U episodes in MPV, in the order given. */
export async function playSeriesEpisodes(episodeIds: number[]): Promise<void> {
  return await invoke('play_series_episodes', { episodeIds });
}

// ========== Settings Commands ==========

export async function getSetting(key: string): Promise<string | null> {
  return await invoke('get_setting', { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  await invoke('set_setting', { key, value });
}

// ========== Profile Management Commands ==========

export async function getActiveProfileId(): Promise<number | null> {
  return await invoke('get_active_profile_id');
}

export async function setActiveProfileId(profileId: number): Promise<void> {
  return await invoke('set_active_profile_id', { profileId });
}

export async function renamePlaylist(playlistId: number, newName: string): Promise<void> {
  return await invoke('rename_playlist', { playlistId, newName });
}

// ========== EPG Commands ==========
//
// The guide's commands live in ./epgIpc. What follows is what the Settings
// EPG tab still uses until it shows the guide sources itself.

export async function fetchEpgData(epgUrl: string): Promise<number> {
  return await invoke('fetch_epg_data', { epgUrl });
}

/** The summary the current Settings EPG tab shows; see `getLegacyEpgStatus`. */
export interface LegacyEpgStatus {
  has_url: boolean;
  last_fetched: string | null;
  program_count: number;
}

export interface EpgRefreshResult {
  success: boolean;
  programs_loaded: number;
  timestamp: string;
  error: string | null;
}

/**
 * The old status summary, derived from the per-source status for the
 * Settings EPG tab until that tab shows the sources itself: whether an
 * enabled source applies, its latest successful download, and the
 * programmes stored for the enabled sources.
 */
export async function getLegacyEpgStatus(): Promise<LegacyEpgStatus> {
  const status = await getEpgStatus();
  const enabled = status.sources.filter((s) => s.enabled);
  let lastFetched: string | null = null;
  for (const source of enabled) {
    const at = source.last_success_at;
    if (at !== null && (lastFetched === null || Date.parse(at) > Date.parse(lastFetched))) {
      lastFetched = at;
    }
  }
  return {
    has_url: enabled.length > 0,
    last_fetched: lastFetched,
    program_count: status.programme_count,
  };
}

export async function forceRefreshEpg(): Promise<EpgRefreshResult> {
  return await invoke('force_refresh_epg');
}

// ========== Parental Controls Commands ==========

export async function setParentalPin(pin: string): Promise<void> {
  return await invoke('set_parental_pin', { pin });
}

export async function verifyParentalPin(pin: string): Promise<boolean> {
  return await invoke('verify_parental_pin', { pin });
}

export async function resetParentalPin(): Promise<void> {
  return await invoke('reset_parental_pin');
}

export async function getBlockedChannels(): Promise<number[]> {
  return await invoke('get_blocked_channels');
}

export async function setBlockedChannels(channelIds: number[]): Promise<void> {
  return await invoke('set_blocked_channels', { channelIds });
}

export interface ParentalSettings {
  enabled: boolean;
  has_pin: boolean;
  auto_detect: boolean;
  blocked_channels: number[];
  blocked_categories: string[];
  unlock_duration: string;
  visibility: 'hide' | 'lock' | 'blur';
}

export async function getParentalSettings(): Promise<ParentalSettings> {
  return await invoke('get_parental_settings');
}

// ========== Update Check ==========

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  return await invoke('check_for_update');
}

// ========== TMDB Commands ==========

export interface TmdbCard {
  channel_id: number;
  tmdb_id: number;
  title: string;
  year: number | null;
  rating: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  genres: string[];
}

export interface TmdbCastMember {
  name: string;
  character: string | null;
  photo_url: string | null;
}

export interface TmdbDetails {
  /** A key resolved and the feature is on. False: provider data only, no "Wrong title?". */
  available: boolean;
  matched: boolean;
  manual: boolean;
  tmdb_id: number | null;
  title: string | null;
  original_title: string | null;
  year: number | null;
  rating: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  overview: string | null;
  runtime_minutes: number | null;
  genres: string[];
  cast: TmdbCastMember[];
  trailer_url: string | null;
}

export interface TmdbEpisode {
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  still_url: string | null;
  runtime_minutes: number | null;
  air_date: string | null;
}

export interface TmdbCandidate {
  tmdb_id: number;
  title: string;
  original_title: string;
  year: number | null;
  poster_url: string | null;
  overview: string | null;
}

export interface TmdbStatus {
  enabled: boolean;
  has_user_key: boolean;
  has_shared_key: boolean;
  user_key_rejected: boolean;
  shared_key_rejected: boolean;
  language: string;
  /** The `tmdb_background_enrich` setting. */
  background_enrich: boolean;
  /** Where the library scan stands; null until one ran this session. */
  background_progress: { done: number; total: number; running: boolean } | null;
}

/** Cached cards for these channels (max 120); misses arrive later as `tmdb-card` events. */
export async function getTmdbCards(channelIds: number[]): Promise<TmdbCard[]> {
  return await invoke('get_tmdb_cards', { channelIds });
}

export async function getTmdbStatus(): Promise<TmdbStatus> {
  return await invoke('get_tmdb_status');
}

/** Resolves when TMDB accepts the key; rejects with TMDB's message otherwise. */
export async function checkTmdbKey(key: string): Promise<void> {
  await invoke('check_tmdb_key', { key });
}

export async function getTmdbDetails(channelId: number): Promise<TmdbDetails> {
  return await invoke('get_tmdb_details', { channelId });
}

export async function getTmdbSeason(channelId: number, season: number): Promise<TmdbEpisode[]> {
  return await invoke('get_tmdb_season', { channelId, season });
}

/** One slide of a Home slideshow; a superset of TmdbCard plus the plot. */
export interface HomeItem {
  channel_id: number;
  tmdb_id: number;
  title: string;
  year: number | null;
  rating: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  genres: string[];
  overview: string | null;
  /** The channel row behind the slide; the backend never sends an item without it. */
  channel: Channel;
}

/** One Home slideshow: a genre of movies or of series. */
export interface HomeRow {
  genre: string;
  content_type: 'vod' | 'series';
  items: HomeItem[];
}

/** The day's Home rows for a profile; empty when the gate is closed. */
export async function getHomeRows(playlistId: number): Promise<HomeRow[]> {
  return await invoke('get_home_rows', { playlistId });
}

/** "Our pick of the day": a trending title in the library, else the best rated. */
export interface HomePick {
  item: HomeItem;
  source: 'trending' | 'top_rated';
}

/** The day's pick for a profile; null when the gate is closed or nothing qualifies. */
export async function getHomePick(playlistId: number): Promise<HomePick | null> {
  return await invoke('get_home_pick', { playlistId });
}

export async function searchTmdb(
  query: string,
  contentType: 'vod' | 'series'
): Promise<TmdbCandidate[]> {
  return await invoke('search_tmdb', { query, contentType });
}

/** `null` records "not on TMDB". */
export async function setTmdbMatch(channelId: number, tmdbId: number | null): Promise<TmdbDetails> {
  return await invoke('set_tmdb_match', { channelId, tmdbId });
}

export async function deleteTmdbCache(): Promise<number> {
  return await invoke('delete_tmdb_cache');
}

// ========== Logo Commands ==========

/**
 * Reports provider logo URLs that failed to load. Returns the iptv-org fallback
 * per channel id. serde sends the HashMap<i64, String> keys as strings, so they
 * are converted back to numbers here.
 */
export async function reportDeadLogos(
  items: Array<{ channelId: number; url: string }>
): Promise<Record<number, string>> {
  const raw = await invoke<Record<string, string>>('report_dead_logos', {
    items: items.map(({ channelId, url }) => ({ channel_id: channelId, url })),
  });
  return Object.fromEntries(Object.entries(raw).map(([id, url]) => [Number(id), url]));
}
