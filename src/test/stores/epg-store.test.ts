import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useEpgStore } from '../../stores/epg-store';
import { epgStatus, nowNext, programme } from '../epgFixtures';

const mockedInvoke = vi.mocked(invoke);
const entry = (title: string) =>
  nowNext(programme(title, '2099-01-01T10:00:00+00:00', '2099-01-01T11:00:00+00:00'));

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
      0
    );
    unsubscribe();
    const { nowNext, missedAt, fetchedIn } = useEpgStore.getState();
    expect(updates).toBe(1);
    expect(nowNext.get('a')?.now?.title).toBe('A');
    expect(nowNext.get('b')?.now?.title).toBe('B');
    expect(missedAt.get('c')).toBe(1000);
    expect([...fetchedIn.entries()]).toEqual([
      ['a', 0],
      ['b', 0],
      ['c', 0],
    ]);
  });

  it('keeps the now/next map when an answer only brings misses', () => {
    useEpgStore.getState().setNowNext([['a', entry('A')]], [], 0, 0);
    const before = useEpgStore.getState().nowNext;
    useEpgStore.getState().setNowNext([], ['x', 'y'], 0, 0);
    expect(useEpgStore.getState().nowNext).toBe(before);
    // A miss for a key with an entry drops the entry.
    useEpgStore.getState().setNowNext([], ['a'], 0, 0);
    expect(useEpgStore.getState().nowNext.has('a')).toBe(false);
  });

  it('a hit clears an earlier miss', () => {
    useEpgStore.getState().setNowNext([], ['a'], 0, 0);
    useEpgStore.getState().setNowNext([['a', entry('A')]], [], 5, 0);
    expect(useEpgStore.getState().missedAt.has('a')).toBe(false);
  });

  it('invalidate starts a new generation, forgets misses and keeps entries on screen', () => {
    useEpgStore.getState().setNowNext([['a', entry('A')]], ['b'], 0, 0);
    useEpgStore.getState().invalidate();
    const state = useEpgStore.getState();
    expect(state.generation).toBe(1);
    expect(state.missedAt.size).toBe(0);
    expect(state.nowNext.get('a')?.now?.title).toBe('A');
    expect(state.fetchedIn.get('a')).toBe(0);
  });

  it('drops an answer to a request made before the last invalidate', () => {
    useEpgStore.getState().invalidate();
    useEpgStore.getState().setNowNext([['a', entry('Old')]], ['b'], 0, 0);
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
