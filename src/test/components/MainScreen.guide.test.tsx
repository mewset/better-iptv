import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import MainScreen from '../../components/MainScreen';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel, Playlist } from '../../types';

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
const calls = (cmd: string) => mockedInvoke.mock.calls.filter((c) => c[0] === cmd);

let hasUrl = true;

function setupInvoke() {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'get_channels':
      case 'get_channel_groups':
      case 'get_stale_playlist_ids':
      case 'get_blocked_channels':
        return [];
      case 'get_channels_epg':
      case 'get_guide':
        return {};
      case 'get_epg_status':
        return { has_url: hasUrl, last_fetched: null, program_count: 0 };
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
  target.dispatchEvent(
    new globalThis.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );
}

const section = () => usePlayerStore.getState().contentTypeFilter;
const guideTable = () => screen.queryByRole('table', { name: 'TV guide' });

describe('MainScreen: TV guide and shortcuts', () => {
  beforeEach(() => {
    hasUrl = true;
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
      parentalEnabled: false,
      parentalUnlocked: false,
      blockedChannelIds: new Set(),
      blockedCategories: [],
      parentalVisibility: 'hide',
      parentalAutoDetect: false,
    });
    usePlayerStore.getState().setChannels([svt1]);
  });

  it('the Rail opens the guide view', async () => {
    render(<MainScreen />);
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', {
        name: 'TV Guide',
      })
    );
    expect(await screen.findByRole('table', { name: 'TV guide' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'SVT1' })).toBeInTheDocument();
  });

  it('G opens the guide and G again returns to the previous section', async () => {
    render(<MainScreen />);
    press('g');
    await waitFor(() => expect(section()).toBe('guide'));
    expect(await screen.findByRole('table', { name: 'TV guide' })).toBeInTheDocument();
    press('G');
    await waitFor(() => expect(section()).toBe('vod'));
    expect(guideTable()).toBeNull();
  });

  it('g typed in the search box types instead of switching view', async () => {
    render(<MainScreen />);
    const search = screen.getByRole('searchbox');
    search.focus();
    press('g', search);
    expect(section()).toBe('vod');
  });

  it('Escape leaves the guide for the previous section without stopping playback', async () => {
    usePlayerStore.setState({ isPlaying: true, currentChannel: svt1 });
    render(<MainScreen />);
    press('g');
    await screen.findByRole('table', { name: 'TV guide' });
    press('Escape');
    await waitFor(() => expect(section()).toBe('vod'));
    expect(calls('stop_playback')).toHaveLength(0);
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    // With no view left to close, Escape stops playback as before.
    press('Escape');
    await waitFor(() => expect(calls('stop_playback')).toHaveLength(1));
  });

  it('G does nothing while Settings is open', async () => {
    render(<MainScreen />);
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    await screen.findByRole('heading', { level: 1, name: 'General' });
    press('g');
    expect(section()).toBe('vod');
    expect(screen.getByRole('heading', { level: 1, name: 'General' })).toBeInTheDocument();
  });

  it('Open EPG settings opens Settings on the EPG section', async () => {
    hasUrl = false;
    render(<MainScreen />);
    press('g');
    fireEvent.click(await screen.findByRole('button', { name: 'Open EPG settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'EPG' })).toBeInTheDocument();
  });
});
