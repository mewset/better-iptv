import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getHomeRows, type HomeRow } from '../lib/tauri';
import { TMDB_BACKGROUND_PROGRESS_EVENT, type TmdbBackgroundProgress } from '../lib/tmdb';
import { logger } from '../lib/logger';

export interface HomeRowsState {
  rows: HomeRow[];
  loading: boolean;
  /** The latest background-scan progress event, for the empty state. */
  progress: TmdbBackgroundProgress | null;
}

/**
 * The day's Home rows for a profile. Loads when `enabled` (the gate is open
 * and Home is the section), again on a profile switch, and again when the
 * background scan reports itself finished, since that is when new titles
 * qualify. Errors are logged and leave the page empty; Home is not a task
 * the user started, so no toast.
 */
export function useHomeRows(playlistId: number | null, enabled: boolean): HomeRowsState {
  const [rows, setRows] = useState<HomeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<TmdbBackgroundProgress | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The playlist id of the last successful load, so a scan-finish reload of
  // the same profile does not flash a skeleton over already-rendered rows,
  // while a profile switch (or re-entering Home) still shows one.
  const loadedForRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<TmdbBackgroundProgress>(TMDB_BACKGROUND_PROGRESS_EVENT, (event) => {
      const p = event.payload;
      setProgress(p);
      if (!p.running && p.total > 0 && p.done === p.total) setReloadKey((k) => k + 1);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => logger.warn('Failed to listen for TMDB scan progress:', err));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || playlistId == null) {
      setRows([]);
      setLoading(false);
      setProgress(null);
      loadedForRef.current = null;
      return;
    }
    let cancelled = false;
    setLoading(loadedForRef.current !== playlistId);
    getHomeRows(playlistId)
      .then((r) => {
        if (!cancelled) {
          setRows(r);
          loadedForRef.current = playlistId;
        }
      })
      .catch((err) => {
        logger.error('Failed to load Home rows:', err);
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, playlistId, reloadKey]);

  return { rows, loading, progress };
}
