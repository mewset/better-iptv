import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { startEpgEvents } from '../../lib/epgEvents';
import { useEpgStore } from '../../stores/epg-store';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel } from '../../types';
import { epgStatus } from '../epgFixtures';

const unlisten = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => unlisten),
}));

const mockedListen = vi.mocked(listen);
const mockedInvoke = vi.mocked(invoke);

const live = (id: number, epg_id?: string): Channel => ({
  id,
  name: `Live ${id}`,
  content_type: 'live',
  is_favorite: false,
  epg_id,
});
const playlist = (id: number) => ({ id, name: `P${id}`, auto_refresh: false });

/** Answers `get_channel_epg_keys` by hand: one resolver per call, in call order. */
function holdKeyRequests() {
  const answers: Array<(pairs: Array<[number, string]>) => void> = [];
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd !== 'get_channel_epg_keys') throw new Error(`unexpected command ${cmd}`);
    return new Promise((resolve) => answers.push(resolve));
  });
  return answers;
}
const keyCalls = () => mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_channel_epg_keys');

/** The handler registered for `event`, called with `payload`. */
function emit(event: string, payload: unknown) {
  const call = mockedListen.mock.calls.find(([name]) => name === event);
  expect(call).toBeDefined();
  (call![1] as (e: { payload: unknown }) => void)({ payload });
}

describe('epgEvents', () => {
  beforeEach(() => {
    mockedListen.mockClear();
    unlisten.mockClear();
    useEpgStore.setState(useEpgStore.getInitialState(), true);
    mockedInvoke.mockReset();
    usePlayerStore.setState({ currentPlaylist: playlist(1), currentChannel: null });
    usePlayerStore.getState().setChannels([live(1), live(2, 'gone.se')]);
  });

  it('listens once per event however many start, and stops with the last', async () => {
    const stopA = startEpgEvents();
    const stopB = startEpgEvents();
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalledTimes(2));
    expect(mockedListen.mock.calls.map(([name]) => name).sort()).toEqual([
      'epg-refreshed',
      'epg-status',
    ]);

    stopA();
    stopA();
    await Promise.resolve();
    expect(unlisten).not.toHaveBeenCalled();
    stopB();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(2));
  });

  it('epg-refreshed invalidates the cached guide data', async () => {
    const stop = startEpgEvents();
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalledTimes(2));
    useEpgStore.getState().setNowNext([], ['a'], 0, 0, new Set());

    emit('epg-refreshed', { reason: 'ingest', source_id: 1, matches_changed: 0 });

    expect(useEpgStore.getState().generation).toBe(1);
    expect(useEpgStore.getState().missedAt.size).toBe(0);
    stop();
  });

  it('epg-refreshed without changed matches reads no keys', async () => {
    const stop = startEpgEvents();
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalledTimes(2));
    const channels = usePlayerStore.getState().channels;

    emit('epg-refreshed', { reason: 'ingest', source_id: 1, matches_changed: 0 });
    usePlayerStore.setState({ currentPlaylist: null });
    emit('epg-refreshed', { reason: 'match', source_id: null, matches_changed: 4 });

    expect(keyCalls()).toEqual([]);
    expect(useEpgStore.getState().generation).toBe(2);
    expect(usePlayerStore.getState().channels).toBe(channels);
    stop();
  });

  it('changed matches set the new keys on the channels, then invalidate', async () => {
    const answers = holdKeyRequests();
    const stop = startEpgEvents();
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalledTimes(2));

    emit('epg-refreshed', { reason: 'match', source_id: null, matches_changed: 2 });

    expect(keyCalls()).toEqual([['get_channel_epg_keys', { playlistId: 1 }]]);
    // The cards ask again only once the new keys are set.
    expect(useEpgStore.getState().generation).toBe(0);
    answers[0]([[1, 'svt1.se']]);
    await vi.waitFor(() => expect(useEpgStore.getState().generation).toBe(1));
    expect(usePlayerStore.getState().liveChannels.map((c) => c.epg_id)).toEqual([
      'svt1.se',
      undefined,
    ]);
    stop();
  });

  it('drops an answer that arrives after a profile switch', async () => {
    const answers = holdKeyRequests();
    const stop = startEpgEvents();
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalledTimes(2));

    emit('epg-refreshed', { reason: 'ingest', source_id: 1, matches_changed: 1 });
    usePlayerStore.setState({ currentPlaylist: playlist(2) });
    usePlayerStore.getState().setChannels([live(1), live(2, 'gone.se')]);
    const channels = usePlayerStore.getState().channels;
    answers[0]([[1, 'svt1.se']]);

    await vi.waitFor(() => expect(useEpgStore.getState().generation).toBe(1));
    expect(usePlayerStore.getState().channels).toBe(channels);
    stop();
  });

  it('only the latest of two overlapping key requests is used', async () => {
    const answers = holdKeyRequests();
    const stop = startEpgEvents();
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalledTimes(2));

    emit('epg-refreshed', { reason: 'ingest', source_id: 1, matches_changed: 1 });
    emit('epg-refreshed', { reason: 'ingest', source_id: 2, matches_changed: 1 });
    answers[1]([[1, 'new.se']]);
    await vi.waitFor(() => expect(useEpgStore.getState().generation).toBe(1));
    answers[0]([[1, 'old.se']]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(usePlayerStore.getState().liveChannels[0].epg_id).toBe('new.se');
    expect(useEpgStore.getState().generation).toBe(1);
    stop();
  });

  it('a failed key request still invalidates', async () => {
    mockedInvoke.mockRejectedValue(new Error('db busy'));
    const stop = startEpgEvents();
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalledTimes(2));
    const channels = usePlayerStore.getState().channels;

    emit('epg-refreshed', { reason: 'match', source_id: null, matches_changed: 3 });

    await vi.waitFor(() => expect(useEpgStore.getState().generation).toBe(1));
    expect(usePlayerStore.getState().channels).toBe(channels);
    stop();
  });

  it('epg-status replaces the status', async () => {
    const stop = startEpgEvents();
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalledTimes(2));
    const status = epgStatus(false);

    emit('epg-status', status);

    expect(useEpgStore.getState().status).toBe(status);
    stop();
  });

  it('a listen that fails is logged, not thrown', async () => {
    mockedListen.mockRejectedValueOnce(new Error('no runtime'));
    const stop = startEpgEvents();
    await vi.waitFor(() => expect(mockedListen).toHaveBeenCalledTimes(2));
    stop();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});
