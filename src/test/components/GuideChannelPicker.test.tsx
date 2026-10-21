import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import EpgTab from '../../components/settings/EpgTab';
import {
  CHANNEL_FILTER_DEBOUNCE_MS,
  GUIDE_SEARCH_DEBOUNCE_MS,
} from '../../components/settings/GuideChannelPicker';
import { useEpgStore } from '../../stores/epg-store';
import { usePlayerStore } from '../../stores/player-store';
import type { EpgChannelHit, MatchCounts, MatchDetails } from '../../lib/epgIpc';
import type { Channel } from '../../types';
import { epgStatus } from '../epgFixtures';

const mockedInvoke = vi.mocked(invoke);

const counts: MatchCounts = {
  by_id: 1,
  by_tvg_name: 0,
  by_name: 1,
  manual: 1,
  unmatched_with_id: 0,
  ambiguous_names: 0,
};

const channel = (
  id: number,
  name: string,
  epg_id?: string,
  content_type: Channel['content_type'] = 'live'
): Channel => ({ id, name, epg_id, content_type, is_favorite: false, group_name: 'Sverige' });

const LIVE = [
  channel(1, 'SVT1', 'svt1.se'),
  channel(2, 'TV4', 'tv4hd.se'),
  channel(4, 'SVT2'),
  channel(5, 'Sjuan', 'sjuan.se'),
];
const FILM = channel(9, 'SVT Play film', 'svt1.se', 'vod');

const DETAILS: MatchDetails = {
  manual: [
    {
      channel_id: 2,
      channel_name: 'TV4',
      key: 'tv4hd.se',
      guide_name: 'TV4 HD',
      has_programmes: true,
    },
    {
      channel_id: 7,
      channel_name: 'Kanal 9',
      key: 'kanal9.se',
      guide_name: null,
      has_programmes: false,
    },
  ],
  by_name: [5],
};

const HITS: EpgChannelHit[] = [
  { key: 'svt1hd.se', name: 'SVT1 HD', source_id: 3, source_label: "Your provider's guide" },
  { key: 'svt1.dk', name: null, source_id: 4, source_label: 'epg.example' },
];

type Handler = (args: Record<string, unknown>) => unknown;

function answer(overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    get_channel_match_details: () => DETAILS,
    search_epg_channels: () => HITS,
    set_channel_epg_match: () => undefined,
    ...overrides,
  };
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) =>
    handlers[cmd]?.((args ?? {}) as Record<string, unknown>)
  );
}

const calls = (cmd: string) =>
  mockedInvoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const settle = () => act(async () => {});

async function renderTab(matches: MatchCounts | null = counts) {
  useEpgStore.setState({ status: epgStatus(true, { matches }) });
  render(<EpgTab />);
  await settle();
}

async function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: 'Fix a channel…' }));
  return screen.getByRole('dialog', { name: "Fix a channel's guide" });
}

/** Types into step 1's field and lets the filter run. */
function searchChannels(query: string) {
  fireEvent.change(screen.getByLabelText('Search your channels'), { target: { value: query } });
  act(() => vi.advanceTimersByTime(CHANNEL_FILTER_DEBOUNCE_MS));
}

const listed = () =>
  within(screen.getByRole('list', { name: 'Your channels' }))
    .queryAllByRole('button')
    .map((b) => b.textContent);

/** Step 1 → step 2 for the channel named `name`. */
async function pick(name: string) {
  searchChannels(name);
  fireEvent.click(
    within(screen.getByRole('list', { name: 'Your channels' })).getByRole('button', {
      name: new RegExp(`^${name}`),
    })
  );
  await settle();
}

