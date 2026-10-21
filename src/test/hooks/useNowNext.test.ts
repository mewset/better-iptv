import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { getEpgNowNext, type NowNext } from '../../lib/epgIpc';
import { useEpgStore } from '../../stores/epg-store';
import { EMPTY_RETRY_MS, epgKey, nowNextFor, useNowNext } from '../../hooks/useNowNext';
import { nowNext, programme } from '../epgFixtures';
import type { Channel } from '../../types';

vi.mock('../../lib/epgIpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/epgIpc')>()),
  getEpgNowNext: vi.fn(),
}));

const mocked = vi.mocked(getEpgNowNext);

const makeChannel = (overrides: Partial<Channel>): Channel => ({
  id: 1,
  name: 'Test',
  content_type: 'live',
  is_favorite: false,
  ...overrides,
});

/** RFC 3339 `m` minutes from now (the fake or real clock). */
const at = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const airing = (title: string, startMin = -10, stopMin = 50): NowNext =>
  nowNext(programme(title, at(startMin), at(stopMin)));
/** Answers every key asked with `entry(key)`, or leaves it out when that is undefined. */
function answerWith(entry: (key: string) => NowNext | undefined) {
  mocked.mockImplementation(async (keys: string[]) => {
    const out: Record<string, NowNext> = {};
    for (const key of keys) {
      const e = entry(key);
      if (e) out[key] = e;
    }
    return out;
  });
}
const store = () => useEpgStore.getState();
const none = new Set<string>();

