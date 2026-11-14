import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChannelPlayback } from '../../hooks/useChannelPlayback';
import { usePlayerStore } from '../../stores/player-store';
import {
  playSeriesEpisodes,
  playChannel,
  playEpisodeWithSeason,
  getPlaybackStatus,
  stopPlayback,
} from '../../lib/tauri';
import { resetPlaybackGuard } from '../../lib/playGuard';
import type { Channel, Playlist } from '../../types';

vi.mock('../../lib/tauri', () => ({
  playChannel: vi.fn(),
  stopPlayback: vi.fn(),
  getPlaybackStatus: vi.fn().mockResolvedValue({ playing: false, failure: null }),
  playEpisodeWithSeason: vi.fn(),
  playSeriesEpisodes: vi.fn().mockResolvedValue(undefined),
}));

describe('useChannelPlayback.playLocalEpisodes', () => {
  beforeEach(() => {
    vi.mocked(playSeriesEpisodes).mockClear();
    vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: false, failure: null });
    resetPlaybackGuard();
    usePlayerStore.setState({
      currentChannel: null,
      isPlaying: false,
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
const tv4: Channel = { id: 2, name: 'TV4', content_type: 'live', is_favorite: false };

describe('useChannelPlayback start guard and failure toast', () => {
  beforeEach(() => {
    vi.mocked(playChannel).mockReset().mockResolvedValue(undefined);
    vi.mocked(stopPlayback).mockReset().mockResolvedValue(undefined);
    vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: true, failure: null });
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

  it('Stop leaves nothing current', async () => {
    const { result } = renderHook(() => useChannelPlayback());
    await act(async () => {
      await result.current.play(svt1);
    });
    await act(async () => {
      await result.current.stop();
    });
    expect(stopPlayback).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().currentChannel).toBeNull();
  });

  it('a click on the playing card stops it, also right after the start', async () => {
    const { result } = renderHook(() => useChannelPlayback());
    await act(async () => {
      await result.current.play(svt1);
    });
    // Well inside the start cooldown: a stop is never held back by it.
    await act(async () => {
      await result.current.play(svt1);
    });
    expect(stopPlayback).toHaveBeenCalledTimes(1);
    expect(playChannel).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().currentChannel).toBeNull();
  });

  it('a stop does not hold up the next start', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useChannelPlayback());
      await act(async () => {
        await result.current.play(svt1);
      });
      // Past the cooldown of that start; the stop must not begin a new one.
      vi.setSystemTime(Date.now() + 2500);
      await act(async () => {
        await result.current.play(svt1);
      });
      await act(async () => {
        await result.current.play(tv4);
      });
      expect(playChannel).toHaveBeenLastCalledWith(2);
      expect(usePlayerStore.getState().currentChannel?.name).toBe('TV4');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a toast when MPV exits because the stream failed', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useChannelPlayback());
      await act(async () => {
        await result.current.play(svt1);
      });
      vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: false, failure: 'stream' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      const toast = usePlayerStore.getState().toast;
      expect(toast?.message).toBe(
        "Couldn't play SVT1. The provider refused the stream, maybe because your line is already in use."
      );
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when it was mpv itself that could not start', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useChannelPlayback());
      await act(async () => {
        await result.current.play(svt1);
      });
      vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: false, failure: 'player' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(usePlayerStore.getState().toast?.message).toBe(
        "Couldn't play SVT1. mpv could not start. Check the video settings in Settings → Playback, or update mpv."
      );
      expect(usePlayerStore.getState().currentChannel).toBeNull();
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
      vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: false, failure: null });
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
    vi.mocked(getPlaybackStatus).mockResolvedValue({ playing: true, failure: null });
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

  it('a season start replaces what was playing in the dock', async () => {
    const rest = [
      { id: '901', title: 'Pilot', extension: 'mkv' },
      { id: '902', title: 'Two', extension: 'mkv' },
    ];
    usePlayerStore.setState({ currentChannel: svt1, isPlaying: true });
    const { result } = renderHook(() => useChannelPlayback());
    await act(async () => {
      await result.current.playEpisode('901', 'mkv', 'Pilot', xtream, rest);
    });
    expect(usePlayerStore.getState().currentChannel).toEqual({
      id: -1,
      name: 'Pilot',
      content_type: 'series',
      is_favorite: false,
    });
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });
});
