import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import MainScreen from '../../components/MainScreen';
import { usePlayerStore } from '../../stores/player-store';
import { useEpgStore } from '../../stores/epg-store';
import type { Channel, Playlist } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

// jsdom has no layout, so the real virtualiser would render no rows. The
// stand-in mounts every row and records what the grid asks to scroll to.
const virtualiser = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  options: [] as Array<{ scrollPaddingEnd?: number }>,
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; scrollPaddingEnd?: number }) => {
    virtualiser.options.push(options);
    const { count } = options;
    return Object.assign(virtualiser, {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 300 })),
      getTotalSize: () => count * 300,
      measureElement: () => {},
      measure: () => {},
      range: count > 0 ? { startIndex: 0, endIndex: count - 1 } : null,
    });
  },
}));

const home: Playlist = { id: 1, name: 'Home', url: 'http://home.example', auto_refresh: false };

function channel(id: number, name: string, content_type: Channel['content_type']): Channel {
  return { id, name, group_name: 'G', content_type, is_favorite: false };
}

// jsdom's window is 1024 wide: four cards to a row in both grids.
const live = Array.from({ length: 6 }, (_, i) => channel(i + 1, `Channel ${i + 1}`, 'live'));
const movies = Array.from({ length: 6 }, (_, i) => channel(i + 11, `Movie ${i + 1}`, 'vod'));

const mockedInvoke = vi.mocked(invoke);
const calls = (cmd: string) => mockedInvoke.mock.calls.filter(([c]) => c === cmd);

function setupInvoke() {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'get_channels':
      case 'get_stale_playlist_ids':
      case 'get_tmdb_cards':
        return [];
      case 'get_channel_groups':
        return { pinned: [], others: [] };
      case 'get_epg_now_next':
        return {};
      case 'playback_status':
        return { playing: true, failed: false };
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

const grid = (name: string) => screen.findByRole('grid', { name });
const press = (el: HTMLElement, key: string) => fireEvent.keyDown(el, { key });

describe('MainScreen: keyboard navigation in the grid', () => {
  beforeEach(() => {
    virtualiser.scrollToIndex.mockClear();
    virtualiser.options = [];
    useEpgStore.setState(useEpgStore.getInitialState(), true);
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
    usePlayerStore.getState().setChannels([...live, ...movies]);
  });

  it('describes the list as a grid of rows and cells', async () => {
    render(<MainScreen />);
    const el = await grid('Live TV');

    expect(el).toHaveAttribute('aria-rowcount', '2');
    expect(el).toHaveAttribute('aria-colcount', '4');
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getAllByRole('gridcell')).toHaveLength(6);
    // The cards themselves stay out of the tab order; their buttons stay in it.
    expect(screen.getByRole('button', { name: 'Play Channel 1' })).not.toHaveAttribute('tabindex');
  });

  it('moves with the arrows and plays the active channel on Enter', async () => {
    render(<MainScreen />);
    const el = await grid('Live TV');

    fireEvent.focus(el);
    press(el, 'ArrowRight');
    press(el, 'ArrowDown');

    expect(el).toHaveAttribute('aria-activedescendant', 'grid-cell-6');
    const cell = screen.getByRole('gridcell', { selected: true });
    expect(cell).toContainElement(screen.getByRole('button', { name: 'Play Channel 6' }));
    expect(cell.className).toContain('ring-2');
    // Row 1 of the grid, asked of the virtualiser by row.
    expect(virtualiser.scrollToIndex).toHaveBeenLastCalledWith(1, { align: 'auto' });

    press(el, 'Enter');
    await waitFor(() => expect(calls('play_channel')).toHaveLength(1));
    expect(calls('play_channel')[0][1]).toEqual({ channelId: 6 });
  });

  it('opens the active title on Enter in the poster grid', async () => {
    usePlayerStore.setState({ contentTypeFilter: 'vod' });
    render(<MainScreen />);
    const el = await grid('Movies');

    fireEvent.focus(el);
    press(el, 'ArrowRight');
    press(el, 'Enter');

    // The detail view replaces the grid; nothing plays yet.
    await waitFor(() => expect(screen.queryByRole('grid')).toBeNull());
    expect(calls('play_channel')).toHaveLength(0);
  });

  it('starts over at the top when the section changes', async () => {
    render(<MainScreen />);
    const el = await grid('Live TV');
    fireEvent.focus(el);
    press(el, 'ArrowRight');
    expect(el).toHaveAttribute('aria-activedescendant', 'grid-cell-2');

    // Favorites is empty here: no grid until Live TV is back.
    act(() => usePlayerStore.getState().setContentTypeFilter('favorites'));
    expect(screen.queryByRole('grid')).toBeNull();
    act(() => usePlayerStore.getState().setContentTypeFilter('live'));

    expect(await grid('Live TV')).not.toHaveAttribute('aria-activedescendant');
  });

  it('keeps the row it scrolls to clear of the dock while something plays', async () => {
    render(<MainScreen />);
    await grid('Live TV');
    expect(virtualiser.options.at(-1)?.scrollPaddingEnd).toBe(20);

    usePlayerStore.setState({ isPlaying: true, currentChannel: live[0] });

    await waitFor(() => expect(virtualiser.options.at(-1)?.scrollPaddingEnd).toBe(148));
  });
});
