import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
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
    expect(calls('get_channels')).toHaveLength(1);
  });

  it('starts on Live when the gate is closed', async () => {
    mockBackend((cmd) => (cmd === 'get_tmdb_status' ? status(false) : base(cmd)));
    const { findByTestId } = render(<App />);
    await findByTestId('main-screen');
    expect(usePlayerStore.getState().contentTypeFilter).toBe('live');
  });

  it('fetches playlists, profile and status in parallel', async () => {
    const release: Array<() => void> = [];
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(((cmd: string) => {
      if (['get_playlists', 'get_active_profile_id', 'get_tmdb_status'].includes(cmd)) {
        return new Promise((resolve) => {
          release.push(() => resolve(base(cmd) ?? status(true)));
        });
      }
      return Promise.resolve(base(cmd));
    }) as never);
    render(<App />);
    // All three are in flight before any of them has resolved.
    await waitFor(() => expect(release).toHaveLength(3));
    release.forEach((r) => r());
    await waitFor(() => expect(calls('get_channels')).toHaveLength(1));
  });
});
