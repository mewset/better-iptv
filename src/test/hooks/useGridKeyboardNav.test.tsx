import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useGridKeyboardNav } from '../../hooks/useGridKeyboardNav';

interface Item {
  id: number;
  name: string;
}

const items = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: 100 + i, name: `Card ${i}` }));

const onActivate = vi.fn();
const scrollToIndex = vi.fn();
const onCardButton = vi.fn();

/** A grid the way MainScreen wires it: cells with ids and indices, a button inside each. */
function Grid({
  list,
  listKey = 'live',
  firstVisible = 0,
}: {
  list: Item[];
  listKey?: string;
  firstVisible?: number;
}) {
  const nav = useGridKeyboardNav({
    items: list,
    columns: 4,
    pageRows: 2,
    listKey,
    firstVisibleIndex: () => firstVisible,
    onActivate,
    scrollToIndex,
  });
  return (
    <div role="grid" aria-label="Cards" {...nav.gridProps}>
      {list.map((item, index) => (
        <div
          key={item.id}
          id={nav.cellId(item)}
          role="gridcell"
          aria-selected={nav.activeIndex === index}
          data-grid-index={index}
          data-ring={nav.activeIndex === index && nav.ringVisible}
        >
          <button type="button" onClick={onCardButton}>
            {item.name}
          </button>
        </div>
      ))}
    </div>
  );
}

const grid = () => screen.getByRole('grid', { name: 'Cards' });
const active = () => grid().getAttribute('aria-activedescendant');
const ringed = () => document.querySelectorAll('[data-ring="true"]');
const key = (name: string, init = {}) => fireEvent.keyDown(grid(), { key: name, ...init });

