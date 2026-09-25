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

function movie(id: number, name: string, created_at: string): Channel {
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
  } as Channel;
}

const older = movie(1, 'Older Movie', '2026-01-01T00:00:00Z');
const newest = movie(2, 'Newest Movie', '2026-06-01T00:00:00Z');

// TMDB off: the detail view shows provider data only.
const off = {
  available: false,
  matched: false,
  manual: false,
  tmdb_id: null,
  title: null,
  original_title: null,
  year: null,
  rating: null,
  poster_url: null,
  backdrop_url: null,
  overview: null,
  runtime_minutes: null,
  genres: [],
  cast: [],
  trailer_url: null,
};

const mockedInvoke = vi.mocked(invoke);

function calls(cmd: string) {
  return mockedInvoke.mock.calls.filter((c) => c[0] === cmd);
}

function setupInvoke(tmdbAvailable = false) {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'get_channels':
      case 'get_channel_groups':
      case 'get_stale_playlist_ids':
      case 'get_blocked_channels':
      case 'get_tmdb_cards':
      case 'get_tmdb_season':
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
      case 'play_channel':
        return undefined;
      case 'get_tmdb_status':
        return {
          enabled: true,
          has_user_key: false,
          has_shared_key: false,
          user_key_rejected: false,
          shared_key_rejected: false,
          language: 'en-US',
        };
      case 'get_tmdb_details':
        return tmdbAvailable ? { ...off, available: true } : off;
      case 'search_tmdb':
        return [];
      case 'set_tmdb_match':
        return off;
      default:
        return null;
    }
  });
}

describe('MainScreen opens the detail view', () => {
  beforeEach(() => {
    setupInvoke();
    usePlayerStore.setState({
      playlists: [home],
      currentPlaylist: home,
      activeProfileId: 1,
      contentTypeFilter: 'vod',
      searchQuery: '',
      categoryFilter: null,
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

  it('a click on a movie poster opens the detail view instead of playing', async () => {
    render(<MainScreen />);
    const card = (await screen.findAllByRole('article'))[0];
    fireEvent.click(card);
    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(calls('play_channel')).toHaveLength(0);
  });

  it('the overlay Play button plays the movie without opening the view', async () => {
    render(<MainScreen />);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: /^Play (Older|Newest) Movie$/ }))[0]
    );
    await waitFor(() => expect(calls('play_channel')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('Escape closes the detail view', async () => {
    render(<MainScreen />);
    fireEvent.click((await screen.findAllByRole('article'))[0]);
    await screen.findByRole('button', { name: 'Back' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    );
  });
  it('"Find on TMDB" in the detail view opens the re-match dialog', async () => {
    setupInvoke(true);
    render(<MainScreen />);
    fireEvent.click((await screen.findAllByRole('article'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Find on TMDB' }));
    expect(await screen.findByRole('dialog', { name: 'Find the right title' })).toBeInTheDocument();
    await waitFor(() => expect(calls('search_tmdb')).toHaveLength(1));
  });
});
