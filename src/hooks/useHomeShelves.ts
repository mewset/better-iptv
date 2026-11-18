import { useEffect, useState } from 'react';
import { getFeaturedTitles, type FeaturedTitle } from '../lib/tauri';
import { logger } from '../lib/logger';

/** Home's featured titles (trending today, then popular), movies and series, each in rank order. */
export interface HomeShelves {
  featured: { vod: FeaturedTitle[]; series: FeaturedTitle[] };
}

const EMPTY: HomeShelves = { featured: { vod: [], series: [] } };

/** Trending changes once a day; ten minutes is plenty. */
const REFRESH_MS = 10 * 60_000;

/**
 * Loads Home's TMDB-backed shelves for the profile while Home is shown. Each
 * request fails on its own (logged), leaving that shelf empty rather than
 * blanking the page.
 */
export function useHomeShelves(playlistId: number | null, enabled: boolean): HomeShelves {
  const [shelves, setShelves] = useState<HomeShelves>(EMPTY);

  useEffect(() => {
    if (!enabled || playlistId === null) return;
    let alive = true;
    const featured = (contentType: 'vod' | 'series') =>
      getFeaturedTitles(playlistId, contentType)
        .then((items) => (Array.isArray(items) ? items : []))
        .catch((err) => {
          logger.warn(`Could not load Home's featured ${contentType}:`, err);
          return [] as FeaturedTitle[];
        });
    const load = async () => {
      const [vod, series] = await Promise.all([featured('vod'), featured('series')]);
      if (alive) setShelves({ featured: { vod, series } });
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [playlistId, enabled]);

  return shelves;
}
