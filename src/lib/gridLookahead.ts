/**
 * Rows past each edge of the view whose cards still feed the guide and TMDB
 * lookups, so a short scroll lands on cards that already have their data.
 * Separate from the grid's DOM overscan, which only has to cover scrolling.
 */
export const LOOKAHEAD_ROWS = 5;

/**
 * The cards in the visible rows `firstRow..lastRow` plus LOOKAHEAD_ROWS rows
 * each way, clamped to the list. With a hero, virtual row 0 is the hero and
 * holds no cards, so card rows start at 1.
 */
export function lookAheadChannels<T>(
  channels: readonly T[],
  columns: number,
  hasHero: boolean,
  firstRow: number,
  lastRow: number
): T[] {
  const out: T[] = [];
  const rowCount = Math.ceil(channels.length / columns) + (hasHero ? 1 : 0);
  const first = Math.max(firstRow - LOOKAHEAD_ROWS, 0);
  const last = Math.min(lastRow + LOOKAHEAD_ROWS, rowCount - 1);
  for (let row = first; row <= last; row++) {
    if (hasHero && row === 0) continue;
    const start = (hasHero ? row - 1 : row) * columns;
    for (let i = start; i < Math.min(start + columns, channels.length); i++) {
      out.push(channels[i]);
    }
  }
  return out;
}
