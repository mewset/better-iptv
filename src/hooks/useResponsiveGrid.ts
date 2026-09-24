import { useState, useEffect, useCallback } from 'react';

interface GridConfig {
  columns: number;
  cardHeight: number;
  estimatedRowHeight: number;
  gap: number;
}

interface BreakpointConfig {
  minWidth: number;
  columns: number;
  minCardHeight: number;
  maxCardHeight: number;
}

// Breakpoint configuration - easily adjustable
const BREAKPOINTS: BreakpointConfig[] = [
  { minWidth: 0, columns: 2, minCardHeight: 200, maxCardHeight: 240 },
  { minWidth: 640, columns: 3, minCardHeight: 220, maxCardHeight: 260 },
  { minWidth: 1024, columns: 4, minCardHeight: 240, maxCardHeight: 300 },
  { minWidth: 1440, columns: 5, minCardHeight: 260, maxCardHeight: 320 },
  { minWidth: 1920, columns: 6, minCardHeight: 280, maxCardHeight: 360 },
  { minWidth: 2560, columns: 7, minCardHeight: 300, maxCardHeight: 400 },
];

const GAP = 16; // Tailwind gap-4
// Live cards have a fixed 208px shape (124px logo area + a fixed info block),
// so the grid no longer solves for an ideal card height per viewport - it
// only picks a column count per breakpoint.
// (Task 11 replaces this with calculateGridConfig(width, height, kind), which
// needs a per-item-kind height again; the BREAKPOINTS' min/maxCardHeight are
// kept for that.)
const LIVE_CARD_HEIGHT = 208;

function getBreakpointConfig(width: number): BreakpointConfig {
  // Find the highest matching breakpoint
  let config = BREAKPOINTS[0];
  for (const bp of BREAKPOINTS) {
    if (width >= bp.minWidth) {
      config = bp;
    }
  }
  return config;
}

function calculateGridConfig(viewportWidth: number): GridConfig {
  const breakpoint = getBreakpointConfig(viewportWidth);

  // Row height includes gap for virtualizer
  const estimatedRowHeight = LIVE_CARD_HEIGHT + GAP;

  return {
    columns: breakpoint.columns,
    cardHeight: LIVE_CARD_HEIGHT,
    estimatedRowHeight,
    gap: GAP,
  };
}

export function useResponsiveGrid(): GridConfig {
  const [gridConfig, setGridConfig] = useState<GridConfig>(() => {
    // Initial calculation based on window size (or defaults for SSR)
    if (typeof window !== 'undefined') {
      return calculateGridConfig(window.innerWidth);
    }
    return {
      columns: 4,
      cardHeight: LIVE_CARD_HEIGHT,
      estimatedRowHeight: LIVE_CARD_HEIGHT + GAP,
      gap: GAP,
    };
  });

  const handleResize = useCallback(() => {
    const newConfig = calculateGridConfig(window.innerWidth);
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
  }, []);

  useEffect(() => {
    // Initial calculation
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
