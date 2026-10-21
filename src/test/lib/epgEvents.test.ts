import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { startEpgEvents } from '../../lib/epgEvents';
import { useEpgStore } from '../../stores/epg-store';
import { epgStatus } from '../epgFixtures';

const unlisten = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => unlisten),
}));

const mockedListen = vi.mocked(listen);

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
    useEpgStore.getState().setNowNext([], ['a'], 0, 0);

    emit('epg-refreshed', { reason: 'ingest', source_id: 1, matches_changed: 0 });

    expect(useEpgStore.getState().generation).toBe(1);
    expect(useEpgStore.getState().missedAt.size).toBe(0);
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
