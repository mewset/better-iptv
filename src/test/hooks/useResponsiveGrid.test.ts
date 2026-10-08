import { afterEach, describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  calculateGridConfig,
  useResponsiveGrid,
  type GridKind,
} from '../../hooks/useResponsiveGrid';

describe('calculateGridConfig', () => {
  it('uses one column below 560 px for both kinds', () => {
    expect(calculateGridConfig(500, 900, 'live').columns).toBe(1);
    expect(calculateGridConfig(500, 900, 'poster').columns).toBe(1);
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
