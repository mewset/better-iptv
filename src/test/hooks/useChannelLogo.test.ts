import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useChannelLogo } from '../../hooks/useChannelLogo';
import { REPORT_BATCH_MS, resetLogoFallbackSession } from '../../lib/logoFallback';
import type { Channel } from '../../types';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockedInvoke = vi.mocked(invoke);

function channel(id: number, logo = `http://logo/${id}.png`): Channel {
  return {
    id,
    playlist_id: 1,
    name: `Ch ${id}`,
    url: `http://x/${id}`,
    logo,
    content_type: 'live',
    is_favorite: false,
    sort_order: 0,
  } as Channel;
}

describe('useChannelLogo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue({ '1': 'http://fb/1.png' });
    resetLogoFallbackSession();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with the provider logo', () => {
    const { result } = renderHook(() => useChannelLogo(channel(1)));
    expect(result.current.src).toBe('http://logo/1.png');
  });

  it('switches to the session fallback after onError', async () => {
    const { result } = renderHook(() => useChannelLogo(channel(1)));
    act(() => result.current.onError());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    });
    expect(result.current.src).toBe('http://fb/1.png');
  });

  it('a_failing_fallback_is_not_reported', async () => {
    const { result } = renderHook(() => useChannelLogo(channel(1)));
    act(() => result.current.onError());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    });
    act(() => result.current.onError());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS * 2);
    });
    expect(result.current.src).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it('treats a blank logo as no logo and never reports it', async () => {
    const { result } = renderHook(() => useChannelLogo(channel(1, '   ')));
    expect(result.current.src).toBeNull();
    act(() => result.current.onError());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS * 2);
    });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('resets when the channel changes', async () => {
    const { result, rerender } = renderHook(({ ch }) => useChannelLogo(ch), {
      initialProps: { ch: channel(1) },
    });
    act(() => result.current.onError());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_BATCH_MS);
    });
    expect(result.current.src).toBe('http://fb/1.png');
    rerender({ ch: channel(2) });
    expect(result.current.src).toBe('http://logo/2.png');
  });
});
