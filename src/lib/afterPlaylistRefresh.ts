/**
 * What a host of RefreshModal does once a playlist was refreshed: reload the
 * profile list, which carries each profile's refresh date, and the channels
 * if the refreshed profile is the one on screen. Shared by Settings > General
 * and Settings > Profiles, so a refresh from either shows the same result.
 */
import { usePlayerStore } from '../stores/player-store';
import { getChannels, getPlaylists } from './tauri';
import { logger } from './logger';

export async function reloadAfterPlaylistRefresh(playlistId: number): Promise<void> {
  const store = usePlayerStore.getState;

  try {
    store().setPlaylists(await getPlaylists());
  } catch (err) {
    logger.debug('Failed to reload playlists after refresh:', err);
  }

  if (store().currentPlaylist?.id !== playlistId) return;
  try {
    const freshChannels = await getChannels(playlistId);
    // A switch while the fetch was in flight: these are the old profile's channels
    if (store().currentPlaylist?.id !== playlistId) return;
    store().setChannels(freshChannels);
  } catch (err) {
    logger.error('Failed to reload channels after refresh:', err);
  }
}
