import { describe, it, expect } from 'vitest';
import { defaultRangeExtractor } from '@tanstack/react-virtual';
import { LOOKAHEAD_ROWS, lookAheadChannels } from '../../lib/gridLookahead';

// Channel i is just its index, so a result reads as the slice of the list it covers
const list = (n: number) => Array.from({ length: n }, (_, i) => i);
const span = (from: number, to: number) => list(to + 1).slice(from);

describe('lookAheadChannels', () => {
  it('takes the visible rows plus five rows each way', () => {
    // 60 channels in 3 columns are rows 0-19; rows 8-10 on screen -> rows 3-15
    expect(LOOKAHEAD_ROWS).toBe(5);
    expect(lookAheadChannels(list(60), 3, false, 8, 10)).toEqual(span(9, 47));
  });

  it('clamps at the top of the list', () => {
    expect(lookAheadChannels(list(60), 3, false, 0, 2)).toEqual(span(0, 23));
  });

  it('clamps at the end of the list, including a short last row', () => {
    // 58 channels: rows 0-19, row 19 holds channel 57 only
    expect(lookAheadChannels(list(58), 3, false, 17, 19)).toEqual(span(36, 57));
  });

  it('skips the hero row, which holds no cards', () => {
    // Virtual rows 0-7, of which 1-7 are card rows 0-6
    expect(lookAheadChannels(list(60), 3, true, 0, 2)).toEqual(span(0, 20));
    // Below the hero the card rows are shifted by one: virtual rows 5-15 = card rows 4-14
    expect(lookAheadChannels(list(60), 3, true, 10, 10)).toEqual(span(12, 44));
  });

  it('covers the same rows the grid mounted with an overscan of five', () => {
    const channels = list(100);
    const columns = 4;
    const rowCount = Math.ceil(channels.length / columns);
    for (const [startIndex, endIndex] of [
      [0, 3],
      [6, 9],
      [21, 24],
    ]) {
      const mounted = defaultRangeExtractor({ startIndex, endIndex, overscan: 5, count: rowCount });
      const fromMounted = mounted.flatMap((row) =>
        channels.slice(row * columns, row * columns + columns)
      );
      expect(lookAheadChannels(channels, columns, false, startIndex, endIndex)).toEqual(
        fromMounted
      );
    }
  });
});
