import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { GuideView } from '../../components/GuideView';
import { usePlayerStore } from '../../stores/player-store';
import { formatClock } from '../../lib/epgTime';
import { layoutLanes } from '../../lib/guideLayout';
import { NOW_TICK_MS } from '../../hooks/useNow';
import { resetLogoFallbackSession, useLogoFallbackStore } from '../../lib/logoFallback';
import type { Programme } from '../../lib/epgIpc';
import { useEpgStore } from '../../stores/epg-store';
import type { Channel } from '../../types';
import { epgStatus } from '../epgFixtures';

// jsdom has no layout, so the real virtualizer renders no rows. This stand-in
// renders every row unless a test narrows `visible`, and records the offset
// each time rows are asked for.
const virtualiser = vi.hoisted(() => ({
  scrollOffset: 0 as number | null,
  visible: null as null | [number, number],
  offsetsAsked: [] as Array<number | null>,
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) =>
    Object.assign(virtualiser, {
      getVirtualItems: () => {
        virtualiser.offsetsAsked.push(virtualiser.scrollOffset);
        const [first, last] = virtualiser.visible ?? [0, count - 1];
        return Array.from(
          { length: Math.max(0, Math.min(last, count - 1) - first + 1) },
          (_, i) => ({
            index: first + i,
            key: first + i,
            start: (first + i) * 64,
            size: 64,
          })
        );
      },
      getTotalSize: () => count * 64,
      measure: () => {},
    }),
}));

// useGuide listens for `epg-refreshed`; there is no Tauri runtime here.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

// The real layout, counted: lanes are laid out once per programme answer.
vi.mock('../../lib/guideLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/guideLayout')>();
  return { ...actual, layoutLanes: vi.fn(actual.layoutLanes) };
});
const mockedLayoutLanes = vi.mocked(layoutLanes);

const mockedInvoke = vi.mocked(invoke);

const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const span = (from: number, to: number) => ({ start: at(from), stop: at(to) });

function channel(id: number, name: string, epg_id: string | null): Channel {
  return {
    id,
    playlist_id: 1,
    name,
    url: `http://x/${id}.ts`,
    group_name: 'Sweden',
    epg_id,
    content_type: 'live',
    is_favorite: false,
    sort_order: id,
  } as Channel;
}

const svt1 = channel(1, 'SVT1', 'svt1.se');
const tv4 = channel(2, 'TV4', 'tv4.se');

const airing: Programme = {
  title: 'Rapport',
  description: 'The evening news.',
  start: at(-10),
  stop: at(20),
};
const later: Programme = {
  title: 'Babel',
  description: null,
  start: at(20),
  stop: at(50),
};

let guide: Record<string, Programme[]>;
let guideIds: string[];
let hasUrl: boolean;

function setupInvoke() {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_epg_guide') return guide;
    if (cmd === 'get_epg_guide_keys') return guideIds;
    if (cmd === 'get_epg_status') return epgStatus(hasUrl);
    return null;
  });
}

function renderGuide(overrides: Partial<React.ComponentProps<typeof GuideView>> = {}) {
  const props = {
    channels: [svt1, tv4],
    playingChannelId: null,
    onPlay: vi.fn(),
    onOpenEpgSettings: vi.fn(),
    dockVisible: false,
    loadStatus: 'loaded' as const,
    onRetry: vi.fn(),
    ...overrides,
  };
  render(<GuideView {...props} />);
  return props;
}

const blockName = (p: Programme, ch: string) =>
  `${p.title}, ${formatClock(p.start)}–${formatClock(p.stop)}, ${ch}`;

