import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useHomeRows } from '../../hooks/useHomeRows';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

const rows = [{ genre: 'Action', content_type: 'vod', items: [] }];
const pick = {
  item: {
    channel_id: 7,
    tmdb_id: 70,
    title: 'Pick',
    year: 2021,
    rating: 8.1,
    poster_url: null,
    backdrop_url: null,
    genres: ['Drama'],
    overview: null,
  },
  source: 'trending',
};

function answer(cmd: string) {
  return cmd === 'get_home_pick' ? pick : rows;
}

function rowCalls() {
  return mockedInvoke.mock.calls.filter((c) => c[0] === 'get_home_rows').length;
}

describe('useHomeRows', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedListen.mockClear();
    mockedInvoke.mockImplementation(async (cmd: string) => answer(cmd));
  });

  it('does nothing while disabled', () => {
    const { result } = renderHook(() => useHomeRows(1, false));
    expect(result.current.rows).toEqual([]);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('loads the rows for the profile when enabled', async () => {
    const { result } = renderHook(() => useHomeRows(1, true));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.rows).toEqual(rows));
    expect(result.current.loading).toBe(false);
    expect(mockedInvoke).toHaveBeenCalledWith('get_home_rows', { playlistId: 1 });
  });

  it("loads the day's pick alongside the rows", async () => {
    const { result } = renderHook(() => useHomeRows(1, true));
    await waitFor(() => expect(result.current.pick).toEqual(pick));
    expect(mockedInvoke).toHaveBeenCalledWith('get_home_pick', { playlistId: 1 });
  });

  it('a rejected pick leaves the rows alone', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_home_pick') throw new Error('no pick');
      return rows;
    });
    const { result } = renderHook(() => useHomeRows(1, true));
    await waitFor(() => expect(result.current.rows).toEqual(rows));
    expect(result.current.pick).toBeNull();
  });

  it('reloads on a profile switch', async () => {
    const { result, rerender } = renderHook(({ id }) => useHomeRows(id, true), {
      initialProps: { id: 1 },
    });
    await waitFor(() => expect(result.current.rows).toEqual(rows));
    rerender({ id: 2 });
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('get_home_rows', { playlistId: 2 }));
  });

  it('reloads when the background scan finishes and exposes the progress', async () => {
    const { result } = renderHook(() => useHomeRows(1, true));
    await waitFor(() => expect(result.current.rows).toEqual(rows));
    const handler = mockedListen.mock.calls[0][1] as (e: { payload: unknown }) => void;
    act(() => handler({ payload: { done: 3, total: 10, running: true } }));
    expect(result.current.progress).toEqual({ done: 3, total: 10, running: true });
    expect(rowCalls()).toBe(1);
    act(() => handler({ payload: { done: 10, total: 10, running: false } }));
    await waitFor(() => expect(rowCalls()).toBe(2));
  });

  it('logs and shows nothing when the command rejects', async () => {
    mockedInvoke.mockRejectedValue(new Error('db gone'));
    const { result } = renderHook(() => useHomeRows(1, true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([]);
  });

  it('clears the progress when disabled', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useHomeRows(1, enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.rows).toEqual(rows));
    const handler = mockedListen.mock.calls[0][1] as (e: { payload: unknown }) => void;
    act(() => handler({ payload: { done: 3, total: 10, running: true } }));
    expect(result.current.progress).toEqual({ done: 3, total: 10, running: true });
    rerender({ enabled: false });
    expect(result.current.progress).toBeNull();
    expect(result.current.rows).toEqual([]);
  });

  it('a scan-finish reload keeps the rows on screen without a skeleton', async () => {
    const { result } = renderHook(() => useHomeRows(1, true));
    await waitFor(() => expect(result.current.rows).toEqual(rows));
    const handler = mockedListen.mock.calls[0][1] as (e: { payload: unknown }) => void;
    act(() => handler({ payload: { done: 10, total: 10, running: false } }));
    expect(result.current.loading).toBe(false);
    expect(result.current.rows).toEqual(rows);
    await waitFor(() => expect(rowCalls()).toBe(2));
  });

  it('a profile switch shows the skeleton', async () => {
    const { result, rerender } = renderHook(({ id }) => useHomeRows(id, true), {
      initialProps: { id: 1 },
    });
    await waitFor(() => expect(result.current.rows).toEqual(rows));
    rerender({ id: 2 });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  describe('midnight rollover', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('refetches when the local date changes while Home stays open', async () => {
      // shouldAdvanceTime: waitFor's own polling still needs real elapsed
      // time to fire; only the app's setInterval is driven explicitly below.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date('2026-09-26T23:59:30'));
      const { result } = renderHook(() => useHomeRows(1, true));
      await waitFor(() => expect(rowCalls()).toBe(1));
      vi.setSystemTime(new Date('2026-09-27T00:00:30'));
      act(() => vi.advanceTimersByTime(60_000));
      await waitFor(() => expect(rowCalls()).toBe(2));
      void result;
    });
  });
});
