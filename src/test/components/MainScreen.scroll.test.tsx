import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import MainScreen from '../../components/MainScreen';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel, Playlist } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

// jsdom has no layout, so the real virtualiser would render no rows.
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

function channel(id: number, name: string, content_type: Channel['content_type']): Channel {
  return {
    id,
    playlist_id: 1,
    name,
    url: `http://home.example/${id}`,
    group_name: 'G',
    content_type,
    is_favorite: false,
    sort_order: id,
  };
}

const mockedInvoke = vi.mocked(invoke);

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
}

/** The scrolling grid container, scrolled part-way down. */
async function scrolledList(): Promise<HTMLElement> {
  const list = await screen.findByRole('region', { name: 'Channel list' });
  list.scrollTop = 480;
  expect(list.scrollTop).toBe(480);
  return list;
}

describe('MainScreen: scroll position resets when the list changes', () => {
  beforeEach(() => {
    setupInvoke();
    usePlayerStore.setState({
      playlists: [home],
      activeProfileId: 1,
      currentPlaylist: home,
      contentTypeFilter: 'live',
      categoryFilter: null,
      searchQuery: '',
      isPlaying: false,
      currentChannel: null,
      parentalEnabled: false,
      parentalUnlocked: false,
      blockedChannelIds: new Set(),
      blockedCategories: [],
      parentalVisibility: 'hide',
      parentalAutoDetect: false,
    });
    usePlayerStore
      .getState()
      .setChannels([
        channel(1, 'SVT1', 'live'),
        channel(2, 'TV4', 'live'),
        channel(3, 'Older Movie', 'vod'),
        channel(4, 'Newest Movie', 'vod'),
      ]);
  });

  it('scrolls to the top when the section changes', async () => {
    render(<MainScreen />);
    const list = await scrolledList();

    usePlayerStore.getState().setContentTypeFilter('vod');

    await waitFor(() => expect(list.scrollTop).toBe(0));
  });

  it('scrolls to the top when a category chip is chosen', async () => {
    render(<MainScreen />);
    const list = await scrolledList();

    usePlayerStore.getState().setCategoryFilter('G');

    await waitFor(() => expect(list.scrollTop).toBe(0));
  });

  it('scrolls to the top when a search starts and again when it is cleared', async () => {
    render(<MainScreen />);
    let list = await scrolledList();

    usePlayerStore.getState().setSearchQuery('TV');
    await waitFor(() => expect(list.scrollTop).toBe(0));

    list = await scrolledList();
    usePlayerStore.getState().setSearchQuery('');
    await waitFor(() => expect(list.scrollTop).toBe(0));
  });
});
