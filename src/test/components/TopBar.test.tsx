import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef, useRef, useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { TopBar } from '../../components/TopBar';
import { usePlayerStore } from '../../stores/player-store';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import type { Channel, Playlist } from '../../types';

const switchTo = vi.fn(async () => {});
const clearError = vi.fn();
let switchError: string | null = null;

vi.mock('../../hooks/useProfileSwitch', () => ({
  useProfileSwitch: () => ({ switchTo, error: switchError, clearError }),
}));

const home: Playlist = { id: 1, name: 'Home', url: 'http://home.example', auto_refresh: false };
const cabin: Playlist = { id: 2, name: 'Cabin', url: 'http://cabin.example', auto_refresh: false };

function baseProps(overrides: Partial<React.ComponentProps<typeof TopBar>> = {}) {
  return {
    title: 'Live TV',
    subtitle: '15 channels',
    searchRef: createRef<globalThis.HTMLInputElement>(),
    query: '',
    onQuery: vi.fn(),
    update: null,
    onOpenUpdate: vi.fn(),
    showSearch: true,
    profileMenuOpen: false,
    onProfileMenuOpenChange: vi.fn(),
    ...overrides,
  };
}

/** TopBar with its menu state held the way MainScreen holds it. */
function Controlled(props: Partial<React.ComponentProps<typeof TopBar>>) {
  const [open, setOpen] = useState(false);
  return <TopBar {...baseProps(props)} profileMenuOpen={open} onProfileMenuOpenChange={setOpen} />;
}

describe('TopBar', () => {
  beforeEach(() => {
    switchTo.mockClear();
    clearError.mockClear();
    switchError = null;
    vi.mocked(invoke).mockReset();
    usePlayerStore.setState({
      playlists: [home, cabin],
      activeProfileId: 1,
      currentPlaylist: home,
      isPlaying: false,
      currentChannel: null,
    });
  });

  it('renders the title and subtitle', () => {
    render(<TopBar {...baseProps()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Live TV' })).toBeInTheDocument();
    expect(screen.getByText('15 channels')).toBeInTheDocument();
  });

  it('points the search ref at the search input and reports typing', () => {
    const searchRef = createRef<globalThis.HTMLInputElement>();
    const onQuery = vi.fn();
    render(<TopBar {...baseProps({ searchRef, onQuery })} />);
    const input = screen.getByRole('searchbox', { name: 'Search channels, movies and series' });
    expect(searchRef.current).toBe(input);
    fireEvent.change(input, { target: { value: 'Sky' } });
    expect(onQuery).toHaveBeenCalledWith('Sky');
  });

  it('hides the search box when showSearch is false', () => {
    render(<TopBar {...baseProps({ showSearch: false })} />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('shows the update pill only when an update exists, and opens it', () => {
    const { rerender } = render(<TopBar {...baseProps()} />);
    expect(screen.queryByRole('button', { name: /available/ })).not.toBeInTheDocument();

    const onOpenUpdate = vi.fn();
    rerender(
      <TopBar
        {...baseProps({
          update: { version: '3.0.1', url: 'https://example.invalid' },
          onOpenUpdate,
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '3.0.1 available' }));
    expect(onOpenUpdate).toHaveBeenCalled();
  });

  it('lists every profile, marks the active one and switches to another', async () => {
    render(<Controlled />);
    const trigger = screen.getByRole('button', { name: /Home/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const menu = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Home', 'Cabin']);
    expect(screen.getByRole('menuitemradio', { name: 'Home' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('menuitemradio', { name: 'Cabin' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(menu).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Cabin' }));
    await waitFor(() => expect(switchTo).toHaveBeenCalledWith(cabin));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('does not switch when the active profile is chosen again', () => {
    render(<Controlled />);
    fireEvent.click(screen.getByRole('button', { name: /Home/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Home' }));
    expect(switchTo).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the menu on an outside click', () => {
    render(
      <div>
        <p>Outside</p>
        <Controlled />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: /Home/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('Outside'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows a failed switch in the error modal', () => {
    switchError = 'Failed to switch profile: provider unreachable';
    render(<TopBar {...baseProps()} />);
    expect(screen.getByText('Failed to switch profile: provider unreachable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(clearError).toHaveBeenCalled();
  });
});

/** TopBar next to the global shortcuts, as MainScreen mounts them. */
function WithShortcuts() {
  const searchRef = useRef<globalThis.HTMLInputElement>(null);
  useKeyboardShortcuts(searchRef);
  const [open, setOpen] = useState(false);
  return (
    <TopBar
      {...baseProps({ searchRef })}
      profileMenuOpen={open}
      onProfileMenuOpenChange={setOpen}
    />
  );
}

describe('TopBar profile menu and the global Escape shortcut', () => {
  const playing: Channel = {
    id: 5,
    playlist_id: 1,
    name: 'SVT1',
    url: 'http://home.example/5.ts',
    content_type: 'live',
    is_favorite: false,
    sort_order: 0,
  } as Channel;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    usePlayerStore.setState({
      playlists: [home, cabin],
      activeProfileId: 1,
      currentPlaylist: home,
      isPlaying: true,
      currentChannel: playing,
    });
  });

  it('Escape with the menu open only closes the menu and keeps playback going', async () => {
    render(<WithShortcuts />);
    const trigger = screen.getByRole('button', { name: /Home/ });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getAllByRole('menuitemradio')[0], { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    // Give the async shortcut handler a chance to run if it was reached.
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalledWith('stop_playback');
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it('Escape with the menu closed still stops playback', async () => {
    render(<WithShortcuts />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stop_playback'));
    await waitFor(() => expect(usePlayerStore.getState().isPlaying).toBe(false));
  });
});
