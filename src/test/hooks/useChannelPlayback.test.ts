import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChannelPlayback } from '../../hooks/useChannelPlayback';
import { usePlayerStore } from '../../stores/player-store';
import { playSeriesEpisodes, isPlaying as checkIsPlaying } from '../../lib/tauri';

vi.mock('../../lib/tauri', () => ({
  playChannel: vi.fn(),
  stopPlayback: vi.fn(),
  isPlaying: vi.fn().mockResolvedValue(false),
  getChannelEpg: vi.fn(),
  playEpisodeWithSeason: vi.fn(),
  playSeriesEpisodes: vi.fn().mockResolvedValue(undefined),
}));

describe('useChannelPlayback.playLocalEpisodes', () => {
  beforeEach(() => {
    vi.mocked(playSeriesEpisodes).mockClear();
    vi.mocked(checkIsPlaying).mockResolvedValue(false);
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
