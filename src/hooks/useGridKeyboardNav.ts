import { useCallback, useEffect, useRef, useState } from 'react';
import { isGridNavKey, moveInGrid } from '../lib/gridNav';

interface GridItem {
  id: number;
}

export interface GridKeyboardNavOptions<T extends GridItem> {
  /** The cards, in display order. */
  items: T[];
  /** Cards per row. */
  columns: number;
  /** Rows a Page Up or Page Down moves. */
  pageRows: number;
  /** Changes when the list is a different list (section, category, search): the active card is forgotten. */
  listKey: string;
  /** Index of the first card in view: where the keyboard starts without an active card. */
  firstVisibleIndex: () => number;
  /** Enter on the active card. */
  onActivate: (item: T) => void;
  /** Bring the card at `index` into view. */
  scrollToIndex: (index: number) => void;
}

export interface GridKeyboardNav<T extends GridItem> {
  /** Index of the active card in `items`; null without one. */
  activeIndex: number | null;
  /** Whether the active card shows its ring: only while the keyboard drives the grid. */
  ringVisible: boolean;
  /** Spread on the element that holds the rows; it takes the focus, the cards do not. */
  gridProps: {
    ref: React.RefObject<globalThis.HTMLDivElement | null>;
    tabIndex: 0;
    'aria-activedescendant': string | undefined;
    onKeyDown: (e: React.KeyboardEvent<globalThis.HTMLElement>) => void;
    onFocus: (e: React.FocusEvent<globalThis.HTMLElement>) => void;
    onBlur: (e: React.FocusEvent<globalThis.HTMLElement>) => void;
    onMouseDown: (e: React.MouseEvent<globalThis.HTMLElement>) => void;
    onMouseUp: () => void;
  };
  /** DOM id of the cell of a card, for `aria-activedescendant`. */
  cellId: (item: T) => string;
}

/** The attribute a cell carries its index in (`data-grid-index`), so a click can say which card it hit. */
const GRID_INDEX_ATTRIBUTE = 'data-grid-index';

interface Active {
  id: number;
  /** Where the card was when it became active; checked against the list before use. */
  index: number;
}

/** Where the active card is in `items` now; null when it is gone. */
function locate<T extends GridItem>(items: T[], active: Active | null): number | null {
  if (!active) return null;
  if (items[active.index]?.id === active.id) return active.index;
  // The list changed under the card (a favourite toggled, a refresh): find it again.
  const index = items.findIndex((item) => item.id === active.id);
  return index === -1 ? null : index;
}

/**
 * Keyboard navigation for a virtualised card grid, after the WAI-ARIA grid
 * pattern with `aria-activedescendant`: the grid element holds the DOM focus
 * and names the active card, so the cards stay out of the tab order (their
 * own buttons keep their places in it) and a card scrolled out of the DOM
 * cannot lose the focus.
 *
 * Arrows, Home, End, Page Up and Page Down move the active card
 * (`lib/gridNav`), Enter activates it. The first key after the grid gets the
 * focus starts at the first card in view. A click makes the clicked card the
 * active one without showing the ring, so the arrows carry on from there.
 * Keys pressed on a control inside a card are left to that control.
 *
 * The grid is reached with Tab, and also by an arrow key pressed while
 * nothing has the focus (right after start, or after a click on empty
 * space): the category chips before it can be a hundred tab stops. Arrow
 * Down in a search field leads on to the grid as well, so a search is
 * typed, walked and played without leaving the keyboard.
 */
