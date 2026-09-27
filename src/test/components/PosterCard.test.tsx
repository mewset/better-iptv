import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PosterCard } from '../../components/PosterCard';
import type { Channel } from '../../types';

const movie: Channel = {
  id: 9,
  playlist_id: 1,
  name: 'Past Lives',
  url: 'http://x',
  group_name: 'Drama',
  logo: 'http://img/poster.jpg',
  content_type: 'vod',
  is_favorite: false,
  sort_order: 0,
};

describe('PosterCard', () => {
  it('opens on a click on the frame and on the Play button', () => {
    const onOpen = vi.fn();
    render(<PosterCard channel={movie} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play Past Lives' }));
    expect(onOpen).toHaveBeenCalledWith(movie);
  });
  it('labels a series card as a series and its button as Open', () => {
    render(<PosterCard channel={{ ...movie, content_type: 'series' }} onOpen={vi.fn()} />);
    expect(screen.getByText('Series')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Past Lives' })).toBeInTheDocument();
  });
  it('does not render the artwork in lock mode and asks for the PIN', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <PosterCard channel={movie} onOpen={onOpen} isBlocked parentalVisibility="lock" />
    );
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Past Lives with PIN' }));
    expect(onOpen).toHaveBeenCalledWith(movie);
  });
  it('blurs the artwork in blur mode', () => {
    const { container } = render(
      <PosterCard channel={movie} onOpen={vi.fn()} isBlocked parentalVisibility="blur" />
    );
    expect(container.querySelector('img')?.className).toMatch(/blur/);
  });
});

const tmdb = {
  channel_id: 9,
  tmdb_id: 11324,
  title: 'Past Lives',
  year: 2023,
  rating: 7.9,
  poster_url: 'https://image.tmdb.org/t/p/w342/p.jpg',
  backdrop_url: null,
  genres: ['Drama'],
};

describe('PosterCard with TMDB data', () => {
  it('prefers the TMDB poster and shows year and rating instead of the group', () => {
    const { container } = render(<PosterCard channel={movie} onOpen={vi.fn()} tmdb={tmdb} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(tmdb.poster_url);
    expect(screen.getByText('2023 · ★ 7.9')).toBeInTheDocument();
    expect(screen.queryByText('Drama')).not.toBeInTheDocument();
  });
  it('falls back to the provider logo when the TMDB poster fails to load', () => {
    const { container } = render(<PosterCard channel={movie} onOpen={vi.fn()} tmdb={tmdb} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(movie.logo);
  });
  it('shows a new TMDB poster after a re-match even though the old one failed', () => {
    const { container, rerender } = render(
      <PosterCard channel={movie} onOpen={vi.fn()} tmdb={tmdb} />
    );
    fireEvent.error(container.querySelector('img')!);
    const rematched = { ...tmdb, poster_url: 'https://image.tmdb.org/t/p/w342/new.jpg' };
    rerender(<PosterCard channel={movie} onOpen={vi.fn()} tmdb={rematched} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(rematched.poster_url);
  });
  it('keeps the group line without TMDB data', () => {
    render(<PosterCard channel={movie} onOpen={vi.fn()} />);
    expect(screen.getByText('Drama')).toBeInTheDocument();
  });
  it('plays a movie from the overlay button when onPlay is given, and opens otherwise', () => {
    const onOpen = vi.fn();
    const onPlay = vi.fn();
    render(<PosterCard channel={movie} onOpen={onOpen} onPlay={onPlay} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play Past Lives' }));
    expect(onPlay).toHaveBeenCalledWith(movie);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('article'));
    expect(onOpen).toHaveBeenCalledWith(movie);
  });
});
