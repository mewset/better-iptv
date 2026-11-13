import { describe, it, expect } from 'vitest';
import { isGridNavKey, moveInGrid, type GridNavKey, type GridShape } from '../../lib/gridNav';

// Ten cards, four to a row:
//   0 1 2 3
//   4 5 6 7
//   8 9
const grid: GridShape = { count: 10, columns: 4, pageRows: 2 };
const move = (index: number, key: GridNavKey, toListEnd = false) =>
  moveInGrid(index, key, grid, toListEnd);

describe('moveInGrid', () => {
  it('moves one card with the arrows', () => {
    expect(move(5, 'ArrowLeft')).toBe(4);
    expect(move(5, 'ArrowRight')).toBe(6);
    expect(move(5, 'ArrowUp')).toBe(1);
    expect(move(1, 'ArrowDown')).toBe(5);
  });

  it('stops at the edges instead of wrapping', () => {
    expect(move(4, 'ArrowLeft')).toBe(4);
    expect(move(7, 'ArrowRight')).toBe(7);
    expect(move(2, 'ArrowUp')).toBe(2);
    expect(move(9, 'ArrowDown')).toBe(9);
    expect(move(9, 'ArrowRight')).toBe(9);
  });

  it('lands on the last card when the row below is shorter', () => {
    expect(move(6, 'ArrowDown')).toBe(9);
    expect(move(4, 'ArrowDown')).toBe(8);
  });

  it('goes to the ends of the row with Home and End', () => {
    expect(move(6, 'Home')).toBe(4);
    expect(move(5, 'End')).toBe(7);
    expect(move(8, 'End')).toBe(9);
  });

  it('goes to the ends of the list with Ctrl+Home and Ctrl+End', () => {
    expect(move(6, 'Home', true)).toBe(0);
    expect(move(1, 'End', true)).toBe(9);
  });

  it('moves a page of rows and keeps the column where it can', () => {
    const tall: GridShape = { count: 42, columns: 4, pageRows: 3 };
    expect(moveInGrid(5, 'PageDown', tall)).toBe(17);
    expect(moveInGrid(17, 'PageUp', tall)).toBe(5);
    // Past the ends: the first row, and the last card of a shorter last row.
    expect(moveInGrid(5, 'PageUp', tall)).toBe(1);
    expect(moveInGrid(35, 'PageDown', tall)).toBe(41);
    expect(moveInGrid(32, 'PageDown', tall)).toBe(40);
  });

  it('stays on the only card of a one-card list', () => {
    const one: GridShape = { count: 1, columns: 4, pageRows: 2 };
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'End'] as const) {
      expect(moveInGrid(0, key, one)).toBe(0);
    }
  });

  it('brings an index outside the list back into it', () => {
    expect(move(99, 'ArrowLeft')).toBe(8);
    expect(move(-3, 'ArrowRight')).toBe(1);
  });
});

describe('isGridNavKey', () => {
  it('knows the navigation keys and nothing else', () => {
    expect(isGridNavKey('ArrowDown')).toBe(true);
    expect(isGridNavKey('PageUp')).toBe(true);
    expect(isGridNavKey('Enter')).toBe(false);
    expect(isGridNavKey('a')).toBe(false);
  });
});
