/**
 * Keyboard movement in a card grid: which card a key leads to. Pure math, so
 * the grid's hook and its tests share one definition.
 *
 * The keys follow the WAI-ARIA grid pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/grid/): arrows move one card and
 * stop at the edges, Home and End go to the ends of the row and with Ctrl to
 * the ends of the list, Page Up and Page Down move a screenful of rows.
 */

const NAV_KEYS = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
] as const;

export type GridNavKey = (typeof NAV_KEYS)[number];

export function isGridNavKey(key: string): key is GridNavKey {
  return (NAV_KEYS as readonly string[]).includes(key);
}

export interface GridShape {
  /** Cards in the list. */
  count: number;
  /** Cards per row; the last row may hold fewer. */
  columns: number;
  /** Rows a Page Up or Page Down moves. */
  pageRows: number;
}

/**
 * The index `key` leads to from `index`. Nothing wraps: a move past an edge
 * stays where it is. Moving down from the row above a shorter last row lands
 * on the last card, so every card can be reached with the arrows alone.
 * `toListEnd` is Ctrl with Home or End.
 */
export function moveInGrid(
  index: number,
  key: GridNavKey,
  { count, columns, pageRows }: GridShape,
  toListEnd = false
): number {
  if (count <= 0) return 0;
  const last = count - 1;
  const from = Math.min(Math.max(index, 0), last);
  const row = Math.floor(from / columns);
  const column = from % columns;
  const lastRow = Math.floor(last / columns);
  const inRow = (targetRow: number) => Math.min(targetRow * columns + column, last);

  switch (key) {
    case 'ArrowLeft':
      return column === 0 ? from : from - 1;
    case 'ArrowRight':
      return column === columns - 1 || from === last ? from : from + 1;
    case 'ArrowUp':
      return row === 0 ? from : from - columns;
    case 'ArrowDown':
      return row === lastRow ? from : inRow(row + 1);
    case 'PageUp':
      return inRow(Math.max(row - Math.max(pageRows, 1), 0));
    case 'PageDown':
      return inRow(Math.min(row + Math.max(pageRows, 1), lastRow));
    case 'Home':
      return toListEnd ? 0 : row * columns;
    case 'End':
      return toListEnd ? last : Math.min(row * columns + columns - 1, last);
  }
}
