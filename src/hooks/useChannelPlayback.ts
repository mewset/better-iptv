import { useCallback, useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import {
  playChannel as tauriPlayChannel,
  stopPlayback as tauriStopPlayback,
  getPlaybackStatus,
  getChannelEpg,
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
  /** Current EPG program title */
  currentProgram: string | null;
  /** Next EPG program title */
  nextProgram: string | null;
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
 * - EPG updates during playback
 * - Episode/series playback
 */
export function useChannelPlayback(): UseChannelPlaybackResult {
  const currentChannel = usePlayerStore((s) => s.currentChannel);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentProgram = usePlayerStore((s) => s.currentProgram);
  const nextProgram = usePlayerStore((s) => s.nextProgram);
  const setCurrentChannel = usePlayerStore((s) => s.setCurrentChannel);
  const setIsPlaying = usePlayerStore((s) => s.setIsPlaying);
  const setCurrentProgram = usePlayerStore((s) => s.setCurrentProgram);
  const setNextProgram = usePlayerStore((s) => s.setNextProgram);
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
          setCurrentProgram(null);
          setNextProgram(null);
        }
      } catch (err) {
        logger.error('Failed to check playback status:', err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isPlaying, setIsPlaying, setCurrentChannel, setCurrentProgram, setNextProgram, showToast]);

  // Update EPG periodically while playing
  useEffect(() => {
    if (!isPlaying || !currentChannel?.epg_id) return;

    const interval = setInterval(async () => {
      try {
        const [current, next] = await getChannelEpg(currentChannel.epg_id!);
        setCurrentProgram(current);
        setNextProgram(next);
      } catch (err) {
        logger.error('Failed to update EPG:', err);
      }
    }, 60000); // Update every minute

    return () => clearInterval(interval);
  }, [isPlaying, currentChannel, setCurrentProgram, setNextProgram]);

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
          setCurrentProgram(null);
          setNextProgram(null);
          return;
        }

        // Play new channel
        await tauriPlayChannel(channel);
        setCurrentChannel(channel);
        setIsPlaying(true);

        // Fetch EPG data if channel has EPG ID
        if (channel.epg_id) {
          try {
            const [current, next] = await getChannelEpg(channel.epg_id);
            setCurrentProgram(current);
            setNextProgram(next);
          } catch (err) {
            logger.error('Failed to fetch EPG:', err);
            setCurrentProgram(null);
            setNextProgram(null);
          }
        } else {
          setCurrentProgram(null);
          setNextProgram(null);
        }
      } catch (err) {
        logger.error('Failed to play channel:', err);
        showToast(`Couldn't start ${channel.name}.`);
        throw err;
      } finally {
        endPlaybackStart();
      }
    },
    [
      currentChannel,
      isPlaying,
      setCurrentChannel,
      setIsPlaying,
      setCurrentProgram,
      setNextProgram,
      showToast,
    ]
  );

  // Stop playback
  const stop = useCallback(async () => {
    try {
      await tauriStopPlayback();
      setIsPlaying(false);
      setCurrentProgram(null);
      setNextProgram(null);
    } catch (err) {
      logger.error('Failed to stop playback:', err);
      throw err;
    }
  }, [setIsPlaying, setCurrentProgram, setNextProgram]);

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
        if (remainingEpisodes && remainingEpisodes.length > 0) {
          // Play season playlist
          await playEpisodeWithSeason(
            playlist.url,
            playlist.xtream_username,
            playlist.xtream_password,
            remainingEpisodes
          );
          setIsPlaying(true);
        } else {
          // Fallback: play single episode
          const episodeUrl = `${playlist.url.replace(/\/$/, '')}/series/${playlist.xtream_username}/${playlist.xtream_password}/${episodeId}.${extension}`;

          const episodeChannel: Channel = {
            id: -1, // Virtual channel
            playlist_id: playlist.id || 0,
            name: title,
            url: episodeUrl,
            content_type: 'series',
            is_favorite: false,
            sort_order: 0,
          };

          await tauriPlayChannel(episodeChannel);
          setCurrentChannel(episodeChannel);
          setIsPlaying(true);
        }
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
          playlist_id: 0,
          name: title,
          url: '',
          content_type: 'series',
          is_favorite: false,
          sort_order: 0,
        });
        setIsPlaying(true);
        setCurrentProgram(null);
        setNextProgram(null);
      } catch (err) {
        logger.error('Failed to play local episodes:', err);
        showToast(`Couldn't start ${title}.`);
        throw err;
      } finally {
        endPlaybackStart();
      }
    },
    [setCurrentChannel, setIsPlaying, setCurrentProgram, setNextProgram, showToast]
  );

  return {
    currentChannel,
    isPlaying,
    currentProgram,
    nextProgram,
    play,
    stop,
    playEpisode,
    playLocalEpisodes,
  };
}
