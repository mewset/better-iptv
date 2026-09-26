import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
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

const profile: Playlist = {
  id: 1,
  name: 'Home',
  url: 'http://home.example',
  auto_refresh: false,
  xtream_username: 'user',
  xtream_password: 'pass',
};

function movie(id: number, name: string, extra: Partial<Channel> = {}): Channel {
  return {
    id,
    playlist_id: 1,
    name,
    url: `http://home.example/movie/${id}.mkv`,
    group_name: 'Movies',
    content_type: 'vod',
    is_favorite: false,
    sort_order: id,
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  } as Channel;
}

const channels = [1, 2, 3, 4, 5].map((id) => movie(id, `Title ${id}`));

function item(channel_id: number) {
  return {
    channel_id,
    tmdb_id: channel_id,
    title: `Title ${channel_id}`,
    year: 2020,
    rating: 7,
    poster_url: null,
    backdrop_url: null,
    genres: ['Action'],
    overview: null,
  };
}

const rows = [{ genre: 'Action', content_type: 'vod', items: [1, 2, 3, 4, 5].map(item) }];

const seriesChannels = [6, 7, 8].map((id) =>
  movie(id, `Title ${id}`, { content_type: 'series' })
);
const rowsWithSurvivor = [
  { genre: 'Action', content_type: 'vod', items: [1, 2, 3, 4, 5].map(item) },
  { genre: 'Comedy', content_type: 'series', items: [6, 7, 8].map(item) },
];

const mockedInvoke = vi.mocked(invoke);

function status(open: boolean) {
  return {
    enabled: true,
    has_user_key: open,
    has_shared_key: false,
    user_key_rejected: false,
    shared_key_rejected: false,
    language: 'en-US',
    background_enrich: open,
    background_progress: null,
  };
}

// Mutable so a test can close the gate mid-run (as turning the scan off in
// Settings would) while every other command keeps its answer.
let gateOpen = false;

function setupInvoke(
  open: boolean,
  parental = { enabled: false, blocked: [] as number[] },
  homeRows: unknown = rows
) {
  gateOpen = open;
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'get_tmdb_status':
        return status(gateOpen);
      case 'get_home_rows':
        return homeRows;
      case 'get_blocked_channels':
        return parental.blocked;
      case 'get_parental_settings':
        return {
          enabled: parental.enabled,
          has_pin: parental.enabled,
          blocked_categories: [],
          visibility: 'hide',
          auto_detect: false,
        };
      case 'get_channels':
      case 'get_channel_groups':
      case 'get_stale_playlist_ids':
      case 'get_tmdb_cards':
        return [];
      case 'get_channels_epg':
      case 'get_guide':
        return {};
      case 'get_epg_status':
        return { has_url: false, last_fetched: null, program_count: 0 };
      default:
        return null;
    }
  });
}

// Scoped to the rail: the TopBar profile switcher is also named after the
// profile ("Home").
const rail = () => within(screen.getByRole('navigation', { name: 'Sections' }));

function seedStore() {
  usePlayerStore.setState({
    playlists: [profile],
    activeProfileId: 1,
    currentPlaylist: profile,
    contentTypeFilter: 'live',
    categoryFilter: null,
    searchQuery: '',
    isPlaying: false,
    currentChannel: null,
    tmdbCards: new Map(),
    parentalEnabled: false,
    parentalUnlocked: false,
    blockedChannelIds: new Set(),
    blockedCategories: [],
    parentalAutoDetect: false,
    parentalVisibility: 'hide',
  });
  usePlayerStore.getState().setChannels(channels);
}

