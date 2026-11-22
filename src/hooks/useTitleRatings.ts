import { useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { getTitleRatings } from '../lib/tauri';
import { logger } from '../lib/logger';
import type { SortableSection, TitleSort } from '../lib/titleSort';

/** How often they are re-read while such a sort is on: the TMDB scan keeps adding them. */
const REFRESH_MS = 60_000;

const SECTIONS: SortableSection[] = ['vod', 'series'];

/** The sorts that order by something TMDB knows: the rating, the release year. */
const usesTmdb = (sort: TitleSort) => sort === 'rating' || sort === 'year';

/**
 * Loads TMDB's ratings, vote counts and release years for every section
 * sorted by "Highest rated" or "Year" (Movies, Series or both), whichever
 * section is open, so switching between them sorts right away instead of
 * reordering once they arrive. Kept fresh as TMDB matches more titles;
 * nothing is fetched for a section sorted any other way.
 */
export function useTitleRatings(): void {
  const playlistId = usePlayerStore((s) => s.currentPlaylist?.id ?? null);
  const vodWanted = usePlayerStore((s) => usesTmdb(s.titleSorts.vod));
  const seriesWanted = usePlayerStore((s) => usesTmdb(s.titleSorts.series));
  const setTitleRatings = usePlayerStore((s) => s.setTitleRatings);

  useEffect(() => {
    if (playlistId === null) return;
    const wanted = SECTIONS.filter((s) => (s === 'vod' ? vodWanted : seriesWanted));
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
  }, [playlistId, vodWanted, seriesWanted, setTitleRatings]);
}
