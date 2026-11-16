import type { Channel } from '../types';

/**
 * How the Movies and Series grids are ordered. `provider` is the playlist's
 * own order (categories in provider order, titles as listed), the order the
 * grid had before sorting existed.
 */
export type TitleSort = 'provider' | 'added' | 'rating' | 'name' | 'name-desc' | 'year';

/** The sortable sections. */
export type SortableSection = 'vod' | 'series';

/** Options in menu order, with their labels. */
export const TITLE_SORTS: ReadonlyArray<{ value: TitleSort; label: string }> = [
  { value: 'provider', label: 'Provider order' },
  { value: 'added', label: 'Recently added' },
  { value: 'rating', label: 'Highest rated' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'year', label: 'Year, newest first' },
];

export const DEFAULT_TITLE_SORTS: Record<SortableSection, TitleSort> = {
  vod: 'provider',
  series: 'provider',
};

const STORAGE_KEY = 'better-iptv:title-sort';

export function isTitleSort(value: unknown): value is TitleSort {
  return TITLE_SORTS.some((s) => s.value === value);
}

/** The saved sort per section; the default for anything missing or unreadable. */
export function loadTitleSorts(): Record<SortableSection, TitleSort> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === 'object') {
      const { vod, series } = saved as Record<string, unknown>;
      return {
        vod: isTitleSort(vod) ? vod : DEFAULT_TITLE_SORTS.vod,
        series: isTitleSort(series) ? series : DEFAULT_TITLE_SORTS.series,
      };
    }
  } catch {
    // Storage blocked or the value is not JSON: fall back to the defaults
  }
  return { ...DEFAULT_TITLE_SORTS };
}

export function saveTitleSorts(sorts: Record<SortableSection, TitleSort>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(sorts));
  } catch {
    // The choice still applies for this session
  }
}

// Numeric so "Rocky 2" comes before "Rocky 10"; punctuation ignored so
// "#Alive" files under A; base sensitivity so case and accents do not split
// the list.
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
  ignorePunctuation: true,
});

/** The release year a provider puts at the end of a title, "Freaky (2020)". */
export function titleYear(name: string): number | null {
  const match = /\((\d{4})\)\s*$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** TMDB's rating and vote count for one title, keyed by channel id. */
export type TitleRatings = Record<number, { rating: number; votes: number }>;

/**
 * How many votes a TMDB rating needs before it counts at full weight: the
 * "m" of the weighted rating IMDb's Top 250 uses. Below it a rating is pulled
 * towards the average, so a 10.0 from one vote does not top the list.
 */
export const RATING_MIN_VOTES = 250;

/**
 * The "C" a low-vote rating is pulled towards: about TMDB's typical average.
 * Fixed rather than the list's own average, which in a small or filtered
 * list can itself be high enough to float a one-vote 10 to the top.
 */
export const RATING_PRIOR = 6.5;

/**
 * The vote-weighted rating: (v / (v + m)) * R + (m / (v + m)) * C, where R is
 * the title's rating, v its votes, m `RATING_MIN_VOTES` and C `RATING_PRIOR`.
 */
export function weightedRating(rating: number, votes: number, prior = RATING_PRIOR): number {
  const m = RATING_MIN_VOTES;
  return (votes / (votes + m)) * rating + (m / (votes + m)) * prior;
}

/**
 * A provider rating worth sorting on. Panels copy TMDB's average without the
 * vote count, and an average of exactly 10 only happens with a handful of
 * votes, so a perfect 10 counts as no rating, like 0 or a missing one.
 */
export function providerRating(rating: number | undefined): number | null {
  return typeof rating === 'number' && rating > 0 && rating < 10 ? rating : null;
}

/**
 * Highest rated: titles with TMDB votes first, by their vote-weighted rating;
 * then the rest by the provider's rating (`providerRating`); then the unrated.
 * Ties keep the list's own order.
 */
function byRating(channels: Channel[], ratings: TitleRatings | null | undefined): Channel[] {
  const keyed = channels.map((channel, index) => {
    const tmdb = ratings?.[channel.id];
    if (tmdb) return { channel, index, tier: 0, score: weightedRating(tmdb.rating, tmdb.votes) };
    const provider = providerRating(channel.rating);
    return provider !== null
      ? { channel, index, tier: 1, score: provider }
      : { channel, index, tier: 2, score: 0 };
  });
  keyed.sort((a, b) => a.tier - b.tier || b.score - a.score || a.index - b.index);
  return keyed.map((k) => k.channel);
}

/**
 * The list in the given order, as a new array (the input is left alone);
 * `provider` returns the list itself. Titles a key cannot place (no year, no
 * added date) go last; ties keep the list's own order. `ratings` (TMDB's,
 * when known) only matters for `rating`.
 */
export function sortTitles(
  channels: Channel[],
  sort: TitleSort,
  ratings?: TitleRatings | null
): Channel[] {
  switch (sort) {
    case 'provider':
      return channels;
    case 'name':
      return [...channels].sort((a, b) => collator.compare(a.name, b.name));
    case 'name-desc':
      return [...channels].sort((a, b) => collator.compare(b.name, a.name));
    case 'rating':
      return byRating(channels, ratings);
    case 'year':
      return sortByKey(
        channels,
        (c) => titleYear(c.name),
        (a, b) => b - a
      );
    case 'added':
      // `created_at` is `YYYY-MM-DD HH:MM:SS` UTC, which orders as text; the
      // Xtream import fills it with the provider's own "added" time.
      return sortByKey(
        channels,
        (c) => c.created_at || null,
        (a, b) => (a < b ? 1 : a > b ? -1 : 0)
      );
  }
}

function sortByKey<K>(
  channels: Channel[],
  key: (c: Channel) => K | null,
  compare: (a: K, b: K) => number
): Channel[] {
  const keyed = channels.map((channel, index) => ({ channel, index, key: key(channel) }));
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) {
      if (a.key === b.key) return a.index - b.index;
      return a.key === null ? 1 : -1;
    }
    return compare(a.key, b.key) || a.index - b.index;
  });
  return keyed.map((k) => k.channel);
}