export function useGridKeyboardNav<T extends GridItem>({
  items,
  columns,
  pageRows,
  listKey,
  firstVisibleIndex,
  onActivate,
  scrollToIndex,
}: GridKeyboardNavOptions<T>): GridKeyboardNav<T> {
  const [active, setActive] = useState<Active | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  // A mouse press focuses the grid too; that focus must not show the ring.
  const pointerDown = useRef(false);

  // Another list starts without an active card, also when the same list
  // comes back later: it is scrolled to its top then, not to the old place.
  const [seenListKey, setSeenListKey] = useState(listKey);
  if (seenListKey !== listKey) {
    setSeenListKey(listKey);
    setActive(null);
  }

  const activeIndex = seenListKey === listKey ? locate(items, active) : null;

  const activate = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) setActive({ id: item.id, index });
    },
    [items]
  );

  const startIndex = useCallback(
    () => Math.min(Math.max(firstVisibleIndex(), 0), items.length - 1),
    [firstVisibleIndex, items.length]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<globalThis.HTMLElement>) => {
      // A key pressed on a button inside a card belongs to that button.
      if (e.target !== e.currentTarget || e.altKey || e.metaKey) return;

      if (e.key === 'Enter') {
        if (activeIndex === null || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        onActivate(items[activeIndex]);
        return;
      }

      if (!isGridNavKey(e.key) || items.length === 0) return;
      const toListEnd = e.ctrlKey && (e.key === 'Home' || e.key === 'End');
      if (e.ctrlKey && !toListEnd) return;
      // Also keeps the browser from scrolling the list on its own.
      e.preventDefault();
      const next =
        activeIndex === null
          ? startIndex()
          : moveInGrid(activeIndex, e.key, { count: items.length, columns, pageRows }, toListEnd);
      activate(next);
      setKeyboard(true);
      scrollToIndex(next);
    },
    [activeIndex, items, columns, pageRows, onActivate, scrollToIndex, activate, startIndex]
  );

  const onFocus = useCallback(
    (e: React.FocusEvent<globalThis.HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (pointerDown.current) return;
      // Reached with Tab: show where the keyboard is.
      setKeyboard(true);
      if (activeIndex === null && items.length > 0) activate(startIndex());
    },
    [activeIndex, items.length, activate, startIndex]
  );

  const onBlur = useCallback((e: React.FocusEvent<globalThis.HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    pointerDown.current = false;
    setKeyboard(false);
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<globalThis.HTMLElement>) => {
      pointerDown.current = true;
      setKeyboard(false);
      const cell = (e.target as globalThis.HTMLElement).closest?.(`[${GRID_INDEX_ATTRIBUTE}]`);
      const index = Number(cell?.getAttribute(GRID_INDEX_ATTRIBUTE) ?? NaN);
      if (Number.isInteger(index)) activate(index);
    },
    [activate]
  );

  const onMouseUp = useCallback(() => {
    pointerDown.current = false;
  }, []);

  // An arrow key with the focus on nothing goes to the grid, and so does
  // Arrow Down in a search field, a key a one-line field has no use for.
  // The grid's focus handler then shows the ring where the keyboard is; the
  // key itself moves nothing, like the first key after Tab. A dialog keeps
  // its keys.
  const gridRef = useRef<globalThis.HTMLDivElement | null>(null);
  useEffect(() => {
    const onWindowKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      // Mid-composition the arrows belong to the input method's candidates.
      if (e.isComposing) return;
      if (!e.key.startsWith('Arrow')) return;
      const focused = document.activeElement;
      const onNothing = !focused || focused === document.body;
      const downFromSearch =
        e.key === 'ArrowDown' &&
        focused instanceof globalThis.HTMLInputElement &&
        focused.type === 'search';
      if (!onNothing && !downFromSearch) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const grid = gridRef.current;
      if (!grid) return;
      e.preventDefault();
      grid.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, []);

  const cellId = useCallback((item: T) => `grid-cell-${item.id}`, []);

  return {
    activeIndex,
    ringVisible: keyboard && activeIndex !== null,
    gridProps: {
      ref: gridRef,
      tabIndex: 0,
      'aria-activedescendant': activeIndex === null ? undefined : cellId(items[activeIndex]),
      onKeyDown,
      onFocus,
      onBlur,
      onMouseDown,
      onMouseUp,
    },
    cellId,
  };
}
