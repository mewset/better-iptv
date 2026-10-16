import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Setup from '../../components/Setup';
import { usePlayerStore } from '../../stores/player-store';
import {
  checkMpvInstalled,
  importPlaylist,
  getPlaylists,
  setActiveProfileId as persistActiveProfileId,
} from '../../lib/tauri';
import type { Playlist } from '../../types';

vi.mock('../../lib/tauri', () => ({
  checkMpvInstalled: vi.fn(),
  importPlaylist: vi.fn(),
  importXtreamPlaylist: vi.fn(),
  getChannels: vi.fn(async () => []),
  getPlaylists: vi.fn(),
  setActiveProfileId: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => {}),
}));

const created = { id: 7, name: 'Home TV' } as Playlist;

async function submitFirstRun() {
  render(<Setup />);
  fireEvent.change(screen.getByLabelText(/profile name|playlist name|name/i), {
    target: { value: 'Home TV' },
  });
  fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'http://x/list.m3u' } });
  fireEvent.submit(
    screen.getByRole('button', { name: /import|add|continue|start/i }).closest('form')!
  );
}

describe('Setup first run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMpvInstalled).mockResolvedValue(true);
    vi.mocked(importPlaylist).mockResolvedValue(created);
    usePlayerStore.setState({
      isLoading: false,
      isSetupComplete: false,
      playlists: [],
      activeProfileId: null,
    });
  });

  it('first-run import puts the profile in the store', async () => {
    vi.mocked(getPlaylists).mockResolvedValue([created]);
    await submitFirstRun();

    await waitFor(() => expect(usePlayerStore.getState().isSetupComplete).toBe(true));
    expect(usePlayerStore.getState().playlists).toEqual([created]);
    expect(usePlayerStore.getState().activeProfileId).toBe(7);
    expect(persistActiveProfileId).toHaveBeenCalledWith(7);
  });

  it('falls back to the imported playlist when get_playlists fails', async () => {
    vi.mocked(getPlaylists).mockRejectedValue(new Error('boom'));
    await submitFirstRun();

    await waitFor(() => expect(usePlayerStore.getState().isSetupComplete).toBe(true));
    expect(usePlayerStore.getState().playlists).toEqual([created]);
    expect(usePlayerStore.getState().activeProfileId).toBe(7);
  });
});