describe('MainScreen: Home', () => {
  beforeEach(() => {
    seedStore();
  });

  it('starts on Home with the gate open and shows the slideshow', async () => {
    setupInvoke(true);
    render(<MainScreen />);
    expect(await rail().findByRole('button', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(await screen.findByRole('region', { name: 'Action Movies' })).toBeInTheDocument();
    // TopBar owns the page's h1 ("Home"); the greeting is an h2.
    expect(
      screen.getByRole('heading', { level: 2, name: /^Good (morning|afternoon|evening)$/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('stays on Live TV and hides Home with the gate closed', async () => {
    setupInvoke(false);
    render(<MainScreen />);
    await waitFor(() =>
      expect(mockedInvoke.mock.calls.some((c) => c[0] === 'get_tmdb_status')).toBe(true)
    );
    // The status call resolving is not the same as `setTmdbStatus` having
    // run; flush the promise queue before asserting on its effects.
    await act(async () => {
      await Promise.resolve();
    });
    expect(rail().queryByRole('button', { name: 'Home' })).toBeNull();
    expect(rail().getByRole('button', { name: 'Live TV' })).toHaveAttribute('aria-current', 'page');
    expect(mockedInvoke.mock.calls.some((c) => c[0] === 'get_home_rows')).toBe(false);
  });

  it('opens the detail view from a slide', async () => {
    setupInvoke(true);
    render(<MainScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Title 1, open details' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Action Movies' })).toBeNull());
    // The detail view and the top-bar subtitle both carry the name.
    expect(screen.getAllByText('Title 1').length).toBeGreaterThan(0);
  });

  it('drops blocked titles and hides a row that falls under three', async () => {
    setupInvoke(true, { enabled: true, blocked: [1, 2, 3] }, rowsWithSurvivor);
    usePlayerStore.setState({ parentalEnabled: true, blockedChannelIds: new Set([1, 2, 3]) });
    usePlayerStore.getState().setChannels([...channels, ...seriesChannels]);
    render(<MainScreen />);
    await rail().findByRole('button', { name: 'Home' });
    await waitFor(() =>
      expect(mockedInvoke.mock.calls.some((c) => c[0] === 'get_home_rows')).toBe(true)
    );
    expect(screen.queryByRole('region', { name: 'Action Movies' })).toBeNull();
    expect(await screen.findByRole('region', { name: 'Comedy Series' })).toBeInTheDocument();
  });

  it('leaves Home for Live TV when the gate closes', async () => {
    setupInvoke(true);
    render(<MainScreen />);
    await screen.findByRole('region', { name: 'Action Movies' });
    gateOpen = false;
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    await screen.findByRole('heading', { level: 1, name: 'General' });
    // Let the load effect settle so the clean snapshot is taken.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^save changes$/i })).not.toBeDisabled()
    );
    document.body.dispatchEvent(
      new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    await waitFor(() =>
      expect(rail().getByRole('button', { name: 'Live TV' })).toHaveAttribute(
        'aria-current',
        'page'
      )
    );
    expect(rail().queryByRole('button', { name: 'Home' })).toBeNull();
  });

  it('leaving Settings through the rail refreshes the gate', async () => {
    setupInvoke(true);
    render(<MainScreen />);
    await screen.findByRole('region', { name: 'Action Movies' });
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    await screen.findByRole('heading', { level: 1, name: 'General' });
    // Let the load effect settle so the clean snapshot is taken.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^save changes$/i })).not.toBeDisabled()
    );
    gateOpen = false;
    fireEvent.click(rail().getByRole('button', { name: 'Live TV' }));
    await waitFor(() => expect(rail().queryByRole('button', { name: 'Home' })).toBeNull());
  });

  it('"/" on Home switches to Live TV and focuses search', async () => {
    setupInvoke(true);
    render(<MainScreen />);
    await screen.findByRole('region', { name: 'Action Movies' });
    fireEvent.keyDown(document, { key: '/' });
    await waitFor(() =>
      expect(rail().getByRole('button', { name: 'Live TV' })).toHaveAttribute(
        'aria-current',
        'page'
      )
    );
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());
  });

  it('"/" inside Settings opened from Home leaves Settings alone', async () => {
    setupInvoke(true);
    render(<MainScreen />);
    await screen.findByRole('region', { name: 'Action Movies' });
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    await screen.findByRole('heading', { level: 1, name: 'General' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^save changes$/i })).not.toBeDisabled()
    );
    fireEvent.keyDown(document, { key: '/' });
    // Give a wrongful section switch the chance to render.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('heading', { level: 1, name: 'General' })).toBeInTheDocument();
    expect(rail().getByRole('button', { name: 'Live TV' })).not.toHaveAttribute(
      'aria-current',
      'page'
    );
  });
});
