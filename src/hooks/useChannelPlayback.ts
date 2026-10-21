import { useCallback, useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import {
  playChannel as tauriPlayChannel,
  stopPlayback as tauriStopPlayback,
  getPlaybackStatus,
  playEpisodeWithSeason,
  playSeriesEpisodes,
} from '../lib/tauri';
import { logger } from '../lib/logger';
import { beginPlaybackStart, endPlaybackStart } from '../lib/playGuard';
import type { Channel, Playlist } from '../types';

/**
 * Episode data for playlist playback
 */
export interface PlaylistEpisode {
  id: string;
  title: string;
  extension: string;
}

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
          setIsPlaying(false);
          setCurrentChannel(null);
        }
      } catch (err) {
        logger.error('Failed to check playback status:', err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isPlaying, setIsPlaying, setCurrentChannel, showToast]);

  // Play a channel
  const play = useCallback(
    async (channel: Channel): Promise<{ type: 'series'; channel: Channel } | void> => {
      // If it's a series, signal to open series view
      if (channel.content_type === 'series') {
        return { type: 'series', channel };
      }

      if (!beginPlaybackStart()) return;
      try {
        // Toggle playback if same channel
        if (currentChannel?.id === channel.id && isPlaying) {
          await tauriStopPlayback();
          setIsPlaying(false);
          return;
        }

        // Play new channel
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
    [currentChannel, isPlaying, setCurrentChannel, setIsPlaying, showToast]
  );

  // Stop playback
  const stop = useCallback(async () => {
    try {
      await tauriStopPlayback();
      setIsPlaying(false);
    } catch (err) {
      logger.error('Failed to stop playback:', err);
      throw err;
    }
  }, [setIsPlaying]);

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
        // As before, a single episode gets a dock entry as a virtual channel
        // and a season playlist does not.
        if (!season) {
          setCurrentChannel({
            id: -1, // Virtual channel
            name: title,
            content_type: 'series',
            is_favorite: false,
          });
        }
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
        setCurrentChannel({
          id: -1, // Virtual channel: the row ids belong to series_episodes, not channels
          name: title,
          content_type: 'series',
          is_favorite: false,
        });
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
