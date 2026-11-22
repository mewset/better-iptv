import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { usePlayerProgramme } from '../../hooks/usePlayerProgramme';
import type { Channel } from '../../types';
import { nowNext, programme } from '../epgFixtures';

const mockedInvoke = vi.mocked(invoke);
const now = Date.parse('2026-11-21T22:45:00Z');
const iso = (m: number) => new Date(now + m * 60000).toISOString();
const live = { id: 1, name: 'Sky Sports Action', content_type: 'live' } as Channel;
const film = { id: 2, name: 'Heat', content_type: 'vod' } as Channel;
const sent = () =>
  mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'player_set_programme').map(([, a]) => a);

describe('usePlayerProgramme', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it("sends a live channel's programme, again while the player starts, and on a change", () => {
    const first = nowNext(programme('NFL Football', iso(-15), iso(45)), null);
    const { rerender } = renderHook(({ entry }) => usePlayerProgramme(live, entry, now), {
      initialProps: { entry: first },
    });
    expect(sent()).toEqual([{ title: 'NFL Football' }]);
    vi.advanceTimersByTime(5_000);
    expect(sent()).toHaveLength(3);

    rerender({ entry: nowNext(programme('Goals', iso(-1), iso(30)), null) });
    expect(sent().at(-1)).toEqual({ title: 'Goals' });
  });

  it('clears it without guide data, and sends nothing for a film', () => {
    const first = renderHook(() => usePlayerProgramme(live, undefined, now));
    expect(sent()).toEqual([{ title: '' }]);
    first.unmount();
    mockedInvoke.mockClear();
    renderHook(() => usePlayerProgramme(film, undefined, now));
    vi.advanceTimersByTime(5_000);
    expect(sent()).toEqual([]);
  });
});
