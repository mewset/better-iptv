import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import App from '../../App';
import { usePlayerStore } from '../../stores/player-store';
import type { Playlist } from '../../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../components/MainScreen', () => ({
  default: () => <div data-testid="main-screen" />,
}));

const mockedInvoke = vi.mocked(invoke);

const profile: Playlist = { id: 1, name: 'Home', auto_refresh: false };

function status(open: boolean) {
  return {
    enabled: true,
    has_user_key: open,
    has_shared_key: false,
    user_key_rejected: false,
    shared_key_rejected: false,
    language: 'en-US',
    background_enrich: open,
    background_progress: null,
  };
}

function calls(cmd: string) {
  return mockedInvoke.mock.calls.filter((c) => c[0] === cmd);
}

type Handler = (cmd: string) => unknown;

function mockBackend(handler: Handler) {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => handler(cmd) as never);
}

const base: Handler = (cmd) => {
  switch (cmd) {
    case 'get_playlists':
      return [profile];
    case 'get_active_profile_id':
      return 1;
    case 'get_channels':
    case 'get_channel_groups':
      return [];
    default:
      return null;
  }
};

describe('App boot', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      isSetupComplete: false,
      contentTypeFilter: 'live',
      tmdbStatus: null,
    });
  });

  it('starts on Home when the gate is open', async () => {
    mockBackend((cmd) => (cmd === 'get_tmdb_status' ? status(true) : base(cmd)));
    const { findByTestId } = render(<App />);
    await findByTestId('main-screen');
    expect(usePlayerStore.getState().contentTypeFilter).toBe('home');
    expect(usePlayerStore.getState().tmdbStatus).toEqual(status(true));
    expect(
      calls('get_channel_groups').filter(
        (c) => (c[1] as { contentType?: string } | undefined)?.contentType === 'live'
      )
    ).toEqual([]);
  });

  it('starts on Live when get_tmdb_status rejects', async () => {
    mockBackend((cmd) => {
      if (cmd === 'get_tmdb_status') throw new Error('boom');
      return base(cmd);
    });
    const { findByTestId } = render(<App />);
    await findByTestId('main-screen');
    expect(usePlayerStore.getState().contentTypeFilter).toBe('live');
    await waitFor(() => expect(calls('get_channels').length).toBeGreaterThan(0));
  });

  it('starts on Live when the gate is closed', async () => {
    mockBackend((cmd) => (cmd === 'get_tmdb_status' ? status(false) : base(cmd)));
    const { findByTestId } = render(<App />);
    await findByTestId('main-screen');
    expect(usePlayerStore.getState().contentTypeFilter).toBe('live');
  });

  it('mounts the main screen before get_channels resolves', async () => {
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(((cmd: string) =>
      cmd === 'get_channels' ? new Promise(() => {}) : Promise.resolve(base(cmd))) as never);
    const { findByTestId } = render(<App />);
    expect(await findByTestId('main-screen')).toBeInTheDocument();
  });

  it('loads parental settings before mounting', async () => {
    let release: () => void = () => {};
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(((cmd: string) =>
      cmd === 'get_parental_settings'
        ? new Promise((resolve) => {
            release = () =>
              resolve({
                enabled: true,
                blocked_channels: [],
                blocked_categories: [],
                visibility: 'hide',
                auto_detect: true,
              });
          })
        : Promise.resolve(base(cmd))) as never);
    const { queryByTestId, findByTestId } = render(<App />);
    await waitFor(() => expect(calls('get_parental_settings')).toHaveLength(1));
    await waitFor(() => expect(calls('get_playlists')).toHaveLength(1));
    // A full macrotask, so every other boot request has settled while parental is pending
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(queryByTestId('main-screen')).not.toBeInTheDocument();
    expect(calls('get_channels')).toHaveLength(0);
    release();
    await findByTestId('main-screen');
    expect(usePlayerStore.getState().parentalEnabled).toBe(true);
  });

  it('fetches live channels first', async () => {
    mockBackend(base);
    const { findByTestId } = render(<App />);
    await findByTestId('main-screen');
    await waitFor(() => expect(calls('get_channels').length).toBeGreaterThan(0));
    expect(calls('get_channels')[0][1]).toEqual({ playlistId: 1, contentTypes: ['live'] });
  });

  it('shows no loading text before mounting', async () => {
    mockBackend(base);
    const { findByTestId, queryByText } = render(<App />);
    expect(queryByText(/Loading playlist/i)).not.toBeInTheDocument();
    await findByTestId('main-screen');
    expect(queryByText(/Loading playlist/i)).not.toBeInTheDocument();
  });

  it('fetches playlists, profile, status and parental settings in parallel', async () => {
    const release: Array<() => void> = [];
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(((cmd: string) => {
      if (
        [
          'get_playlists',
          'get_active_profile_id',
          'get_tmdb_status',
          'get_parental_settings',
        ].includes(cmd)
      ) {
        return new Promise((resolve) => {
          release.push(() => resolve(base(cmd) ?? status(true)));
        });
      }
      return Promise.resolve(base(cmd));
    }) as never);
    render(<App />);
    // All four are in flight before any of them has resolved.
    await waitFor(() => expect(release).toHaveLength(4));
    release.forEach((r) => r());
    await waitFor(() => expect(calls('get_channels')).toHaveLength(1));
  });
});
