import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import MainScreen from '../../components/MainScreen';
import { usePlayerStore } from '../../stores/player-store';
import { useEpgStore } from '../../stores/epg-store';
import type { Channel, Playlist } from '../../types';
import { epgStatus } from '../epgFixtures';

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
    range: count > 0 ? { startIndex: 0, endIndex: count - 1 } : null,
  }),
}));

const home: Playlist = { id: 1, name: 'Home', url: 'http://home.example', auto_refresh: false };

const svt1 = {
  id: 1,
  name: 'SVT1',
  group_name: 'Sweden',
  epg_id: 'svt1.se',
  content_type: 'live',
  is_favorite: false,
} as Channel;
const tv4 = { ...svt1, id: 2, name: 'TV4', epg_id: 'tv4.se' } as Channel;

const mockedInvoke = vi.mocked(invoke);
const calls = (cmd: string) => mockedInvoke.mock.calls.filter((c) => c[0] === cmd);

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
      case 'get_epg_guide':
        return {};
      case 'get_epg_status':
        return epgStatus(true);
      case 'get_epg_guide_keys':
        return ['svt1.se'];
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

function press(key: string, target: globalThis.EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(
      new globalThis.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
  });
}

const query = () => usePlayerStore.getState().searchQuery;
const section = () => usePlayerStore.getState().contentTypeFilter;
/** Lets a stop that should not happen get its chance to happen. */
const settle = () => act(async () => {});

describe('MainScreen: Escape and the search', () => {
  beforeEach(() => {
    useEpgStore.setState(useEpgStore.getInitialState(), true);
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
    });
    usePlayerStore.getState().setChannels([svt1, tv4]);
  });

  it('empties the search first, leaves the box next, and only then stops playback', async () => {
    render(<MainScreen />);
    const box = screen.getByRole('searchbox');
    box.focus();
    fireEvent.change(box, { target: { value: 'tv4' } });
    expect(query()).toBe('tv4');

    press('Escape', box);
    expect(query()).toBe('');
    expect(box).toHaveFocus();

    press('Escape', box);
    expect(box).not.toHaveFocus();

    await settle();
    expect(calls('stop_playback')).toHaveLength(0);
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    press('Escape');
    await waitFor(() => expect(calls('stop_playback')).toHaveLength(1));
  });

  it('Escape on the clear button empties the search and keeps the focus in the box', async () => {
    usePlayerStore.setState({ searchQuery: 'tv4' });
    render(<MainScreen />);
    const clear = screen.getByRole('button', { name: 'Clear search' });
    clear.focus();

    press('Escape', clear);
    expect(query()).toBe('');
    const box = screen.getByRole('searchbox');
    expect(box).toHaveFocus();

    press('Escape', box);
    expect(box).not.toHaveFocus();
    await settle();
    expect(calls('stop_playback')).toHaveLength(0);
  });

  it('empties a search that is still set when the focus is elsewhere', async () => {
    usePlayerStore.setState({ searchQuery: 'tv4' });
    render(<MainScreen />);

    press('Escape');

    expect(query()).toBe('');
    await settle();
    expect(calls('stop_playback')).toHaveLength(0);
  });

  it('empties the search before it leaves the guide', async () => {
    usePlayerStore.setState({ contentTypeFilter: 'guide', searchQuery: 'svt' });
    render(<MainScreen />);
    await screen.findByRole('table', { name: 'TV guide' });

    press('Escape');
    expect(query()).toBe('');
    expect(section()).toBe('guide');

    press('Escape');
    await waitFor(() => expect(section()).toBe('live'));
    await settle();
    expect(calls('stop_playback')).toHaveLength(0);
  });

  it('stops playback at once when there is no search to undo', async () => {
    render(<MainScreen />);
    press('Escape');
    await waitFor(() => expect(calls('stop_playback')).toHaveLength(1));
  });

  it('Stop in the dock takes the dock away', async () => {
    render(<MainScreen />);
    const dock = screen.getByRole('complementary', { name: 'Now playing' });
    fireEvent.click(within(dock).getByRole('button', { name: /stop/i }));

    await waitFor(() => expect(calls('stop_playback')).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Now playing' })).not.toBeInTheDocument()
    );
    expect(usePlayerStore.getState().currentChannel).toBeNull();
  });
});
