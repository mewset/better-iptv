import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { GuideView } from '../../components/GuideView';
import { usePlayerStore } from '../../stores/player-store';
import { formatClock } from '../../lib/epgTime';
import type { GuideProgram } from '../../lib/tauri';
import type { Channel } from '../../types';

const mockedInvoke = vi.mocked(invoke);

const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

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

const airing: GuideProgram = {
  title: 'Rapport',
  description: 'The evening news.',
  start_time: at(-10),
  end_time: at(20),
};
const later: GuideProgram = {
  title: 'Babel',
  description: null,
  start_time: at(20),
  end_time: at(50),
};

let guide: Record<string, GuideProgram[]>;
let hasUrl: boolean;

function setupInvoke() {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_guide') return guide;
    if (cmd === 'get_epg_status')
      return { has_url: hasUrl, last_fetched: null, program_count: hasUrl ? 10 : 0 };
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
    ...overrides,
  };
  render(<GuideView {...props} />);
  return props;
}

const blockName = (p: GuideProgram, ch: string) =>
  `${p.title}, ${formatClock(p.start_time)}–${formatClock(p.end_time)}, ${ch}`;

describe('GuideView', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    guide = { 'svt1.se': [airing, later], 'tv4.se': [] };
    hasUrl = true;
    setupInvoke();
    usePlayerStore.setState({ categories: [], categoryFilter: null });
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

  it('asks the backend only for channels with an epg id', async () => {
    renderGuide({ channels: [svt1, channel(3, 'No EPG', null), channel(4, 'Blank', '  ')] });
    await screen.findByRole('button', { name: blockName(airing, 'SVT1') });
    const guideCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'get_guide');
    expect(guideCalls[0][1]).toMatchObject({ epgIds: ['svt1.se'] });
    expect(screen.queryByRole('row', { name: 'No EPG' })).toBeNull();
  });

  it('marks the airing block and none of the others as airing', async () => {
    renderGuide();
    const now = await screen.findByRole('button', { name: blockName(airing, 'SVT1') });
    expect(now.className).toContain('border-accent');
    const next = screen.getByRole('button', { name: blockName(later, 'SVT1') });
    expect(next.className).not.toContain('border-accent');
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

  it('survives a rejected guide request with "No guide data" rows', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_guide') throw new Error('invalid epg id');
      if (cmd === 'get_epg_status') return { has_url: true, last_fetched: null, program_count: 1 };
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
      expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'get_guide')).toHaveLength(2)
    );
    const args = mockedInvoke.mock.calls.filter((c) => c[0] === 'get_guide')[1][1] as {
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
      expect(mockedInvoke.mock.calls.some((c) => c[0] === 'get_guide')).toBe(true)
    );
    expect(within(row).getByText('Locked')).toBeInTheDocument();
    expect(within(row).queryByText('Rapport')).toBeNull();
  });
});
