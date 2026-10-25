import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CategoryBar } from '../../components/CategoryBar';
import { usePlayerStore } from '../../stores/player-store';

describe('CategoryBar', () => {
  beforeEach(() => usePlayerStore.setState({ categories: null, categoryFilter: null }));

  it('holds the row with an empty strip while the categories load', () => {
    const { container } = render(<CategoryBar />);
    expect(screen.queryByRole('tablist')).toBeNull();
    const strip = container.firstElementChild as HTMLElement;
    const spacer = strip.firstElementChild as HTMLElement;
    expect(spacer).toHaveAttribute('aria-hidden', 'true');
    expect(spacer).toBeEmptyDOMElement();
    const stripClass = strip.className;
    const spacerClass = spacer.className;

    // jsdom has no layout, so compare the classes that size the row: same padding, chip height
    act(() => usePlayerStore.setState({ categories: ['Sweden'] }));
    const row = screen.getByRole('tablist');
    expect(row.className).toBe(stripClass);
    const chipHeight = screen.getByRole('tab', { name: 'Sweden' }).className.match(/h-\[\d+px\]/);
    expect(chipHeight?.[0]).toBe(spacerClass);
  });

  it('renders nothing for a section without categories', () => {
    usePlayerStore.setState({ categories: [] });
    const { container } = render(<CategoryBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders All plus one chip per category', () => {
    usePlayerStore.setState({ categories: ['Sweden', 'Norway'] });
    render(<CategoryBar />);
    expect(screen.getByRole('tablist', { name: 'Channel categories' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'All',
      'Sweden',
      'Norway',
    ]);
  });
});
