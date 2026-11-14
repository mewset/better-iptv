import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import Settings from '../../components/Settings';
import { usePlayerStore } from '../../stores/player-store';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import {
  getSetting,
  setSetting,
  stopPlayback,
  deletePlaylist,
  deleteTmdbCache,
  renamePlaylist,
  setActiveProfileId,
  getParentalSettings,
  resetParentalPin,
  setBlockedChannels,
} from '../../lib/tauri';
import type { Channel, Playlist } from '../../types';
import * as logoFallback from '../../lib/logoFallback';
import { applyTheme } from '../../lib/theme';
import { useEpgStore } from '../../stores/epg-store';
import { epgSource, epgStatus } from '../epgFixtures';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../../lib/tauri', () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  resetParentalPin: vi.fn(async () => {}),
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
  setBlockedChannels: vi.fn(async () => {}),
  verifyParentalPin: vi.fn(async () => true),
  setParentalPin: vi.fn(async () => {}),
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

// jsdom has no layout, so the block list's real virtualizer would render no rows.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 68,
        size: 68,
      })),
    getTotalSize: () => count * 68,
  }),
}));

const NO_PARENTAL = {
  enabled: false,
  has_pin: false,
  auto_detect: false,
  blocked_channels: [] as number[],
  blocked_categories: [] as string[],
  unlock_duration: '0',
  visibility: 'hide' as const,
};

function channel(id: number, name: string): Channel {
  return {
    id,
    playlist_id: 1,
    name,
    url: `http://home.example/${id}.ts`,
    content_type: 'live',
    is_favorite: false,
    sort_order: id,
  } as Channel;
}

