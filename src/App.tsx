import { useEffect, useState } from 'react';
import Setup from './components/Setup';
import MainScreen from './components/MainScreen';
import ErrorBoundary from './components/ErrorBoundary';
import { usePlayerStore } from './stores/player-store';
import { getPlaylists, getChannels, getActiveProfileId } from './lib/tauri';
import { logger } from './lib/logger';

export default function App() {
  const {
    isSetupComplete,
    setIsSetupComplete,
    setPlaylists,
    setChannels,
    setCurrentPlaylist,
    setActiveProfileId,
  } = usePlayerStore();
  const [isCheckingSetup, setIsCheckingSetup] = useState(true);

  useEffect(() => {
    // Check if user has any playlists on app start
    async function checkSetup() {
      try {
        const playlists = await getPlaylists();

        if (playlists.length > 0) {
          setPlaylists(playlists);

          // Load active profile instead of first playlist
          const activeId = await getActiveProfileId();
          const activePlaylist = activeId
            ? playlists.find((p) => p.id === activeId) || playlists[0]
            : playlists[0];

          setActiveProfileId(activePlaylist.id!);
          setCurrentPlaylist(activePlaylist);

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
  }, [setIsSetupComplete, setPlaylists, setChannels, setCurrentPlaylist, setActiveProfileId]);

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
