import { useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { getTitleRatings } from '../lib/tauri';
import { logger } from '../lib/logger';
import type { SortableSection } from '../lib/titleSort';

/** How often the ratings are re-read while "Highest rated" is on: the TMDB scan keeps adding them. */
const REFRESH_MS = 60_000;

const SECTIONS: SortableSection[] = ['vod', 'series'];

/**
 * Loads TMDB's ratings and vote counts for every section whose sort is
 * "Highest rated" (Movies, Series or both), whichever section is open, so
 * switching between them sorts right away instead of reordering once the
 * ratings arrive. Kept fresh as TMDB matches more titles; nothing is fetched
 * for a section sorted any other way.
 */
export function useTitleRatings(): void {
  const playlistId = usePlayerStore((s) => s.currentPlaylist?.id ?? null);
  const vodByRating = usePlayerStore((s) => s.titleSorts.vod === 'rating');
  const seriesByRating = usePlayerStore((s) => s.titleSorts.series === 'rating');
  const setTitleRatings = usePlayerStore((s) => s.setTitleRatings);

  useEffect(() => {
    if (playlistId === null) return;
    const wanted = SECTIONS.filter((s) => (s === 'vod' ? vodByRating : seriesByRating));
    if (wanted.length === 0) return;
    let alive = true;
    const load = () => {
      for (const section of wanted) {
        getTitleRatings(playlistId, section)
          .then((ratings) => {
            if (alive)
              setTitleRatings(section, ratings && typeof ratings === 'object' ? ratings : {});
          })
          .catch((err) => logger.warn(`Could not load TMDB ratings for ${section}:`, err));
      }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [playlistId, vodByRating, seriesByRating, setTitleRatings]);
}
