import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChannelPlayback } from '../../hooks/useChannelPlayback';
import { usePlayerStore } from '../../stores/player-store';
import {
  playSeriesEpisodes,
  playChannel,
  playEpisodeWithSeason,
  getPlaybackStatus,
} from '../../lib/tauri';
import { resetPlaybackGuard } from '../../lib/playGuard';
import type { Channel, Playlist } from '../../types';

vi.mock('../../lib/tauri', () => ({
  playChannel: vi.fn(),
  stopPlayback: vi.fn(),
  getPlaybackStatus: vi.fn().mockResolvedValue({ playing: false, failed: false }),
  getChannelEpg: vi.fn(),
  playEpisodeWithSeason: vi.fn(),
  playSeriesEpisodes: vi.fn().mockResolvedValue(undefined),
}));

describe('useChannelPlayback.playLocalEpisodes', () => {
  beforeEach(() => {
    vi.mocked(playSeriesEpisodes).mockClear();
    vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: false, failed: false });
    resetPlaybackGuard();
    usePlayerStore.setState({
      currentChannel: null,
      isPlaying: false,
      currentProgram: 'stale',
      nextProgram: 'stale',
    });
  });

  it('queues the ids in order and marks playback active', async () => {
    const { result } = renderHook(() => useChannelPlayback());

    await act(async () => {
      await result.current.playLocalEpisodes([31, 32, 33], 'Pilot');
    });

    expect(playSeriesEpisodes).toHaveBeenCalledWith([31, 32, 33]);
    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(true);
    expect(state.currentChannel?.name).toBe('Pilot');
    expect(state.currentChannel?.content_type).toBe('series');
    expect(state.currentProgram).toBeNull();
    expect(state.nextProgram).toBeNull();
  });

  it('rethrows and leaves playback state alone when the backend fails', async () => {
    vi.mocked(playSeriesEpisodes).mockRejectedValueOnce(new Error('mpv missing'));
    const { result } = renderHook(() => useChannelPlayback());

    await expect(
      act(async () => {
        await result.current.playLocalEpisodes([31], 'Pilot');
      })
    ).rejects.toThrow('mpv missing');

    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });
});

const svt1: Channel = {
  id: 1,
  name: 'SVT1',
  content_type: 'live',
  is_favorite: false,
};

describe('useChannelPlayback start guard and failure toast', () => {
  beforeEach(() => {
    vi.mocked(playChannel).mockReset().mockResolvedValue(undefined);
    vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: true, failed: false });
    resetPlaybackGuard();
    usePlayerStore.setState({ currentChannel: null, isPlaying: false, toast: null });
  });

  it('starts once when Play is pressed four times in the same second', async () => {
    const { result } = renderHook(() => useChannelPlayback());
    await act(async () => {
      await Promise.all([
        result.current.play(svt1),
        result.current.play(svt1),
        result.current.play(svt1),
        result.current.play(svt1),
      ]);
    });
    expect(playChannel).toHaveBeenCalledTimes(1);
  });

  it('shows a toast when MPV exits because the stream failed', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useChannelPlayback());
      await act(async () => {
        await result.current.play(svt1);
      });
      vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: false, failed: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      const toast = usePlayerStore.getState().toast;
      expect(toast?.message).toMatch(/Couldn't play SVT1/);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no toast when MPV was simply closed', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useChannelPlayback());
      await act(async () => {
        await result.current.play(svt1);
      });
      vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: false, failed: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(usePlayerStore.getState().toast).toBeNull();
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useChannelPlayback sends ids and episodes, never stream URLs', () => {
  const xtream: Playlist = {
    id: 3,
    name: 'IPTV',
    url: 'http://p.example:8080/',
    auto_refresh: false,
    xtream_username: 'alice',
    xtream_password: 's3cret',
  };

  beforeEach(() => {
    vi.mocked(playChannel).mockReset().mockResolvedValue(undefined);
    vi.mocked(playEpisodeWithSeason).mockReset().mockResolvedValue(undefined);
    vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: true, failed: false });
    resetPlaybackGuard();
    usePlayerStore.setState({ currentChannel: null, isPlaying: false, toast: null });
  });

  it('plays a channel by its id', async () => {
    const { result } = renderHook(() => useChannelPlayback());
    await act(async () => {
      await result.current.play(svt1);
    });
    expect(playChannel).toHaveBeenCalledWith(1);
  });

  it('plays a single episode through the episode path, not a URL built here', async () => {
    const { result } = renderHook(() => useChannelPlayback());
    await act(async () => {
      await result.current.playEpisode('901', 'mkv', 'Pilot', xtream);
    });
    expect(playChannel).not.toHaveBeenCalled();
    expect(playEpisodeWithSeason).toHaveBeenCalledWith(
      'http://p.example:8080/',
      'alice',
      's3cret',
      [{ id: '901', title: 'Pilot', extension: 'mkv' }]
    );
    expect(usePlayerStore.getState().currentChannel).toEqual({
      id: -1,
      name: 'Pilot',
      content_type: 'series',
      is_favorite: false,
    });
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it('plays the rest of the season when it is known', async () => {
    const rest = [
      { id: '901', title: 'Pilot', extension: 'mkv' },
      { id: '902', title: 'Two', extension: 'mkv' },
    ];
    const { result } = renderHook(() => useChannelPlayback());
    await act(async () => {
      await result.current.playEpisode('901', 'mkv', 'Pilot', xtream, rest);
    });
    expect(playEpisodeWithSeason).toHaveBeenCalledWith(
      'http://p.example:8080/',
      'alice',
      's3cret',
      rest
    );
  });
});
