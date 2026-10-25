import { useEffect, useState } from 'react';
import Setup from './components/Setup';
import MainScreen from './components/MainScreen';
import ErrorBoundary from './components/ErrorBoundary';
import { usePlayerStore } from './stores/player-store';
import { getPlaylists, getActiveProfileId, getTmdbStatus } from './lib/tauri';
import { homeGateOpen } from './lib/tmdb';
import { logger } from './lib/logger';

export default function App() {
  // Only the flag: subscribing to the whole store re-rendered App, and with it MainScreen,
  // on every store change
  const isSetupComplete = usePlayerStore((s) => s.isSetupComplete);
  const [isCheckingSetup, setIsCheckingSetup] = useState(true);

  useEffect(() => {
    // Check if user has any playlists on app start
    async function checkSetup() {
      // Store actions are stable, so they are read once here instead of subscribed to
      const {
        setIsSetupComplete,
        setPlaylists,
        loadChannels,
        loadParentalSettings,
        setCurrentPlaylist,
        setActiveProfileId,
        setTmdbStatus,
        setContentTypeFilter,
      } = usePlayerStore.getState();
      try {
        // Parental settings are awaited before MainScreen mounts, so the first render already
        // filters. loadParentalSettings swallows its own errors: if it fails, the defaults
        // (parental off) apply until a later load succeeds.
        const [playlists, activeId, tmdbStatus] = await Promise.all([
          getPlaylists(),
          getActiveProfileId(),
          getTmdbStatus().catch(() => null),
          loadParentalSettings(),
        ]);

        if (playlists.length > 0) {
          setPlaylists(playlists);

          // Load active profile instead of first playlist
          const activePlaylist = activeId
            ? playlists.find((p) => p.id === activeId) || playlists[0]
            : playlists[0];

          setActiveProfileId(activePlaylist.id!);
          setCurrentPlaylist(activePlaylist);

          // Decide the start section now, so MainScreen mounts on it directly.
          setTmdbStatus(tmdbStatus);
          if (homeGateOpen(tmdbStatus) && usePlayerStore.getState().contentTypeFilter === 'live') {
            setContentTypeFilter('home');
          }

          setIsSetupComplete(true);
          // Not awaited: MainScreen mounts now and the store reports channelLoad
          void loadChannels(activePlaylist.id!);
        }
      } catch (err) {
        logger.error('Failed to check setup:', err);
      } finally {
        setIsCheckingSetup(false);
      }
    }

    checkSetup();
  }, []);

  if (isCheckingSetup) {
    return <div className="min-h-screen bg-bg" />;
  }

  return <ErrorBoundary>{isSetupComplete ? <MainScreen /> : <Setup />}</ErrorBoundary>;
}
