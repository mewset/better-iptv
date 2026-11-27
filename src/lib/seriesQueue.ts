import type { Episode, SeriesInfo } from '../types';
import { episodesInOrder } from './watchProgress';

/** An episode queued in the player: its id, its title there, its container. */
export type QueuedEpisode = { id: string; title: string; extension: string };

/** Most episodes queued in the player at once. */
export const MAX_QUEUE = 60;

/**
 * What the player gets when an episode starts: it, then the rest of the
 * series in viewing order (into the next seasons; specials only when starting
 * in them), each titled "S2 E5 · Name" for the player's title and episode list.
 */
export function queueFrom(
  series: SeriesInfo,
  episodeId: string,
  titleOf: (episode: Episode) => string
): QueuedEpisode[] {
  const order = episodesInOrder(series);
  const at = order.findIndex((e) => e.episode.id === episodeId);
  if (at === -1) return [];
  const special = order[at].season === '0';
  return order
    .slice(at)
    .filter((e) => (e.season === '0') === special)
    .slice(0, MAX_QUEUE)
    .map(({ season, episode }) => ({
      id: episode.id,
      title: `S${season} E${episode.episode_num} · ${titleOf(episode)}`,
      extension: episode.container_extension,
    }));
}
