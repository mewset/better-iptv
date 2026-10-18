import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  REPORT_BATCH_MS,
  reportLogoFailure,
  resetLogoFallbackSession,
  useLogoFallbackStore,
} from '../../lib/logoFallback';
import { logger } from '../../lib/logger';
import type { Channel } from '../../types';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockedInvoke = vi.mocked(invoke);

function channel(id: number, content_type: Channel['content_type'] = 'live'): Channel {
  return {
    id,
    playlist_id: 1,
    name: `Ch ${id}`,
    url: `http://x/${id}`,
    logo: `http://logo/${id}.png`,
    content_type,
    is_favorite: false,
    sort_order: 0,
  } as Channel;
}

describe('logo failure batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue({});
    vi.mocked(logger.warn).mockClear();
    resetLogoFallbackSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('batches failures inside the window into one call', async () => {
    reportLogoFailure(channel(1), 'http://a');
    reportLogoFailure(channel(2), 'http://b');
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS - 1);
    expect(mockedInvoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith('report_dead_logos', {
      items: [
        { channel_id: 1, url: 'http://a' },
        { channel_id: 2, url: 'http://b' },
      ],
    });
  });

  it('ignores vod channels and offline', async () => {
    reportLogoFailure(channel(1, 'vod'), 'http://a');
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    reportLogoFailure(channel(2), 'http://b');
    spy.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS * 2);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('skips blank and overlong urls', async () => {
    reportLogoFailure(channel(1), '   ');
    reportLogoFailure(channel(2), `http://u/${'a'.repeat(2048)}`);
    reportLogoFailure(channel(3), 'http://ok');
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke.mock.calls[0][1]).toEqual({
      items: [{ channel_id: 3, url: 'http://ok' }],
    });
  });

  it('reports each channel and url pair once per session', async () => {
    reportLogoFailure(channel(1), 'http://a');
    reportLogoFailure(channel(2), 'http://a');
    reportLogoFailure(channel(1), 'http://a');
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    reportLogoFailure(channel(2), 'http://a');
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke.mock.calls[0][1]).toEqual({
      items: [
        { channel_id: 1, url: 'http://a' },
        { channel_id: 2, url: 'http://a' },
      ],
    });
  });

  it('merges returned fallbacks into the store', async () => {
    mockedInvoke.mockResolvedValueOnce({ '1': 'http://fb/1.png' });
    reportLogoFailure(channel(1), 'http://a');
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    expect(useLogoFallbackStore.getState().fallbacks).toEqual({ 1: 'http://fb/1.png' });
  });

  it('a failed call is logged and dropped', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('boom'));
    reportLogoFailure(channel(1), 'http://a');
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    expect(logger.warn).toHaveBeenCalled();
    expect(useLogoFallbackStore.getState().fallbacks).toEqual({});
  });

  it('splits more than 200 items into sequential chunks', async () => {
    for (let i = 1; i <= 250; i++) reportLogoFailure(channel(i), `http://u/${i}`);
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    const sizes = mockedInvoke.mock.calls.map((c) => (c[1] as { items: unknown[] }).items.length);
    expect(sizes).toEqual([200, 50]);
  });

  it('reset while a call is pending drops its result and the remaining chunks', async () => {
    let resolve: (v: Record<number, string>) => void = () => {};
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r as typeof resolve;
        })
    );
    for (let i = 1; i <= 250; i++) reportLogoFailure(channel(i), `http://u/${i}`);
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);

    resetLogoFallbackSession();
    resolve({ 1: 'http://fb/1.png' });
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS * 2);

    expect(useLogoFallbackStore.getState().fallbacks).toEqual({});
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it('a report after reset still goes out while an old call is pending', async () => {
    let resolve: (v: Record<number, string>) => void = () => {};
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r as typeof resolve;
        })
    );
    reportLogoFailure(channel(1), 'http://a');
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    resetLogoFallbackSession();
    mockedInvoke.mockResolvedValueOnce({ 2: 'http://fb/2.png' });
    reportLogoFailure(channel(2), 'http://b');
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    resolve({ 1: 'http://fb/1.png' });
    await vi.advanceTimersByTimeAsync(0);
    expect(useLogoFallbackStore.getState().fallbacks).toEqual({ 2: 'http://fb/2.png' });
  });

  it('reset cancels a pending flush', async () => {
    reportLogoFailure(channel(1), 'http://a');
    resetLogoFallbackSession();
    await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS * 2);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
