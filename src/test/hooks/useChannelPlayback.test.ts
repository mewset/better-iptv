import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChannelPlayback } from '../../hooks/useChannelPlayback';
import { usePlayerStore } from '../../stores/player-store';
import { playSeriesEpisodes, playChannel, getPlaybackStatus } from '../../lib/tauri';
import { resetPlaybackGuard } from '../../lib/playGuard';
import type { Channel } from '../../types';

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
  playlist_id: 1,
  name: 'SVT1',
  url: 'http://x',
  content_type: 'live',
  is_favorite: false,
  sort_order: 0,
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
