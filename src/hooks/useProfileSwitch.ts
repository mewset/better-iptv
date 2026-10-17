/**
 * Switch the active profile: tell the backend, show the new profile at once,
 * then load its channels in the background. Shared by Settings > Profiles and
 * the top bar's profile switcher so both follow the same order.
 *
 * The store only changes after the backend accepted the switch, so a failed
 * activation leaves the previous profile active; that failure is kept in
 * `error` for the caller to show. Channel loading never blocks or fails the
 * switch: `loadChannels` reports through `channelLoad`, and the user stays on
 * the new profile with an error state.
 */
import { useCallback, useState } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { setActiveProfileId } from '../lib/tauri';
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
  const loadChannels = usePlayerStore((s) => s.loadChannels);
  const [error, setError] = useState<string | null>(null);

  const switchTo = useCallback(
    async (playlist: Playlist) => {
      try {
        logger.info(`Switching to profile: ${playlist.name}`);

        // Set active in backend
        await setActiveProfileId(playlist.id!);

        // Update frontend state first: loadChannels is a no-op unless the
        // playlist is already the current one
        setStoreActiveId(playlist.id!);
        setCurrentPlaylist(playlist);
        void loadChannels(playlist.id!);

        logger.info(`Profile switched: ${playlist.name}`);
      } catch (err) {
        logger.error('Failed to switch profile:', err);
        setError(`Failed to switch profile: ${err}`);
      }
    },
    [setStoreActiveId, setCurrentPlaylist, loadChannels]
  );

  const clearError = useCallback(() => setError(null), []);

  return { switchTo, error, clearError };
}
