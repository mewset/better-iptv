import { useCallback, useEffect, useRef, useState } from 'react';
import { getChannelMatchDetails, type MatchDetails } from '../lib/epgIpc';
import { useEpgStore } from '../stores/epg-store';
import { logger } from '../lib/logger';

export interface MatchDetailsView {
  /** null until the first answer, and while there is no playlist. */
  details: MatchDetails | null;
  /** Asks again, after a change made here. */
  reload: () => void;
}

/**
 * The playlist's matches set by hand and found by name
 * (`get_channel_match_details`). Asked when the playlist changes and after
 * every `epg-refreshed` (the epg store's `generation`), so a match changed
 * anywhere shows here; only the latest request's answer is kept.
 */
export function useMatchDetails(playlistId: number | undefined): MatchDetailsView {
  const generation = useEpgStore((s) => s.generation);
  // Kept with the playlist it is for, so another playlist's never shows.
  const [answer, setAnswer] = useState<{ playlistId: number; details: MatchDetails } | null>(null);
  const [asked, setAsked] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    if (playlistId === undefined) return;
    getChannelMatchDetails(playlistId)
      .then((details) => {
        if (current === request.current) setAnswer({ playlistId, details });
      })
      .catch((err) => {
        if (current === request.current) logger.warn('Failed to read the manual matches:', err);
      });
  }, [playlistId, generation, asked]);

  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const details = answer !== null && answer.playlistId === playlistId ? answer.details : null;
  return { details, reload };
}
