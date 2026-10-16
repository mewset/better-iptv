import { useEffect, useState } from 'react';
import Setup from './components/Setup';
import MainScreen from './components/MainScreen';
import ErrorBoundary from './components/ErrorBoundary';
import { usePlayerStore } from './stores/player-store';
import { getPlaylists, getChannels, getActiveProfileId, getTmdbStatus } from './lib/tauri';
import { homeGateOpen } from './lib/tmdb';
import { logger } from './lib/logger';

export default function App() {
  const {
    isSetupComplete,
    setIsSetupComplete,
    setPlaylists,
    setChannels,
    setCurrentPlaylist,
    setActiveProfileId,
    setTmdbStatus,
    setContentTypeFilter,
  } = usePlayerStore();
  const [isCheckingSetup, setIsCheckingSetup] = useState(true);

  useEffect(() => {
    // Check if user has any playlists on app start
    async function checkSetup() {
      try {
        const [playlists, activeId, tmdbStatus] = await Promise.all([
          getPlaylists(),
          getActiveProfileId(),
          getTmdbStatus().catch(() => null),
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

          const channels = await getChannels(activePlaylist.id);
          setChannels(channels);
          setIsSetupComplete(true);
        }
      } catch (err) {
        logger.error('Failed to check setup:', err);
      } finally {
        setIsCheckingSetup(false);
      }
    }

    checkSetup();
  }, [
    setIsSetupComplete,
    setPlaylists,
    setChannels,
    setCurrentPlaylist,
    setActiveProfileId,
    setTmdbStatus,
    setContentTypeFilter,
  ]);

  if (isCheckingSetup) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="text-center">
          <div className="mx-auto mb-4 h-16 w-16 animate-spin rounded-full border-4 border-accent border-t-transparent"></div>
          <p className="text-lg font-medium text-text-muted">Loading playlist...</p>
        </div>
      </div>
    );
  }

  return <ErrorBoundary>{isSetupComplete ? <MainScreen /> : <Setup />}</ErrorBoundary>;
}
