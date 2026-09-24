import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import MainScreen from '../../components/MainScreen';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel, Playlist } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

// jsdom has no layout, so the real virtualiser would render no rows. This
// stand-in renders every row, which is all a behaviour test needs.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 300 })),
    getTotalSize: () => count * 300,
    measureElement: () => {},
    measure: () => {},
  }),
}));

const home: Playlist = {
  id: 1,
  name: 'Home',
  url: 'http://home.example',
  auto_refresh: false,
  xtream_username: 'user',
  xtream_password: 'pass',
};
const cabin: Playlist = {
  id: 2,
  name: 'Cabin',
  url: 'http://cabin.example/list.m3u',
  auto_refresh: false,
};

const theBear: Channel = {
  id: 42,
  playlist_id: 1,
  name: 'The Bear',
  url: 'http://home.example/series/user/pass/777.mkv',
  content_type: 'series',
  is_favorite: false,
  sort_order: 0,
} as Channel;

const seriesInfo = {
  info: { name: 'The Bear', plot: 'A chef.', genre: 'Drama' },
  seasons: [{ id: '1', name: 'Season 1', season_number: '1', episode_count: 0 }],
  episodes: {},
};

const mockedInvoke = vi.mocked(invoke);

function calls(cmd: string) {
  return mockedInvoke.mock.calls.filter((c) => c[0] === cmd);
}

describe('MainScreen: switching profile with a series open', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case 'get_series_info':
        case 'get_local_series_info':
          return seriesInfo;
        case 'get_channels':
        case 'get_channel_groups':
        case 'get_stale_playlist_ids':
        case 'get_blocked_channels':
          return [];
        case 'get_channels_epg':
          return {};
        case 'get_parental_settings':
          return {
            enabled: false,
            has_pin: false,
            blocked_categories: [],
            visibility: 'hide',
            auto_detect: false,
          };
        default:
          return null;
      }
    });
    usePlayerStore.setState({
      playlists: [home, cabin],
      activeProfileId: 1,
      currentPlaylist: home,
      contentTypeFilter: 'series',
      categoryFilter: null,
      searchQuery: '',
      isPlaying: false,
      currentChannel: null,
      currentSeries: null,
      selectedSeason: null,
    });
    // setChannels also fills the per-type lists the filter reads.
    usePlayerStore.getState().setChannels([theBear]);
  });

  it('returns to browse and never loads the old series against the new profile', async () => {
    render(<MainScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open The Bear' }));
    expect(await screen.findByRole('button', { name: 'Back to series' })).toBeInTheDocument();
    expect(calls('get_series_info')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Cabin' }));

    await waitFor(() => expect(usePlayerStore.getState().activeProfileId).toBe(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Back to series' })).not.toBeInTheDocument()
    );
    // Browse view is back: the Series section title and the empty grid.
    expect(screen.getByRole('region', { name: 'Channel list' })).toBeInTheDocument();

    // Let any effect-driven reload settle before counting requests.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls('get_series_info')).toHaveLength(1);
    expect(calls('get_local_series_info')).toHaveLength(0);
  });

  it('returns focus to the rail avatar when the menu it opened closes with Escape', () => {
    render(<MainScreen />);
    const avatar = screen.getByRole('button', { name: 'Switch profile' });

    fireEvent.click(avatar);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Home' }), { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(avatar).toHaveFocus();
  });
});