async function goToParental() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: /^parental$/i }));
  await screen.findByRole('heading', { level: 1, name: 'Parental' });
}

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
    vi.mocked(getParentalSettings).mockImplementation(async () => NO_PARENTAL);
    // The EPG tab's guide commands go through invoke, not the tauri module.
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === 'get_epg_status' ? epgStatus(true, { sources: [epgSource({ id: 3 })] }) : undefined
    );
    useEpgStore.setState(useEpgStore.getInitialState(), true);
    usePlayerStore.setState({
      playlists: [],
      currentPlaylist: null,
      channels: [],
      isPlaying: false,
      currentChannel: null,
    });
  });

  it('loads every setting before any of them resolves', async () => {
    const release: Array<() => void> = [];
    vi.mocked(getSetting).mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          release.push(() => resolve(null));
        })
    );
    render(<Settings onClose={vi.fn()} />);

    // Sequential loading would show exactly one pending call here.
    await waitFor(() => expect(release).toHaveLength(17));
    release.forEach((r) => r());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
  });

  it('save is disabled and writes nothing when loading failed', async () => {
    let calls = 0;
    vi.mocked(getSetting).mockImplementation(async () => {
      calls += 1;
      if (calls === 3) throw new Error('db locked');
      return null;
    });
    render(<WithShortcuts onClose={vi.fn()} />);

    await screen.findByText(/could not be loaded/i);
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    expect(screen.getByText(/reopening settings/i)).toBeInTheDocument();

    fireEvent.click(save);
    // Save has no keyboard shortcut; Ctrl+S must not reach a write either.
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('renders seven section triggers with their descriptions', async () => {
    await renderSettings();

    const expected: Array<[string, string]> = [
      ['General', 'Playlist, appearance, updates'],
      ['Playback', 'MPV, video, audio, subtitles'],
      ['EPG', 'Sources, updates and time correction'],
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
        throw { code: 'InvalidInput', details: 'Background fetching needs your own TMDB API key' };
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
    expect(screen.getByText('Background fetching needs your own TMDB API key')).toBeInTheDocument();
  });

  it('saving a changed logo setting resets the session and reloads channels', async () => {
    const loadChannels = vi.fn(async () => {});
    const resetSpy = vi.spyOn(logoFallback, 'resetLogoFallbackSession');
    usePlayerStore.setState({ currentPlaylist: playlist(7, 'Home'), loadChannels });
    await renderSettings();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^metadata$/i }));
    await screen.findByRole('heading', { level: 1, name: 'Metadata' });
    const box = screen.getByRole('checkbox', {
      name: 'Fill in missing channel logos from iptv-org',
    });
    expect(box).toBeChecked();

    // Unchanged: written, but no reset and no reload.
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith('logo_fallback_enabled', '1'));
    expect(resetSpy).not.toHaveBeenCalled();
    expect(loadChannels).not.toHaveBeenCalled();

    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith('logo_fallback_enabled', '0'));
    await waitFor(() => expect(loadChannels).toHaveBeenCalledWith(7));
    expect(resetSpy).toHaveBeenCalledTimes(1);
    resetSpy.mockRestore();
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

  it('the EPG tab acts at once: nothing of it is saved, fetched on save or counted as unsaved', async () => {
    const onClose = await renderSettings();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^epg$/i }));
    await screen.findByRole('heading', { level: 1, name: 'EPG' });
    const source = await screen.findByRole('article', {
      name: "Your provider's guide · signed in with your account",
    });

    // An action is sent straight away, without Save.
    fireEvent.click(
      within(source).getByRole('checkbox', {
        name: "Enable Your provider's guide · signed in with your account",
      })
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('update_epg_source', { id: 3, patch: { enabled: false } })
    );
    // A half-typed URL is not an unsaved setting either.
    fireEvent.change(screen.getByLabelText('Add a source'), {
      target: { value: 'http://typed.example/g.xml' },
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard changes?')).toBeNull();

    vi.mocked(invoke).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    expect(vi.mocked(setSetting).mock.calls.map(([key]) => key)).not.toContain('epg_url');
    expect(getSetting).not.toHaveBeenCalledWith('epg_url');
    const guideCalls = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    for (const cmd of [
      'add_epg_source',
      'refresh_epg',
      'update_epg_source',
      'set_epg_time_policy',
    ]) {
      expect(guideCalls).not.toContain(cmd);
    }
  });

  it('Escape calls onClose', async () => {
    const onClose = await renderSettings();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes from a checkbox or a list, but stays with a field one types in', async () => {
    const onClose = await renderSettings();

    fireEvent.keyDown(screen.getAllByRole('checkbox')[0], { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getAllByRole('combobox')[0], { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.mouseDown(screen.getByRole('tab', { name: /^metadata$/i }));
    await screen.findByRole('heading', { level: 1, name: 'Metadata' });
    fireEvent.keyDown(screen.getByLabelText('TMDB API key'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  describe('theme preview', () => {
    const isDark = () => document.documentElement.classList.contains('dark');

    // The test environment has no localStorage; the theme cache needs one.
    const cache = new Map<string, string>();
    beforeEach(() => {
      cache.clear();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => cache.get(key) ?? null,
        setItem: (key: string, value: string) => void cache.set(key, value),
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      document.documentElement.classList.remove('dark');
    });

    async function openWithDarkSaved() {
      vi.mocked(getSetting).mockImplementation(async (key: string) =>
        key === 'theme' ? 'dark' : null
      );
      applyTheme('dark');
      const onClose = vi.fn();
      const view = render(<Settings onClose={onClose} />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
      );
      fireEvent.click(screen.getByRole('button', { name: 'light' }));
      expect(isDark()).toBe(false);
      return { onClose, ...view };
    }

    it('leaving without Save puts the stored theme back', async () => {
      const { onClose, unmount } = await openWithDarkSaved();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      // The host unmounts the view on close.
      unmount();

      expect(isDark()).toBe(true);
      expect(cache.get('better-iptv-theme')).toBe('dark');
    });

    it('Save keeps the new theme', async () => {
      const { onClose, unmount } = await openWithDarkSaved();

      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(setSetting).toHaveBeenCalledWith('theme', 'light');
      unmount();

      expect(isDark()).toBe(false);
      expect(cache.get('better-iptv-theme')).toBe('light');
    });
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

  it("a refused rename shows the backend's sentence", async () => {
    vi.mocked(renamePlaylist).mockRejectedValueOnce({
      code: 'InvalidInput',
      details: 'A profile with that name already exists',
    });
    usePlayerStore.setState({ playlists: [playlist(1, 'Home')], activeProfileId: 1 });
    await renderSettings();
    await goToProfiles();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Cabin' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('A profile with that name already exists')).toBeInTheDocument();
  });

  it('Reset PIN reloads the parental state the rest of the app reads', async () => {
    vi.mocked(getParentalSettings).mockImplementation(async () => ({
      ...NO_PARENTAL,
      enabled: true,
      has_pin: true,
    }));
    await renderSettings();
    await goToParental();
    const loadsBefore = vi.mocked(getParentalSettings).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Reset PIN' }));
    fireEvent.change(await screen.findByPlaceholderText('Enter PIN'), {
      target: { value: '1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    const confirm = await screen.findByRole('heading', { name: 'Reset PIN?' });
    fireEvent.click(
      within(confirm.closest('[role="dialog"]') as globalThis.HTMLElement).getByRole('button', {
        name: 'Reset PIN',
      })
    );

    await waitFor(() => expect(resetParentalPin).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(vi.mocked(getParentalSettings).mock.calls.length).toBe(loadsBefore + 1)
    );
  });

  it('the block list only edits: Done keeps it unsaved, Save changes writes it', async () => {
    vi.mocked(getParentalSettings).mockImplementation(async () => ({
      ...NO_PARENTAL,
      enabled: true,
      has_pin: true,
      blocked_channels: [1],
    }));
    usePlayerStore.setState({
      channels: [channel(1, 'One'), channel(2, 'Two'), channel(3, 'Three')],
    });
    const onClose = await renderSettings();
    await goToParental();

    fireEvent.click(screen.getByRole('button', { name: 'Select Channels (1 blocked)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('1 of 3 channels blocked')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block All' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Select Channels (3 blocked)' })).toBeInTheDocument();
    expect(setBlockedChannels).not.toHaveBeenCalled();

    // Unsaved for real now, so leaving asks.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await screen.findByText('Discard changes?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(setBlockedChannels).toHaveBeenCalledWith([1, 2, 3]));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Save leaves auto-detected channels out of the manual block list', async () => {
    vi.mocked(getParentalSettings).mockImplementation(async () => ({
      ...NO_PARENTAL,
      enabled: true,
      has_pin: true,
      auto_detect: true,
      blocked_channels: [1],
    }));
    usePlayerStore.setState({
      channels: [channel(1, 'One'), channel(2, 'Late Night XXX'), channel(3, 'Three')],
    });
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(setBlockedChannels).toHaveBeenCalledWith([1]));
    expect(setSetting).toHaveBeenCalledWith('parental_auto_detect', 'true');
  });

  it('Delete asks first, and deletes only on confirmation', async () => {
    usePlayerStore.setState({
      playlists: [playlist(1, 'Home'), playlist(2, 'Cabin')],
      activeProfileId: 1,
    });
    await renderSettings();
    await goToProfiles();

    // Cabin is the second card and not the active profile.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Delete Profile?' })).toBeInTheDocument();
    expect(within(dialog).getByText(/"Cabin"/)).toBeInTheDocument();
    expect(deletePlaylist).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deletePlaylist).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' })
    );
    await waitFor(() => expect(deletePlaylist).toHaveBeenCalledWith(2));
    await waitFor(() => expect(screen.queryByText('Cabin')).toBeNull());
    // An inactive profile is deleted without touching the active one.
    expect(setActiveProfileId).not.toHaveBeenCalled();
  });

  it('keeps the active profile when the switch away from it fails', async () => {
    vi.mocked(setActiveProfileId).mockRejectedValueOnce({
      code: 'Database',
      details: 'database is locked',
    });
    usePlayerStore.setState({
      playlists: [playlist(1, 'Home'), playlist(2, 'Cabin')],
      activeProfileId: 1,
    });
    await renderSettings();
    await goToProfiles();

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' })
    );

    expect(await screen.findByText('database is locked')).toBeInTheDocument();
    expect(setActiveProfileId).toHaveBeenCalledWith(2);
    expect(deletePlaylist).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().playlists).toHaveLength(2);
  });

  it('deleting the only profile says what happens and goes back to adding a playlist', async () => {
    usePlayerStore.setState({
      playlists: [playlist(1, 'Home')],
      activeProfileId: 1,
      isSetupComplete: true,
    });
    const onClose = await renderSettings();
    await goToProfiles();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/asked to add a playlist again/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/restart|onboarding/i)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deletePlaylist).toHaveBeenCalledWith(1));
    await waitFor(() => expect(usePlayerStore.getState().isSetupComplete).toBe(false));
    expect(onClose).toHaveBeenCalled();
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
