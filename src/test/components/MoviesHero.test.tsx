import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MoviesHero } from '../../components/MoviesHero';
import type { Channel } from '../../types';

const movie: Channel = {
  id: 16,
  name: 'Dune: Part Two',
  group_name: 'Movies',
  content_type: 'vod',
  is_favorite: false,
  created_at: '2026-09-01T00:00:00Z',
};

describe('MoviesHero', () => {
  it('renders the eyebrow, the channel name and a Play button that calls onPlay', () => {
    const onPlay = vi.fn();
    render(<MoviesHero channel={movie} onPlay={onPlay} />);

    expect(screen.getByText('RECENTLY ADDED')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dune: Part Two' })).toBeInTheDocument();

    const playButton = screen.getByRole('button', { name: 'Play Dune: Part Two' });
    expect(playButton).toHaveTextContent('Play');
    fireEvent.click(playButton);
    expect(onPlay).toHaveBeenCalledWith(movie);
  });

  it('reads "Playing", disabled and inert, while this title is the one playing', () => {
    const onPlay = vi.fn();
    render(<MoviesHero channel={movie} onPlay={onPlay} isPlaying />);

    const button = screen.getByRole('button', { name: 'Playing Dune: Part Two' });
    expect(button).toHaveTextContent('Playing');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('is labelled as a "Recently added" section', () => {
    render(<MoviesHero channel={movie} onPlay={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Recently added' })).toBeInTheDocument();
  });

  it('shows the group name in the meta row', () => {
    render(<MoviesHero channel={movie} onPlay={vi.fn()} />);
    expect(screen.getByText('Movies')).toBeInTheDocument();
  });
});

describe('MoviesHero with TMDB data', () => {
  const tmdb = {
    channel_id: 1,
    tmdb_id: 1,
    title: 'X',
    year: 2023,
    rating: 7.4,
    poster_url: null,
    backdrop_url: 'https://image.tmdb.org/t/p/w1280/b.jpg',
    genres: ['Action', 'Thriller'],
  };
  it('uses the TMDB backdrop and the year · genres · rating meta row', () => {
    const { container } = render(<MoviesHero channel={movie} onPlay={vi.fn()} tmdb={tmdb} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(tmdb.backdrop_url);
    expect(screen.getByText('2023 · Action, Thriller · ★ 7.4')).toBeInTheDocument();
  });

  it('offers "Open" instead of "Play" for a series and calls onOpen', () => {
    const onPlay = vi.fn();
    const onOpen = vi.fn();
    const series = { ...movie, id: 42, name: 'Newest Show', content_type: 'series' as const };
    render(<MoviesHero channel={series} onPlay={onPlay} onOpen={onOpen} />);
    expect(screen.queryByRole('button', { name: /Play/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Newest Show' }));
    expect(onOpen).toHaveBeenCalledWith(series);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('uses the TMDB title instead of the provider name when matched', () => {
    const tmdb = {
      channel_id: 16,
      tmdb_id: 1,
      title: 'Dune: Part Two',
      year: 2024,
      rating: 8.2,
      poster_url: null,
      backdrop_url: null,
      genres: [],
    };
    render(
      <MoviesHero
        channel={{ ...movie, name: 'Dune.Part.Two.2024.1080p' }}
        onPlay={vi.fn()}
        tmdb={tmdb}
      />
    );
    expect(screen.getByRole('heading', { name: 'Dune: Part Two' })).toBeInTheDocument();
    expect(screen.queryByText('Dune.Part.Two.2024.1080p')).not.toBeInTheDocument();
  });

  it('takes a custom eyebrow and a note line', () => {
    render(
      <MoviesHero
        channel={movie}
        onPlay={vi.fn()}
        eyebrow="Our pick of the day"
        note="Trending on TMDB today"
      />
    );
    expect(screen.getByRole('region', { name: 'Our pick of the day' })).toBeInTheDocument();
    expect(screen.getByText('OUR PICK OF THE DAY')).toBeInTheDocument();
    expect(screen.getByText('Trending on TMDB today')).toBeInTheDocument();
    expect(screen.queryByText('RECENTLY ADDED')).not.toBeInTheDocument();
  });
});
