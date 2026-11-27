import { useState, useEffect, useMemo } from 'react';

export interface GridConfig {
  columns: number;
  cardHeight: number;
  estimatedRowHeight: number;
  gap: number;
  /** Rows it takes to cover the window's height: enough to fill the visible grid */
  windowRows: number;
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
  // Ultrawide: without these a 3840 px window kept seven columns of cards
  // over 500 px wide. The card stays about as wide as it is at 2560 (330 px).
  { minWidth: 3200, columns: 9 },
  { minWidth: 3840, columns: 11 },
];

const POSTER_BREAKPOINTS: Breakpoint[] = [
  { minWidth: 0, columns: 1 },
  { minWidth: 560, columns: 2 },
  { minWidth: 640, columns: 3 },
  { minWidth: 1024, columns: 4 },
  { minWidth: 1280, columns: 6 },
  { minWidth: 1440, columns: 7 },
  { minWidth: 1920, columns: 8 },
  // Ultrawide: eight columns at 3840 px made each poster 447 px wide, with
  // one row and a bit in view. The poster stays about as wide as it is at
  // 2560 (287 px).
  { minWidth: 3200, columns: 10 },
  { minWidth: 3840, columns: 12 },
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
export function calculateGridConfig(width: number, height: number, kind: GridKind): GridConfig {
  if (kind === 'live') {
    const columns = getColumns(LIVE_BREAKPOINTS, width);
    return {
      columns,
      cardHeight: LIVE_CARD_HEIGHT,
      estimatedRowHeight: LIVE_CARD_HEIGHT + GAP,
      gap: GAP,
      windowRows: Math.ceil(height / (LIVE_CARD_HEIGHT + GAP)),
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
    windowRows: Math.ceil(height / (cardHeight + GAP)),
  };
}

/**
 * `reserved`: width beside the grid taken by something else (a category
 * sidebar), so the columns fit what is left.
 */
export function useResponsiveGrid(kind: GridKind = 'live', reserved = 0): GridConfig {
  // Only the viewport lives in state; the config is derived during render.
  // Updating the config in an effect laid out one render of a new section
  // with the previous kind's columns, which mounted every visible card twice.
  const [size, setSize] = useState(() =>
    typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1024, height: 768 }
  );

  useEffect(() => {
    // Debounced resize handler
    let timeoutId: ReturnType<typeof setTimeout>;
    const debouncedResize = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setSize((prev) =>
          prev.width === window.innerWidth && prev.height === window.innerHeight
            ? prev
            : { width: window.innerWidth, height: window.innerHeight }
        );
      }, 100);
    };

    window.addEventListener('resize', debouncedResize);
    return () => {
      window.removeEventListener('resize', debouncedResize);
      clearTimeout(timeoutId);
    };
  }, []);

  return useMemo(
    () => calculateGridConfig(size.width - reserved, size.height, kind),
    [size, kind, reserved]
  );
}

// Utility to generate Tailwind grid classes based on columns. Spelled out so
// Tailwind finds each class; a column count missing here falls back to four
// columns, which is how a new breakpoint can lay out wrong without a test.
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
    9: 'grid-cols-9',
    10: 'grid-cols-10',
    11: 'grid-cols-11',
    12: 'grid-cols-12',
  };
  return gridColsMap[columns] || 'grid-cols-4';
}
