import type { TmdbCard, TmdbDetails } from './tauri';

export const TMDB_CARD_EVENT = 'tmdb-card';

/** Payload of the `tmdb-card` Tauri event. */
export interface TmdbCardEvent {
  channel_ids: number[];
  card: TmdbCard;
}

function ratingText(rating: number | null): string | null {
  return rating == null ? null : `★ ${rating.toFixed(1)}`;
}

/** "2010 · ★ 8.2", either half alone, or the fallback (the provider group). */
export function metaLine(
  card: Pick<TmdbCard, 'year' | 'rating'> | undefined,
  fallback: string
): string {
  if (!card) return fallback;
  const parts = [card.year ? String(card.year) : null, ratingText(card.rating)].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : fallback;
}

/** Hero variant: year · up to three genres · rating. */
export function heroMetaLine(card: TmdbCard | undefined, fallback: string): string {
  if (!card) return fallback;
  const genres = card.genres.slice(0, 3).join(', ');
  const parts = [
    card.year ? String(card.year) : null,
    genres || null,
    ratingText(card.rating),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : fallback;
}

/** The grid card for a title whose details just arrived (manual re-match). */
export function cardFromDetails(channelId: number, d: TmdbDetails): TmdbCard | null {
  if (!d.matched || d.tmdb_id == null) return null;
  return {
    channel_id: channelId,
    tmdb_id: d.tmdb_id,
    title: d.title ?? '',
    year: d.year,
    rating: d.rating,
    // Details carry the w780 poster; the grid uses w342.
    poster_url: d.poster_url ? d.poster_url.replace('/w780/', '/w342/') : null,
    backdrop_url: d.backdrop_url,
    genres: d.genres,
  };
}
