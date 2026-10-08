import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { newestTitles } from '../../lib/newestTitle';
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

// Passes through, but counts how often the section is ranked.
vi.mock('../../lib/newestTitle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/newestTitle')>();
  return { ...actual, newestTitles: vi.fn(actual.newestTitles) };
});

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

/** TMDB card the backend returns for a channel id in `tmdbCardsFor`. */
/** TMDB titles for the fixture channels: the hero shows the TMDB title once matched. */
const TMDB_TITLES: Record<number, string> = {
  1: 'Older Movie',
  2: 'Newest Movie',
  3: 'Blocked Newest',
  11: 'Older Show',
  12: 'Newest Show',
};

function tmdbCard(channel_id: number) {
  return {
    channel_id,
    tmdb_id: 1000 + channel_id,
    title: TMDB_TITLES[channel_id] ?? `Title ${channel_id}`,
    year: 2024,
    rating: 7.5,
    poster_url: null,
    backdrop_url: null,
    genres: [],
  };
}

function setupInvoke(
  parentalSettings: FixtureParentalSettings = defaultParentalSettings(),
  tmdbCardsFor: number[] = []
) {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case 'get_channels':
      case 'get_channel_groups':
      case 'get_stale_playlist_ids':
      case 'get_blocked_channels':
        return [];
      case 'get_tmdb_cards':
        return (args as { channelIds: number[] }).channelIds
          .filter((id) => tmdbCardsFor.includes(id))
          .map(tmdbCard);
      case 'get_channels_epg':
        return {};
      case 'get_parental_settings':
        return parentalSettings;
      case 'play_channel':
        return undefined;
      case 'get_series_info':
      case 'get_local_series_info':
        return { seasons: [], info: { name: 'Newest Show' }, episodes: {} };
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

describe('MainScreen: Movies hero', () => {
  beforeEach(() => {
    setupInvoke(defaultParentalSettings(), [1, 2]);
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
      tmdbCards: new Map(),
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
    setupInvoke(
      {
        enabled: true,
        has_pin: true,
        blocked_categories: ['Adult'],
        visibility: 'blur',
        auto_detect: false,
      },
      [1, 2, 3]
    );
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

  it('does not re-rank the whole section when a TMDB card arrives', async () => {
    // Every card used to re-sort the section to find the hero; the background
    // scan sends up to five a second, ~9 ms each on a 7,677-title library.
    render(<MainScreen />);
    await screen.findByRole('region', { name: 'Recently added' });
    const ranked = vi.mocked(newestTitles).mock.calls.length;

    act(() => usePlayerStore.getState().setTmdbCards([tmdbCard(77)]));
    act(() => usePlayerStore.getState().setTmdbCards([tmdbCard(78)]));

    expect(vi.mocked(newestTitles).mock.calls.length).toBe(ranked);
    expect(screen.getByRole('heading', { name: 'Newest Movie' })).toBeInTheDocument();
  });

  it('shows no hero until the newest title has a TMDB match', async () => {
    setupInvoke(defaultParentalSettings(), []);
    render(<MainScreen />);
    await waitFor(() => expect(calls('get_tmdb_cards').length).toBeGreaterThan(0));
    expect(screen.queryByRole('region', { name: 'Recently added' })).not.toBeInTheDocument();
  });

  it('falls back to the newest matched title when the newest has no match', async () => {
    setupInvoke(defaultParentalSettings(), [1]);
    render(<MainScreen />);
    const hero = await screen.findByRole('region', { name: 'Recently added' });
    expect(within(hero).getByRole('heading', { name: 'Older Movie' })).toBeInTheDocument();
  });

  it('never features an adult-labelled title, even with parental controls off', async () => {
    const adult = movie(3, 'Hot Night', '2026-09-01T00:00:00Z', { group_name: 'Adult XXX' });
    setupInvoke(defaultParentalSettings(), [1, 2, 3]);
    usePlayerStore.getState().setChannels([older, newest, adult]);
    render(<MainScreen />);
    const hero = await screen.findByRole('region', { name: 'Recently added' });
    expect(within(hero).getByRole('heading', { name: 'Newest Movie' })).toBeInTheDocument();
  });

  it('asks for the newest titles right away so the hero is warm before the section opens', async () => {
    setupInvoke(defaultParentalSettings(), [1, 2]);
    usePlayerStore.setState({ contentTypeFilter: 'live' });
    render(<MainScreen />);
    await waitFor(() => expect(calls('get_tmdb_cards').length).toBeGreaterThan(0));
    const requested = calls('get_tmdb_cards').flatMap(
      (c) => (c[1] as { channelIds: number[] }).channelIds
    );
    expect(requested).toEqual(expect.arrayContaining([2, 1]));
  });
});

describe('MainScreen: Series hero', () => {
  const olderShow = movie(11, 'Older Show', '2026-01-01T00:00:00Z', { content_type: 'series' });
  const newestShow = movie(12, 'Newest Show', '2026-06-01T00:00:00Z', { content_type: 'series' });

  beforeEach(() => {
    setupInvoke(defaultParentalSettings(), [11, 12]);
    usePlayerStore.setState({
      playlists: [home],
      activeProfileId: 1,
      currentPlaylist: home,
      contentTypeFilter: 'series',
      categoryFilter: null,
      searchQuery: '',
      isPlaying: false,
      currentChannel: null,
      currentSeries: null,
      selectedSeason: null,
      tmdbCards: new Map(),
      parentalEnabled: false,
      parentalUnlocked: false,
      blockedChannelIds: new Set(),
      blockedCategories: [],
      parentalVisibility: 'hide',
      parentalAutoDetect: false,
    });
    usePlayerStore.getState().setChannels([olderShow, newestShow]);
  });

  it('shows the hero for the newest series with an Open button', async () => {
    render(<MainScreen />);
    const hero = await screen.findByRole('region', { name: 'Recently added' });
    expect(within(hero).getByRole('heading', { name: 'Newest Show' })).toBeInTheDocument();
    expect(within(hero).getByRole('button', { name: 'Open Newest Show' })).toBeInTheDocument();
  });

  it("the hero's Open button opens the detail view instead of playing", async () => {
    render(<MainScreen />);
    const hero = await screen.findByRole('region', { name: 'Recently added' });
    fireEvent.click(within(hero).getByRole('button', { name: 'Open Newest Show' }));
    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(calls('play_channel')).toHaveLength(0);
  });

  it('hides the hero when a search query is active', async () => {
    render(<MainScreen />);
    await screen.findByRole('region', { name: 'Recently added' });
    usePlayerStore.getState().setSearchQuery('Older');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Recently added' })).not.toBeInTheDocument()
    );
  });

  it('shows a movie in cross-type search results with its TMDB year and rating, not "No guide data"', async () => {
    setupInvoke(defaultParentalSettings(), [11, 12, 2]);
    usePlayerStore.setState({ contentTypeFilter: 'live', searchQuery: 'Newest' });
    usePlayerStore
      .getState()
      .setChannels([olderShow, newestShow, movie(2, 'Newest Movie', '2026-06-01T00:00:00Z')]);
    render(<MainScreen />);
    expect(await screen.findByText('Movie · 2024 · ★ 7.5')).toBeInTheDocument();
    expect(screen.getByText('Series · 2024 · ★ 7.5')).toBeInTheDocument();
    expect(screen.queryByText('No guide data')).not.toBeInTheDocument();
  });
});
