import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePlayerStore } from '../../stores/player-store';

const listeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  getTmdbCards: vi.fn(),
}));

import { getTmdbCards } from '../../lib/tauri';
import { useTmdbCards } from '../../hooks/useTmdbCards';

const card = (channel_id: number) => ({
  channel_id,
  tmdb_id: 100 + channel_id,
  title: `T${channel_id}`,
  year: 2020,
  rating: 7,
  poster_url: null,
  backdrop_url: null,
  genres: [],
});

describe('useTmdbCards', () => {
  beforeEach(() => {
    // waitFor polls on timers; let them tick in real time too, or it never settles.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getTmdbCards).mockReset();
    listeners.clear();
    usePlayerStore.setState({
      tmdbCards: new Map(),
      currentPlaylist: { id: 1, name: 'P', auto_refresh: false },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests the missing ids once after the debounce and stores the reply', async () => {
    // Plain fake timers: real-time ticking would make the 299 ms step flaky.
    vi.useFakeTimers();
    vi.mocked(getTmdbCards).mockResolvedValue([card(1)]);
    const { result, rerender } = renderHook(({ ids }) => useTmdbCards(ids), {
      initialProps: { ids: [1, 2] },
    });
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(getTmdbCards).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(getTmdbCards).toHaveBeenCalledWith([1, 2]);
    expect(result.current.get(1)?.title).toBe('T1');
    // Same ids again (a scroll back): nothing new to ask for.
    rerender({ ids: [2, 1] });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(getTmdbCards).toHaveBeenCalledTimes(1);
  });

  it('keeps cards already in the store when it mounts', async () => {
    usePlayerStore.setState({ tmdbCards: new Map([[7, card(7)]]) });
    vi.mocked(getTmdbCards).mockResolvedValue([]);
    const { result } = renderHook(() => useTmdbCards([7]));
    await act(async () => {});
    expect(result.current.get(7)).toBeDefined();
    expect(usePlayerStore.getState().tmdbCards.get(7)).toBeDefined();
  });

  it('asks again for ids whose lookup failed', async () => {
    vi.mocked(getTmdbCards)
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValue([card(3)]);
    const { result, rerender } = renderHook(({ ids }) => useTmdbCards(ids), {
      initialProps: { ids: [3, 4] },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(getTmdbCards).toHaveBeenCalledTimes(1));
    rerender({ ids: [4, 3] });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(getTmdbCards).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getTmdbCards).mock.calls[1][0]).toEqual([4, 3]);
    await waitFor(() => expect(result.current.get(3)?.title).toBe('T3'));
  });

  it('merges tmdb-card events for every channel id in the payload', async () => {
    vi.mocked(getTmdbCards).mockResolvedValue([]);
    const { result } = renderHook(() => useTmdbCards([5, 6]));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(listeners.has('tmdb-card')).toBe(true));
    act(() => {
      listeners.get('tmdb-card')!({ payload: { channel_ids: [5, 6], card: card(5) } });
    });
    expect(result.current.get(5)?.tmdb_id).toBe(105);
    expect(result.current.get(6)?.tmdb_id).toBe(105);
    expect(result.current.get(6)?.channel_id).toBe(6);
  });

  it('asks again for the visible ids after the cache is cleared', async () => {
    vi.mocked(getTmdbCards).mockResolvedValue([card(1), card(2)]);
    const { result } = renderHook(() => useTmdbCards([1, 2]));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(result.current.size).toBe(2));
    // Settings' Save (key or language change) and "Clear cached metadata"
    // empty the store while MainScreen stays mounted.
    act(() => {
      usePlayerStore.getState().clearTmdbCards();
    });
    expect(usePlayerStore.getState().tmdbCards.size).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(getTmdbCards).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getTmdbCards).mock.calls[1][0]).toEqual([1, 2]);
    await waitFor(() => expect(result.current.size).toBe(2));
  });

  it('forgets everything on a profile switch and asks again', async () => {
    vi.mocked(getTmdbCards).mockResolvedValue([card(1)]);
    const { result } = renderHook(() => useTmdbCards([1]));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(result.current.size).toBe(1));
    act(() => {
      usePlayerStore.setState({ currentPlaylist: { id: 2, name: 'Q', auto_refresh: false } });
    });
    await waitFor(() => expect(usePlayerStore.getState().tmdbCards.size).toBe(0));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(getTmdbCards).toHaveBeenCalledTimes(2));
  });
});
