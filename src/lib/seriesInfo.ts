import { getLocalSeriesInfo, getSeriesInfo, getXtreamSeriesId } from './tauri';
import type { Playlist, SeriesInfo } from '../types';

/**
 * A series' seasons and episodes: from the provider for an Xtream profile,
 * from the episodes grouped at import for an M3U one.
 */
export async function fetchSeriesInfo(channelId: number, playlist: Playlist): Promise<SeriesInfo> {
  const { url, xtream_username: username, xtream_password: password } = playlist;
  if (url && username && password) {
    const seriesId = await getXtreamSeriesId(channelId);
    if (seriesId === null) throw new Error('Failed to load series: Invalid URL format');
    return getSeriesInfo(url, username, password, seriesId);
  }
  return getLocalSeriesInfo(channelId);
}
