import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import MainScreen from '../../components/MainScreen';
import { usePlayerStore } from '../../stores/player-store';
import { useEpgStore } from '../../stores/epg-store';
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
      case 'get_epg_now_next':
        return {};
      case 'get_parental_settings':
        return {
          enabled: false,
          has_pin: false,
          blocked_categories: [],
          visibility: 'hide',
          auto_detect: false,
        };
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

describe('MainScreen: channel load placeholders', () => {
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
      isPlaying: false,
      currentChannel: null,
      parentalEnabled: false,
      parentalUnlocked: false,
      blockedChannelIds: new Set(),
      blockedCategories: [],
      parentalVisibility: 'hide',
      parentalAutoDetect: false,
      channels: [],
      liveChannels: [],
      vodChannels: [],
      seriesChannels: [],
      favoriteChannels: [],
      channelLoad: { live: 'loading', library: 'loading' },
      retryChannels: vi.fn(async () => {}),
    });
  });

  it('shows placeholders, not the empty state, while live channels load', () => {
    render(<MainScreen />);
    expect(screen.getByTestId('channel-grid-placeholder')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Nothing in this section yet')).toBeNull();
    expect(screen.queryByTestId('channel-load-error')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows the Live list while the library is still loading', () => {
    usePlayerStore.setState({
      channels: [svt1],
      liveChannels: [svt1],
      channelLoad: { live: 'loaded', library: 'loading' },
    });
    render(<MainScreen />);
    expect(screen.getByText('SVT1')).toBeInTheDocument();
    expect(screen.queryByTestId('channel-grid-placeholder')).toBeNull();
  });

  it('shows placeholders for a search typed before the library arrives', async () => {
    usePlayerStore.setState({
      channels: [svt1],
      liveChannels: [svt1],
      channelLoad: { live: 'loaded', library: 'loading' },
    });
    render(<MainScreen />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(await screen.findByTestId('channel-grid-placeholder')).toBeInTheDocument();
    expect(screen.queryByText(/No matches/)).toBeNull();

    usePlayerStore.setState({ channelLoad: { live: 'loaded', library: 'loaded' } });
    expect(await screen.findByText(/No matches for/)).toBeInTheDocument();
    expect(screen.queryByTestId('channel-grid-placeholder')).toBeNull();
  });

  it('requests no EPG while the section shows placeholders', async () => {
    usePlayerStore.setState({
      channels: [svt1],
      liveChannels: [svt1],
      channelLoad: { live: 'loaded', library: 'loading' },
    });
    render(<MainScreen />);
    // A search needs the library too: SVT1 matches but its card is not shown yet
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'SVT' } });
    expect(await screen.findByTestId('channel-grid-placeholder')).toBeInTheDocument();
    // Longer than the hook's 500 ms debounce
    await new Promise((resolve) => setTimeout(resolve, 800));
    const epgCalls = () => mockedInvoke.mock.calls.filter((c) => c[0] === 'get_epg_now_next');
    expect(epgCalls()).toHaveLength(0);

    // Once the card is on screen the lookup runs
    usePlayerStore.setState({ channelLoad: { live: 'loaded', library: 'loaded' } });
    await waitFor(() => expect(epgCalls().length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it('shows the error state on Movies when the library failed, and Retry reloads', async () => {
    const retryChannels = vi.fn(async () => {});
    usePlayerStore.setState({
      contentTypeFilter: 'vod',
      channels: [svt1],
      liveChannels: [svt1],
      channelLoad: { live: 'loaded', library: 'error' },
      retryChannels,
    });
    render(<MainScreen />);
    expect(screen.getByTestId('channel-load-error')).toBeInTheDocument();
    expect(screen.getByText("Couldn't load your channels.")).toBeInTheDocument();
    expect(screen.queryByText('Nothing in this section yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(retryChannels).toHaveBeenCalledTimes(1));
  });

  it('keeps Live working when only the library failed', () => {
    usePlayerStore.setState({
      channels: [svt1],
      liveChannels: [svt1],
      channelLoad: { live: 'loaded', library: 'error' },
    });
    render(<MainScreen />);
    expect(screen.getByText('SVT1')).toBeInTheDocument();
    expect(screen.queryByTestId('channel-load-error')).toBeNull();
  });

  it('shows no channel count in the header while live channels load', () => {
    render(<MainScreen />);
    expect(screen.queryByText(/\d+ channels?/)).toBeNull();
  });

  it('shows no count above the error state on Movies', () => {
    usePlayerStore.setState({
      contentTypeFilter: 'vod',
      channels: [svt1],
      liveChannels: [svt1],
      channelLoad: { live: 'loaded', library: 'error' },
    });
    render(<MainScreen />);
    expect(screen.getByTestId('channel-load-error')).toBeInTheDocument();
    expect(screen.queryByText(/\d+ titles?/)).toBeNull();
  });

  it('shows the count once loaded', () => {
    usePlayerStore.setState({
      channels: [svt1],
      liveChannels: [svt1],
      channelLoad: { live: 'loaded', library: 'loaded' },
    });
    render(<MainScreen />);
    expect(screen.getByText('1 channel')).toBeInTheDocument();
  });
});
