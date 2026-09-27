import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Settings from '../../components/Settings';
import { usePlayerStore } from '../../stores/player-store';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import {
  getSetting,
  setSetting,
  stopPlayback,
  deletePlaylist,
  deleteTmdbCache,
} from '../../lib/tauri';
import type { Channel, Playlist } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

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
  getTmdbStatus: vi.fn(async () => ({
    enabled: true,
    has_user_key: false,
    has_shared_key: false,
    user_key_rejected: false,
    shared_key_rejected: false,
    language: 'en-US',
    background_enrich: false,
    background_progress: null,
  })),
  checkTmdbKey: vi.fn(async () => {}),
  deleteTmdbCache: vi.fn(async () => 0),
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
  // The tab list renders before loading is done; Save stays disabled until it
  // is, so an early click on a slow runner does nothing at all.
  await screen.findByRole('tab', { name: /general/i });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
  return onClose;
}

describe('Settings as a view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations; put back the defaults a test may
    // have swapped out.
    vi.mocked(getSetting).mockImplementation(async () => null);
    vi.mocked(setSetting).mockImplementation(async () => {});
    usePlayerStore.setState({
      playlists: [],
      currentPlaylist: null,
      channels: [],
      isPlaying: false,
      currentChannel: null,
    });
  });

  it('renders seven section triggers with their descriptions', async () => {
    await renderSettings();

    const expected: Array<[string, string]> = [
      ['General', 'Playlist, appearance, updates'],
      ['Playback', 'MPV, video, audio, subtitles'],
      ['EPG', 'Guide sources and refresh'],
      ['Metadata', 'Posters and details from TMDB'],
      ['Parental', 'PIN and blocked content'],
      ['Profiles', 'Playlists and providers'],
      ['About', 'Version and licenses'],
    ];

    for (const [name, description] of expected) {
      expect(screen.getByRole('tab', { name: new RegExp(`^${name}$`, 'i') })).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
    }

    expect(screen.getAllByRole('tab')).toHaveLength(expected.length);
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
  });

  it('Save writes the TMDB keys and clears the cache when the language changed', async () => {
    await renderSettings();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^metadata$/i }));
    await screen.findByRole('heading', { level: 1, name: 'Metadata' });
    fireEvent.change(screen.getByLabelText('Metadata language'), { target: { value: 'sv-SE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith('tmdb_language', 'sv-SE'));
    expect(setSetting).toHaveBeenCalledWith('tmdb_enabled', '1');
    expect(setSetting).toHaveBeenCalledWith('tmdb_api_key', '');
    expect(deleteTmdbCache).toHaveBeenCalled();
  });

  it('Save writes tmdb_background_enrich after tmdb_api_key, false once the key is emptied', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === 'tmdb_api_key' ? 'own-key' : key === 'tmdb_background_enrich' ? '1' : null
    );
    await renderSettings();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^metadata$/i }));
    await screen.findByRole('heading', { level: 1, name: 'Metadata' });
    const box = screen.getByRole('checkbox', {
      name: 'Fetch details for the whole library in the background',
    });
    expect(box).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith('tmdb_background_enrich', '1'));
    const calls = vi.mocked(setSetting).mock.calls.map(([key]) => key);
    expect(calls.indexOf('tmdb_background_enrich')).toBeGreaterThan(calls.indexOf('tmdb_api_key'));

    // Emptying the key saves the flag as off, whatever the checkbox held.
    vi.mocked(setSetting).mockClear();
    fireEvent.change(screen.getByLabelText('TMDB API key'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith('tmdb_background_enrich', '0'));
  });

  it('shows the backend refusal of the background flag in the error modal', async () => {
    vi.mocked(setSetting).mockImplementation(async (key: string, value: string) => {
      if (key === 'tmdb_background_enrich' && value === '1')
        throw 'Background fetching needs your own TMDB API key';
    });
    await renderSettings();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^metadata$/i }));
    await screen.findByRole('heading', { level: 1, name: 'Metadata' });
    fireEvent.change(screen.getByLabelText('TMDB API key'), { target: { value: 'k' } });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Fetch details for the whole library in the background',
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('heading', { name: 'Failed to Save Settings' });
    expect(screen.getByText(/Background fetching needs your own TMDB API key/)).toBeInTheDocument();
  });

  it('Save with an unchanged language leaves the cache alone', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith('tmdb_enabled', '1'));
    expect(deleteTmdbCache).not.toHaveBeenCalled();
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

  it('labels the footer button "Save changes"', async () => {
    await renderSettings();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('an empty rename reports "Invalid profile name"', async () => {
    usePlayerStore.setState({ playlists: [playlist(1, 'Home')], activeProfileId: 1 });
    await renderSettings();
    await goToProfiles();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Invalid profile name')).toBeInTheDocument();
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
