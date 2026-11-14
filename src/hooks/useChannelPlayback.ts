import { useCallback, useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import {
  playChannel as tauriPlayChannel,
  getPlaybackStatus,
  playEpisodeWithSeason,
  playSeriesEpisodes,
  type PlaylistEpisode,
} from '../lib/tauri';
import { logger } from '../lib/logger';
import { beginPlaybackStart, endPlaybackStart } from '../lib/playGuard';
import type { Channel, Playlist } from '../types';

/**
 * Hook result for channel playback
 */
interface UseChannelPlaybackResult {
  /** Currently playing channel */
  currentChannel: Channel | null;
  /** Whether playback is active */
  isPlaying: boolean;
  /** Play a channel (or open series view for series content) */
  play: (channel: Channel) => Promise<{ type: 'series'; channel: Channel } | void>;
  /** Stop current playback */
  stop: () => Promise<void>;
  /** Play episode(s) from a series */
  playEpisode: (
    episodeId: string,
    extension: string,
    title: string,
    playlist: Playlist,
    remainingEpisodes?: PlaylistEpisode[]
  ) => Promise<void>;
  /** Play stored M3U episodes by database id, in the order given */
  playLocalEpisodes: (episodeIds: number[], title: string) => Promise<void>;
}

/**
 * What the dock shows while episodes play. Every successful start sets what
 * is playing, and an episode has no row in `channels` (its id belongs to the
 * provider or to series_episodes), so it gets a virtual channel.
 */
function episodeChannel(title: string): Channel {
  return { id: -1, name: title, content_type: 'series', is_favorite: false };
}

/**
 * Custom hook for channel playback management
 *
 * Consolidates:
 * - Play/stop channel logic
 * - MPV status polling
 * - Episode/series playback
 *
 * What the playing channel shows comes from `useNowNext`, which always asks
 * for it.
 */
export function useChannelPlayback(): UseChannelPlaybackResult {
  const currentChannel = usePlayerStore((s) => s.currentChannel);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const setCurrentChannel = usePlayerStore((s) => s.setCurrentChannel);
  const setIsPlaying = usePlayerStore((s) => s.setIsPlaying);
  const stopPlayback = usePlayerStore((s) => s.stopPlayback);
  const playbackEnded = usePlayerStore((s) => s.playbackEnded);
  const showToast = usePlayerStore((s) => s.showToast);

  // Poll MPV playback status to detect when player is closed externally
  useEffect(() => {
    if (!isPlaying) return;

    const interval = setInterval(async () => {
      try {
        const status = await getPlaybackStatus();
        if (!status.playing) {
          // MPV exited: closed by the user, or (failed) the stream could not
          // be opened, which used to look like nothing happened at all.
          if (status.failed) {
            const name = usePlayerStore.getState().currentChannel?.name ?? 'this stream';
            showToast(
              `Couldn't play ${name}. The provider refused the stream, maybe because your line is already in use.`
            );
          }
          playbackEnded();
        }
      } catch (err) {
        logger.error('Failed to check playback status:', err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isPlaying, playbackEnded, showToast]);

  // Play a channel
  const play = useCallback(
    async (channel: Channel): Promise<{ type: 'series'; channel: Channel } | void> => {
      // If it's a series, signal to open series view
      if (channel.content_type === 'series') {
        return { type: 'series', channel };
      }

      // The playing card's button is a stop, and a stop is never gated.
      if (currentChannel?.id === channel.id && isPlaying) {
        await stopPlayback();
        return;
      }

      if (!beginPlaybackStart()) return;
      try {
        await tauriPlayChannel(channel.id);
        setCurrentChannel(channel);
        setIsPlaying(true);
      } catch (err) {
        logger.error('Failed to play channel:', err);
        showToast(`Couldn't start ${channel.name}.`);
        throw err;
      } finally {
        endPlaybackStart();
      }
    },
    [currentChannel, isPlaying, setCurrentChannel, setIsPlaying, stopPlayback, showToast]
  );

  // Stop playback
  const stop = useCallback(async () => {
    try {
      await stopPlayback();
    } catch (err) {
      logger.error('Failed to stop playback:', err);
      throw err;
    }
  }, [stopPlayback]);

  // Play episode(s) from a series
  const playEpisode = useCallback(
    async (
      episodeId: string,
      extension: string,
      title: string,
      playlist: Playlist,
      remainingEpisodes?: PlaylistEpisode[]
    ) => {
      if (!playlist.url || !playlist.xtream_username || !playlist.xtream_password) {
        logger.error('Missing Xtream credentials');
        throw new Error('Missing Xtream credentials');
      }

      if (!beginPlaybackStart()) return;
      try {
        // The rest of the season when known, otherwise just this episode;
        // the backend builds the stream URLs either way.
        const season = remainingEpisodes !== undefined && remainingEpisodes.length > 0;
        await playEpisodeWithSeason(
          playlist.url,
          playlist.xtream_username,
          playlist.xtream_password,
          season ? remainingEpisodes : [{ id: episodeId, title, extension }]
        );
        setCurrentChannel(episodeChannel(title));
        setIsPlaying(true);
      } catch (err) {
        logger.error('Failed to play episode:', err);
        showToast(`Couldn't start ${title}.`);
        throw err;
      } finally {
        endPlaybackStart();
      }
    },
    [setCurrentChannel, setIsPlaying, showToast]
  );

  // Play stored M3U episodes (grouped at import) by database id
  const playLocalEpisodes = useCallback(
    async (episodeIds: number[], title: string) => {
      if (!beginPlaybackStart()) return;
      try {
        await playSeriesEpisodes(episodeIds);
        setCurrentChannel(episodeChannel(title));
        setIsPlaying(true);
      } catch (err) {
        logger.error('Failed to play local episodes:', err);
        showToast(`Couldn't start ${title}.`);
        throw err;
      } finally {
        endPlaybackStart();
      }
    },
    [setCurrentChannel, setIsPlaying, showToast]
  );

  return {
    currentChannel,
    isPlaying,
    play,
    stop,
    playEpisode,
    playLocalEpisodes,
  };
}