describe('GuideView', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedLayoutLanes.mockClear();
    guide = { 'svt1.se': [airing, later], 'tv4.se': [] };
    guideIds = ['svt1.se', 'tv4.se'];
    virtualiser.scrollOffset = 0;
    virtualiser.visible = null;
    virtualiser.offsetsAsked = [];
    hasUrl = true;
    setupInvoke();
    usePlayerStore.setState({ categories: [], categoryFilter: null });
    useEpgStore.setState(useEpgStore.getInitialState(), true);
  });

  it('shows Loading guide instead of "No channels in this list" while live channels load', async () => {
    renderGuide({ channels: [], loadStatus: 'loading' });
    expect(await screen.findByText('Loading guide…')).toBeInTheDocument();
    expect(screen.queryByText('No channels in this list')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows the error state with Retry when they failed', async () => {
    const props = renderGuide({ channels: [], loadStatus: 'error' });
    expect(await screen.findByTestId('channel-load-error')).toBeInTheDocument();
    expect(screen.queryByText('No channels in this list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('a Favorites chip narrows the rows to favourites and All restores every channel', async () => {
    const favSvt1 = { ...svt1, is_favorite: true };
    usePlayerStore.setState({ categories: ['Sweden'], categoryFilter: null });
    renderGuide({ channels: [favSvt1, tv4] });
    expect(await screen.findByRole('row', { name: 'SVT1' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'TV4' })).toBeInTheDocument();

    const chip = screen.getByRole('button', { name: 'Favorites' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);

    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('row', { name: 'SVT1' })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'TV4' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('row', { name: 'TV4' })).toBeInTheDocument();
  });

  it('says so when Favorites is on and no channel is a favourite', async () => {
    renderGuide();
    await screen.findByRole('row', { name: 'SVT1' });
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(screen.getByText('No favorite channels yet')).toBeInTheDocument();
  });

  it('renders one row per channel with its programmes as buttons', async () => {
    renderGuide();
    const svtRow = await screen.findByRole('row', { name: 'SVT1' });
    const tv4Row = screen.getByRole('row', { name: 'TV4' });
    expect(
      await within(svtRow).findByRole('button', { name: blockName(airing, 'SVT1') })
    ).toBeInTheDocument();
    expect(within(svtRow).getByRole('button', { name: blockName(later, 'SVT1') })).toBeVisible();
    // TV4 has no programmes in the window.
    expect(within(tv4Row).getByText('No guide data')).toBeInTheDocument();
    expect(within(tv4Row).queryByRole('button')).toBeNull();
  });

  it('a block shows the full programme name and time as its hover text', async () => {
    renderGuide();
    const svtRow = await screen.findByRole('row', { name: 'SVT1' });
    const block = await within(svtRow).findByRole('button', { name: blockName(airing, 'SVT1') });
    expect(block).toHaveAttribute(
      'title',
      `${airing.title} · ${formatClock(airing.start)}–${formatClock(airing.stop)}`
    );
  });

  it('asks the backend only for channels with an epg id', async () => {
    renderGuide({ channels: [svt1, channel(3, 'No EPG', null), channel(4, 'Blank', '  ')] });
    await screen.findByRole('button', { name: blockName(airing, 'SVT1') });
    const guideCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'get_epg_guide');
    expect(guideCalls[0][1]).toMatchObject({ keys: ['svt1.se'] });
    expect(screen.queryByRole('row', { name: 'No EPG' })).toBeNull();
  });

  it('marks the airing block and none of the others as airing', async () => {
    renderGuide();
    const now = await screen.findByRole('button', { name: blockName(airing, 'SVT1') });
    expect(now.className).toContain('border-accent');
    const next = screen.getByRole('button', { name: blockName(later, 'SVT1') });
    expect(next.className).not.toContain('border-accent');
  });

  it('draws a row without nested programmes as full-height blocks', async () => {
    renderGuide();
    const block = await screen.findByRole('button', { name: blockName(airing, 'SVT1') });
    expect(block.className).toContain('h-14');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('draws a nested pair as two half-height blocks, both airing while both run', async () => {
    const container: Programme = { title: 'Movie night', description: null, ...span(-30, 90) };
    const nested: Programme = { title: 'Film', description: null, ...span(-15, 45) };
    guide = { 'svt1.se': [container, nested], 'tv4.se': [airing] };
    renderGuide();
    const row = await screen.findByRole('row', { name: 'SVT1' });
    const top = await within(row).findByRole('button', { name: blockName(container, 'SVT1') });
    const below = within(row).getByRole('button', { name: blockName(nested, 'SVT1') });
    for (const block of [top, below]) {
      expect(block.className).toContain('h-[26px]');
      expect(block.className).toContain('border-accent');
      // Half-height blocks show no times; the tooltip still has them.
      expect(block.textContent).not.toContain('–');
    }
    expect(top.className).toContain('top-1');
    expect(below.className).toContain('top-[34px]');
    // TV4 has no second lane and keeps its full-height block.
    const tv4Row = screen.getByRole('row', { name: 'TV4' });
    expect(within(tv4Row).getByRole('button').className).toContain('h-14');
  });

  it('counts programmes that fit in neither lane in a +N chip', async () => {
    const block: Programme = { title: 'Block', description: null, ...span(-30, 120) };
    const first: Programme = { title: 'First', description: null, ...span(-20, 40) };
    const second: Programme = { title: 'Second', description: null, ...span(0, 60) };
    const third: Programme = { title: 'Third', description: null, ...span(10, 50) };
    guide = { 'svt1.se': [block, first, second, third], 'tv4.se': [] };
    renderGuide();
    const row = await screen.findByRole('row', { name: 'SVT1' });
    const chip = await within(row).findByRole('note', {
      name: '2 overlapping programmes not shown',
    });
    expect(chip).toHaveTextContent('+2');
    expect(within(row).getAllByRole('button')).toHaveLength(2);
    expect(within(row).queryByRole('button', { name: blockName(second, 'SVT1') })).toBeNull();
  });

  it('keeps the +N chip clear of the blocks: in its row they end before the chip', async () => {
    // Block runs past the window's right edge, the chip's corner.
    const block: Programme = { title: 'Block', description: null, ...span(-30, 600) };
    const first: Programme = { title: 'First', description: null, ...span(-20, 40) };
    const second: Programme = { title: 'Second', description: null, ...span(0, 60) };
    guide = { 'svt1.se': [block, first, second], 'tv4.se': [airing] };
    renderGuide();
    const row = await screen.findByRole('row', { name: 'SVT1' });
    const chip = await within(row).findByRole('note');
    expect(chip.className).toContain('w-8');
    expect(chip.className).toContain('right-0');
    for (const button of within(row).getAllByRole('button')) {
      // Never past 100% minus the 2 px left inset and the chip's 36 px strip.
      expect(button.style.maxWidth).toMatch(/^calc\(\d+(\.\d+)?% - 38px\)$/);
    }
    // A row without a chip uses the whole track.
    const tv4Row = screen.getByRole('row', { name: 'TV4' });
    expect(within(tv4Row).getByRole('button').style.maxWidth).toBe('');
  });

  it('names a single programme left out in the singular', async () => {
    const block: Programme = { title: 'Block', description: null, ...span(-30, 120) };
    const first: Programme = { title: 'First', description: null, ...span(-20, 40) };
    const second: Programme = { title: 'Second', description: null, ...span(0, 60) };
    guide = { 'svt1.se': [block, first, second], 'tv4.se': [] };
    renderGuide();
    const row = await screen.findByRole('row', { name: 'SVT1' });
    expect(
      await within(row).findByRole('note', { name: '1 overlapping programme not shown' })
    ).toHaveTextContent('+1');
  });

  it('selects one of two programmes with one start, and only that one', async () => {
    const container: Programme = { title: 'Movie night', description: null, ...span(-10, 110) };
    const opener: Programme = { title: 'Film', description: 'The first film.', ...span(-10, 50) };
    guide = { 'svt1.se': [container, opener], 'tv4.se': [] };
    renderGuide();
    const row = await screen.findByRole('row', { name: 'SVT1' });
    const film = await within(row).findByRole('button', { name: blockName(opener, 'SVT1') });
    const night = within(row).getByRole('button', { name: blockName(container, 'SVT1') });

    fireEvent.click(film);
    expect(film).toHaveAttribute('aria-pressed', 'true');
    expect(night).toHaveAttribute('aria-pressed', 'false');
    const panel = screen.getByRole('region', { name: 'Selected programme' });
    expect(within(panel).getByText('The first film.')).toBeInTheDocument();

    fireEvent.click(night);
    expect(night).toHaveAttribute('aria-pressed', 'true');
    expect(film).toHaveAttribute('aria-pressed', 'false');
    expect(within(panel).getByRole('heading', { name: 'Movie night' })).toBeInTheDocument();
  });

  it('lays out each row once per answer, not again on a re-render or a now tick', async () => {
    // Mid half hour, so the tick does not move the window and fetch again.
    const mid = new Date();
    mid.setMinutes(mid.getMinutes() >= 30 ? 40 : 10, 0, 0);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(mid);
    try {
      guide = { 'svt1.se': [{ title: 'News', description: null, ...span(-5, 20) }], 'tv4.se': [] };
      renderGuide();
      await screen.findByRole('button', { name: /^News/ });
      const calls = mockedLayoutLanes.mock.calls.length;
      expect(calls).toBe(2);
      const line = screen.getByTestId('guide-now-line');
      const before = line.style.left;

      act(() => usePlayerStore.setState({ categories: ['Sweden'] }));
      await act(async () => {
        vi.advanceTimersByTime(NOW_TICK_MS);
      });
      // The tick reached the guide (the now line moved) without a new layout.
      expect(screen.getByTestId('guide-now-line').style.left).not.toBe(before);
      expect(mockedLayoutLanes.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no detail panel until a block is selected', async () => {
    renderGuide({ playingChannelId: 1 });
    await screen.findByRole('button', { name: blockName(airing, 'SVT1') });
    expect(screen.queryByRole('region', { name: 'Selected programme' })).toBeNull();
  });

  it('clicking a block opens the detail panel with Watch now', async () => {
    renderGuide();
    fireEvent.click(await screen.findByRole('button', { name: blockName(airing, 'SVT1') }));
    const panel = screen.getByRole('region', { name: 'Selected programme' });
    expect(within(panel).getByText('Rapport')).toBeInTheDocument();
    expect(within(panel).getByText('The evening news.')).toBeInTheDocument();
    expect(within(panel).getByText(/SVT1 · .* · \d+ min left/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Watch now' })).toBeInTheDocument();
    expect(panel.querySelector('[data-progress]')).not.toBeNull();
  });

  it('Watch now reads "Playing" and does nothing when that channel already plays', async () => {
    const props = renderGuide({ playingChannelId: 1 });
    fireEvent.click(await screen.findByRole('button', { name: blockName(airing, 'SVT1') }));
    const panel = screen.getByRole('region', { name: 'Selected programme' });
    expect(within(panel).queryByRole('button', { name: 'Watch now' })).toBeNull();
    const button = within(panel).getByRole('button', { name: 'Playing' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(props.onPlay).not.toHaveBeenCalled();
  });

  it('a later programme has no minutes left and no progress', async () => {
    renderGuide();
    fireEvent.click(await screen.findByRole('button', { name: blockName(later, 'SVT1') }));
    const panel = screen.getByRole('region', { name: 'Selected programme' });
    expect(within(panel).queryByText(/min left/)).toBeNull();
    expect(panel.querySelector('[data-progress]')).toBeNull();
    expect(panel.textContent).not.toMatch(/NaN|undefined/);
  });

  it('Watch now calls the play handler with that channel', async () => {
    const props = renderGuide();
    fireEvent.click(await screen.findByRole('button', { name: blockName(airing, 'SVT1') }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch now' }));
    expect(props.onPlay).toHaveBeenCalledWith(svt1);
  });

  it('Escape closes the detail panel first and marks the key as handled', async () => {
    renderGuide();
    fireEvent.click(await screen.findByRole('button', { name: blockName(airing, 'SVT1') }));
    const event = new globalThis.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Selected programme' })).toBeNull()
    );
  });

  it('lifts the panel above the dock when the dock is visible', async () => {
    renderGuide({ dockVisible: true });
    fireEvent.click(await screen.findByRole('button', { name: blockName(airing, 'SVT1') }));
    expect(screen.getByRole('region', { name: 'Selected programme' }).className).toContain(
      'bottom-[112px]'
    );
  });

  it('shows the EPG empty state without an EPG source', async () => {
    hasUrl = false;
    const props = renderGuide();
    expect(
      await screen.findByText('Add an EPG source in Settings to see the guide')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open EPG settings' }));
    expect(props.onOpenEpgSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('row')).toBeNull();
  });

  it('shows neither the table nor the empty state until the status is known', async () => {
    let answer!: (status: ReturnType<typeof epgStatus>) => void;
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_epg_status') return new Promise((r) => (answer = r));
      if (cmd === 'get_epg_guide') return guide;
      if (cmd === 'get_epg_guide_keys') return guideIds;
      return null;
    });
    renderGuide();
    // The row lookup answers first; without a status the guide still waits.
    await waitFor(() =>
      expect(mockedInvoke.mock.calls.some((c) => c[0] === 'get_epg_guide_keys')).toBe(true)
    );
    await act(async () => {});
    expect(screen.getByText('Loading guide…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Add an EPG source in Settings to see the guide')).toBeNull();

    await act(async () => answer(epgStatus(false)));
    expect(screen.getByText('Add an EPG source in Settings to see the guide')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('never renders the table before the empty state (no flash)', async () => {
    hasUrl = false;
    const seenTable: boolean[] = [];
    const observer = new globalThis.MutationObserver(() =>
      seenTable.push(document.querySelector('[role="table"]') !== null)
    );
    observer.observe(document.body, { childList: true, subtree: true });
    renderGuide();
    expect(
      await screen.findByText('Add an EPG source in Settings to see the guide')
    ).toBeInTheDocument();
    observer.disconnect();
    expect(seenTable.some(Boolean)).toBe(false);
  });

  it('treats a profile whose sources are all disabled as having no source', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_epg_status') {
        const status = epgStatus(true);
        status.sources[0].enabled = false;
        return status;
      }
      if (cmd === 'get_epg_guide') return guide;
      if (cmd === 'get_epg_guide_keys') return guideIds;
      return null;
    });
    renderGuide();
    expect(
      await screen.findByText('Add an EPG source in Settings to see the guide')
    ).toBeInTheDocument();
  });

  it('follows epg-status: a source enabled meanwhile brings the guide back', async () => {
    hasUrl = false;
    renderGuide();
    await screen.findByText('Add an EPG source in Settings to see the guide');
    act(() => useEpgStore.getState().setStatus(epgStatus(true)));
    expect(await screen.findByRole('row', { name: 'SVT1' })).toBeInTheDocument();
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'get_epg_status')).toHaveLength(1);
  });

  it('shows the guide when the status cannot be read', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_epg_status') throw new Error('db locked');
      if (cmd === 'get_epg_guide') return guide;
      if (cmd === 'get_epg_guide_keys') return guideIds;
      return null;
    });
    renderGuide();
    expect(await screen.findByRole('row', { name: 'SVT1' })).toBeInTheDocument();
    expect(screen.queryByText('Add an EPG source in Settings to see the guide')).toBeNull();
  });

  it('survives a rejected guide request with "No guide data" rows', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_epg_guide') throw new Error('invalid epg id');
      if (cmd === 'get_epg_guide_keys') return ['svt1.se', 'tv4.se'];
      if (cmd === 'get_epg_status') return epgStatus(true);
      return null;
    });
    renderGuide();
    const row = await screen.findByRole('row', { name: 'SVT1' });
    await waitFor(() => expect(within(row).getByText('No guide data')).toBeInTheDocument());
  });

  it('offers today plus the next four days', async () => {
    renderGuide();
    const days = within(await screen.findByRole('tablist', { name: 'Day' })).getAllByRole('tab');
    expect(days).toHaveLength(5);
    expect(days[0]).toHaveTextContent('Today');
    expect(days[0]).toHaveAttribute('aria-selected', 'true');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(days[1]).toHaveTextContent(String(tomorrow.getDate()));
  });

  it('switching day asks for 18:00-21:00 and hides the now line', async () => {
    renderGuide();
    await screen.findByRole('button', { name: blockName(airing, 'SVT1') });
    expect(screen.getByTestId('guide-now-line')).toBeInTheDocument();
    const days = within(screen.getByRole('tablist', { name: 'Day' })).getAllByRole('tab');
    fireEvent.click(days[1]);
    await waitFor(() =>
      expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'get_epg_guide')).toHaveLength(2)
    );
    const args = mockedInvoke.mock.calls.filter((c) => c[0] === 'get_epg_guide')[1][1] as {
      from: string;
    };
    expect(new Date(args.from).getHours()).toBe(18);
    expect(screen.queryByTestId('guide-now-line')).toBeNull();
  });

  it('hides a blocked channel’s programmes', async () => {
    renderGuide({ blockedMap: new Map([[1, true]]) });
    const row = await screen.findByRole('row', { name: 'SVT1' });
    await screen.findByRole('row', { name: 'TV4' });
    await waitFor(() =>
      expect(mockedInvoke.mock.calls.some((c) => c[0] === 'get_epg_guide')).toBe(true)
    );
    expect(within(row).getByText('Locked')).toBeInTheDocument();
    expect(within(row).queryByText('Rapport')).toBeNull();
  });
  it('lists only channels with guide data, matching ids regardless of case and spacing', async () => {
    guideIds = ['svt1.se'];
    renderGuide({ channels: [channel(1, 'SVT1', ' SVT1.se '), tv4] });
    const row = await screen.findByRole('row', { name: 'SVT1' });
    expect(screen.queryByRole('row', { name: 'TV4' })).toBeNull();
    // Programmes come back keyed by the normalized id and still reach the row.
    expect(
      await within(row).findByRole('button', { name: blockName(airing, 'SVT1') })
    ).toBeInTheDocument();
  });

  it('tells assistive technology how many rows there are and where each sits', async () => {
    renderGuide();
    const table = await screen.findByRole('table', { name: 'TV guide' });
    await waitFor(() => expect(table).toHaveAttribute('aria-rowcount', '2'));
    expect(screen.getByRole('row', { name: 'SVT1' })).toHaveAttribute('aria-rowindex', '1');
    expect(screen.getByRole('row', { name: 'TV4' })).toHaveAttribute('aria-rowindex', '2');
  });

  it('shows "Loading guide…" until it knows which channels have data', async () => {
    let answer!: (ids: string[]) => void;
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_epg_guide_keys') return new Promise<string[]>((r) => (answer = r));
      if (cmd === 'get_epg_guide') return guide;
      if (cmd === 'get_epg_status') return epgStatus(true);
      return null;
    });
    renderGuide();
    expect(await screen.findByText('Loading guide…')).toBeInTheDocument();
    expect(screen.queryByText('None of these channels has guide data')).toBeNull();
    await act(async () => answer(['svt1.se', 'tv4.se']));
    expect(await screen.findByRole('row', { name: 'SVT1' })).toBeInTheDocument();
    expect(screen.queryByText('Loading guide…')).toBeNull();
  });

  it('says none of the channels has guide data when the lookup finds nothing', async () => {
    guideIds = [];
    renderGuide();
    expect(await screen.findByText('None of these channels has guide data')).toBeInTheDocument();
    expect(screen.queryByText('Loading guide…')).toBeNull();
  });

  it('keeps the scroll position on a day change and starts at the top for a new list', async () => {
    renderGuide();
    await screen.findByRole('row', { name: 'SVT1' });
    virtualiser.scrollOffset = 640;
    virtualiser.offsetsAsked = [];

    fireEvent.click(within(screen.getByRole('tablist', { name: 'Day' })).getAllByRole('tab')[1]);
    await waitFor(() =>
      expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'get_epg_guide')).toHaveLength(2)
    );
    expect(virtualiser.offsetsAsked.every((o) => o === 640)).toBe(true);

    virtualiser.offsetsAsked = [];
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(virtualiser.offsetsAsked[0]).toBe(0);
  });

  it('clicking the day already shown keeps the selected programme open', async () => {
    renderGuide();
    const row = await screen.findByRole('row', { name: 'SVT1' });
    fireEvent.click(await within(row).findByRole('button', { name: blockName(airing, 'SVT1') }));
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Day' })).getAllByRole('tab')[0]);
    expect(screen.getByRole('region', { name: 'Selected programme' })).toBeInTheDocument();
  });

  it('closes the selected programme when midnight moves the window to the next day', async () => {
    const lateEvening = new Date();
    lateEvening.setHours(23, 50, 0, 0);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(lateEvening);
    try {
      const news: Programme = { title: 'Late news', description: null, ...span(-5, 20) };
      guide = { 'svt1.se': [news], 'tv4.se': [] };
      renderGuide();
      fireEvent.click(await screen.findByRole('button', { name: /^Late news/ }));
      // A tick before midnight keeps it.
      await act(async () => {
        vi.advanceTimersByTime(NOW_TICK_MS);
      });
      expect(screen.getByRole('region', { name: 'Selected programme' })).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(20 * NOW_TICK_MS);
      });
      expect(screen.queryByRole('region', { name: 'Selected programme' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the detail panel when the selected row scrolls out of view', async () => {
    renderGuide();
    const row = await screen.findByRole('row', { name: 'SVT1' });
    fireEvent.click(await within(row).findByRole('button', { name: blockName(airing, 'SVT1') }));
    expect(screen.getByRole('region', { name: 'Selected programme' })).toBeInTheDocument();

    // Only TV4's row is rendered now; SVT1 has scrolled away. Any store change
    // GuideView reads re-renders it with the narrower range.
    virtualiser.visible = [1, 1];
    act(() => usePlayerStore.setState({ categoryFilter: 'Sweden' }));
    await waitFor(() => expect(screen.queryByRole('row', { name: 'SVT1' })).toBeNull());
    expect(screen.getByRole('region', { name: 'Selected programme' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Selected programme' })).toBeNull();
  });
});

describe('GuideView logos', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    guide = { 'svt1.se': [airing, later], 'tv4.se': [] };
    guideIds = ['svt1.se', 'tv4.se'];
    virtualiser.scrollOffset = 0;
    virtualiser.visible = null;
    hasUrl = true;
    setupInvoke();
    usePlayerStore.setState({ categories: [], categoryFilter: null });
    useEpgStore.setState(useEpgStore.getInitialState(), true);
    resetLogoFallbackSession();
    useLogoFallbackStore.getState().merge({ 1: 'https://f/x.png' });
  });

  const withLogo = { ...svt1, logo: 'https://p/dead.png' };

  it('a row tile shows the letter after the logo and fallback fail', async () => {
    renderGuide({ channels: [withLogo] });
    const block = await screen.findByRole('button', { name: blockName(airing, 'SVT1') });
    const row = block.closest('[role="row"]') as HTMLElement;
    const img = () => row.querySelector('img');
    fireEvent.error(img()!);
    expect(img()?.getAttribute('src')).toBe('https://f/x.png');
    fireEvent.error(img()!);
    expect(img()).toBeNull();
  });

  it('the selection panel shows the placeholder after the logo and fallback fail', async () => {
    renderGuide({ channels: [withLogo] });
    fireEvent.click(await screen.findByRole('button', { name: blockName(airing, 'SVT1') }));
    const panel = screen.getByRole('region', { name: 'Selected programme' });
    fireEvent.error(panel.querySelector('img')!);
    expect(panel.querySelector('img')?.getAttribute('src')).toBe('https://f/x.png');
    fireEvent.error(panel.querySelector('img')!);
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.querySelectorAll('[data-bars]')).toHaveLength(1);
  });
});