describe('useGridKeyboardNav', () => {
  beforeEach(() => {
    onActivate.mockClear();
    scrollToIndex.mockClear();
    onCardButton.mockClear();
  });

  it('has no active card until the keyboard reaches the grid', () => {
    render(<Grid list={items(10)} />);
    expect(active()).toBeNull();
    expect(ringed()).toHaveLength(0);
    expect(grid()).toHaveAttribute('tabindex', '0');
  });

  it('starts at the first card in view when the grid is reached with Tab', () => {
    render(<Grid list={items(10)} firstVisible={4} />);
    fireEvent.focus(grid());
    expect(active()).toBe('grid-cell-104');
    expect(ringed()).toHaveLength(1);
  });

  it('moves the active card with the arrows and scrolls it into view', () => {
    render(<Grid list={items(10)} />);
    fireEvent.focus(grid());

    key('ArrowRight');
    expect(active()).toBe('grid-cell-101');
    key('ArrowDown');
    expect(active()).toBe('grid-cell-105');

    expect(scrollToIndex.mock.calls).toEqual([[1], [5]]);
    expect(screen.getAllByRole('gridcell', { selected: true })).toHaveLength(1);
  });

  it('keeps the browser from scrolling on a navigation key', () => {
    render(<Grid list={items(10)} />);
    fireEvent.focus(grid());
    // fireEvent returns false when the handler called preventDefault
    expect(key('ArrowDown')).toBe(false);
    expect(key('PageDown')).toBe(false);
    expect(key('a')).toBe(true);
  });

  it('goes to the ends of the list with Ctrl+End and Ctrl+Home', () => {
    render(<Grid list={items(10)} />);
    fireEvent.focus(grid());
    key('End', { ctrlKey: true });
    expect(active()).toBe('grid-cell-109');
    key('Home', { ctrlKey: true });
    expect(active()).toBe('grid-cell-100');
  });

  it('leaves Ctrl, Alt and Meta chords with the arrows alone', () => {
    render(<Grid list={items(10)} />);
    fireEvent.focus(grid());
    expect(key('ArrowRight', { ctrlKey: true })).toBe(true);
    expect(key('ArrowRight', { altKey: true })).toBe(true);
    expect(key('ArrowRight', { metaKey: true })).toBe(true);
    expect(active()).toBe('grid-cell-100');
  });

  it('activates the active card on Enter', () => {
    const list = items(10);
    render(<Grid list={list} />);
    fireEvent.focus(grid());
    key('ArrowRight');
    key('Enter');
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(list[1]);
  });

  it('does nothing on Enter without an active card', () => {
    render(<Grid list={items(10)} />);
    expect(key('Enter')).toBe(true);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('leaves keys pressed on a button inside a card to that button', () => {
    render(<Grid list={items(10)} />);
    fireEvent.focus(grid());
    const button = screen.getByRole('button', { name: 'Card 3' });

    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: 'ArrowRight' });

    expect(onActivate).not.toHaveBeenCalled();
    expect(active()).toBe('grid-cell-100');
  });

  it('makes a clicked card the active one without showing the ring', () => {
    render(<Grid list={items(10)} />);
    const button = screen.getByRole('button', { name: 'Card 6' });

    fireEvent.mouseDown(button);
    fireEvent.focus(grid());
    fireEvent.mouseUp(button);

    expect(active()).toBe('grid-cell-106');
    expect(ringed()).toHaveLength(0);

    // The arrows carry on from the clicked card, and the ring shows again.
    key('ArrowLeft');
    expect(active()).toBe('grid-cell-105');
    expect(ringed()).toHaveLength(1);
  });

  it('hides the ring when the focus leaves the grid and keeps the place', () => {
    render(<Grid list={items(10)} />);
    fireEvent.focus(grid());
    key('ArrowRight');

    fireEvent.blur(grid());
    expect(ringed()).toHaveLength(0);

    fireEvent.focus(grid());
    expect(active()).toBe('grid-cell-101');
    expect(ringed()).toHaveLength(1);
  });

  it('follows the active card when the list changes under it', () => {
    const list = items(10);
    const { rerender } = render(<Grid list={list} />);
    fireEvent.focus(grid());
    key('ArrowRight');
    key('ArrowRight');
    expect(active()).toBe('grid-cell-102');

    // The card before it is gone (a favourite removed): same card, new index.
    rerender(<Grid list={list.filter((item) => item.id !== 101)} />);
    expect(active()).toBe('grid-cell-102');
    key('ArrowRight');
    expect(active()).toBe('grid-cell-103');
  });

  it('forgets the active card when it leaves the list', () => {
    const list = items(10);
    const { rerender } = render(<Grid list={list} />);
    fireEvent.focus(grid());
    key('ArrowRight');

    rerender(<Grid list={list.filter((item) => item.id !== 101)} />);

    expect(active()).toBeNull();
    expect(ringed()).toHaveLength(0);
  });

  it('forgets the active card when the list is another list', () => {
    const list = items(10);
    const { rerender } = render(<Grid list={list} listKey="live" />);
    fireEvent.focus(grid());
    key('ArrowRight');

    rerender(<Grid list={list} listKey="vod" />);
    expect(active()).toBeNull();

    // The next key starts at the first card in view again.
    key('ArrowDown');
    expect(active()).toBe('grid-cell-100');
  });

  describe('reaching the grid with an arrow key', () => {
    const pressOnPage = (name: string, init = {}) =>
      fireEvent.keyDown(document.body, { key: name, ...init });

    it('takes the focus when nothing has it, and shows the first card in view', () => {
      render(<Grid list={items(10)} firstVisible={4} />);
      expect(document.body).toHaveFocus();

      // Prevented, so the page does not scroll as well.
      expect(pressOnPage('ArrowDown')).toBe(false);

      expect(grid()).toHaveFocus();
      expect(active()).toBe('grid-cell-104');
      expect(ringed()).toHaveLength(1);
      // The key that brought the focus moved nothing; the next one does.
      key('ArrowRight');
      expect(active()).toBe('grid-cell-105');
    });

    it('shows the card that was clicked last instead of starting over', () => {
      render(<Grid list={items(10)} />);
      const button = screen.getByRole('button', { name: 'Card 6' });
      fireEvent.mouseDown(button);
      fireEvent.mouseUp(button);

      pressOnPage('ArrowUp');

      expect(active()).toBe('grid-cell-106');
      expect(ringed()).toHaveLength(1);
    });

    it('goes on from a search field with Arrow Down, and only with that key', () => {
      render(
        <>
          <input type="search" aria-label="Search" />
          <Grid list={items(10)} />
        </>
      );
      const search = screen.getByRole('searchbox', { name: 'Search' });
      search.focus();

      // The other arrows stay in the field (the cursor moves with them).
      expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true);
      expect(fireEvent.keyDown(search, { key: 'ArrowUp' })).toBe(true);
      expect(search).toHaveFocus();

      expect(fireEvent.keyDown(search, { key: 'ArrowDown' })).toBe(false);
      expect(grid()).toHaveFocus();
      expect(active()).toBe('grid-cell-100');
      expect(ringed()).toHaveLength(1);
    });

    it('leaves the key alone while something else has the focus', () => {
      render(
        <>
          <input aria-label="Search" />
          <Grid list={items(10)} />
        </>
      );
      const search = screen.getByRole('textbox', { name: 'Search' });
      search.focus();

      expect(fireEvent.keyDown(search, { key: 'ArrowDown' })).toBe(true);

      expect(search).toHaveFocus();
      expect(active()).toBeNull();
    });

    it('leaves the key alone while a dialog is open, with a modifier, or for other keys', () => {
      const { rerender } = render(<Grid list={items(10)} />);
      expect(pressOnPage('ArrowDown', { ctrlKey: true })).toBe(true);
      expect(pressOnPage('ArrowDown', { shiftKey: true })).toBe(true);
      expect(pressOnPage('PageDown')).toBe(true);
      expect(pressOnPage('a')).toBe(true);

      rerender(
        <>
          <div role="dialog" aria-modal="true" />
          <Grid list={items(10)} />
        </>
      );
      expect(pressOnPage('ArrowDown')).toBe(true);

      expect(grid()).not.toHaveFocus();
      expect(active()).toBeNull();
    });
  });

  it('ignores the keys in an empty list', () => {
    render(<Grid list={[]} />);
    grid().focus();
    expect(key('ArrowDown')).toBe(true);
    expect(active()).toBeNull();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
