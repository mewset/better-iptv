import { invoke } from '@tauri-apps/api/core';
import type { Channel, Playlist, SeriesInfo, MergeResult, UpdateInfo } from '../types';

// ========== MPV Commands ==========

export async function checkMpvInstalled(): Promise<boolean> {
  return await invoke('check_mpv_installed');
}

export async function playChannel(channel: Channel): Promise<void> {
  await invoke('play_channel', { channel });
}

export async function stopPlayback(): Promise<void> {
  await invoke('stop_playback');
}

export async function isPlaying(): Promise<boolean> {
  return await invoke('is_playing');
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

export async function getChannels(playlistId?: number): Promise<Channel[]> {
  return await invoke('get_channels', { playlistId });
}

export async function toggleFavorite(channelId: number): Promise<void> {
  await invoke('toggle_favorite', { channelId });
}

export async function getFavorites(): Promise<Channel[]> {
  return await invoke('get_favorites');
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

export async function fetchEpgData(epgUrl: string): Promise<number> {
  return await invoke('fetch_epg_data', { epgUrl });
}

export async function getChannelEpg(channelEpgId: string): Promise<[string | null, string | null]> {
  return await invoke('get_channel_epg', { channelEpgId });
}

export interface ChannelEpg {
  current: string | null;
  current_start: string | null;
  current_end: string | null;
  next: string | null;
  next_start: string | null;
}

/** Current/next programme for many channels in one IPC call (max 500 ids). */
export async function getChannelsEpg(epgIds: string[]): Promise<Record<string, ChannelEpg>> {
  return await invoke('get_channels_epg', { epgIds });
}

export interface GuideProgram {
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
}

/**
 * Programmes for many channels within a time window (max 100 ids, max 48h
 * span). `from`/`to` are RFC 3339 strings; every requested id is a key in
 * the result, with an empty array when it has no programmes in the window.
 */
export async function getGuide(
  epgIds: string[],
  from: string,
  to: string
): Promise<Record<string, GuideProgram[]>> {
  return await invoke('get_guide', { epgIds, from, to });
}

export interface EpgStatus {
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

export async function getEpgStatus(): Promise<EpgStatus> {
  return await invoke('get_epg_status');
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
