import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import MainScreen from '../../components/MainScreen';
import { usePlayerStore } from '../../stores/player-store';
import { useEpgStore } from '../../stores/epg-store';
import type { Channel, Playlist } from '../../types';
import type { NowNext } from '../../lib/epgIpc';
import { nowNext, programme } from '../epgFixtures';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 300 })),
    getTotalSize: () => count * 300,
    measureElement: () => {},
    measure: () => {},
  }),
}));

const home: Playlist = { id: 1, name: 'Home', url: 'http://home.example', auto_refresh: false };

const svt1 = {
  id: 1,
  playlist_id: 1,
  name: 'SVT1',
  url: 'http://home.example/live/1.ts',
  group_name: 'Sweden',
  epg_id: 'svt1.se',
  content_type: 'live',
  is_favorite: false,
  sort_order: 1,
} as Channel;

const mockedInvoke = vi.mocked(invoke);
let nowNextAnswer: Record<string, NowNext> = {};

function setupInvoke() {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'get_channels':
      case 'get_channel_groups':
      case 'get_stale_playlist_ids':
      case 'get_blocked_channels':
      case 'get_tmdb_cards':
        return [];
      case 'get_epg_now_next':
        return nowNextAnswer;
      case 'get_parental_settings':
        return {
          enabled: false,
          has_pin: false,
          blocked_categories: [],
          visibility: 'hide',
          auto_detect: false,
        };
      case 'get_tmdb_status':
        return {
          enabled: true,
          has_user_key: false,
          has_shared_key: false,
          user_key_rejected: false,
          shared_key_rejected: false,
          language: 'en-US',
        };
      default:
        return null;
    }
  });
}

describe('MainScreen: now/next', () => {
  beforeEach(() => {
    useEpgStore.setState(useEpgStore.getInitialState(), true);
    const at = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
    nowNextAnswer = {
      'svt1.se': nowNext(programme('Rapport', at(-10), at(20)), programme('Sport', at(20), at(50))),
    };
    setupInvoke();
    usePlayerStore.setState({
      playlists: [home],
      activeProfileId: 1,
      currentPlaylist: home,
      contentTypeFilter: 'live',
      categoryFilter: null,
      searchQuery: '',
      isPlaying: true,
      currentChannel: svt1,
      parentalEnabled: false,
      parentalUnlocked: false,
      blockedChannelIds: new Set(),
      blockedCategories: [],
      parentalVisibility: 'hide',
      parentalAutoDetect: false,
      channels: [svt1],
      liveChannels: [svt1],
      vodChannels: [],
      seriesChannels: [],
      favoriteChannels: [],
      channelLoad: { live: 'loaded', library: 'loaded' },
    });
  });

  it('the card and the dock of the playing channel show one entry from one request', async () => {
    render(<MainScreen />);
    const dock = screen.getByRole('complementary', { name: 'Now playing' });
    await waitFor(() => expect(within(dock).getByText('Rapport')).toBeInTheDocument(), {
      timeout: 3000,
    });
    const card = screen.getByRole('button', { name: 'Stop SVT1' }).closest('article')!;
    expect(within(card as HTMLElement).getByText('Rapport')).toBeInTheDocument();
    expect(within(dock).getByText(/Sport/)).toBeInTheDocument();

    const calls = mockedInvoke.mock.calls.filter((c) => c[0] === 'get_epg_now_next');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ keys: ['svt1.se'] });
  });
});