describe('Fixing a channel by hand in Settings → EPG', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    answer();
    useEpgStore.setState(useEpgStore.getInitialState(), true);
    usePlayerStore.setState({
      currentPlaylist: { id: 1, name: 'Home', url: 'http://x', auto_refresh: false },
      channels: [...LIVE, FILM],
      liveChannels: LIVE,
      parentalEnabled: false,
      parentalUnlocked: false,
      parentalVisibility: 'hide',
      parentalAutoDetect: false,
      blockedChannelIds: new Set(),
      blockedCategories: [],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the channels set by hand and clears one', async () => {
    await renderTab();
    expect(calls('get_channel_match_details')).toEqual([{ playlistId: 1 }]);

    const list = screen.getByRole('list', { name: 'Channels set by hand' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual([
      'TV4 → TV4 HD (tv4hd.se)Clear',
      'Kanal 9 → kanal9.se (guide has no programmes now)Clear',
    ]);

    answer({ get_channel_match_details: () => ({ ...DETAILS, manual: [DETAILS.manual[1]] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Clear the match of TV4' }));
    await settle();

    expect(calls('set_channel_epg_match')).toEqual([{ channelId: 2, key: null }]);
    expect(calls('get_channel_match_details')).toHaveLength(2);
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows why a clear failed', async () => {
    answer({ set_channel_epg_match: () => Promise.reject({ code: 'Database', details: 'busy' }) });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the match of TV4' }));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not clear it: busy');
  });

  it('leaves channels parental controls hide out of the manual list while locked', async () => {
    const adult = {
      channel_id: 8,
      channel_name: 'XXX Nights',
      key: 'nights.se',
      guide_name: 'Nights',
      has_programmes: true,
    };
    answer({
      get_channel_match_details: () => ({ ...DETAILS, manual: [...DETAILS.manual, adult] }),
    });
    usePlayerStore.setState({
      parentalEnabled: true,
      parentalAutoDetect: true,
      blockedChannelIds: new Set([2]),
    });
    await renderTab();
    const names = () =>
      within(screen.getByRole('list', { name: 'Channels set by hand' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent?.split(' → ')[0]);
    // TV4 blocked by hand, XXX Nights by the auto-detection.
    expect(names()).toEqual(['Kanal 9']);

    act(() => usePlayerStore.setState({ parentalUnlocked: true }));
    expect(names()).toEqual(['TV4', 'Kanal 9', 'XXX Nights']);

    // Lock and blur modes show the channel in the list, so here too.
    act(() => usePlayerStore.setState({ parentalUnlocked: false, parentalVisibility: 'blur' }));
    expect(names()).toEqual(['TV4', 'Kanal 9', 'XXX Nights']);
  });

  it('a blocked category hides a manual match by the group of its channel', async () => {
    usePlayerStore.setState({ parentalEnabled: true, blockedCategories: ['Sverige'] });
    await renderTab();
    // TV4 is in Sverige; Kanal 9 is not in the channel list, so no group is known.
    expect(
      within(screen.getByRole('list', { name: 'Channels set by hand' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent?.split(' → ')[0])
    ).toEqual(['Kanal 9']);
  });

  it('cannot be opened before the guide is downloaded', async () => {
    await renderTab(null);
    expect(screen.getByRole('button', { name: 'Fix a channel…' })).toBeDisabled();
  });

  it('step 1 filters the live channels and says how each is matched', async () => {
    vi.useFakeTimers();
    await renderTab();
    const dialog = await openPicker();
    expect(within(dialog).getByText("Type part of a channel's name.")).toBeInTheDocument();
    expect(listed()).toEqual([]);

    fireEvent.change(screen.getByLabelText('Search your channels'), { target: { value: 'sv' } });
    act(() => vi.advanceTimersByTime(CHANNEL_FILTER_DEBOUNCE_MS - 1));
    expect(listed()).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(listed()).toEqual(['SVT1Sverige · Matched by id · svt1.se', 'SVT2Sverige · No guide']);
    expect(within(dialog).getByText('2 channels')).toBeInTheDocument();

    searchChannels('tv4');
    expect(listed()).toEqual(['TV4Sverige · Set by hand · TV4 HD']);
    searchChannels('SJUAN');
    expect(listed()).toEqual(['SjuanSverige · Matched by name · sjuan.se']);
    searchChannels('film');
    expect(listed()).toEqual([]);
    expect(within(dialog).getByText('No channel has that in its name.')).toBeInTheDocument();
  });

  it('step 1 leaves out channels parental controls hide', async () => {
    vi.useFakeTimers();
    usePlayerStore.setState({ parentalEnabled: true, blockedChannelIds: new Set([4]) });
    await renderTab();
    await openPicker();
    searchChannels('svt');
    expect(listed()).toEqual(['SVT1Sverige · Matched by id · svt1.se']);
  });

  it('step 2 searches the guide once typing stops and sets the chosen channel', async () => {
    vi.useFakeTimers();
    await renderTab();
    await openPicker();
    await pick('SVT1');

    // It starts with the channel's own name.
    expect(screen.getByLabelText('Search guide channels')).toHaveValue('SVT1');
    expect(screen.getByText('Now: Matched by id · svt1.se')).toBeInTheDocument();
    expect(calls('search_epg_channels')).toEqual([{ query: 'SVT1', limit: 50 }]);

    for (const value of ['S', 'SV', 'SVT', 'SVT1 h']) {
      fireEvent.change(screen.getByLabelText('Search guide channels'), { target: { value } });
      act(() => vi.advanceTimersByTime(GUIDE_SEARCH_DEBOUNCE_MS - 1));
    }
    expect(calls('search_epg_channels')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    await settle();
    expect(calls('search_epg_channels')).toEqual([
      { query: 'SVT1', limit: 50 },
      { query: 'SVT1 h', limit: 50 },
    ]);

    const guide = screen.getByRole('list', { name: 'Guide channels' });
    expect(
      within(guide)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual([
      "SVT1 HDsvt1hd.se · Your provider's guideUse this",
      'svt1.dksvt1.dk · epg.exampleUse this',
    ]);
    // A channel matched automatically has nothing to go back to.
    expect(screen.queryByRole('button', { name: 'Use automatic match' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Use SVT1 HD (svt1hd.se)' }));
    await settle();

    expect(calls('set_channel_epg_match')).toEqual([{ channelId: 1, key: 'svt1hd.se' }]);
    // Back at step 1 with the search kept, and the details asked again.
    expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent(
      'SVT1 now shows SVT1 HD.'
    );
    expect(screen.getByLabelText('Search your channels')).toHaveValue('SVT1');
    expect(calls('get_channel_match_details')).toHaveLength(2);
  });

  it('step 2 shows a refused guide channel under the field', async () => {
    vi.useFakeTimers();
    answer({
      set_channel_epg_match: () =>
        Promise.reject({
          code: 'InvalidInput',
          details: 'The guide of this profile has no programmes for "svt1.dk"',
        }),
    });
    await renderTab();
    await openPicker();
    await pick('SVT1');

    fireEvent.click(screen.getByRole('button', { name: 'Use svt1.dk (svt1.dk)' }));
    await settle();

    const field = screen.getByLabelText('Search guide channels');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    const alert = within(screen.getByRole('dialog')).getByRole('alert');
    expect(alert).toHaveTextContent('The guide of this profile has no programmes for "svt1.dk"');
    expect(field.getAttribute('aria-describedby')).toBe(alert.id);
    expect(screen.getByRole('list', { name: 'Guide channels' })).toBeInTheDocument();
  });

  it('gives a channel set by hand back to the automatic match', async () => {
    vi.useFakeTimers();
    await renderTab();
    await openPicker();
    await pick('TV4');

    expect(screen.getByText('Now: Set by hand · TV4 HD')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use automatic match' }));
    await settle();

    expect(calls('set_channel_epg_match')).toEqual([{ channelId: 2, key: null }]);
    expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent(
      'TV4 is matched automatically again.'
    );
  });

  it('step 2 leaves out adult guide channels while parental controls are locked', async () => {
    vi.useFakeTimers();
    answer({
      search_epg_channels: () => [
        ...HITS,
        { key: 'hot.se', name: 'Hot XXX', source_id: 3, source_label: "Your provider's guide" },
        { key: 'adult.tv', name: null, source_id: 4, source_label: 'epg.example' },
      ],
    });
    usePlayerStore.setState({ parentalEnabled: true, parentalVisibility: 'lock' });
    await renderTab();
    await openPicker();
    await pick('SVT1');
    const keys = () =>
      within(screen.getByRole('list', { name: 'Guide channels' }))
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'));
    expect(keys()).toEqual(['Use SVT1 HD (svt1hd.se)', 'Use svt1.dk (svt1.dk)']);

    act(() => usePlayerStore.setState({ parentalUnlocked: true }));
    expect(keys()).toEqual([
      'Use SVT1 HD (svt1hd.se)',
      'Use svt1.dk (svt1.dk)',
      'Use Hot XXX (hot.se)',
      'Use adult.tv (adult.tv)',
    ]);
  });

  it('goes back to your channels and closes with Escape', async () => {
    vi.useFakeTimers();
    await renderTab();
    await openPicker();
    await pick('SVT1');

    fireEvent.click(screen.getByRole('button', { name: 'Your channels' }));
    expect(screen.getByLabelText('Search your channels')).toHaveValue('SVT1');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
