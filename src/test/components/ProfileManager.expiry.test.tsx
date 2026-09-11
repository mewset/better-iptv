import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ProfileManager from '../../components/ProfileManager';
import { usePlayerStore } from '../../stores/player-store';
import type { Playlist } from '../../types';

vi.mock('../../lib/tauri', () => ({
  setActiveProfileId: vi.fn(),
  deletePlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  getChannels: vi.fn(async () => []),
  getSubscriptionExpiry: vi.fn(async (id: number) =>
    id === 1 ? '2026-02-01T00:00:00+00:00' : '2099-03-15T00:00:00+00:00'
  ),
  importPlaylist: vi.fn(),
  importXtreamPlaylist: vi.fn(),
}));

import { getSubscriptionExpiry } from '../../lib/tauri';

function playlist(id: number, name: string, xtream: boolean): Playlist {
  return {
    id,
    name,
    url: 'http://provider.example',
    auto_refresh: false,
    xtream_username: xtream ? 'user' : undefined,
    xtream_password: xtream ? 'pass' : undefined,
  };
}

function setProfiles(playlists: Playlist[]) {
  usePlayerStore.setState({ playlists, activeProfileId: playlists[0]?.id ?? null });
}

describe('ProfileManager subscription expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
