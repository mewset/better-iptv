import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ProfileManager from '../../components/ProfileManager';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel, Playlist } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('../../lib/tauri', () => ({
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
  playlist_id: 1,
  name,
  url: `http://x/${id}`,
  content_type: 'live',
  is_favorite: false,
  sort_order: id,
});

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
});
