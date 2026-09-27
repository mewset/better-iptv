import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useGuide } from '../../hooks/useGuide';
import { getGuide } from '../../lib/tauri';
import type { Channel } from '../../types';

vi.mock('../../lib/tauri', () => ({
  getGuide: vi.fn(),
}));

const mockedGetGuide = vi.mocked(getGuide);

const ch = (id: number, epg_id: string | null): Channel =>
  ({ id, name: `C${id}`, url: 'http://x', content_type: 'live', epg_id }) as Channel;

const programme = {
  title: 'News',
  description: null,
  start_time: '2026-09-24T18:00:00Z',
  end_time: '2026-09-24T18:30:00Z',
};

describe('useGuide', () => {
  beforeEach(() => {
    mockedGetGuide.mockReset();
    mockedGetGuide.mockResolvedValue({ a: [programme] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks only for non-blank, trimmed, de-duplicated epg ids', async () => {
    const channels = [ch(1, ' a '), ch(2, null), ch(3, '   '), ch(4, 'b'), ch(5, 'a')];
    const { result } = renderHook(() => useGuide(channels, 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedGetGuide).toHaveBeenCalledTimes(1);
    expect(mockedGetGuide.mock.calls[0][0]).toEqual(['a', 'b']);
    expect(result.current.programs).toEqual({ a: [programme] });
  });

  it('sends the window as RFC 3339 strings', async () => {
    const { result } = renderHook(() => useGuide([ch(1, 'a')], 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [, from, to] = mockedGetGuide.mock.calls[0];
    expect(Date.parse(from)).toBe(result.current.window.from);
    expect(Date.parse(to)).toBe(result.current.window.to);
    expect(result.current.window.to - result.current.window.from).toBe(3 * 3600_000);
  });

  it('caps the request at 100 ids', async () => {
    const channels = Array.from({ length: 130 }, (_, i) => ch(i + 1, `e${i}`));
    renderHook(() => useGuide(channels, 0));
    await waitFor(() => expect(mockedGetGuide).toHaveBeenCalled());
    expect(mockedGetGuide.mock.calls[0][0]).toHaveLength(100);
  });

  it('does not call the backend when no channel has an epg id', async () => {
    const { result } = renderHook(() => useGuide([ch(1, null)], 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedGetGuide).not.toHaveBeenCalled();
    expect(result.current.programs).toEqual({});
  });

  it('survives a rejected request with empty programmes', async () => {
    mockedGetGuide.mockRejectedValue(new Error('invalid epg id'));
    const { result } = renderHook(() => useGuide([ch(1, 'a')], 0));
    await waitFor(() => expect(mockedGetGuide).toHaveBeenCalled());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.programs).toEqual({});
  });

  it('refetches when the day changes and when the channel ids change', async () => {
    const { result, rerender } = renderHook(({ list, day }) => useGuide(list, day), {
      initialProps: { list: [ch(1, 'a')], day: 0 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedGetGuide).toHaveBeenCalledTimes(1);

    // Same ids in a new array: no refetch.
    rerender({ list: [ch(1, 'a')], day: 0 });
    expect(mockedGetGuide).toHaveBeenCalledTimes(1);

    rerender({ list: [ch(1, 'a')], day: 1 });
    await waitFor(() => expect(mockedGetGuide).toHaveBeenCalledTimes(2));
    const from = new Date(Date.parse(mockedGetGuide.mock.calls[1][1]));
    expect(from.getHours()).toBe(18);
    expect(from.getMinutes()).toBe(0);

    rerender({ list: [ch(1, 'a'), ch(2, 'b')], day: 1 });
    await waitFor(() => expect(mockedGetGuide).toHaveBeenCalledTimes(3));
    expect(mockedGetGuide.mock.calls[2][0]).toEqual(['a', 'b']);
  });

  it('refetches every five minutes', async () => {
    vi.useFakeTimers();
    renderHook(() => useGuide([ch(1, 'a')], 0));
    await act(async () => {});
    expect(mockedGetGuide).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(mockedGetGuide).toHaveBeenCalledTimes(2);
  });
});
