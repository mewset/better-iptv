import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import ProfileManager from '../../components/ProfileManager';
import { usePlayerStore } from '../../stores/player-store';
import type { Playlist } from '../../types';

vi.mock('../../lib/tauri', () => ({
  setActiveProfileId: vi.fn(),
  deletePlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  getChannels: vi.fn(async () => []),
  getSubscriptionExpiry: vi.fn(),
  getPlaylistChannelCounts: vi.fn(),
  importPlaylist: vi.fn(),
  importXtreamPlaylist: vi.fn(),
}));

import { getSubscriptionExpiry, getPlaylistChannelCounts } from '../../lib/tauri';

function playlist(
  id: number,
  name: string,
  xtream: boolean,
  extra: Partial<Playlist> = {}
): Playlist {
  return {
    id,
    name,
    url: 'http://provider.example',
    auto_refresh: false,
    xtream_username: xtream ? 'user' : undefined,
    xtream_password: xtream ? 'pass' : undefined,
    ...extra,
  };
}

function setProfiles(playlists: Playlist[]) {
  usePlayerStore.setState({ playlists, activeProfileId: playlists[0]?.id ?? null });
}

describe('ProfileManager subscription expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // A per-test-suite default map; individual ids used across the file:
    // 1 = expired long ago, 2 = expires far in the future, 4 = expires soon.
    vi.mocked(getSubscriptionExpiry).mockImplementation(async (id: number) => {
      if (id === 1) return '2026-02-01T00:00:00+00:00';
      if (id === 2) return '2099-03-15T00:00:00+00:00';
      if (id === 4) return new Date(Date.now() + 30 * 86_400_000).toISOString();
      return null;
    });
    vi.mocked(getPlaylistChannelCounts).mockResolvedValue({});
  });

  it('shows the expiry on the card of the profile it belongs to', async () => {
    setProfiles([playlist(1, 'Expired Provider', true)]);

    render(<ProfileManager onClose={vi.fn()} />);

    expect(await screen.findByText(/Subscription ended/)).toBeInTheDocument();
  });

  it('gives each profile its own date rather than sharing one', async () => {
    setProfiles([playlist(1, 'Expired Provider', true), playlist(2, 'Live Provider', true)]);

    render(<ProfileManager onClose={vi.fn()} />);

    expect(await screen.findByText(/Subscription ended/)).toBeInTheDocument();
    expect(await screen.findByText(/Subscription ends/)).toBeInTheDocument();
  });

  it('leaves an M3U profile alone and never asks the backend about it', async () => {
    setProfiles([playlist(3, 'Plain M3U', false)]);

    render(<ProfileManager onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Plain M3U')).toBeInTheDocument());
    expect(screen.queryByText(/Subscription end/)).not.toBeInTheDocument();
    expect(getSubscriptionExpiry).not.toHaveBeenCalled();
  });

  it('gives an expiry within 60 days the accent treatment', async () => {
    setProfiles([playlist(4, 'Expiring Soon Provider', true)]);

    render(<ProfileManager onClose={vi.fn()} />);

    const line = await screen.findByText(/Subscription ends/);
    expect(line).toHaveClass('text-accent-text');
    expect(line).toHaveClass('font-semibold');
  });

  it('does not give a far-future expiry the accent treatment', async () => {
    setProfiles([playlist(2, 'Live Provider', true)]);

    render(<ProfileManager onClose={vi.fn()} />);

    const line = await screen.findByText(/Subscription ends/);
    expect(line).not.toHaveClass('text-accent-text');
  });

  it('flags a playlist refreshed more than a week ago', async () => {
    const nineDaysAgo = new Date(Date.now() - 9 * 86_400_000).toISOString();
    setProfiles([playlist(5, 'Stale Cabin', false, { last_updated: nineDaysAgo })]);

    render(<ProfileManager onClose={vi.fn()} />);

    expect(await screen.findByText('Older than a week')).toBeInTheDocument();
  });

  it('renders the channel count from get_playlist_channel_counts', async () => {
    vi.mocked(getPlaylistChannelCounts).mockResolvedValue({ 6: 42 });
    setProfiles([playlist(6, 'Counted Provider', false)]);

    render(<ProfileManager onClose={vi.fn()} />);

    expect(await screen.findByText('42 channels')).toBeInTheDocument();
  });

  it('shows the singular "1 channel" for a count of exactly one', async () => {
    vi.mocked(getPlaylistChannelCounts).mockResolvedValue({ 7: 1 });
    setProfiles([playlist(7, 'Single Channel Provider', false)]);

    render(<ProfileManager onClose={vi.fn()} />);

    expect(await screen.findByText('1 channel')).toBeInTheDocument();
    expect(screen.queryByText('1 channels')).not.toBeInTheDocument();
  });

  it('refetches channel counts when a profile is added, so the new card gets a count', async () => {
    vi.mocked(getPlaylistChannelCounts)
      .mockResolvedValueOnce({ 8: 10 })
      .mockResolvedValueOnce({ 8: 10, 9: 20 });

    setProfiles([playlist(8, 'First Provider', false)]);

    render(<ProfileManager onClose={vi.fn()} />);

    expect(await screen.findByText('10 channels')).toBeInTheDocument();
    expect(getPlaylistChannelCounts).toHaveBeenCalledTimes(1);

    act(() => {
      usePlayerStore.setState({
        playlists: [...usePlayerStore.getState().playlists, playlist(9, 'Second Provider', false)],
      });
    });

    await waitFor(() => expect(getPlaylistChannelCounts).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('20 channels')).toBeInTheDocument();
    // The first card's count survives the refetch rather than disappearing.
    expect(screen.getByText('10 channels')).toBeInTheDocument();
  });
});
