import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GenreSlideshow, SLIDE_INTERVAL_MS } from '../../components/GenreSlideshow';
import type { HomeRow } from '../../lib/tauri';

function item(channel_id: number, title: string) {
  return {
    channel_id,
    tmdb_id: 1000 + channel_id,
    title,
    year: 2021,
    rating: 7.4,
    poster_url: null,
    backdrop_url: `https://image.tmdb.org/t/p/w1280/${channel_id}.jpg`,
    genres: ['Action', 'Thriller'],
    overview: `${title} plot`,
  };
}

const row: HomeRow = {
  genre: 'Action',
  content_type: 'vod',
  items: [item(1, 'First'), item(2, 'Second'), item(3, 'Third')],
};

function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new globalThis.Event('visibilitychange'));
}

describe('GenreSlideshow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotion(false);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the genre, the kind and the first slide with its meta line', () => {
    render(<GenreSlideshow row={row} onOpen={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Action');
    expect(screen.getByText('Movies')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('First');
    expect(screen.getByText('2021 · Action, Thriller · ★ 7.4')).toBeInTheDocument();
    expect(screen.getByText('First plot')).toBeInTheDocument();
  });

  it('labels a series row', () => {
    render(<GenreSlideshow row={{ ...row, content_type: 'series' }} onOpen={vi.fn()} />);
    expect(screen.getByText('Series')).toBeInTheDocument();
  });

  it('advances every 8 seconds and wraps', () => {
    render(<GenreSlideshow row={row} onOpen={vi.fn()} />);
    act(() => vi.advanceTimersByTime(SLIDE_INTERVAL_MS));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Second');
    act(() => vi.advanceTimersByTime(SLIDE_INTERVAL_MS * 2));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('First');
  });

  it('pauses while hovered', () => {
    render(<GenreSlideshow row={row} onOpen={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTestId('slide'));
    act(() => vi.advanceTimersByTime(SLIDE_INTERVAL_MS * 3));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('First');
    fireEvent.mouseLeave(screen.getByTestId('slide'));
    act(() => vi.advanceTimersByTime(SLIDE_INTERVAL_MS));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Second');
  });

  it('pauses while the document is hidden', () => {
    render(<GenreSlideshow row={row} onOpen={vi.fn()} />);
    act(() => setHidden(true));
    act(() => vi.advanceTimersByTime(SLIDE_INTERVAL_MS * 3));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('First');
    act(() => setHidden(false));
    act(() => vi.advanceTimersByTime(SLIDE_INTERVAL_MS));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Second');
  });

  it('never autoplays under reduced motion', () => {
    setReducedMotion(true);
    render(<GenreSlideshow row={row} onOpen={vi.fn()} />);
    act(() => vi.advanceTimersByTime(SLIDE_INTERVAL_MS * 3));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('First');
  });

  it('arrows step and wrap, and a manual step restarts the clock', () => {
    render(<GenreSlideshow row={row} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Third');
    act(() => vi.advanceTimersByTime(SLIDE_INTERVAL_MS - 1000));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('First');
    act(() => vi.advanceTimersByTime(SLIDE_INTERVAL_MS - 1000));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('First');
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Second');
  });

  it('dots select a slide', () => {
    render(<GenreSlideshow row={row} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Slide 3 of 3' }));
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Third');
    expect(screen.getByRole('tab', { name: 'Slide 3 of 3' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('opens the current title', () => {
    const onOpen = vi.fn();
    render(<GenreSlideshow row={row} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'First, open details' }));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('falls back to colour bars when the backdrop fails to load', () => {
    render(<GenreSlideshow row={row} onOpen={vi.fn()} />);
    fireEvent.error(screen.getByTestId('slide').querySelector('img')!);
    expect(screen.getByTestId('slide').querySelector('img')).toBeNull();
  });

  it('shows no arrows or dots for a single slide', () => {
    render(<GenreSlideshow row={{ ...row, items: [item(1, 'Only')] }} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});
