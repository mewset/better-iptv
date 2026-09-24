import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
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

function movie(
  id: number,
  name: string,
  created_at: string,
  extra: Partial<Channel> = {}
): Channel {
  return {
    id,
    playlist_id: 1,
    name,
    url: `http://home.example/movie/${id}.mkv`,
    group_name: 'Movies',
    content_type: 'vod',
    is_favorite: false,
    sort_order: id,
    created_at,
    ...extra,
  } as Channel;
}

const older = movie(1, 'Older Movie', '2026-01-01T00:00:00Z');
const newest = movie(2, 'Newest Movie', '2026-06-01T00:00:00Z');

const mockedInvoke = vi.mocked(invoke);

function calls(cmd: string) {
  return mockedInvoke.mock.calls.filter((c) => c[0] === cmd);
}

interface FixtureParentalSettings {
  enabled: boolean;
  has_pin: boolean;
  blocked_categories: string[];
  visibility: 'hide' | 'lock' | 'blur';
  auto_detect: boolean;
}

function defaultParentalSettings(): FixtureParentalSettings {
  return {
    enabled: false,
    has_pin: false,
    blocked_categories: [],
    visibility: 'hide',
    auto_detect: false,
  };
}

function setupInvoke(parentalSettings: FixtureParentalSettings = defaultParentalSettings()) {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'get_channels':
      case 'get_channel_groups':
      case 'get_stale_playlist_ids':
      case 'get_blocked_channels':
        return [];
      case 'get_channels_epg':
        return {};
      case 'get_parental_settings':
        return parentalSettings;
      case 'play_channel':
        return undefined;
      default:
        return null;
    }
  });
}

describe('MainScreen: Movies hero', () => {
  beforeEach(() => {
    setupInvoke();
    usePlayerStore.setState({
      playlists: [home],
      activeProfileId: 1,
      currentPlaylist: home,
      contentTypeFilter: 'vod',
      categoryFilter: null,
      searchQuery: '',
      isPlaying: false,
      currentChannel: null,
      currentSeries: null,
      selectedSeason: null,
      parentalEnabled: false,
      parentalUnlocked: false,
      blockedChannelIds: new Set(),
      blockedCategories: [],
      parentalVisibility: 'hide',
      parentalAutoDetect: false,
    });
    usePlayerStore.getState().setChannels([older, newest]);
  });

  it('shows the hero for the newest title on the Movies section', async () => {
    render(<MainScreen />);
    expect(await screen.findByRole('region', { name: 'Recently added' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Newest Movie' })).toBeInTheDocument();
  });

  it('hides the hero when a search query is active', async () => {
    render(<MainScreen />);
    await screen.findByRole('region', { name: 'Recently added' });

    usePlayerStore.getState().setSearchQuery('Older');

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Recently added' })).not.toBeInTheDocument()
    );
  });

  it('hides the hero when a category filter is active', async () => {
    render(<MainScreen />);
    await screen.findByRole('region', { name: 'Recently added' });

    usePlayerStore.getState().setCategoryFilter('Movies');

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Recently added' })).not.toBeInTheDocument()
    );
  });

  it("hero's Play button plays the newest title", async () => {
    render(<MainScreen />);
    const hero = await screen.findByRole('region', { name: 'Recently added' });

    fireEvent.click(within(hero).getByRole('button', { name: 'Play Newest Movie' }));

    await waitFor(() => expect(calls('play_channel')).toHaveLength(1));
    expect(calls('play_channel')[0][1]).toEqual({ channel: newest });
  });

  it('skips a blocked newest title and shows the next one instead', async () => {
    setupInvoke({
      enabled: true,
      has_pin: true,
      blocked_categories: ['Adult'],
      visibility: 'blur',
      auto_detect: false,
    });
    const blockedNewest = movie(3, 'Blocked Newest', '2026-09-01T00:00:00Z', {
      group_name: 'Adult',
    });
    usePlayerStore.getState().setChannels([older, newest, blockedNewest]);

    render(<MainScreen />);

    await waitFor(() => expect(usePlayerStore.getState().parentalEnabled).toBe(true));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Newest Movie' })).toBeInTheDocument()
    );
    expect(screen.queryByRole('heading', { name: 'Blocked Newest' })).not.toBeInTheDocument();
  });
});
