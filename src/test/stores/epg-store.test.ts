import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useEpgStore } from '../../stores/epg-store';
import { epgStatus, nowNext, programme } from '../epgFixtures';

const mockedInvoke = vi.mocked(invoke);
const entry = (title: string) =>
  nowNext(programme(title, '2099-01-01T10:00:00+00:00', '2099-01-01T11:00:00+00:00'));
const none = new Set<string>();
const HOUR = 3_600_000;

describe('epg store', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    useEpgStore.setState(useEpgStore.getInitialState(), true);
  });

  it('stores hits and misses of one answer in one update', () => {
    let updates = 0;
    const unsubscribe = useEpgStore.subscribe(() => updates++);
    useEpgStore.getState().setNowNext(
      [
        ['a', entry('A')],
        ['b', entry('B')],
      ],
      ['c'],
      1000,
      0,
      none
    );
    unsubscribe();
    const { nowNext, missedAt, fetchedIn } = useEpgStore.getState();
    expect(updates).toBe(1);
    expect(nowNext.get('a')?.now?.title).toBe('A');
    expect(nowNext.get('b')?.now?.title).toBe('B');
    expect(missedAt.get('c')).toBe(1000);
    expect([...fetchedIn]).toEqual(['a', 'b', 'c']);
  });

  it('keeps the now/next map when an answer only brings misses', () => {
    useEpgStore.getState().setNowNext([['a', entry('A')]], [], 0, 0, none);
    const before = useEpgStore.getState().nowNext;
    useEpgStore.getState().setNowNext([], ['x', 'y'], 0, 0, none);
    expect(useEpgStore.getState().nowNext).toBe(before);
    // A miss for a key with an entry drops the entry.
    useEpgStore.getState().setNowNext([], ['a'], 0, 0, none);
    expect(useEpgStore.getState().nowNext.has('a')).toBe(false);
  });

  it('a hit clears an earlier miss', () => {
    useEpgStore.getState().setNowNext([], ['a'], 0, 0, none);
    useEpgStore.getState().setNowNext([['a', entry('A')]], [], 5, 0, none);
    expect(useEpgStore.getState().missedAt.has('a')).toBe(false);
  });

  it('invalidate starts a new generation, forgets what was answered and keeps entries on screen', () => {
    useEpgStore.getState().setNowNext([['a', entry('A')]], ['b'], 0, 0, none);
    useEpgStore.getState().invalidate();
    const state = useEpgStore.getState();
    expect(state.generation).toBe(1);
    expect(state.missedAt.size).toBe(0);
    expect(state.fetchedIn.size).toBe(0);
    expect(state.nowNext.get('a')?.now?.title).toBe('A');
  });

  it('keeps an old entry while its key is wanted and drops it once it is not', () => {
    useEpgStore.getState().setNowNext([['a', entry('A')]], [], 0, 0, none);
    useEpgStore.getState().invalidate();
    useEpgStore.getState().setNowNext([['b', entry('B')]], [], 0, 1, new Set(['a', 'b']));
    expect(useEpgStore.getState().nowNext.get('a')?.now?.title).toBe('A');
    useEpgStore.getState().setNowNext([['c', entry('C')]], [], 0, 1, new Set(['c']));
    expect([...useEpgStore.getState().nowNext.keys()].sort()).toEqual(['b', 'c']);
  });

  it('drops entries past their boundary and old misses of keys no longer wanted', () => {
    const t = Date.parse('2026-10-21T18:00:00Z');
    const ends = (title: string, min: number) =>
      nowNext(
        programme(title, new Date(t - HOUR).toISOString(), new Date(t + min * 60_000).toISOString())
      );
    useEpgStore.getState().setNowNext(
      [
        ['short', ends('S', 10)],
        ['long', ends('L', 60)],
      ],
      ['gone'],
      t,
      0,
      none
    );
    // Twenty minutes on: `short` has ended and `gone` may be asked again.
    const later = t + 20 * 60_000;
    useEpgStore.getState().setNowNext([['x', ends('X', 60)]], [], later, 0, new Set(['x']));
    const state = useEpgStore.getState();
    expect([...state.nowNext.keys()].sort()).toEqual(['long', 'x']);
    expect([...state.missedAt.keys()]).toEqual([]);
    expect([...state.fetchedIn].sort()).toEqual(['long', 'x']);
  });

  it('stays bounded by the wanted keys across many generations of scrolling', () => {
    for (let generation = 0; generation < 50; generation++) {
      const wanted = Array.from({ length: 100 }, (_, i) => `g${generation}-k${i}`);
      const hits = wanted
        .slice(0, 60)
        .map((k): [string, ReturnType<typeof entry>] => [k, entry(k)]);
      // Misses answered long enough ago to be asked again by the next round.
      const at = generation * 10 * 60_000;
      useEpgStore.getState().setNowNext(hits, wanted.slice(60), at, generation, new Set(wanted));
      useEpgStore.getState().invalidate();
    }
    const state = useEpgStore.getState();
    expect(state.nowNext.size).toBeLessThanOrEqual(100);
    expect(state.missedAt.size).toBe(0);
    expect(state.fetchedIn.size).toBe(0);
  });

  it('drops an answer to a request made before the last invalidate', () => {
    useEpgStore.getState().invalidate();
    useEpgStore.getState().setNowNext([['a', entry('Old')]], ['b'], 0, 0, none);
    const state = useEpgStore.getState();
    expect(state.nowNext.size).toBe(0);
    expect(state.missedAt.size).toBe(0);
  });

  it('asks for the status once and keeps it', async () => {
    mockedInvoke.mockResolvedValue(epgStatus(true));
    useEpgStore.getState().loadStatus();
    useEpgStore.getState().loadStatus();
    await vi.waitFor(() => expect(useEpgStore.getState().status).not.toBeNull());
    useEpgStore.getState().loadStatus();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith('get_epg_status');
  });

  it('an epg-status event that arrives first wins over the answer', async () => {
    let answer!: (s: unknown) => void;
    mockedInvoke.mockImplementation(() => new Promise((r) => (answer = r)));
    useEpgStore.getState().loadStatus();
    const fromEvent = epgStatus(false);
    useEpgStore.getState().setStatus(fromEvent);
    answer(epgStatus(true));
    await vi.waitFor(() => expect(useEpgStore.getState().statusLoading).toBe(false));
    expect(useEpgStore.getState().status).toBe(fromEvent);
  });

  it('a failed status request is marked and asked again on the next use', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('db locked'));
    useEpgStore.getState().loadStatus();
    await vi.waitFor(() => expect(useEpgStore.getState().statusFailed).toBe(true));
    expect(useEpgStore.getState().status).toBeNull();

    mockedInvoke.mockResolvedValueOnce(epgStatus(true));
    useEpgStore.getState().loadStatus();
    await vi.waitFor(() => expect(useEpgStore.getState().status).not.toBeNull());
    expect(useEpgStore.getState().statusFailed).toBe(false);
  });
});
