import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Settings from '../../components/Settings';
import { usePlayerStore } from '../../stores/player-store';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { setSetting, stopPlayback, deletePlaylist } from '../../lib/tauri';
import type { Channel, Playlist } from '../../types';

vi.mock('../../lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  fetchEpgData: vi.fn(async () => 0),
  resetParentalPin: vi.fn(async () => {}),
  getEpgStatus: vi.fn(async () => ({ has_url: false, last_fetched: null, program_count: 0 })),
  forceRefreshEpg: vi.fn(async () => ({
    success: true,
    programs_loaded: 0,
    timestamp: '',
    error: null,
  })),
  getChannels: vi.fn(async () => []),
  getParentalSettings: vi.fn(async () => ({
    enabled: false,
    has_pin: false,
    auto_detect: false,
    blocked_channels: [],
    blocked_categories: [],
    unlock_duration: '0',
    visibility: 'hide',
  })),
  getBlockedChannels: vi.fn(async () => []),
  setBlockedChannels: vi.fn(async () => {}),
  stopPlayback: vi.fn(async () => {}),
  playChannel: vi.fn(async () => {}),
  renamePlaylist: vi.fn(async () => {}),
  deletePlaylist: vi.fn(async () => {}),
  setActiveProfileId: vi.fn(async () => {}),
  getSubscriptionExpiry: vi.fn(async () => null),
  getPlaylistChannelCounts: vi.fn(async () => ({})),
}));

/** Settings next to the global shortcuts, as MainScreen mounts them. */
function WithShortcuts({ onClose }: { onClose: () => void }) {
  const searchRef = useRef<globalThis.HTMLInputElement>(null);
  useKeyboardShortcuts(searchRef);
  return <Settings onClose={onClose} />;
}

function playlist(id: number, name: string): Playlist {
  return { id, name, url: 'http://provider.example', auto_refresh: false };
}

async function goToProfiles() {
  // Radix's Tabs.Trigger switches on mousedown, not click.
  fireEvent.mouseDown(screen.getByRole('tab', { name: /^profiles$/i }));
  await screen.findByRole('heading', { level: 1, name: 'Profiles' });
}

async function renderSettings(onClose = vi.fn()) {
  render(<Settings onClose={onClose} />);
  // Wait for the load effect to finish so tab switching / save aren't racing it.
  await screen.findByRole('tab', { name: /general/i });
  return onClose;
}

describe('Settings as a view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePlayerStore.setState({
      playlists: [],
      currentPlaylist: null,
      channels: [],
      isPlaying: false,
      currentChannel: null,
    });
  });

  it('renders six section triggers with their descriptions', async () => {
    await renderSettings();

    const expected: Array<[string, string]> = [
      ['General', 'Playlist, appearance, updates'],
      ['Playback', 'MPV, video, audio, subtitles'],
      ['EPG', 'Guide sources and refresh'],
      ['Parental', 'PIN and blocked content'],
      ['Profiles', 'Playlists and providers'],
      ['About', 'Version and licenses'],
    ];

    for (const [name, description] of expected) {
      expect(screen.getByRole('tab', { name: new RegExp(`^${name}$`, 'i') })).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
    }

    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
  });

  it('Ctrl+3 selects EPG', async () => {
    await renderSettings();

    fireEvent.keyDown(window, { key: '3', ctrlKey: true });

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /^epg$/i })).toHaveAttribute('aria-selected', 'true')
    );
    expect(screen.getByRole('heading', { name: 'EPG' })).toBeInTheDocument();
  });

  it('Escape calls onClose', async () => {
    const onClose = await renderSettings();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape while the error modal is open does not call onClose', async () => {
    vi.mocked(setSetting).mockRejectedValueOnce(new Error('boom'));
    const onClose = await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByRole('heading', { name: 'Failed to Save Settings' });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    // Closing the modal lets Escape reach Settings again.
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape with a channel playing does not call stop_playback', async () => {
    const playing: Channel = {
      id: 5,
      playlist_id: 1,
      name: 'SVT1',
      url: 'http://home.example/5.ts',
      content_type: 'live',
      is_favorite: false,
      sort_order: 0,
    } as Channel;
    usePlayerStore.setState({ isPlaying: true, currentChannel: playing });

    const onClose = vi.fn();
    render(<WithShortcuts onClose={onClose} />);
    await screen.findByRole('tab', { name: /general/i });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(stopPlayback).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it('Escape during a profile rename cancels the rename and leaves Settings open', async () => {
    usePlayerStore.setState({ playlists: [playlist(1, 'Home')], activeProfileId: 1 });
    const onClose = await renderSettings();

    await goToProfiles();
    await screen.findByText('Home');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    // The rename was cancelled: the input is gone, the old name is back.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    // Settings itself did not react to the same Escape.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape with ProfileManager's delete-last-profile warning open leaves Settings open", async () => {
    usePlayerStore.setState({ playlists: [playlist(1, 'Home')], activeProfileId: 1 });
    const onClose = await renderSettings();

    await goToProfiles();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete Last Profile?');

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Delete Last Profile?')).toBeInTheDocument();
    expect(deletePlaylist).not.toHaveBeenCalled();
  });
});
