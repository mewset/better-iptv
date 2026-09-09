// Re-export error types
export * from './errors';

export interface Playlist {
  id?: number;
  name: string;
  url?: string;
  file_path?: string;
  last_updated?: string;
  auto_refresh: boolean;
  created_at?: string;
  // Xtream credentials (stored for series lookups)
  xtream_username?: string;
  xtream_password?: string;
}

/**
 * Channel data input (before creation, without id)
 */
export interface ChannelInput {
  playlist_id: number;
  name: string;
  url: string;
  logo?: string;
  group_name?: string;
  epg_id?: string;
  tvg_name?: string;
  content_type: 'live' | 'vod' | 'series';
  is_favorite: boolean;
  sort_order: number;
}

/**
 * Channel with required id (after creation/from database)
 */
export interface Channel extends ChannelInput {
  id: number;
  created_at?: string;
}

export interface AppSettings {
  theme: 'light' | 'dark';
  volume: number;
  quality: 'auto' | '1080p' | '720p' | '480p';
}

export interface XtreamCredentials {
  server_url: string;
  username: string;
  password: string;
}

export interface SeriesInfo {
  seasons: Season[];
  info: SeriesMetadata;
  episodes: Record<string, Episode[]>;
}

export interface Season {
  id: string;
  name: string;
  season_number: string;
  episode_count: number;
  air_date?: string;
  overview?: string;
  cover?: string;
}

export interface Episode {
  id: string;
  episode_num: number;
  title: string;
  container_extension: string;
  season: number;
  info: EpisodeInfo;
}

export interface EpisodeInfo {
  plot?: string;
  movie_image?: string;
  releaseDate?: string;
  duration?: string;
  rating?: number;
}

export interface MergeResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

export interface SeriesMetadata {
  name: string;
  cover?: string;
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  releaseDate?: string;
  rating?: string;
  backdrop_path?: string[];
}

/** A GitHub release newer than the running app. */
export interface UpdateInfo {
  version: string;
  url: string;
}
