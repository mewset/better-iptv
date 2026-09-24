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

const railButton = (name: string) =>
  within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name });
const dock = () => screen.queryByRole('complementary', { name: 'Now playing' });

describe('MainScreen: Settings view and navigation', () => {
  beforeEach(() => {
    hasUrl = true;
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
    usePlayerStore.getState().setChannels([svt1]);
  });

  it('hides the dock while Settings is open and brings it back on leaving', async () => {
    usePlayerStore.setState({ isPlaying: true, currentChannel: svt1 });
    render(<MainScreen />);
    expect(dock()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    await screen.findByRole('heading', { level: 1, name: 'General' });
    expect(dock()).toBeNull();
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    fireEvent.click(railButton('Live TV'));
    await waitFor(() => expect(dock()).not.toBeNull());
  });

  async function openSettings() {
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    await screen.findByRole('heading', { level: 1, name: 'General' });
    // Let the load effect settle so the clean snapshot is taken.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^save changes$/i })).not.toBeDisabled()
    );
  }
  const settingsOpen = () => screen.queryByRole('heading', { level: 1, name: 'General' });
  const discardDialog = () => screen.queryByRole('dialog');

  it('leaves clean Settings straight away from the rail', async () => {
    render(<MainScreen />);
    await openSettings();
    fireEvent.click(railButton('Movies'));
    await waitFor(() => expect(settingsOpen()).toBeNull());
    expect(discardDialog()).toBeNull();
    expect(usePlayerStore.getState().contentTypeFilter).toBe('vod');
  });

  it('asks before leaving Settings with unsaved edits; Keep editing stays', async () => {
    render(<MainScreen />);
    await openSettings();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(railButton('Movies'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Discard changes?')).toBeInTheDocument();
    expect(
      within(dialog).getByText('You have unsaved settings. Leave without saving?')
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));

    expect(discardDialog()).toBeNull();
    expect(settingsOpen()).not.toBeNull();
    expect(usePlayerStore.getState().contentTypeFilter).toBe('live');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('Discard leaves Settings for the chosen section', async () => {
    render(<MainScreen />);
    await openSettings();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(railButton('Movies'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(settingsOpen()).toBeNull());
    expect(usePlayerStore.getState().contentTypeFilter).toBe('vod');
  });

  it('Escape with unsaved edits asks too instead of closing', async () => {
    render(<MainScreen />);
    await openSettings();
    fireEvent.click(screen.getByRole('checkbox'));
    document.body.dispatchEvent(
      new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(settingsOpen()).not.toBeNull();
  });
});
