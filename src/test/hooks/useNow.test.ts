import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { NOW_TICK_MS, useNow } from '../../hooks/useNow';

describe('useNow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves every user on together, from one interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T18:00:00Z'));
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const a = renderHook(() => useNow());
    const b = renderHook(() => useNow());
    expect(a.result.current).toBe(Date.parse('2026-10-21T18:00:00Z'));
    expect(setInterval).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS);
    });
    expect(a.result.current).toBe(Date.parse('2026-10-21T18:00:30Z'));
    expect(b.result.current).toBe(a.result.current);

    a.unmount();
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
    setInterval.mockRestore();
  });
});
