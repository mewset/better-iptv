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
