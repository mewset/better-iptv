import type { Channel } from '../types';

/**
 * The channel with the greatest `created_at` (ISO string, compared via
 * `Date.parse`). A missing or unparseable date sorts last, so it never
 * displaces a channel with a real date; among channels that tie (including
 * every channel having an invalid/missing date), the first one in list
 * order wins. Returns null for an empty list.
 */
/**
 * The `n` newest channels by `created_at`, newest first. Undated or
 * unparseable channels sort last, in list order; ties keep list order.
 */
export function newestTitles(channels: Channel[], n: number): Channel[] {
  const dated = channels.map((channel, index) => {
    const parsed = channel.created_at ? Date.parse(channel.created_at) : NaN;
    return { channel, index, time: Number.isNaN(parsed) ? -Infinity : parsed };
  });
  dated.sort((a, b) => b.time - a.time || a.index - b.index);
  return dated.slice(0, Math.max(0, n)).map((d) => d.channel);
}

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