describe('useNowNext', () => {
  beforeEach(() => {
    mocked.mockReset();
    useEpgStore.setState(useEpgStore.getInitialState(), true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for every live channel with an epg_id in one call, by its key', async () => {
    answerWith((key) =>
      key === 'svt1.se'
        ? nowNext(programme('Rapport', at(-10), at(20)), programme('Aktuellt', at(20), at(50)))
        : key === 'tv4.se'
          ? airing('Nyheterna')
          : undefined
    );
    const channels = [
      makeChannel({ id: 1, name: 'SVT1', epg_id: 'svt1.se' }),
      makeChannel({ id: 2, name: 'TV4', epg_id: 'tv4.se' }),
      makeChannel({ id: 3, name: 'No EPG' }),
      makeChannel({ id: 4, name: 'Movie', epg_id: 'movie.id', content_type: 'vod' }),
    ];

    const { result } = renderHook(() => useNowNext(channels));

    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(mocked).toHaveBeenCalledWith(['svt1.se', 'tv4.se']);
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(nowNextFor(result.current, channels[0])?.now?.title).toBe('Rapport');
    expect(nowNextFor(result.current, channels[0])?.next?.title).toBe('Aktuellt');
    expect(nowNextFor(result.current, channels[1])?.now?.title).toBe('Nyheterna');
    expect(nowNextFor(result.current, channels[2])).toBeUndefined();
    expect(nowNextFor(result.current, channels[3])).toBeUndefined();
  });

  it('two channels with one key cost one key and share one entry', async () => {
    answerWith(() => airing('Rapport'));
    const a = makeChannel({ id: 1, epg_id: 'svt1.se' });
    const b = makeChannel({ id: 2, epg_id: 'svt1.se' });

    const { result } = renderHook(() => useNowNext([a, b]));

    await waitFor(() => expect(result.current.size).toBe(1), { timeout: 2000 });
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith(['svt1.se']);
    expect(nowNextFor(result.current, a)).toBe(nowNextFor(result.current, b));
  });

  it('the dock and the card of the playing channel read the same entry from one key', async () => {
    answerWith(() => airing('Rapport'));
    const svt1 = makeChannel({ id: 1, epg_id: 'svt1.se' });

    const { result } = renderHook(() => useNowNext([svt1], { ...svt1 }));

    await waitFor(() => expect(result.current.size).toBe(1), { timeout: 2000 });
    expect(mocked).toHaveBeenCalledWith(['svt1.se']);
    expect(nowNextFor(result.current, svt1)).toBe(store().nowNext.get('svt1.se'));
  });

  it('does not stall behind channels without guide data', async () => {
    // 120 keys the guide knows nothing about, then 30 it does. The batch
    // holds 100, so the first is all misses; the next must reach the rest.
    const channels = Array.from({ length: 150 }, (_, i) =>
      makeChannel({ id: i + 1, name: `C${i}`, epg_id: `c${i}` })
    );
    answerWith((key) => (Number(key.slice(1)) >= 120 ? airing(`Show ${key}`) : undefined));

    const { result } = renderHook(() => useNowNext(channels));

    await waitFor(
      () => expect(nowNextFor(result.current, channels[149])?.now?.title).toBe('Show c149'),
      { timeout: 3000 }
    );
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[0][0]).toHaveLength(100);
    expect(mocked.mock.calls[1][0]).toHaveLength(50);
  });

  it('asks in batches of at most 100 keys until every wanted key is answered', async () => {
    const channels = Array.from({ length: 250 }, (_, i) =>
      makeChannel({ id: i + 1, epg_id: `k${i}` })
    );
    answerWith((key) => airing(key));

    const { result } = renderHook(() => useNowNext(channels));

    await waitFor(() => expect(result.current.size).toBe(250), { timeout: 4000 });
    expect(mocked.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 50]);
    const asked = mocked.mock.calls.flatMap((c) => c[0]);
    expect(new Set(asked).size).toBe(250);
  });

  it('puts the playing channel first, so the cap never drops it', async () => {
    const channels = Array.from({ length: 150 }, (_, i) =>
      makeChannel({ id: i + 1, epg_id: `c${i}` })
    );
    const playing = makeChannel({ id: 999, name: 'Kanal 5', epg_id: 'kanal5.se' });
    answerWith((key) => airing(key));

    renderHook(() => useNowNext(channels, playing));

    await waitFor(() => expect(mocked).toHaveBeenCalled(), { timeout: 2000 });
    expect(mocked.mock.calls[0][0][0]).toBe('kanal5.se');
  });

  it('does not ask again for keys the guide had nothing for', async () => {
    mocked.mockResolvedValue({});
    const channels = [makeChannel({ id: 1, name: 'No data', epg_id: 'none.se' })];

    const { rerender } = renderHook(({ list }) => useNowNext(list), {
      initialProps: { list: channels },
    });
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1), { timeout: 2000 });

    // Scrolling away and back hands the hook a new array with the same channel.
    rerender({ list: [...channels] });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(store().missedAt.has('none.se')).toBe(true);
  });

  it('asks for a miss again after five minutes', async () => {
    vi.useFakeTimers();
    mocked.mockResolvedValue({});
    renderHook(() => useNowNext([makeChannel({ id: 1, epg_id: 'none.se' })]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mocked).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EMPTY_RETRY_MS - 1000);
    });
    expect(mocked).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('asks for the new key when a channel’s epg_id changes, and stops reading the old entry', async () => {
    answerWith((key) => (key === 'kanal5.se' ? airing('Ny') : undefined));
    const { result, rerender } = renderHook(({ list }) => useNowNext(list), {
      initialProps: { list: [makeChannel({ id: 1, epg_id: 'kanal 5.se' })] },
    });
    await waitFor(() => expect(mocked).toHaveBeenCalledWith(['kanal 5.se']), { timeout: 2000 });

    // A playlist refresh renamed the id; same channel row.
    const renamed = makeChannel({ id: 1, epg_id: 'kanal5.se' });
    rerender({ list: [renamed] });

    await waitFor(() => expect(nowNextFor(result.current, renamed)?.now?.title).toBe('Ny'), {
      timeout: 2000,
    });
  });

  it('stores a whole batch with one store update', async () => {
    answerWith(() => airing('P'));
    let updates = 0;
    const unsubscribe = useEpgStore.subscribe((state, prev) => {
      if (state.nowNext !== prev.nowNext) updates++;
    });

    renderHook(() =>
      useNowNext([
        makeChannel({ id: 1, epg_id: 'a.se' }),
        makeChannel({ id: 2, epg_id: 'b.se' }),
        makeChannel({ id: 3, epg_id: 'c.se' }),
      ])
    );

    await waitFor(() => expect(store().nowNext.size).toBe(3), { timeout: 2000 });
    unsubscribe();
    expect(updates).toBe(1);
  });

  it('asks again for a wanted key whose cached programme has ended', async () => {
    store().setNowNext(
      [['svt1.se', nowNext(programme('Old show', at(-90), at(-30)))]],
      [],
      0,
      0,
      none
    );
    answerWith(() => airing('New show'));

    const { result } = renderHook(() =>
      useNowNext([makeChannel({ id: 1, name: 'SVT1', epg_id: 'svt1.se' })])
    );

    await waitFor(() => expect(result.current.get('svt1.se')?.now?.title).toBe('New show'), {
      timeout: 2000,
    });
  });

  it('asks again for the playing channel when its cached programme has ended', async () => {
    store().setNowNext(
      [['kanal5.se', nowNext(programme('Old show', at(-90), at(-30)))]],
      [],
      0,
      0,
      none
    );
    answerWith(() => airing('New show'));
    const playing = makeChannel({ id: 9, name: 'Kanal 5', epg_id: 'kanal5.se' });

    renderHook(() => useNowNext([], playing));

    await waitFor(() => expect(mocked).toHaveBeenCalledWith(['kanal5.se']), { timeout: 2000 });
    await waitFor(() => expect(store().nowNext.get('kanal5.se')?.now?.title).toBe('New show'));
  });

  it('keeps a channel that is off air but has a next programme', async () => {
    const offAir = nowNext(null, programme('Spårlöst försvunnen', at(30), at(90)));
    answerWith(() => offAir);

    renderHook(() => useNowNext([makeChannel({ id: 7, name: 'SVT2', epg_id: 'svt2.se' })]));

    await waitFor(() => expect(store().nowNext.get('svt2.se')).toEqual(offAir), {
      timeout: 2000,
    });
  });

  it('does not call the backend when no channel has an epg_id', async () => {
    renderHook(() =>
      useNowNext([makeChannel({ id: 1 }), makeChannel({ id: 2, epg_id: '' })], null)
    );

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(mocked).not.toHaveBeenCalled();
  });

  it('an epg-refreshed asks for every wanted key again and keeps entries until answered', async () => {
    answerWith(() => airing('Rapport'));
    const channels = [
      makeChannel({ id: 1, name: 'SVT1', epg_id: 'svt1.se' }),
      makeChannel({ id: 2, name: 'Gone', epg_id: 'gone.se' }),
    ];
    const { result } = renderHook(() => useNowNext(channels));
    await waitFor(() => expect(result.current.size).toBe(2), { timeout: 2000 });

    let answer!: (r: Record<string, NowNext>) => void;
    mocked.mockImplementation(() => new Promise((r) => (answer = r)));
    act(() => store().invalidate());
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(mocked.mock.calls[1][0]).toEqual(['svt1.se', 'gone.se']);
    // Still on screen while the request runs: no flash of "No guide data".
    expect(result.current.get('svt1.se')?.now?.title).toBe('Rapport');

    await act(async () => answer({ 'svt1.se': airing('Sport') }));
    expect(result.current.get('svt1.se')?.now?.title).toBe('Sport');
    expect(result.current.has('gone.se')).toBe(false);
  });

  it('an epg-refreshed asks again for a key that was a miss', async () => {
    mocked.mockResolvedValue({});
    renderHook(() => useNowNext([makeChannel({ id: 1, epg_id: 'new.se' })]));
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1), { timeout: 2000 });

    answerWith(() => airing('First day'));
    act(() => store().invalidate());

    await waitFor(() => expect(store().nowNext.get('new.se')?.now?.title).toBe('First day'), {
      timeout: 2000,
    });
  });

  it('drops an answer that was asked for before an epg-refreshed', async () => {
    let first!: (r: Record<string, NowNext>) => void;
    mocked.mockImplementationOnce(() => new Promise((r) => (first = r)));
    renderHook(() => useNowNext([makeChannel({ id: 1, epg_id: 'svt1.se' })]));
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1), { timeout: 2000 });

    answerWith(() => airing('Fresh'));
    act(() => store().invalidate());
    await act(async () => first({ 'svt1.se': airing('Old') }));
    await waitFor(() => expect(store().nowNext.get('svt1.se')?.now?.title).toBe('Fresh'), {
      timeout: 2000,
    });
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('asks at the next programme boundary, only for the keys whose programme ended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T18:00:00Z'));
    answerWith((key) =>
      key === 'short.se'
        ? nowNext(programme('Short', at(-5), at(10)), programme('After', at(10), at(40)))
        : airing('Long', -5, 60)
    );
    renderHook(() =>
      useNowNext([
        makeChannel({ id: 1, epg_id: 'short.se' }),
        makeChannel({ id: 2, epg_id: 'long.se' }),
      ])
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mocked).toHaveBeenCalledTimes(1);

    answerWith(() => airing('After', 0, 30));
    // Nothing before the boundary: no polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 600 - 1000);
    });
    expect(mocked).toHaveBeenCalledTimes(1);

    // The entry was answered 500 ms in; its boundary plus a second is due now.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[1][0]).toEqual(['short.se']);
    expect(store().nowNext.get('short.se')?.now?.title).toBe('After');
  });

  it('asks at once for an entry past its boundary when the timer was re-armed after it', async () => {
    // The clock passes the boundary without the timer firing (a busy or
    // suspended page), then something re-arms the timer: the boundary is
    // behind it, so only an immediate request still catches it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T18:00:00Z'));
    answerWith((key) => (key === 'a.se' ? airing('A', -5, 10) : airing('B', -5, 60)));
    const a = makeChannel({ id: 1, epg_id: 'a.se' });
    const b = makeChannel({ id: 2, epg_id: 'b.se' });
    const { rerender } = renderHook(({ list }) => useNowNext(list), {
      initialProps: { list: [a] },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mocked).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 10 * 60_000 + 5000);
    answerWith(() => airing('After', 0, 30));
    rerender({ list: [a, b] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // At once, not after the 500 ms debounce of the new list.
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[1][0]).toContain('a.se');
    expect(store().nowNext.get('a.se')?.now?.title).toBe('After');
  });

  it('a batch of misses does not re-render the caller', async () => {
    mocked.mockResolvedValue({});
    let renders = 0;
    renderHook(() => {
      renders++;
      return useNowNext([makeChannel({ id: 1, epg_id: 'none.se' })]);
    });
    await waitFor(() => expect(store().missedAt.has('none.se')).toBe(true), { timeout: 2000 });
    const after = renders;
    act(() => store().setNowNext([], ['other.se'], Date.now(), 0, none));
    expect(renders).toBe(after);
  });

  it('an off-air entry is asked again when its next programme begins', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T18:00:00Z'));
    answerWith(() => nowNext(null, programme('Morgon', at(30), at(90))));
    renderHook(() => useNowNext([makeChannel({ id: 1, epg_id: 'svt2.se' })]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mocked).toHaveBeenCalledTimes(1);

    answerWith(() => airing('Morgon', 0, 60));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000 - 2000);
    });
    expect(mocked).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('after a failed request asks again in five minutes, not in a loop', async () => {
    vi.useFakeTimers();
    mocked.mockRejectedValue(new Error('db locked'));
    renderHook(() => useNowNext([makeChannel({ id: 1, epg_id: 'svt1.se' })]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EMPTY_RETRY_MS - 1000);
    });
    expect(mocked).toHaveBeenCalledTimes(1);

    answerWith(() => airing('Rapport'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(store().nowNext.get('svt1.se')?.now?.title).toBe('Rapport');
  });
});

describe('epgKey', () => {
  it('is the epg_id of a live channel as the backend sent it', () => {
    // `epg_id` is already the backend's match key: never trimmed or
    // lower-cased again, so both sides use one key.
    expect(epgKey(makeChannel({ epg_id: 'ämne.se' }))).toBe('ämne.se');
    expect(epgKey(makeChannel({ epg_id: ' Ämne.SE ' }))).toBe(' Ämne.SE ');
    expect(epgKey(makeChannel({ epg_id: '' }))).toBeNull();
    expect(epgKey(makeChannel({}))).toBeNull();
    expect(epgKey(makeChannel({ epg_id: 'x.se', content_type: 'series' }))).toBeNull();
  });
});
