import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ProfileManager from '../../components/ProfileManager';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel, Playlist } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('../../lib/tauri', () => ({
  LIVE_TYPES: ['live'],
  LIBRARY_TYPES: ['vod', 'series'],
  setActiveProfileId: vi.fn(),
  deletePlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  getChannels: vi.fn(),
  getPlaylists: vi.fn(),
  refreshPlaylist: vi.fn(),
  getSubscriptionExpiry: vi.fn(async () => null),
  getPlaylistChannelCounts: vi.fn(async () => ({})),
  importPlaylist: vi.fn(),
  importXtreamPlaylist: vi.fn(),
}));

import { getChannels, getPlaylists, refreshPlaylist } from '../../lib/tauri';

const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

const profile: Playlist = {
  id: 1,
  name: 'Home',
  url: 'http://provider.example/list.m3u',
  auto_refresh: false,
  last_updated: monthAgo,
};

const channel = (id: number, name: string): Channel => ({
  id,
  name,
  content_type: 'live',
  is_favorite: false,
});

function deferred() {
  let resolve!: (value: Channel[]) => void;
  const promise = new Promise<Channel[]>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ProfileManager refresh of the active profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePlayerStore.getState().setChannels([channel(1, 'SVT1')]);
    usePlayerStore.setState({
      playlists: [profile],
      activeProfileId: 1,
      currentPlaylist: profile,
    });
    vi.mocked(refreshPlaylist).mockResolvedValue({ added: 1, updated: 0, removed: 0 } as never);
    vi.mocked(getChannels).mockResolvedValue([channel(1, 'SVT1'), channel(2, 'SVT2')]);
    vi.mocked(getPlaylists).mockResolvedValue([
      { ...profile, last_updated: new Date().toISOString() },
    ]);
  });

  it('updates the grid lists and the card refresh line', async () => {
    render(<ProfileManager onClose={vi.fn()} />);
    expect(screen.getByText('Older than a week')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() =>
      expect(usePlayerStore.getState().liveChannels.map((c) => c.name)).toContain('SVT2')
    );
    expect(await screen.findByText(/Refreshed today/)).toBeInTheDocument();
    expect(screen.queryByText('Older than a week')).toBeNull();
  });
  it("a refresh during a boot load wins over the boot load's late result", async () => {
    const live = deferred();
    const library = deferred();
    const fresh = [channel(1, 'SVT1'), channel(2, 'SVT2')];
    vi.mocked(getChannels).mockImplementation(async (_id, types) => {
      if (types === undefined) return fresh;
      return types.includes('live') ? live.promise : library.promise;
    });

    // Boot load is in flight: both parts wait on their deferred responses
    const boot = usePlayerStore.getState().loadChannels(1);
    expect(usePlayerStore.getState().channelLoad).toEqual({ live: 'loading', library: 'loading' });

    render(<ProfileManager onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(usePlayerStore.getState().liveChannels.map((c) => c.name)).toContain('SVT2')
    );
    expect(usePlayerStore.getState().channelLoad).toEqual({ live: 'loaded', library: 'loaded' });

    // The boot load's responses arrive late and must be dropped
    live.resolve([channel(9, 'Stale live')]);
    library.resolve([{ ...channel(10, 'Stale movie'), content_type: 'vod' }]);
    await boot;

    const state = usePlayerStore.getState();
    expect(state.channels).toEqual(fresh);
    expect(state.liveChannels).toEqual(fresh);
    expect(state.vodChannels).toEqual([]);
    expect(state.channelLoad).toEqual({ live: 'loaded', library: 'loaded' });
  });

  it("a refresh that lands after a profile switch does not replace the new profile's channels", async () => {
    const refetch = deferred();
    vi.mocked(getChannels).mockImplementation(async () => refetch.promise);

    render(<ProfileManager onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(getChannels).toHaveBeenCalledWith(1));

    // The user switches to profile 2 while A's channel fetch is in flight
    const other: Playlist = { id: 2, name: 'Other', auto_refresh: false };
    usePlayerStore.setState({ currentPlaylist: other, activeProfileId: 2 });
    usePlayerStore.getState().setChannels([channel(20, 'Other1')]);

    refetch.resolve([channel(1, 'SVT1'), channel(2, 'SVT2')]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(usePlayerStore.getState().channels.map((c) => c.name)).toEqual(['Other1']);
  });
});
