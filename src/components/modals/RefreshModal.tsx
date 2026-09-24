import { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle, X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { refreshPlaylist } from '../../lib/tauri';
import { logger } from '../../lib/logger';
import type { MergeResult } from '../../types';

interface FetchProgress {
  live_count: number;
  vod_count: number;
  series_count: number;
}

interface RefreshModalProps {
  isOpen: boolean;
  onClose: () => void;
  playlistId: number;
  playlistName: string;
  /** Called after a successful refresh so the parent can reload channels */
  onRefreshComplete?: (result: MergeResult) => void;
}

export default function RefreshModal({
  isOpen,
  onClose,
  playlistId,
  playlistName,
  onRefreshComplete,
}: RefreshModalProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [progress, setProgress] = useState<FetchProgress | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Listen for progress events
  useEffect(() => {
    if (!isOpen) return;

    const unlisten = listen<FetchProgress>('refresh-progress', (event) => {
      setProgress(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [isOpen]);

  // Start refresh when modal opens
  useEffect(() => {
    if (!isOpen || isRefreshing || result || error) return;

    setIsRefreshing(true);
    setProgress(null);
    setResult(null);
    setError(null);

    refreshPlaylist(playlistId)
      .then((mergeResult) => {
        setResult(mergeResult);
        onRefreshComplete?.(mergeResult);
        logger.info(
          `Playlist "${playlistName}" refreshed: +${mergeResult.added} ~${mergeResult.updated} -${mergeResult.removed}`
        );
      })
      .catch((err) => {
        const msg = typeof err === 'string' ? err : JSON.stringify(err);
        setError(msg);
        logger.error('Playlist refresh failed:', err);
      })
      .finally(() => {
        setIsRefreshing(false);
      });
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg bg-surface p-6 shadow-xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xl font-bold text-text">
            {result ? 'Refresh Complete' : 'Refreshing Playlist'}
          </h3>
          {(result || error) && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1 hover:bg-surface-hover"
            >
              <X className="h-5 w-5 text-text-muted" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="space-y-4">
          {isRefreshing && (
            <>
              <div className="flex items-center gap-3">
                <RefreshCw className="h-5 w-5 animate-spin text-accent-text" aria-hidden="true" />
                <span className="text-text-muted">Refreshing "{playlistName}"...</span>
              </div>
              {progress && (
                <div className="space-y-1 text-sm text-text-muted">
                  {progress.live_count > 0 && <p>Live channels: {progress.live_count}</p>}
                  {progress.vod_count > 0 && <p>VOD: {progress.vod_count}</p>}
                  {progress.series_count > 0 && <p>Series: {progress.series_count}</p>}
                </div>
              )}
            </>
          )}

          {result && (
            <>
              <div className="flex items-center gap-3">
                <CheckCircle className="h-5 w-5 text-success" aria-hidden="true" />
                <span className="text-text-muted">Refresh complete</span>
              </div>
              <div className="rounded-lg border border-border bg-surface-2/50 p-4">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold text-success">{result.added}</p>
                    <p className="text-xs text-text-muted">New</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-accent-text">{result.updated}</p>
                    <p className="text-xs text-text-muted">Updated</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-danger">{result.removed}</p>
                    <p className="text-xs text-text-muted">Removed</p>
                  </div>
                </div>
              </div>
              <button
                onClick={onClose}
                className="w-full rounded-lg bg-accent px-4 py-2 text-on-accent transition-colors hover:bg-accent-hover"
              >
                Done
              </button>
            </>
          )}

          {error && (
            <>
              <div className="rounded-lg border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
                Failed to refresh playlist: {error}
              </div>
              <button
                onClick={onClose}
                className="w-full rounded-lg bg-surface-2 px-4 py-2 text-text transition-colors hover:bg-surface-hover"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
