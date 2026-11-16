import { useCallback, useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import {
  playChannel as tauriPlayChannel,
  getPlaybackStatus,
  playEpisodeWithSeason,
  playSeriesEpisodes,
  playerPaused,
  type PlaybackStatus,
  type PlaylistEpisode,
} from '../lib/tauri';
import { logger } from '../lib/logger';
import { errorText } from '../lib/errorText';
import { beginPlaybackStart, endPlaybackStart } from '../lib/playGuard';
import type { Channel, Playlist } from '../types';
import { useProgressStore } from '../stores/progress-store';
import { useNowPlayingStore, type QueuedTitle } from '../stores/now-playing-store';
import { progressKey, resumeSecs } from '../lib/watchProgress';

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
  /** Stop current playback (the store's `stopPlayback`; never rejects) */
  stop: () => Promise<void>;
  /** Play episode(s) from a series */
  playEpisode: (
    episodeId: string,
    extension: string,
    title: string,
    playlist: Playlist,
    remainingEpisodes?: PlaylistEpisode[],
    seriesChannelId?: number,
    startSecs?: number
  ) => Promise<void>;
  /** Play stored M3U episodes by database id, in the order given */
  playLocalEpisodes: (
    episodeIds: number[],
    title: string,
    startSecs?: number,
    seriesChannelId?: number,
    queue?: QueuedTitle[]
  ) => Promise<void>;
}

/** Why mpv exited by itself, after "Couldn't play X." in the toast. */
const FAILURE_TEXT: Record<NonNullable<PlaybackStatus['failure']>, string> = {
  stream: 'The provider refused the stream, maybe because your line is already in use.',
  player: 'mpv could not start. Check the video settings in Settings → Playback, or update mpv.',
};

/**
 * What the dock shows while episodes play. Every successful start sets what
 * is playing, and an episode has no row in `channels` (its id belongs to the
 * provider or to series_episodes), so it gets a virtual channel.
 */
/** The bar's record of episodes playing: their series and the queue. */
function recordEpisodes(seriesChannelId: number | undefined, queue: QueuedTitle[] | undefined) {
  const series =
    seriesChannelId === undefined
      ? undefined
      : usePlayerStore.getState().channels.find((c) => c.id === seriesChannelId);
  useNowPlayingStore
    .getState()
    .setInfo(series ? { kind: 'episode', channel: series, queue: queue ?? [] } : null);
}

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
          // MPV exited: closed by the user, or it failed, which used to look
          // like nothing happened at all.
          if (status.failure) {
            const name = usePlayerStore.getState().currentChannel?.name ?? 'this stream';
            showToast(`Couldn't play ${name}. ${FAILURE_TEXT[status.failure]}`);
          }
          playbackEnded();
          useNowPlayingStore.getState().setInfo(null);
        } else {
          // The bar shows play or pause as the player has it (also paused in MPV itself)
          const paused = await playerPaused().catch(() => null);
          if (paused !== null && paused !== useNowPlayingStore.getState().paused) {
            useNowPlayingStore.getState().setPaused(paused);
          }
        }
      } catch (err) {
        logger.error('Failed to check playback status:', err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isPlaying, playbackEnded, showToast]);

  // Watch progress: the backend saves it every few seconds while a film or
  // episode plays; reload it then, when playback starts or stops, and on a
  // profile switch.
  const playlistId = usePlayerStore((s) => s.currentPlaylist?.id ?? null);
  const loadProgress = useProgressStore((s) => s.load);
  useEffect(() => {
    void loadProgress(playlistId);
    if (!isPlaying || playlistId === null) return;
    const interval = setInterval(() => void loadProgress(playlistId), 15_000);
    return () => clearInterval(interval);
  }, [isPlaying, playlistId, loadProgress]);

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
        // A film picks up where it was left ("Start over" forgets that first)
        const start =
          channel.content_type === 'vod'
            ? resumeSecs(useProgressStore.getState().index.byKey.get(progressKey(channel.id)))
            : undefined;
        await tauriPlayChannel(channel.id, start);
        setCurrentChannel(channel);
        useNowPlayingStore
          .getState()
          .setInfo({ kind: channel.content_type === 'live' ? 'live' : 'film', channel });
        setIsPlaying(true);
      } catch (err) {
        logger.error('Failed to play channel:', err);
        showToast(`Couldn't start ${channel.name}: ${errorText(err)}`);
        throw err;
      } finally {
        endPlaybackStart();
      }
    },
    [currentChannel, isPlaying, setCurrentChannel, setIsPlaying, stopPlayback, showToast]
  );

  // Play episode(s) from a series
  const playEpisode = useCallback(
    async (
      episodeId: string,
      extension: string,
      title: string,
      playlist: Playlist,
      remainingEpisodes?: PlaylistEpisode[],
      seriesChannelId?: number,
      startSecs?: number
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
          season ? remainingEpisodes : [{ id: episodeId, title, extension }],
          seriesChannelId,
          startSecs
        );
        setCurrentChannel(episodeChannel(title));
        recordEpisodes(seriesChannelId, season ? remainingEpisodes : [{ id: episodeId, title }]);
        setIsPlaying(true);
      } catch (err) {
        logger.error('Failed to play episode:', err);
        showToast(`Couldn't start ${title}: ${errorText(err)}`);
        throw err;
      } finally {
        endPlaybackStart();
      }
    },
    [setCurrentChannel, setIsPlaying, showToast]
  );

  // Play stored M3U episodes (grouped at import) by database id
  const playLocalEpisodes = useCallback(
    async (
      episodeIds: number[],
      title: string,
      startSecs?: number,
      seriesChannelId?: number,
      queue?: QueuedTitle[]
    ) => {
      if (!beginPlaybackStart()) return;
      try {
        await playSeriesEpisodes(episodeIds, startSecs);
        setCurrentChannel(episodeChannel(title));
        recordEpisodes(seriesChannelId, queue);
        setIsPlaying(true);
      } catch (err) {
        logger.error('Failed to play local episodes:', err);
        showToast(`Couldn't start ${title}: ${errorText(err)}`);
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
    stop: stopPlayback,
    playEpisode,
    playLocalEpisodes,
  };
}
