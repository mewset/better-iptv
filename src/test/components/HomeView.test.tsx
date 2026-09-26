import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HomeView } from '../../components/HomeView';
import type { HomeRow } from '../../lib/tauri';

function item(channel_id: number, title: string) {
  return {
    channel_id,
    tmdb_id: channel_id,
    title,
    year: 2020,
    rating: 6.5,
    poster_url: null,
    backdrop_url: null,
    genres: ['Comedy'],
    overview: null,
  };
}

const rows: HomeRow[] = [
  { genre: 'Comedy', content_type: 'vod', items: [item(1, 'A'), item(2, 'B'), item(3, 'C')] },
  { genre: 'Drama', content_type: 'series', items: [item(4, 'D'), item(5, 'E'), item(6, 'F')] },
];

describe('HomeView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 26, 9, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('greets by the clock and lists one slideshow per row', () => {
    render(<HomeView rows={rows} loading={false} progress={null} onOpen={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Good morning');
    expect(screen.getByRole('region', { name: 'Comedy Movies' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Drama Series' })).toBeInTheDocument();
  });

  it('shows skeletons while loading', () => {
    render(<HomeView rows={[]} loading progress={null} onOpen={vi.fn()} />);
    expect(screen.getByTestId('home-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to show yet/)).toBeNull();
  });

  it('explains a running scan', () => {
    render(
      <HomeView
        rows={[]}
        loading={false}
        progress={{ done: 120, total: 900, running: true }}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByText('Fetched 120 of 900 titles')).toBeInTheDocument();
    expect(screen.getByText('Home fills in as the scan completes.')).toBeInTheDocument();
  });

  it('explains an empty library', () => {
    render(<HomeView rows={[]} loading={false} progress={null} onOpen={vi.fn()} />);
    expect(screen.getByText(/Nothing to show yet/)).toBeInTheDocument();
  });
});
