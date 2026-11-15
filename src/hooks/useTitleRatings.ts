import { useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { getTitleRatings } from '../lib/tauri';
import { logger } from '../lib/logger';
import type { SortableSection } from '../lib/titleSort';

/** How often the ratings are re-read while "Highest rated" is on: the TMDB scan keeps adding them. */
const REFRESH_MS = 60_000;

/**
 * Loads TMDB's ratings and vote counts for the section into the store while
 * its sort is "Highest rated", and keeps them fresh as TMDB matches more
 * titles. Nothing is fetched for any other sort.
 */
export function useTitleRatings(section: SortableSection | null): void {
  const playlistId = usePlayerStore((s) => s.currentPlaylist?.id ?? null);
  const byRating = usePlayerStore((s) => (section ? s.titleSorts[section] === 'rating' : false));
  const setTitleRatings = usePlayerStore((s) => s.setTitleRatings);

  useEffect(() => {
    if (!section || !byRating || playlistId === null) return;
    let alive = true;
    const load = () =>
      getTitleRatings(playlistId, section)
        .then((ratings) => {
          if (alive) setTitleRatings(ratings && typeof ratings === 'object' ? ratings : {});
        })
        .catch((err) => logger.warn('Could not load TMDB ratings:', err));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [section, byRating, playlistId, setTitleRatings]);
}
