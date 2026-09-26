import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('useHomeRows', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedListen.mockClear();
    mockedInvoke.mockResolvedValue(rows);
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
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    act(() => handler({ payload: { done: 10, total: 10, running: false } }));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(2));
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
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(2));
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
});
