import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import EpgTab from '../../components/settings/EpgTab';
import { POLICY_DEBOUNCE_MS } from '../../components/settings/TimeCorrection';
import { useEpgStore } from '../../stores/epg-store';
import { usePlayerStore } from '../../stores/player-store';
import type { EpgSource, EpgStatus } from '../../lib/epgIpc';
import { epgSource, epgStatus } from '../epgFixtures';

const mockedInvoke = vi.mocked(invoke);

const PROVIDER = "Your provider's guide · signed in with your account";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** Answers every guide command; `overrides` replace single commands. */
function answer(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const handler = overrides[cmd];
    if (handler) return handler((args ?? {}) as Record<string, unknown>);
    return undefined;
  });
}

function statusWith(sources: EpgSource[], overrides: Partial<EpgStatus> = {}): EpgStatus {
  return epgStatus(true, { sources, ...overrides });
}

function renderTab(status: EpgStatus | null) {
  useEpgStore.setState({ status });
  return render(<EpgTab />);
}

const row = (name: string) => screen.getByRole('article', { name });
const calls = (cmd: string) => mockedInvoke.mock.calls.filter(([c]) => c === cmd);
/** Lets the mocked command's promise settle inside act. */
const settle = () => act(async () => {});

describe('EpgTab', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    answer();
    useEpgStore.setState(useEpgStore.getInitialState(), true);
    usePlayerStore.setState({ currentPlaylist: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names each origin by its label and never shows a provider's or playlist's URL", () => {
    const secret = 'http://provider.example:8080/xmltv.php?username=mattias&password=s3cret';
    renderTab(
      statusWith([
        epgSource({ id: 1, origin: 'xtream', display_url: secret, priority: 30 }),
        epgSource({
          id: 2,
          origin: 'manual',
          playlist_id: null,
          label: 'epg.example',
          display_url: 'http://epg.example/guide.xml?token=••••',
          priority: 10,
        }),
        epgSource({ id: 3, origin: 'm3u_header', display_url: secret, priority: 40 }),
      ])
    );

    const names = screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    expect(names).toEqual([
      'http://epg.example/guide.xml?token=••••',
      PROVIDER,
      'From the playlist (url-tvg)',
    ]);
    expect(document.body.innerHTML).not.toContain('s3cret');
    expect(document.body.innerHTML).not.toContain('provider.example');
    // Only a URL added by hand can be removed.
    expect(within(row(PROVIDER)).queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(
      within(row('http://epg.example/guide.xml?token=••••')).getByRole('button', {
        name: 'Remove http://epg.example/guide.xml?token=••••',
      })
    ).toBeInTheDocument();
  });

  it('says which profile the sources are for', () => {
    usePlayerStore.setState({
      currentPlaylist: { id: 1, name: 'Home', url: 'http://x', auto_refresh: false },
    });
    renderTab(statusWith([epgSource()]));
    expect(screen.getByText('Used by Home')).toBeInTheDocument();
  });

  it('shows one status line per state: ok, partial, error, never, updating', () => {
    renderTab(
      statusWith([
        epgSource({
          id: 1,
          origin: 'manual',
          display_url: 'http://ok.example/g.xml',
          last_success_at: minutesAgo(12),
          programme_count: 42_809,
        }),
        epgSource({
          id: 2,
          origin: 'manual',
          display_url: 'http://partial.example/g.xml',
          last_result: 'partial',
          last_success_at: minutesAgo(180),
        }),
        epgSource({
          id: 3,
          origin: 'manual',
          display_url: 'http://error.example/g.xml',
          last_result: 'error',
          last_attempt_at: minutesAgo(180),
          last_error: 'The EPG server answered 403 Forbidden',
        }),
        epgSource({
          id: 4,
          origin: 'manual',
          display_url: 'http://never.example/g.xml',
          last_result: 'never',
          last_success_at: null,
          last_attempt_at: null,
        }),
        epgSource({
          id: 5,
          origin: 'manual',
          display_url: 'http://busy.example/g.xml',
          refreshing: true,
        }),
      ])
    );
    expect(
      within(row('http://ok.example/g.xml')).getByText('Updated 12 min ago · 42,809 programmes')
    ).toBeInTheDocument();
    expect(
      within(row('http://partial.example/g.xml')).getByText(
        'Partial update 3 h ago: the download broke off; programmes read so far were kept'
      )
    ).toBeInTheDocument();
    expect(
      within(row('http://error.example/g.xml')).getByText(
        'Failed 3 h ago: The EPG server answered 403 Forbidden'
      )
    ).toBeInTheDocument();
    expect(
      within(row('http://never.example/g.xml')).getByText('Never updated')
    ).toBeInTheDocument();
    const busy = row('http://busy.example/g.xml');
    expect(within(busy).getByText('Updating…')).toBeInTheDocument();
    expect(
      within(busy).getByRole('button', { name: 'Update http://busy.example/g.xml' })
    ).toBeDisabled();
    // Any source updating holds "Update all now".
    expect(screen.getByRole('button', { name: 'Update all now' })).toBeDisabled();
  });

  it('keeps the zone and decoder counters in the status tooltip', () => {
    renderTab(statusWith([epgSource({ unknown_zone_count: 3, unknown_zone_sample: 'XYZ' })]));
    const line = within(row(PROVIDER)).getByText(/^Updated/);
    expect(line).toHaveAttribute('title', expect.stringContaining('"XYZ"'));
  });

  it('enables, disables and updates a source at once', async () => {
    renderTab(statusWith([epgSource({ id: 7 })]));
    fireEvent.click(screen.getByRole('checkbox', { name: `Enable ${PROVIDER}` }));
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith('update_epg_source', {
      id: 7,
      patch: { enabled: false },
    });
    fireEvent.click(screen.getByRole('button', { name: `Update ${PROVIDER}` }));
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith('refresh_epg', { sourceId: 7 });
  });

  it('"Update all now" asks for every source; disabled when none is enabled', async () => {
    const { unmount } = renderTab(statusWith([epgSource()]));
    fireEvent.click(screen.getByRole('button', { name: 'Update all now' }));
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith('refresh_epg', { sourceId: null });
    unmount();

    renderTab(statusWith([epgSource({ enabled: false })]));
    expect(screen.getByRole('button', { name: 'Update all now' })).toBeDisabled();
    expect(
      screen.getByText('No source is enabled, so nothing is updated automatically')
    ).toBeInTheDocument();
  });

  it('adds a URL, and shows the reason under the field when it is refused', async () => {
    answer({
      add_epg_source: ({ url }) =>
        url === 'http://dup.example/g.xml'
          ? Promise.reject({ code: 'InvalidInput', details: 'This guide URL is already added' })
          : epgSource({ origin: 'manual' }),
    });
    renderTab(statusWith([]));
    const field = screen.getByLabelText('Add a source');

    fireEvent.change(field, { target: { value: ' http://dup.example/g.xml ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith('add_epg_source', {
      url: 'http://dup.example/g.xml',
    });
    const message = screen.getByRole('alert');
    expect(message).toHaveTextContent('This guide URL is already added');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toContain(message.id);
    expect(field).toHaveValue('http://dup.example/g.xml');

    fireEvent.change(field, { target: { value: 'http://new.example/g.xml' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await settle();
    expect(field).toHaveValue('');
    expect(screen.getByRole('link', { name: 'https://iptv-epg.org/' })).toBeInTheDocument();
  });

  it('asks before removing a URL source', async () => {
    renderTab(
      statusWith([epgSource({ id: 4, origin: 'manual', display_url: 'http://e.example/g.xml' })])
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove http://e.example/g.xml' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Remove this guide source?')).toBeInTheDocument();
    expect(calls('remove_epg_source')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith('remove_epg_source', { id: 4 });
  });

  it('shows a refused enable or remove in the row', async () => {
    answer({
      update_epg_source: () => Promise.reject({ code: 'Database', details: 'database is locked' }),
      remove_epg_source: () => Promise.reject({ code: 'InvalidInput', details: 'Not found' }),
    });
    const name = 'http://e.example/g.xml';
    renderTab(statusWith([epgSource({ id: 4, origin: 'manual', display_url: name })]));

    fireEvent.click(screen.getByRole('checkbox', { name: `Enable ${name}` }));
    await settle();
    expect(within(row(name)).getByRole('alert')).toHaveTextContent(
      'Could not disable the source: database is locked'
    );
    expect(screen.getByRole('checkbox', { name: `Enable ${name}` })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: `Remove ${name}` }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(within(row(name)).getByRole('alert')).toHaveTextContent(
      'Could not remove the source: Not found'
    );
  });
});

describe('EpgTab time correction', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    answer();
    useEpgStore.setState(useEpgStore.getInitialState(), true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function openCorrection(source: Partial<EpgSource> = {}) {
    renderTab(statusWith([epgSource({ id: 9, ...source })]));
    fireEvent.click(within(row(PROVIDER)).getByRole('button', { name: /time correction/i }));
  }
  const earlier = () =>
    screen.getByRole('button', { name: 'Shift guide times 30 minutes earlier' });
  const later = () => screen.getByRole('button', { name: 'Shift guide times 30 minutes later' });
  const value = () => screen.getByText(/^(none|[−+]\d)/, { selector: '[aria-live]' });

  it('steps in 30 minutes, previews the result and sends one change after the pause', async () => {
    vi.useFakeTimers();
    openCorrection();
    expect(value()).toHaveTextContent('none');
    expect(value()).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();

    fireEvent.click(earlier());
    expect(value()).toHaveTextContent('−30 min');
    for (let i = 0; i < 3; i++) fireEvent.click(earlier());
    expect(value()).toHaveTextContent('−2 h');
    expect(
      screen.getByText('A programme the guide lists at 20:00 shows at 18:00')
    ).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(POLICY_DEBOUNCE_MS - 1));
    expect(calls('set_epg_time_policy')).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(calls('set_epg_time_policy')).toEqual([
      [
        'set_epg_time_policy',
        { sourceId: 9, policy: { interpret: 'as_written', shift_minutes: -120 } },
      ],
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(value()).toHaveTextContent('none');
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    expect(earlier()).toHaveFocus();
  });

  it('clamps at −12 h and +14 h', () => {
    openCorrection({ policy: { interpret: 'as_written', shift_minutes: -690 } });
    fireEvent.click(earlier());
    expect(value()).toHaveTextContent('−12 h');
    expect(earlier()).toBeDisabled();
    fireEvent.click(earlier());
    expect(value()).toHaveTextContent('−12 h');
  });

  it('clamps at +14 h', () => {
    openCorrection({ policy: { interpret: 'as_written', shift_minutes: 810 } });
    fireEvent.click(later());
    expect(value()).toHaveTextContent('+14 h');
    expect(later()).toBeDisabled();
  });

  it('hides Advanced at no shift without unknown zones, and opens it otherwise', () => {
    openCorrection();
    const advanced = screen.getByRole('button', { name: 'Advanced' });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox', { name: /local time/ })).toBeNull();
    fireEvent.click(advanced);
    expect(screen.getByRole('checkbox', { name: /local time/ })).not.toBeChecked();
    expect(screen.getByText(/^Your clock: \d{2}:\d{2}/)).toBeInTheDocument();
    expect(screen.getByText(/repeats when clocks go back/)).toBeInTheDocument();
  });

  it('opens Advanced by default when the source reports unknown zones', () => {
    openCorrection({ unknown_zone_count: 4 });
    expect(screen.getByRole('checkbox', { name: /local time/ })).toBeInTheDocument();
  });

  it('opens Advanced by default when a shift is set', () => {
    openCorrection({ policy: { interpret: 'as_written', shift_minutes: 60 } });
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('says a pending policy takes effect at the next update', () => {
    renderTab(statusWith([epgSource({ policy_pending: true })]));
    expect(within(row(PROVIDER)).getByText('Takes effect at the next update')).toBeInTheDocument();
  });

  /** The status with source 9 changed by `overrides`. */
  const setSource = (overrides: Partial<EpgSource>) =>
    act(() => useEpgStore.getState().setStatus(statusWith([epgSource({ id: 9, ...overrides })])));

  it('reads "Applying…" from the click until the call returns, then from the backend', async () => {
    vi.useFakeTimers();
    let release = () => {};
    answer({
      set_epg_time_policy: () => new Promise<void>((resolve) => (release = resolve)),
    });
    openCorrection();
    fireEvent.click(later());
    expect(screen.getByText('Applying…')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(POLICY_DEBOUNCE_MS));
    expect(screen.getByText('Applying…')).toBeInTheDocument();

    // The backend's status arrives before the answer: it says applying.
    const shifted = { interpret: 'as_written' as const, shift_minutes: 30 };
    setSource({ policy: shifted, policy_pending: true, applying: true });
    release();
    await settle();
    expect(screen.getByText('Applying…')).toBeInTheDocument();

    // A re-read that failed: no longer applying, still pending.
    setSource({ policy: shifted, policy_pending: true, applying: false });
    expect(screen.queryByText('Applying…')).toBeNull();
    expect(screen.getByText('Takes effect at the next update')).toBeInTheDocument();
    expect(value()).toHaveTextContent('+30 min');

    setSource({ policy: shifted, policy_pending: false, applying: false });
    expect(screen.queryByText('Takes effect at the next update')).toBeNull();
  });

  it('a refused change shows the error, ends "Applying…" and puts the stepper back', async () => {
    vi.useFakeTimers();
    answer({
      set_epg_time_policy: () =>
        Promise.reject({ code: 'InvalidInput', details: 'Guide source 9 not found' }),
    });
    openCorrection();
    fireEvent.click(later());
    act(() => vi.advanceTimersByTime(POLICY_DEBOUNCE_MS));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not change the time correction: Guide source 9 not found'
    );
    expect(screen.queryByText('Applying…')).toBeNull();
    expect(value()).toHaveTextContent('none');
  });

  it('does not show the error of a call a later change replaced', async () => {
    vi.useFakeTimers();
    const rejects: Array<(e: unknown) => void> = [];
    answer({
      set_epg_time_policy: () => new Promise<void>((_, reject) => rejects.push(reject)),
    });
    openCorrection();
    fireEvent.click(later());
    act(() => vi.advanceTimersByTime(POLICY_DEBOUNCE_MS));
    fireEvent.click(later());
    rejects[0]({ code: 'Database', details: 'database is locked' });
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Applying…')).toBeInTheDocument();
    expect(value()).toHaveTextContent('+1 h');
    act(() => vi.advanceTimersByTime(POLICY_DEBOUNCE_MS));
    expect(calls('set_epg_time_policy').map(([, args]) => args)).toEqual([
      { sourceId: 9, policy: { interpret: 'as_written', shift_minutes: 30 } },
      { sourceId: 9, policy: { interpret: 'as_written', shift_minutes: 60 } },
    ]);
  });

  it('sends the last change when Settings closes inside the pause', () => {
    vi.useFakeTimers();
    renderTab(statusWith([epgSource({ id: 9 })]));
    fireEvent.click(within(row(PROVIDER)).getByRole('button', { name: /time correction/i }));
    fireEvent.click(later());
    fireEvent.click(later());
    cleanup();
    expect(calls('set_epg_time_policy')).toEqual([
      [
        'set_epg_time_policy',
        { sourceId: 9, policy: { interpret: 'as_written', shift_minutes: 60 } },
      ],
    ]);
    act(() => vi.advanceTimersByTime(POLICY_DEBOUNCE_MS));
    expect(calls('set_epg_time_policy')).toHaveLength(1);
  });

  it('removing a source inside the pause sends no change for it', async () => {
    vi.useFakeTimers();
    const name = 'http://e.example/g.xml';
    renderTab(statusWith([epgSource({ id: 9, origin: 'manual', display_url: name })]));
    fireEvent.click(within(row(name)).getByRole('button', { name: /time correction/i }));
    fireEvent.click(later());
    fireEvent.click(screen.getByRole('button', { name: `Remove ${name}` }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith('remove_epg_source', { id: 9 });
    // The backend's status no longer lists it, and the row goes.
    act(() => useEpgStore.getState().setStatus(statusWith([])));
    act(() => vi.advanceTimersByTime(2 * POLICY_DEBOUNCE_MS));
    cleanup();
    expect(calls('set_epg_time_policy')).toHaveLength(0);
  });

  it('opens Advanced when unknown zones appear later, unless it was collapsed', () => {
    openCorrection();
    expect(screen.queryByRole('checkbox', { name: /local time/ })).toBeNull();
    setSource({ unknown_zone_count: 3 });
    expect(screen.getByRole('checkbox', { name: /local time/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    setSource({ unknown_zone_count: 5 });
    expect(screen.queryByRole('checkbox', { name: /local time/ })).toBeNull();
  });

  it('sends the local-time reading from the Advanced checkbox', () => {
    vi.useFakeTimers();
    openCorrection();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /local time/ }));
    act(() => vi.advanceTimersByTime(POLICY_DEBOUNCE_MS));
    expect(calls('set_epg_time_policy')).toEqual([
      [
        'set_epg_time_policy',
        { sourceId: 9, policy: { interpret: 'local_zone', shift_minutes: 0 } },
      ],
    ]);
  });

  describe('channel matching', () => {
    const matching = () => screen.getByRole('heading', { name: 'Channel matching' }).parentElement!;
    const counts = {
      by_id: 0,
      by_tvg_name: 0,
      by_name: 0,
      manual: 0,
      unmatched_with_id: 0,
      ambiguous_names: 0,
    };

    it('says the guide is not downloaded without counts', () => {
      renderTab(epgStatus(true, { matches: null }));
      expect(within(matching()).getByText('Guide not downloaded yet')).toBeInTheDocument();
    });

    it('shows a count matched by id only', () => {
      renderTab(epgStatus(true, { matches: { ...counts, by_id: 1250 } }));
      expect(within(matching()).getByText('1,250 channels matched by id')).toBeInTheDocument();
    });

    it('breaks mixed counts down and adds the unknown ids', () => {
      renderTab(
        epgStatus(true, {
          matches: {
            ...counts,
            by_id: 1250,
            by_name: 30,
            manual: 7,
            unmatched_with_id: 13137,
            ambiguous_names: 2,
          },
        })
      );
      const line = within(matching()).getByText(
        '1,287 channels matched (1,250 by id, 30 by name, 7 set by hand) · 13,137 channels have an id the guide does not know'
      );
      expect(line).toHaveAttribute('title', expect.stringContaining('2 names in the guide'));
      expect(line.className).not.toContain('tabular-nums');
    });

    it('is not shown before the status is known', () => {
      renderTab(null);
      expect(screen.queryByRole('heading', { name: 'Channel matching' })).toBeNull();
    });
  });
});
