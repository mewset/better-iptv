import { useEffect } from 'react';
import type { Channel } from '../types';
import type { NowNext } from '../lib/epgIpc';
import { shownNowNext } from '../lib/epgTime';
import { playerSetProgramme } from '../lib/tauri';
import { logger } from '../lib/logger';

/** A player still starting has no socket yet: the title is sent again after these. */
const RESEND_MS = [1_500, 5_000];

/**
 * Keeps the player's controls showing what a live channel has on now
 * ("LIVE  NFL Football   Sky Sports Action"): sent when playback starts and
 * whenever the programme changes, cleared when the guide has nothing.
 */
export function usePlayerProgramme(
  channel: Channel | null,
  entry: NowNext | undefined,
  now: number
): void {
  const live = channel?.content_type === 'live';
  const title = live ? (shownNowNext(entry, now)?.now?.title ?? '') : '';
  const channelId = live ? (channel?.id ?? null) : null;

  useEffect(() => {
    if (channelId === null) return;
    const send = () =>
      playerSetProgramme(title).catch((err) =>
        logger.warn('Could not send the programme to the player:', err)
      );
    void send();
    const timers = RESEND_MS.map((ms) => setTimeout(send, ms));
    return () => timers.forEach(clearTimeout);
  }, [channelId, title]);
}
