import { useState, useEffect, useCallback } from 'react';

export interface GridConfig {
  columns: number;
  cardHeight: number;
  estimatedRowHeight: number;
  gap: number;
}

export type GridKind = 'live' | 'poster';

const GAP = 16; // Tailwind gap-4
// Live cards have a fixed 208px shape (124px logo area + a fixed info block),
// so the grid only picks a column count per breakpoint for them.
const LIVE_CARD_HEIGHT = 208;

// The content area is the window width minus the 72px rail and 80px
// horizontal padding (rail/padding land in a later task; posters compute
// against window.innerWidth today, same as the live grid always has).
const RAIL_AND_PADDING = 72 + 80;

interface Breakpoint {
  minWidth: number;
  columns: number;
}

// Live grid gains the same 0 -> 1 column row below 560px as posters (design
// doc open question 2); every other live breakpoint is unchanged.
const LIVE_BREAKPOINTS: Breakpoint[] = [
  { minWidth: 0, columns: 1 },
  { minWidth: 560, columns: 2 },
  { minWidth: 640, columns: 3 },
  { minWidth: 1024, columns: 4 },
  { minWidth: 1440, columns: 5 },
  { minWidth: 1920, columns: 6 },
  { minWidth: 2560, columns: 7 },
];

const POSTER_BREAKPOINTS: Breakpoint[] = [
  { minWidth: 0, columns: 1 },
  { minWidth: 560, columns: 2 },
  { minWidth: 640, columns: 3 },
  { minWidth: 1024, columns: 4 },
  { minWidth: 1280, columns: 6 },
  { minWidth: 1440, columns: 7 },
  { minWidth: 1920, columns: 8 },
];

function getColumns(breakpoints: Breakpoint[], width: number): number {
  let columns = breakpoints[0].columns;
  for (const bp of breakpoints) {
    if (width >= bp.minWidth) {
      columns = bp.columns;
    }
  }
  return columns;
}

/**
 * Pure grid math for a given viewport size and item kind. No `window` access
 * inside: callers pass the viewport dimensions in, so this is testable
 * without a DOM.
 */
export function calculateGridConfig(width: number, _height: number, kind: GridKind): GridConfig {
  if (kind === 'live') {
    const columns = getColumns(LIVE_BREAKPOINTS, width);
    return {
      columns,
      cardHeight: LIVE_CARD_HEIGHT,
      estimatedRowHeight: LIVE_CARD_HEIGHT + GAP,
      gap: GAP,
    };
  }

  const columns = getColumns(POSTER_BREAKPOINTS, width);
  const columnWidth = (width - RAIL_AND_PADDING - (columns - 1) * GAP) / columns;
  // 2:3 poster frame plus the 28px meta line underneath it.
  const cardHeight = Math.round(columnWidth * 1.5) + 28;

  return {
    columns,
    cardHeight,
    estimatedRowHeight: cardHeight + GAP,
    gap: GAP,
  };
}

export function useResponsiveGrid(kind: GridKind = 'live'): GridConfig {
  const [gridConfig, setGridConfig] = useState<GridConfig>(() => {
    // Initial calculation based on window size (or defaults for SSR)
    if (typeof window !== 'undefined') {
      return calculateGridConfig(window.innerWidth, window.innerHeight, kind);
    }
    return {
      columns: 4,
      cardHeight: LIVE_CARD_HEIGHT,
      estimatedRowHeight: LIVE_CARD_HEIGHT + GAP,
      gap: GAP,
    };
  });

  const handleResize = useCallback(() => {
    const newConfig = calculateGridConfig(window.innerWidth, window.innerHeight, kind);
    setGridConfig((prev) => {
      // Only update if values changed to prevent unnecessary re-renders
      if (
        prev.columns !== newConfig.columns ||
        prev.cardHeight !== newConfig.cardHeight ||
        prev.estimatedRowHeight !== newConfig.estimatedRowHeight
      ) {
        return newConfig;
      }
      return prev;
    });
  }, [kind]);

  useEffect(() => {
    // Initial calculation (also re-runs when `kind` changes)
    handleResize();

    // Debounced resize handler
    let timeoutId: ReturnType<typeof setTimeout>;
    const debouncedResize = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(handleResize, 100);
    };

    window.addEventListener('resize', debouncedResize);
    return () => {
      window.removeEventListener('resize', debouncedResize);
      clearTimeout(timeoutId);
    };
  }, [handleResize]);

  return gridConfig;
}

// Utility to generate Tailwind grid classes based on columns
export function getGridClasses(columns: number): string {
  const gridColsMap: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    5: 'grid-cols-5',
    6: 'grid-cols-6',
    7: 'grid-cols-7',
    8: 'grid-cols-8',
  };
  return gridColsMap[columns] || 'grid-cols-4';
}
