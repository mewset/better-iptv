import { useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { useProgressStore } from '../stores/progress-store';
import { fetchSeriesInfo } from '../lib/seriesInfo';
import { allEpisodeIds, newEpisodeIds } from '../lib/newEpisodes';
import { progressKey } from '../lib/watchProgress';
import { logger } from '../lib/logger';

/** How often series being watched are asked for new episodes. */
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** After start-up, out of the way of the first channel load. */
const FIRST_CHECK_MS = 60_000;

/**
 * Checks the series the viewer is watching (progress on an episode, final
 * episode not watched) for episodes added since they last opened the series,
 * one series at a time, at start-up and every few hours.
 */
export function useNewEpisodeCheck(): void {
  const playlist = usePlayerStore((s) => s.currentPlaylist);

  useEffect(() => {
    if (!playlist) return;
    let alive = true;
    const check = async () => {
      const { entries, index, finales, knownEpisodes, recordCheck } = useProgressStore.getState();
      const channels = usePlayerStore.getState().channels;
      const series = new Set<number>();
      for (const e of entries) {
        if (e.episode_id === '') continue;
        const finale = finales[e.channel_id];
        if (finale && index.byKey.get(progressKey(e.channel_id, finale))?.watched) continue;
        if (channels.find((c) => c.id === e.channel_id)?.content_type === 'series') {
          series.add(e.channel_id);
        }
      }
      for (const channelId of series) {
        if (!alive) return;
        try {
          const info = await fetchSeriesInfo(channelId, playlist);
          const watched = (episodeId: string) =>
            useProgressStore.getState().index.byKey.get(progressKey(channelId, episodeId))
              ?.watched ?? false;
          recordCheck(
            channelId,
            allEpisodeIds(info),
            newEpisodeIds(info, knownEpisodes[channelId], watched)
          );
        } catch (err) {
          logger.debug(`New-episode check failed for series ${channelId}:`, err);
        }
      }
    };
    const first = setTimeout(() => void check(), FIRST_CHECK_MS);
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [playlist]);
}
