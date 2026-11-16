import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ProfileManager from '../../components/ProfileManager';
import { usePlayerStore } from '../../stores/player-store';
import type { Playlist } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => {}),
}));

vi.mock('../../lib/tauri', () => ({
  LIVE_TYPES: ['live'],
  LIBRARY_TYPES: ['vod', 'series'],
  setActiveProfileId: vi.fn(),
  deletePlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  getChannels: vi.fn(async () => []),
  getPlaylists: vi.fn(async () => []),
  refreshPlaylist: vi.fn(),
  getSubscriptionExpiry: vi.fn(async () => null),
  getPlaylistChannelCounts: vi.fn(async () => ({})),
  importPlaylist: vi.fn(),
  importXtreamPlaylist: vi.fn(),
  checkMpvInstalled: vi.fn(async () => true),
}));

const profile: Playlist = {
  id: 1,
  name: 'Home',
  url: 'http://provider.example/list.m3u',
  auto_refresh: false,
  last_updated: new Date().toISOString(),
};

async function openAddProfile() {
  render(<ProfileManager onClose={vi.fn()} />);
  const add = screen.getByRole('button', { name: /add profile/i });
  add.focus();
  fireEvent.click(add);
  // Named by its heading, like every other dialog
  await screen.findByRole('dialog', { name: 'Add a profile' });
  return add;
}

describe('ProfileManager, the Add profile overlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePlayerStore.setState({
      playlists: [profile],
      activeProfileId: 1,
      currentPlaylist: profile,
      isLoading: false,
    });
  });

  it('closes on Escape, also from a field, and hands the focus back', async () => {
    const add = await openAddProfile();

    const name = screen.getByLabelText('Playlist name');
    name.focus();
    fireEvent.keyDown(name, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(add).toHaveFocus();
  });

  it('stays open on Escape while a playlist is being imported', async () => {
    await openAddProfile();
    act(() => usePlayerStore.setState({ isLoading: true }));

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.getByRole('dialog', { name: 'Add a profile' })).toBeInTheDocument();
  });
});
