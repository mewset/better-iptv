import { useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { getTitleTmdbIds } from '../lib/tauri';
import { logger } from '../lib/logger';

/** How often the ids are re-read: the TMDB background scan keeps matching movies. */
const REFRESH_MS = 60_000;

/**
 * Keeps the store's movie -> TMDB id map fresh for the active profile, so a
 * film's translated copies ("Die Truman Show") group with it. Empty while
 * TMDB is off; grouping then relies on the titles alone.
 */
export function useMovieTmdbIds(): void {
  const playlistId = usePlayerStore((s) => s.currentPlaylist?.id ?? null);
  const setMovieTmdbIds = usePlayerStore((s) => s.setMovieTmdbIds);

  useEffect(() => {
    if (playlistId === null) return;
    let alive = true;
    const load = () =>
      getTitleTmdbIds(playlistId, 'vod')
        .then((ids) => {
          if (alive) setMovieTmdbIds(ids && typeof ids === 'object' ? ids : {});
        })
        .catch((err) => logger.warn('Could not load movie TMDB ids:', err));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [playlistId, setMovieTmdbIds]);
}
