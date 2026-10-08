import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useGuide, GUIDE_REQUEST_IDS } from '../../hooks/useGuide';
import { getGuide, getGuideEpgIds } from '../../lib/tauri';
import { listen } from '@tauri-apps/api/event';
import type { Channel } from '../../types';

vi.mock('../../lib/tauri', () => ({
  getGuide: vi.fn(),
  getGuideEpgIds: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

const mockedGetGuide = vi.mocked(getGuide);
const mockedGetIds = vi.mocked(getGuideEpgIds);

const ch = (id: number, epg_id: string | null): Channel =>
  ({ id, name: `C${id}`, content_type: 'live', epg_id }) as Channel;

const programme = {
  title: 'News',
  description: null,
  start_time: '2026-09-24T18:00:00Z',
  end_time: '2026-09-24T18:30:00Z',
};

/** The handler useGuide registered for `epg-refreshed`. */
function epgRefreshed(): () => void {
  const call = vi.mocked(listen).mock.calls.find(([name]) => name === 'epg-refreshed');
  expect(call).toBeDefined();
  return () => (call![1] as (e: { payload: unknown }) => void)({ payload: null });
}

describe('useGuide', () => {
  beforeEach(() => {
    mockedGetGuide.mockReset().mockResolvedValue({ a: [programme] });
    mockedGetIds.mockReset().mockResolvedValue(['a', 'b']);
    vi.mocked(listen).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists only channels whose normalized id has guide data, in list order', async () => {
    const channels = [ch(1, 'B'), ch(2, 'none'), ch(3, ' a '), ch(4, null)];
    const { result } = renderHook(() => useGuide(channels, 0));
    expect(result.current.rowsLoading).toBe(true);
    await waitFor(() => expect(result.current.rowsLoading).toBe(false));
    expect(result.current.rows.map((c) => c.id)).toEqual([1, 3]);
  });

  it('asks for the five-day range once and the programmes of the row ids, normalized', async () => {
    const channels = [ch(1, 'B'), ch(2, ' a '), ch(3, 'a')];
    const { result } = renderHook(() => useGuide(channels, 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedGetIds).toHaveBeenCalledTimes(1);
    const [from, to] = mockedGetIds.mock.calls[0];
    expect(new Date(from).getHours()).toBe(0);
    expect(Date.parse(to) - Date.parse(from)).toBeGreaterThanOrEqual(5 * 23 * 3600_000);
    expect(mockedGetGuide).toHaveBeenCalledTimes(1);
    expect(mockedGetGuide.mock.calls[0][0]).toEqual(['b', 'a']);
    expect(result.current.programs).toEqual({ a: [programme] });
  });

  it('sends the visible window as RFC 3339 strings', async () => {
    const { result } = renderHook(() => useGuide([ch(1, 'a')], 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [, from, to] = mockedGetGuide.mock.calls[0];
    expect(Date.parse(from)).toBe(result.current.window.from);
    expect(Date.parse(to)).toBe(result.current.window.to);
  });

  it('splits more than 5,000 row ids into several requests and merges them', async () => {
    const n = GUIDE_REQUEST_IDS + 2;
    const channels = Array.from({ length: n }, (_, i) => ch(i + 1, `e${i}`));
    mockedGetIds.mockResolvedValue(channels.map((c) => c.epg_id!));
    mockedGetGuide.mockImplementation(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, []]))
    );
    const { result } = renderHook(() => useGuide(channels, 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedGetGuide.mock.calls.map((c) => c[0].length)).toEqual([GUIDE_REQUEST_IDS, 2]);
    expect(Object.keys(result.current.programs)).toHaveLength(n);
  });

  it('a category change that keeps the same row ids fetches nothing', async () => {
    const { result, rerender } = renderHook(({ list }) => useGuide(list, 0), {
      initialProps: { list: [ch(1, 'a'), ch(2, 'none')] },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ list: [ch(1, 'a')] });
    await act(async () => {});
    expect(mockedGetIds).toHaveBeenCalledTimes(1);
    expect(mockedGetGuide).toHaveBeenCalledTimes(1);
  });

  it('a day change fetches programmes again but not the ids', async () => {
    const { result, rerender } = renderHook(({ day }) => useGuide([ch(1, 'a')], day), {
      initialProps: { day: 0 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ day: 1 });
    await waitFor(() => expect(mockedGetGuide).toHaveBeenCalledTimes(2));
    expect(new Date(Date.parse(mockedGetGuide.mock.calls[1][1])).getHours()).toBe(18);
    expect(mockedGetIds).toHaveBeenCalledTimes(1);
  });

  it('epg-refreshed fetches both steps again', async () => {
    const { result } = renderHook(() => useGuide([ch(1, 'a'), ch(2, 'b')], 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockedGetIds.mockResolvedValue(['b']);
    await act(async () => epgRefreshed()());
    await waitFor(() => expect(result.current.rows.map((c) => c.id)).toEqual([2]));
    expect(mockedGetIds).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(mockedGetGuide).toHaveBeenCalledTimes(2));
    expect(mockedGetGuide.mock.calls[1][0]).toEqual(['b']);
  });

  it('refetches programmes every five minutes, and the ids when the date has changed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 8, 23, 58));
    renderHook(() => useGuide([ch(1, 'a')], 0));
    await act(async () => {});
    expect(mockedGetIds).toHaveBeenCalledTimes(1);
    expect(mockedGetGuide).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000); // 00:03 the next day
    });
    expect(mockedGetGuide).toHaveBeenCalledTimes(2);
    expect(mockedGetIds).toHaveBeenCalledTimes(2);
    expect(new Date(mockedGetIds.mock.calls[1][0]).getDate()).toBe(9);

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000); // same day: ids stay
    });
    expect(mockedGetGuide).toHaveBeenCalledTimes(3);
    expect(mockedGetIds).toHaveBeenCalledTimes(2);
  });

  it('never reports rows as loaded before their programmes have been asked for and answered', async () => {
    // A render with loading=false and no programmes makes every row flash
    // "No guide data" until the request lands.
    let answer!: (p: Record<string, (typeof programme)[]>) => void;
    mockedGetGuide.mockImplementation(() => new Promise((r) => (answer = r)));
    const seen: Array<{ loading: boolean; rows: number; programs: number }> = [];
    renderHook(() => {
      const state = useGuide([ch(1, 'a')], 0);
      seen.push({
        loading: state.loading,
        rows: state.rows.length,
        programs: Object.keys(state.programs).length,
      });
      return state;
    });
    await waitFor(() => expect(mockedGetGuide).toHaveBeenCalled());
    await act(async () => answer({ a: [programme] }));
    const loadedWithoutProgrammes = seen.filter(
      (r) => r.rows > 0 && !r.loading && r.programs === 0
    );
    expect(loadedWithoutProgrammes).toEqual([]);
    expect(seen.at(-1)).toEqual({ loading: false, rows: 1, programs: 1 });
  });

  it('falls back to every channel with an id when the lookup fails', async () => {
    mockedGetIds.mockRejectedValue(new Error('db locked'));
    const { result } = renderHook(() => useGuide([ch(1, 'a'), ch(2, 'x'), ch(3, null)], 0));
    await waitFor(() => expect(result.current.rowsLoading).toBe(false));
    expect(result.current.rows.map((c) => c.id)).toEqual([1, 2]);
  });

  it('an empty lookup answer means no rows, not endless loading', async () => {
    mockedGetIds.mockResolvedValue([]);
    const { result } = renderHook(() => useGuide([ch(1, 'a')], 0));
    await waitFor(() => expect(result.current.rowsLoading).toBe(false));
    expect(result.current.rows).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(mockedGetGuide).not.toHaveBeenCalled();
  });

  it('survives a rejected programme request with empty programmes', async () => {
    mockedGetGuide.mockRejectedValue(new Error('invalid epg id'));
    const { result } = renderHook(() => useGuide([ch(1, 'a')], 0));
    await waitFor(() => expect(mockedGetGuide).toHaveBeenCalled());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.programs).toEqual({});
  });
});
