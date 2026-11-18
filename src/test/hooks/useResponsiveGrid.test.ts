import { afterEach, describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  calculateGridConfig,
  getGridClasses,
  useResponsiveGrid,
  type GridKind,
} from '../../hooks/useResponsiveGrid';

describe('calculateGridConfig', () => {
  it('uses one column below 560 px for both kinds', () => {
    expect(calculateGridConfig(500, 900, 'live').columns).toBe(1);
    expect(calculateGridConfig(500, 900, 'poster').columns).toBe(1);
  });
  it('adds columns on an ultrawide window instead of growing the cards', () => {
    // At 3840 px the grids kept the columns of 1920 and 2560: posters 447 px
    // wide with one row in view, live cards over 500 px
    const posterWidth = (w: number) => {
      const c = calculateGridConfig(w, 1600, 'poster');
      return (c.cardHeight - 28) / 1.5;
    };
    expect(calculateGridConfig(2560, 1440, 'poster').columns).toBe(8);
    expect(calculateGridConfig(3440, 1440, 'poster').columns).toBe(10);
    expect(calculateGridConfig(3840, 1600, 'poster').columns).toBe(12);
    for (const width of [3200, 3440, 3840]) {
      expect(posterWidth(width)).toBeGreaterThan(250);
      expect(posterWidth(width)).toBeLessThan(320);
    }

    expect(calculateGridConfig(2560, 1440, 'live').columns).toBe(7);
    expect(calculateGridConfig(3440, 1440, 'live').columns).toBe(9);
    expect(calculateGridConfig(3840, 1600, 'live').columns).toBe(11);
  });

  it('has a grid class for the columns of every window width', () => {
    // The math and the class map are two lists: a column count the map does
    // not know falls back to four columns
    for (const kind of ['live', 'poster'] as const) {
      for (let width = 320; width <= 5200; width += 40) {
        const { columns } = calculateGridConfig(width, 1000, kind);
        expect(getGridClasses(columns), `${kind} at ${width} px`).toBe(`grid-cols-${columns}`);
      }
    }
  });

  it('uses seven poster columns at 1440 px', () => {
    expect(calculateGridConfig(1440, 900, 'poster').columns).toBe(7);
  });
  it('gives posters a 2:3 frame plus the meta line', () => {
    const c = calculateGridConfig(1440, 900, 'poster');
    const col = (1440 - 72 - 80 - 6 * 16) / 7;
    expect(c.cardHeight).toBe(Math.round(col * 1.5) + 28);
    expect(c.estimatedRowHeight).toBe(c.cardHeight + 16);
  });
  it('keeps live cards at a fixed height', () => {
    expect(calculateGridConfig(1440, 900, 'live').cardHeight).toBe(208);
    expect(calculateGridConfig(2560, 1440, 'live').cardHeight).toBe(208);
  });
  it('counts the rows it takes to cover the window', () => {
    // Live rows are 208 + 16 = 224 px: 1080 / 224 = 4.8
    expect(calculateGridConfig(1920, 1080, 'live').windowRows).toBe(5);
    expect(calculateGridConfig(1280, 800, 'live').windowRows).toBe(4);
    const poster = calculateGridConfig(1440, 900, 'poster');
    expect(poster.windowRows).toBe(Math.ceil(900 / poster.estimatedRowHeight));
  });
});

describe('useResponsiveGrid', () => {
  const initialWidth = window.innerWidth;
  afterEach(() => {
    window.innerWidth = initialWidth;
  });

  it("returns the new kind's columns in the same render the kind changes", () => {
    // Updating the config in an effect laid out one render of the new section
    // with the previous kind's columns, so every visible card mounted twice.
    window.innerWidth = 1920;
    const seen: Array<{ kind: GridKind; columns: number }> = [];
    const { rerender } = renderHook(
      ({ kind }: { kind: GridKind }) => {
        const config = useResponsiveGrid(kind);
        seen.push({ kind, columns: config.columns });
        return config;
      },
      { initialProps: { kind: 'live' as GridKind } }
    );

    rerender({ kind: 'poster' });

    const expected = calculateGridConfig(1920, window.innerHeight, 'poster').columns;
    for (const r of seen.filter((r) => r.kind === 'poster')) expect(r.columns).toBe(expected);
  });

  it('follows a window resize', async () => {
    window.innerWidth = 1920;
    const { result } = renderHook(() => useResponsiveGrid('live'));
    expect(result.current.columns).toBe(6);

    window.innerWidth = 1024;
    act(() => {
      window.dispatchEvent(new globalThis.Event('resize'));
    });

    await waitFor(() => expect(result.current.columns).toBe(4));
  });
});
