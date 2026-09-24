import { useState, useEffect } from 'react';
import { importPlaylist, importXtreamPlaylist, getChannels } from '../lib/tauri';
import { usePlayerStore } from '../stores/player-store';
import { listen } from '@tauri-apps/api/event';
import { logger } from '../lib/logger';
import type { Playlist } from '../types';
import LoadingScreen from './LoadingScreen';
import logoImage from '../assets/logo/logo-256.webp';

type ImportType = 'm3u' | 'xtream';

interface SetupProps {
  onComplete?: (playlist: Playlist) => void; // Callback when profile created (modal mode)
  onCancel?: () => void; // Callback to cancel modal
}

export default function Setup({ onComplete, onCancel }: SetupProps = {}) {
  const [importType, setImportType] = useState<ImportType>('m3u');
  const [playlistName, setPlaylistName] = useState('');

  // M3U fields
  const [playlistUrl, setPlaylistUrl] = useState('');

  // Xtream fields
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [error, setError] = useState('');
  const [importProgress, setImportProgress] = useState<{
    live_count: number;
    vod_count: number;
    series_count: number;
  } | null>(null);

  const { setIsSetupComplete, setChannels, setIsLoading, setCurrentPlaylist, isLoading } =
    usePlayerStore();

  // Listen for import progress events
  useEffect(() => {
    const unlisten = listen<{ live_count: number; vod_count: number; series_count: number }>(
      'import-progress',
      (event) => {
        setImportProgress(event.payload);
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!playlistName.trim()) {
      setError('Please enter a playlist name');
      return;
    }

    if (importType === 'm3u' && !playlistUrl.trim()) {
      setError('Please enter a playlist URL');
      return;
    }

    if (importType === 'xtream' && (!serverUrl.trim() || !username.trim() || !password.trim())) {
      setError('Please fill in all Xtream credentials');
      return;
    }

    setIsLoading(true);
    setImportProgress(null);

    try {
      let playlist;

      if (importType === 'm3u') {
        logger.info('Importing M3U playlist...');
        playlist = await importPlaylist(playlistName, playlistUrl);
      } else {
        logger.info('Importing Xtream playlist...', { serverUrl, username });
        playlist = await importXtreamPlaylist(playlistName, serverUrl, username, password);
        logger.debug('Xtream import result:', playlist);
      }

      logger.debug('Fetching channels for playlist:', playlist.id);
      const channels = await getChannels(playlist.id);
      logger.info('Fetched channels:', channels.length);

      // If modal mode with onComplete callback, call it
      if (onComplete) {
        onComplete(playlist);
        return; // Don't set setup complete, parent handles state
      }

      // Normal mode (initial setup)
      setCurrentPlaylist(playlist);
      setChannels(channels);
      setIsSetupComplete(true);
    } catch (err) {
      logger.error('Import error:', err);
      setError(err instanceof Error ? err.message : 'Failed to import playlist');
    } finally {
      setIsLoading(false);
      setImportProgress(null);
    }
  };

  // Calculate total loaded channels for progress display
  const totalLoaded = importProgress
    ? importProgress.live_count + importProgress.vod_count + importProgress.series_count
    : 0;

  // Show full-screen loading when importing (initial setup mode)
  if (isLoading && !onCancel) {
    return (
      <LoadingScreen
        message="Importing playlist..."
        progress={totalLoaded > 0 ? totalLoaded : undefined}
        details={importProgress || undefined}
      />
    );
  }

  return (
    <div className={onCancel ? '' : 'flex min-h-screen items-center justify-center bg-bg p-4'}>
      <div
        className={`relative rounded-lg bg-surface p-8 shadow-xl ${onCancel ? 'w-full max-w-md' : 'w-full max-w-md'}`}
      >
        {/* Modal mode loading overlay */}
        {isLoading && onCancel && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-surface/80 backdrop-blur-sm">
            <div className="text-center">
              <div className="mx-auto mb-4 h-16 w-16 animate-spin rounded-full border-4 border-accent border-t-transparent"></div>
              <p className="font-medium text-text-muted">Importing playlist...</p>
              {importProgress && totalLoaded > 0 && (
                <p className="mt-2 text-sm text-text-muted">
                  Loaded {totalLoaded.toLocaleString()} channels
                </p>
              )}
            </div>
          </div>
        )}

        {/* Cancel button if in modal mode */}
        {onCancel && (
          <button
            onClick={onCancel}
            aria-label="Cancel"
            className="absolute right-4 top-4 text-text-faint hover:text-text-muted"
          >
            ✕
          </button>
        )}

        <div className="mb-8 text-center">
          {/* Logo */}
          <div className="mb-4 flex justify-center">
            <img src={logoImage} alt="Better-IPTV Logo" className="h-24 w-24" />
          </div>

          <h1 className="mb-2 text-3xl font-bold text-text">
            {onCancel ? 'Add New Profile' : 'Better IPTV'}
          </h1>
          <p className="text-text-muted">
            {onCancel ? 'Add a new IPTV playlist' : 'Add your IPTV playlist to get started'}
          </p>
        </div>

        {/* Tab switcher */}
        <div className="mb-6 flex border-b border-border">
          <button
            type="button"
            onClick={() => setImportType('m3u')}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
              importType === 'm3u'
                ? 'border-b-2 border-accent text-accent-text'
                : 'text-text-faint hover:text-text-muted'
            }`}
          >
            M3U URL
          </button>
          <button
            type="button"
            onClick={() => setImportType('xtream')}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
              importType === 'xtream'
                ? 'border-b-2 border-accent text-accent-text'
                : 'text-text-faint hover:text-text-muted'
            }`}
          >
            Xtream Codes
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="name" className="mb-1 block text-sm font-medium text-text-muted">
              Playlist Name
            </label>
            <input
              id="name"
              type="text"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              placeholder="My IPTV Playlist"
              className="w-full rounded-md border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent"
            />
          </div>

          {importType === 'm3u' ? (
            <div>
              <label htmlFor="url" className="mb-1 block text-sm font-medium text-text-muted">
                M3U Playlist URL
              </label>
              <input
                id="url"
                type="text"
                value={playlistUrl}
                onChange={(e) => setPlaylistUrl(e.target.value)}
                placeholder="http://example.com/playlist.m3u"
                className="w-full rounded-md border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent"
              />
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="server" className="mb-1 block text-sm font-medium text-text-muted">
                  Server URL
                </label>
                <input
                  id="server"
                  type="text"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="http://example.com:8080"
                  className="w-full rounded-md border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent"
                />
              </div>
              <div>
                <label
                  htmlFor="username"
                  className="mb-1 block text-sm font-medium text-text-muted"
                >
                  Username
                </label>
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  className="w-full rounded-md border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent"
                />
              </div>
              <div>
                <label
                  htmlFor="password"
                  className="mb-1 block text-sm font-medium text-text-muted"
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="password"
                  className="w-full rounded-md border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent"
                />
              </div>
            </>
          )}

          {error && (
            <div className="rounded-md border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="w-full rounded-md bg-accent px-4 py-3 font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add Playlist
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-text-faint">
          Your playlist will be saved locally
        </div>
      </div>
    </div>
  );
}
