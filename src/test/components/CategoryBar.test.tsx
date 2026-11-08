import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CategoryBar } from '../../components/CategoryBar';
import { usePlayerStore } from '../../stores/player-store';

const ROW = { name: 'Channel categories' };

/** The category name buttons in bar order (pin buttons are named "Pin …"/"Unpin …"). */
function names(): string[] {
  return screen
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
    .filter((t) => t !== '');
}

describe('CategoryBar', () => {
  const toggleCategoryPin = vi.fn(async () => {});

  beforeEach(() => {
    toggleCategoryPin.mockClear();
    usePlayerStore.setState({
      categories: null,
      pinnedCategories: [],
      categoryFilter: null,
      toggleCategoryPin,
    });
  });

  it('holds the row with an empty strip while the categories load', () => {
    const { container } = render(<CategoryBar />);
    expect(screen.queryByRole('group', ROW)).toBeNull();
    const strip = container.firstElementChild as HTMLElement;
    const spacer = strip.firstElementChild as HTMLElement;
    expect(spacer).toHaveAttribute('aria-hidden', 'true');
    expect(spacer).toBeEmptyDOMElement();
    const stripClass = strip.className;
    const spacerClass = spacer.className;

    // jsdom has no layout, so compare the classes that size the row: same padding, chip height
    act(() => usePlayerStore.setState({ categories: ['Sweden'] }));
    const row = screen.getByRole('group', ROW);
    expect(row.className).toBe(stripClass);
    const pill = screen.getByRole('button', { name: 'Sweden' }).parentElement as HTMLElement;
    expect(pill.className.match(/h-\[\d+px\]/)?.[0]).toBe(spacerClass);
  });

  it('reserves the scrollbar gutter from the first layout, while loading too', () => {
    // WebKitGTK does not grow the parent when an overflow-x:auto scrollbar appears later, so
    // the list below would cover it; jsdom has no layout, so check the rule that prevents it
    const { container } = render(<CategoryBar />);
    expect(container.firstElementChild).toHaveClass('overflow-x-scroll');
    act(() => usePlayerStore.setState({ categories: ['Sweden'] }));
    expect(screen.getByRole('group', ROW)).toHaveClass('overflow-x-scroll');
  });

  it('renders nothing when both lists are empty', () => {
    usePlayerStore.setState({ categories: [], pinnedCategories: [] });
    const { container } = render(<CategoryBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a section where every category is pinned', () => {
    usePlayerStore.setState({ categories: [], pinnedCategories: ['Sweden'] });
    render(<CategoryBar />);
    expect(names()).toEqual(['All', 'Sweden']);
  });

  it('renders All, then the pinned categories, a divider, then the rest', () => {
    usePlayerStore.setState({
      pinnedCategories: ['Sweden'],
      categories: ['Netherlands', 'Norway'],
    });
    render(<CategoryBar />);
    expect(names()).toEqual(['All', 'Sweden', 'Netherlands', 'Norway']);

    const row = screen.getByRole('group', ROW);
    const dividers = row.querySelectorAll(':scope > [aria-hidden="true"]');
    expect(dividers).toHaveLength(1);
    const sweden = screen.getByRole('button', { name: 'Sweden' }).parentElement;
    const netherlands = screen.getByRole('button', { name: 'Netherlands' }).parentElement;
    expect(dividers[0].previousElementSibling).toBe(sweden);
    expect(dividers[0].nextElementSibling).toBe(netherlands);
  });

  it('shows no divider without pins', () => {
    usePlayerStore.setState({ categories: ['Netherlands', 'Norway'] });
    render(<CategoryBar />);
    const row = screen.getByRole('group', ROW);
    expect(row.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(0);
  });

  it('shows no divider when everything is pinned', () => {
    usePlayerStore.setState({ categories: [], pinnedCategories: ['Sweden', 'Norway'] });
    render(<CategoryBar />);
    const row = screen.getByRole('group', ROW);
    expect(row.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(0);
  });

  it('selects a category on its name without pinning it', () => {
    usePlayerStore.setState({ categories: ['Netherlands'] });
    render(<CategoryBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Netherlands' }));
    expect(usePlayerStore.getState().categoryFilter).toBe('Netherlands');
    expect(toggleCategoryPin).not.toHaveBeenCalled();
  });

  it('pins a category on its pin without selecting it', () => {
    usePlayerStore.setState({ categories: ['Netherlands'] });
    render(<CategoryBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Netherlands' }));
    expect(toggleCategoryPin).toHaveBeenCalledTimes(1);
    expect(toggleCategoryPin).toHaveBeenCalledWith('Netherlands');
    expect(usePlayerStore.getState().categoryFilter).toBeNull();
  });

  it('marks the selected category and the pinned ones as pressed', () => {
    usePlayerStore.setState({
      pinnedCategories: ['Sweden'],
      categories: ['Norway'],
      categoryFilter: 'Norway',
    });
    render(<CategoryBar />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Norway' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Sweden' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Unpin Sweden' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Pin Norway' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('fills the icon of a pinned pin, not of an unpinned one', () => {
    // lucide puts fill="none" on the svg itself, so a fill class on the button never reaches it
    usePlayerStore.setState({ pinnedCategories: ['Sweden'], categories: ['Norway'] });
    render(<CategoryBar />);
    const icon = (name: string) => screen.getByRole('button', { name }).querySelector('svg');
    expect(icon('Unpin Sweden')).toHaveClass('fill-current');
    expect(icon('Pin Norway')).not.toHaveClass('fill-current');
  });

  it('keeps keyboard focus on a pin when its chip moves between the groups', () => {
    usePlayerStore.setState({ categories: ['Sweden', 'Norway'] });
    render(<CategoryBar />);
    const pin = screen.getByRole('button', { name: 'Pin Norway' });
    pin.focus();
    fireEvent.click(pin);
    // What toggleCategoryPin's answer does: Norway moves to the pinned group
    act(() => usePlayerStore.setState({ pinnedCategories: ['Norway'], categories: ['Sweden'] }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Unpin Norway' }));
  });

  it('ignores the second click of a double-click, which lands where the chips moved to', () => {
    usePlayerStore.setState({ categories: ['Sweden', 'Norway'] });
    render(<CategoryBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin Sweden' }), { detail: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Norway' }), { detail: 2 });
    expect(toggleCategoryPin).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().categoryFilter).toBeNull();

    // A keyboard press reports detail 0 and still counts
    fireEvent.click(screen.getByRole('button', { name: 'Pin Sweden' }), { detail: 0 });
    expect(toggleCategoryPin).toHaveBeenCalledWith('Sweden');
  });

  it('marks All as pressed when no category is selected', () => {
    usePlayerStore.setState({ categories: ['Norway'] });
    render(<CategoryBar />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps every name and pin button a tab stop', () => {
    usePlayerStore.setState({ pinnedCategories: ['Sweden'], categories: ['Norway'] });
    render(<CategoryBar />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toHaveAttribute('tabindex', '-1');
    }
    expect(screen.getAllByRole('button')).toHaveLength(5); // All + 2 × (name, pin)
  });
});
