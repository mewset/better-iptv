import { useState, useEffect, useRef } from 'react';
import { importPlaylist, importXtreamPlaylist, getChannels, checkMpvInstalled } from '../lib/tauri';
import { usePlayerStore } from '../stores/player-store';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { logger } from '../lib/logger';
import type { Playlist } from '../types';
import { X, Check, AlertTriangle } from 'lucide-react';
import LoadingScreen from './LoadingScreen';
import logoImage from '../assets/logo/logo-256.webp';
import { BARS } from './ColorBars';

const MPV_INSTALL_URL = 'https://mpv.io/installation/';

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

  // null while the check is in flight; a rejected call is treated the same
  // as "not found" rather than left in an unknown state.
  const [mpvInstalled, setMpvInstalled] = useState<boolean | null>(null);

  const m3uTabRef = useRef<HTMLButtonElement>(null);
  const xtreamTabRef = useRef<HTMLButtonElement>(null);

  const { setIsSetupComplete, setChannels, setIsLoading, setCurrentPlaylist, isLoading } =
    usePlayerStore();

  // Check whether MPV is available so the status line can tell the user
  // before they import a playlist they can't play back yet.
  useEffect(() => {
    let cancelled = false;

    checkMpvInstalled()
      .then((found) => {
        if (!cancelled) setMpvInstalled(found);
      })
      .catch((err) => {
        logger.warn('Failed to check for MPV:', err);
        if (!cancelled) setMpvInstalled(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleInstallMpvClick = () => {
    openUrl(MPV_INSTALL_URL).catch((err) =>
      logger.warn('Failed to open the MPV install page:', err)
    );
  };

  // Tabs keyboard model (WAI-ARIA APG): ArrowLeft/ArrowRight move between
  // tabs and select the newly-focused one (automatic activation). With only
  // two tabs, either arrow key just swaps to the other one.
  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next: ImportType = importType === 'm3u' ? 'xtream' : 'm3u';
    setImportType(next);
    (next === 'm3u' ? m3uTabRef : xtreamTabRef).current?.focus();
  };

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

  const card = (
    <div className="relative w-[560px] max-w-[calc(100%-32px)] rounded-3xl border border-border-strong bg-surface/80 p-10 backdrop-blur-2xl">
      {/* Modal mode loading overlay */}
      {isLoading && onCancel && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-3xl bg-surface/80 backdrop-blur-sm">
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
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="absolute right-6 top-6 text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      <img
        src={logoImage}
        alt="Better-IPTV Logo"
        className="mb-4 h-[52px] w-[52px] rounded-[14px]"
      />

      <h1 className="font-display text-[34px] font-bold text-text">
        {onCancel ? 'Add a profile' : 'Add your first playlist'}
      </h1>
      <p className="mt-2 text-sm text-text-muted">
        {onCancel
          ? 'Each profile is one playlist or provider. Add an M3U link or sign in to an Xtream Codes provider.'
          : 'Paste an M3U link or sign in to your Xtream Codes provider. Everything is stored on this computer and nothing is sent anywhere else.'}
      </p>

      {/* Import type segmented control */}
      <div
        role="tablist"
        aria-label="Playlist type"
        className="mt-6 grid grid-cols-2 gap-1 rounded-xl bg-text/5 p-1"
      >
        <button
          ref={m3uTabRef}
          type="button"
          role="tab"
          aria-selected={importType === 'm3u'}
          tabIndex={importType === 'm3u' ? 0 : -1}
          onClick={() => setImportType('m3u')}
          onKeyDown={handleTabKeyDown}
          className={`rounded-lg py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            importType === 'm3u' ? 'bg-text text-bg' : 'text-text-muted'
          }`}
        >
          M3U URL
        </button>
        <button
          ref={xtreamTabRef}
          type="button"
          role="tab"
          aria-selected={importType === 'xtream'}
          tabIndex={importType === 'xtream' ? 0 : -1}
          onClick={() => setImportType('xtream')}
          onKeyDown={handleTabKeyDown}
          className={`rounded-lg py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            importType === 'xtream' ? 'bg-text text-bg' : 'text-text-muted'
          }`}
        >
          Xtream Codes
        </button>
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="name" className="mb-1.5 block text-[13px] font-semibold text-text-muted">
            Playlist Name
          </label>
          <input
            id="name"
            type="text"
            value={playlistName}
            onChange={(e) => setPlaylistName(e.target.value)}
            placeholder="My IPTV Playlist"
            className="h-11 w-full rounded-xl border border-border-strong bg-text/5 px-3.5 text-text focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        {importType === 'm3u' ? (
          <div>
            <label htmlFor="url" className="mb-1.5 block text-[13px] font-semibold text-text-muted">
              M3U Playlist URL
            </label>
            <input
              id="url"
              type="text"
              value={playlistUrl}
              onChange={(e) => setPlaylistUrl(e.target.value)}
              placeholder="http://example.com/playlist.m3u"
              className="h-11 w-full rounded-xl border border-border-strong bg-text/5 px-3.5 text-text focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        ) : (
          <>
            <div>
              <label
                htmlFor="server"
                className="mb-1.5 block text-[13px] font-semibold text-text-muted"
              >
                Server URL
              </label>
              <input
                id="server"
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://example.com:8080"
                className="h-11 w-full rounded-xl border border-border-strong bg-text/5 px-3.5 text-text focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label
                htmlFor="username"
                className="mb-1.5 block text-[13px] font-semibold text-text-muted"
              >
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                className="h-11 w-full rounded-xl border border-border-strong bg-text/5 px-3.5 text-text focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-[13px] font-semibold text-text-muted"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="password"
                className="h-11 w-full rounded-xl border border-border-strong bg-text/5 px-3.5 text-text focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </>
        )}

        {error && (
          <div className="rounded-md border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-text">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="h-12 w-full rounded-xl bg-accent font-bold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          Import playlist
        </button>
      </form>

      {/* MPV status */}
      <div className="mt-4 flex items-center gap-1.5 text-xs">
        {mpvInstalled === true && (
          <>
            <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
            <span className="text-text-muted">MPV found</span>
          </>
        )}
        {mpvInstalled === false && (
          <>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
            <span className="text-text-muted">MPV not found</span>
            <button
              type="button"
              onClick={handleInstallMpvClick}
              className="font-semibold text-accent-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              How to install MPV
            </button>
          </>
        )}
      </div>
    </div>
  );

  // Modal mode (inside ProfileManager's add-profile dialog): the same card,
  // without the full-screen glow background or the colour-bar strip - the
  // dialog wrapper already provides its own backdrop.
  if (onCancel) {
    return card;
  }

  return (
    <div className="relative min-h-screen bg-bg">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgb(var(--color-accent)/0.10),transparent_70%)]"
      />
      <div className="relative flex min-h-screen items-center justify-center p-4">{card}</div>
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 flex h-[6px] opacity-[.35]">
        {BARS.map((c) => (
          <div key={c} className="flex-1" style={{ backgroundColor: c }} />
        ))}
      </div>
    </div>
  );
}
