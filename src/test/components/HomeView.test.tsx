import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { HomeView, type HomeHeroItem, type HomeRailSpec } from '../../components/HomeView';
import type { TmdbCard } from '../../lib/tauri';
import type { Channel } from '../../types';

function title(id: number, name: string, content_type: Channel['content_type'] = 'vod'): Channel {
  return { id, name, content_type, is_favorite: false };
}

function card(channel_id: number, name: string): TmdbCard {
  return {
    channel_id,
    tmdb_id: channel_id,
    title: name,
    year: 2020,
    rating: 7.5,
    poster_url: null,
    backdrop_url: null,
    genres: ['Drama'],
    overview: null,
  } as unknown as TmdbCard;
}

const rails: HomeRailSpec[] = [
  { key: 'live', title: 'On now', kind: 'live', items: [title(50, 'BBC One', 'live')] },
  {
    key: 'trending',
    title: 'Trending in your library',
    kind: 'poster',
    items: [title(1, 'Dune'), title(2, 'Heat')],
  },
  { key: 'empty', title: 'Your favourites', kind: 'poster', items: [] },
  {
    key: 'genre-vod-Comedy',
    title: 'Comedy',
    subtitle: 'Movies',
    kind: 'poster',
    items: [title(3, 'Airplane')],
  },
];

const hero: HomeHeroItem[] = [
  { channel: title(9, 'Pick Movie'), card: card(9, 'Pick Movie'), eyebrow: 'Our pick of the day' },
  { channel: title(10, 'Second'), card: card(10, 'Second'), eyebrow: 'Trending today' },
  { channel: title(11, 'Third'), card: card(11, 'Third'), eyebrow: 'Popular' },
];

function renderHome(props: Partial<React.ComponentProps<typeof HomeView>> = {}) {
  return render(
    <HomeView
      hero={[]}
      rails={rails}
      renderPoster={(c) => <span>poster {c.name}</span>}
      renderLive={(c) => <span>live {c.name}</span>}
      onPlay={vi.fn()}
      onOpenTitle={vi.fn()}
      loading={false}
      progress={null}
      {...props}
    />
  );
}

describe('HomeView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 26, 9, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('shows one row per rail in order, skipping empty ones, with the right card kind', () => {
    renderHome();
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(regions).toEqual(['Home', 'On now', 'Trending in your library', 'Comedy']);
    expect(screen.getByText('live BBC One')).toBeInTheDocument();
    expect(screen.getByText('poster Dune')).toBeInTheDocument();
    expect(screen.getByText('poster Airplane')).toBeInTheDocument();
    expect(screen.getByText('Movies')).toBeInTheDocument();
    // The old explanation is gone; the greeting lives in the top bar
    expect(screen.queryByText(/daily pick and six genre slideshows/i)).toBeNull();
  });

  it('shows skeletons while loading', () => {
    renderHome({ rails: [], loading: true });
    expect(screen.getByTestId('home-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to show yet/)).toBeNull();
  });

  it('explains a running scan when there is nothing yet', () => {
    renderHome({ rails: [], progress: { done: 120, total: 900, running: true } });
    expect(screen.getByText('Fetched 120 of 900 titles')).toBeInTheDocument();
    expect(screen.getByText('Home fills in as the scan completes.')).toBeInTheDocument();
  });

  it('explains an empty library', () => {
    renderHome({ rails: [] });
    expect(screen.getByText(/Nothing to show yet/)).toBeInTheDocument();
  });

  it('rotates the banner every 6 s, jumps by its dots and holds still under the pointer', () => {
    const onPlay = vi.fn();
    renderHome({ hero, onPlay });
    expect(screen.getByText('OUR PICK OF THE DAY')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pick Movie' })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByRole('heading', { name: 'Second' })).toBeInTheDocument();
    expect(screen.getByText('TRENDING TODAY')).toBeInTheDocument();

    const dots = screen.getByRole('group', { name: 'Featured titles' });
    fireEvent.click(within(dots).getByRole('button', { name: 'Show featured title 3 of 3' }));
    expect(screen.getByRole('heading', { name: 'Third' })).toBeInTheDocument();

    const banner = screen.getByRole('region', { name: 'Popular' }).parentElement!;
    fireEvent.mouseEnter(banner);
    act(() => vi.advanceTimersByTime(12_000));
    expect(screen.getByRole('heading', { name: 'Third' })).toBeInTheDocument();
    fireEvent.mouseLeave(banner);
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByRole('heading', { name: 'Pick Movie' })).toBeInTheDocument();
  });
});
