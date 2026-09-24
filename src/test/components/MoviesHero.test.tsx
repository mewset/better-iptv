import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MoviesHero } from '../../components/MoviesHero';
import type { Channel } from '../../types';

const movie: Channel = {
  id: 16,
  playlist_id: 1,
  name: 'Dune: Part Two',
  url: 'http://example.invalid/movie/16.mkv',
  group_name: 'Movies',
  content_type: 'vod',
  is_favorite: false,
  sort_order: 0,
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

  it('is labelled as a "Recently added" section', () => {
    render(<MoviesHero channel={movie} onPlay={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Recently added' })).toBeInTheDocument();
  });

  it('shows the group name in the meta row', () => {
    render(<MoviesHero channel={movie} onPlay={vi.fn()} />);
    expect(screen.getByText('Movies')).toBeInTheDocument();
  });
});
