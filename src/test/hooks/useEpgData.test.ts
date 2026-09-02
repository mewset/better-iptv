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
      'svt1.se': { current: 'Rapport', next: 'Aktuellt' },
      'tv4.se': { current: 'Nyheterna', next: null },
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
      expect(data.get(1)).toEqual({ current: 'Rapport', next: 'Aktuellt' });
      expect(data.get(2)).toEqual({ current: 'Nyheterna', next: undefined });
      expect(data.has(3)).toBe(false);
      expect(data.has(4)).toBe(false);
    });
  });

  it('does not call the backend when no channel has an epg_id', async () => {
    renderHook(() => useEpgData([makeChannel({ id: 1 })]));

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(getChannelsEpg).not.toHaveBeenCalled();
  });
});
