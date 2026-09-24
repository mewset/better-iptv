/**
 * Switch the active profile: tell the backend, load the profile's channels,
 * then update the store. Shared by Settings > Profiles and the top bar's
 * profile switcher so both follow the same order.
 *
 * The store only changes after both backend calls succeed, so a failed
 * switch leaves the previous profile active. The failure is kept in `error`
 * for the caller to show.
 */
import { useCallback, useState } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { setActiveProfileId, getChannels } from '../lib/tauri';
import { logger } from '../lib/logger';
import type { Playlist } from '../types';

export interface ProfileSwitch {
  switchTo: (playlist: Playlist) => Promise<void>;
  error: string | null;
  clearError: () => void;
}

export function useProfileSwitch(): ProfileSwitch {
  const setStoreActiveId = usePlayerStore((s) => s.setActiveProfileId);
  const setCurrentPlaylist = usePlayerStore((s) => s.setCurrentPlaylist);
  const setChannels = usePlayerStore((s) => s.setChannels);
  const [error, setError] = useState<string | null>(null);

  const switchTo = useCallback(
    async (playlist: Playlist) => {
      try {
        logger.info(`Switching to profile: ${playlist.name}`);

        // Set active in backend
        await setActiveProfileId(playlist.id!);

        // Load channels for this playlist
        const channels = await getChannels(playlist.id!);

        // Update frontend state
        setStoreActiveId(playlist.id!);
        setCurrentPlaylist(playlist);
        setChannels(channels);

        logger.info(`Profile switched successfully: ${channels.length} channels loaded`);
      } catch (err) {
        logger.error('Failed to switch profile:', err);
        setError(`Failed to switch profile: ${err}`);
      }
    },
    [setStoreActiveId, setCurrentPlaylist, setChannels]
  );

  const clearError = useCallback(() => setError(null), []);

  return { switchTo, error, clearError };
}
