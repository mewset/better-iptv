import type { Channel } from '../types';

/**
 * The channel with the greatest `created_at` (ISO string, compared via
 * `Date.parse`). A missing or unparseable date sorts last, so it never
 * displaces a channel with a real date; among channels that tie (including
 * every channel having an invalid/missing date), the first one in list
 * order wins. Returns null for an empty list.
 */
export function newestTitle(channels: Channel[]): Channel | null {
  let best: Channel | null = null;
  let bestTime = -Infinity;

  for (const channel of channels) {
    const parsed = channel.created_at ? Date.parse(channel.created_at) : NaN;
    const time = Number.isNaN(parsed) ? -Infinity : parsed;

    if (best === null || time > bestTime) {
      best = channel;
      bestTime = time;
    }
  }

  return best;
}
