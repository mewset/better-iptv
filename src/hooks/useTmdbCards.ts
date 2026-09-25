import { useEffect, useMemo, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { usePlayerStore } from '../stores/player-store';
import { getTmdbCards, type TmdbCard } from '../lib/tauri';
import { TMDB_CARD_EVENT, type TmdbCardEvent } from '../lib/tmdb';
import { logger } from '../lib/logger';

const DEBOUNCE_MS = 300;
/** Backend cap per call. */
const MAX_IDS = 120;

/**
 * TMDB cards for the channels in view. Asks the backend for ids it has not
 * asked for since the last profile switch; cached cards come back at once,
 * the rest arrive as `tmdb-card` events while the worker searches.
 */
export function useTmdbCards(channelIds: number[]): Map<number, TmdbCard> {
  const tmdbCards = usePlayerStore((s) => s.tmdbCards);
  const setTmdbCards = usePlayerStore((s) => s.setTmdbCards);
  const clearTmdbCards = usePlayerStore((s) => s.clearTmdbCards);
  const playlistId = usePlayerStore((s) => s.currentPlaylist?.id ?? null);

  // Ids already sent this profile, so a no-match title is not re-asked on
  // every scroll (the backend caches no-match rows; this saves the IPC).
  const requestedRef = useRef<Set<number>>(new Set());
  const idsKey = channelIds.join(',');
  const ids = useMemo(() => channelIds, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear only on an actual profile switch. Clearing on mount would wipe the
  // cards of another mounted consumer, whose requested set still lists them.
  const lastPlaylistRef = useRef(playlistId);
  useEffect(() => {
    if (lastPlaylistRef.current === playlistId) return;
    lastPlaylistRef.current = playlistId;
    requestedRef.current = new Set();
    clearTmdbCards();
  }, [playlistId, clearTmdbCards]);

  useEffect(() => {
    const missing = ids.filter((id) => !requestedRef.current.has(id)).slice(0, MAX_IDS);
    if (missing.length === 0) return;
    const timer = setTimeout(() => {
      for (const id of missing) requestedRef.current.add(id);
      getTmdbCards(missing)
        .then(setTmdbCards)
        .catch((err) => {
          // Let the next visibility change ask for this batch again.
          for (const id of missing) requestedRef.current.delete(id);
          logger.debug('TMDB card lookup failed:', err);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // playlistId: a profile switch clears the requested set above and must ask again.
  }, [ids, setTmdbCards, playlistId]);

  useEffect(() => {
    const unlisten = listen<TmdbCardEvent>(TMDB_CARD_EVENT, (event) => {
      const { channel_ids, card } = event.payload;
      setTmdbCards(channel_ids.map((channel_id) => ({ ...card, channel_id })));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setTmdbCards]);

  return tmdbCards;
}
