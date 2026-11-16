import type { SeriesInfo } from '../types';
import { episodesInOrder } from './watchProgress';

/** Every episode id of a series, specials included. */
export function allEpisodeIds(series: SeriesInfo): string[] {
  return episodesInOrder(series).map((e) => e.episode.id);
}

/**
 * Episodes added since the viewer last saw the series' list (`known`) that
 * they have not watched, in viewing order; specials aside. Nothing without a
 * list to compare with: a series first checked starts from its current list.
 */
export function newEpisodeIds(
  series: SeriesInfo,
  known: string[] | undefined,
  isWatched: (episodeId: string) => boolean
): string[] {
  if (!known) return [];
  const seen = new Set(known);
  return episodesInOrder(series)
    .filter((e) => e.season !== '0' && !seen.has(e.episode.id) && !isWatched(e.episode.id))
    .map((e) => e.episode.id);
}
