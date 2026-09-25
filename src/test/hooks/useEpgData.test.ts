import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// player-store imports other wrappers from lib/tauri, so keep the real module
// and replace only the function under test.
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  getChannelsEpg: vi.fn(),
}));

import { getChannelsEpg } from '../../lib/tauri';
import { listen } from '@tauri-apps/api/event';
import { useEpgData } from '../../hooks/useEpgData';

const makeChannel = (overrides: Partial<Channel>): Channel => ({
  id: 1,
  name: 'Test',
  url: 'http://test',
  playlist_id: 1,
  content_type: 'live',
  is_favorite: false,
  sort_order: 0,
  ...overrides,
});

describe('useEpgData', () => {
  beforeEach(() => {
    vi.mocked(getChannelsEpg).mockReset();
    usePlayerStore.setState({ channelEpgData: new Map(), epgRefreshTrigger: 0 });
  });

  it('fetches EPG for all live channels with an epg_id in one call', async () => {
    vi.mocked(getChannelsEpg).mockResolvedValue({
      'svt1.se': {
        current: 'Rapport',
        current_start: '2026-09-24T18:00:00Z',
        current_end: '2026-09-24T18:30:00Z',
        next: 'Aktuellt',
        next_start: '2026-09-24T18:30:00Z',
      },
      'tv4.se': {
        current: 'Nyheterna',
        current_start: null,
        current_end: null,
        next: null,
        next_start: null,
      },
    });

    const channels = [
      makeChannel({ id: 1, name: 'SVT1', epg_id: 'svt1.se' }),
      makeChannel({ id: 2, name: 'TV4', epg_id: 'tv4.se' }),
      makeChannel({ id: 3, name: 'No EPG' }),
      makeChannel({ id: 4, name: 'Movie', epg_id: 'movie.id', content_type: 'vod' }),
    ];

    renderHook(() => useEpgData(channels));

    await waitFor(() => expect(getChannelsEpg).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(getChannelsEpg).toHaveBeenCalledWith(['svt1.se', 'tv4.se']);

    await waitFor(() => {
      const data = usePlayerStore.getState().channelEpgData;
      expect(data.get(1)).toEqual({
        current: 'Rapport',
        currentStart: '2026-09-24T18:00:00Z',
        currentEnd: '2026-09-24T18:30:00Z',
        next: 'Aktuellt',
        nextStart: '2026-09-24T18:30:00Z',
      });
      expect(data.get(2)).toEqual({ current: 'Nyheterna', next: undefined });
      expect(data.has(3)).toBe(false);
      expect(data.has(4)).toBe(false);
    });
  });

  it('always includes the playing channel in the batch, even when it is not in the list', async () => {
    vi.mocked(getChannelsEpg).mockResolvedValue({
      'svt1.se': {
        current: 'Rapport',
        current_start: null,
        current_end: null,
        next: null,
        next_start: null,
      },
    });
    const visible = [makeChannel({ id: 1, name: 'SVT1', epg_id: 'svt1.se' })];
    const playing = makeChannel({ id: 9, name: 'Kanal 5', epg_id: 'kanal5.se' });

    renderHook(() => useEpgData(visible, playing));

    await waitFor(() => expect(getChannelsEpg).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(vi.mocked(getChannelsEpg).mock.calls[0][0]).toEqual(
      expect.arrayContaining(['svt1.se', 'kanal5.se'])
    );
  });

  it('refetches the playing channel when its cached programme has ended', async () => {
    const past = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    const playing = makeChannel({ id: 9, name: 'Kanal 5', epg_id: 'kanal5.se' });
    usePlayerStore.setState({
      channelEpgData: new Map([
        [9, { current: 'Old show', currentStart: past(90), currentEnd: past(30) }],
      ]),
    });
    vi.mocked(getChannelsEpg).mockResolvedValue({
      'kanal5.se': {
        current: 'New show',
        current_start: null,
        current_end: null,
        next: null,
        next_start: null,
      },
    });

    renderHook(() => useEpgData([], playing));

    await waitFor(() => expect(getChannelsEpg).toHaveBeenCalledWith(['kanal5.se']), {
      timeout: 2000,
    });
    await waitFor(() =>
      expect(usePlayerStore.getState().channelEpgData.get(9)?.current).toBe('New show')
    );
  });

  it('keeps a channel that is off air but has a next programme', async () => {
    vi.mocked(getChannelsEpg).mockResolvedValue({
      'svt2.se': {
        current: null,
        current_start: null,
        current_end: null,
        next: 'Spårlöst försvunnen',
        next_start: '2099-09-25T11:50:00Z',
      },
    });

    renderHook(() => useEpgData([makeChannel({ id: 7, name: 'SVT2', epg_id: 'svt2.se' })]));

    await waitFor(() => {
      expect(usePlayerStore.getState().channelEpgData.get(7)).toEqual({
        next: 'Spårlöst försvunnen',
        nextStart: '2099-09-25T11:50:00Z',
      });
    });
  });

  it('does not call the backend when no channel has an epg_id', async () => {
    renderHook(() => useEpgData([makeChannel({ id: 1 })]));

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(getChannelsEpg).not.toHaveBeenCalled();
  });

  it('clears cached EPG and refetches when the backend emits epg-refreshed', async () => {
    // The second resolution is empty: with forceRefresh=true the hook skips
    // its cache filter entirely, so the only way the stale 'Rapport' entry
    // can disappear is via clearAllEpg() (setChannelEpg is never called when
    // entry?.current is missing). This proves the cache was actually cleared,
    // not just that a second backend call happened.
    vi.mocked(getChannelsEpg)
      .mockResolvedValueOnce({
        'svt1.se': {
          current: 'Rapport',
          current_start: null,
          current_end: null,
          next: null,
          next_start: null,
        },
      })
      .mockResolvedValue({});
    const channels = [makeChannel({ id: 1, name: 'SVT1', epg_id: 'svt1.se' })];

    renderHook(() => useEpgData(channels));
    await waitFor(() => expect(getChannelsEpg).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await waitFor(() => {
      expect(usePlayerStore.getState().channelEpgData.get(1)).toEqual({
        current: 'Rapport',
        next: undefined,
      });
    });

    const registration = vi
      .mocked(listen)
      .mock.calls.find(([eventName]) => eventName === 'epg-refreshed');
    expect(registration).toBeDefined();

    const handler = registration![1] as (event: { payload: unknown }) => void;
    handler({ payload: { success: true, programs_loaded: 10, timestamp: 'now', error: null } });

    await waitFor(() => expect(getChannelsEpg).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(usePlayerStore.getState().channelEpgData.has(1)).toBe(false);
  });
});
