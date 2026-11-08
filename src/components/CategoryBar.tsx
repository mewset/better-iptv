import { memo } from 'react';
import { Pin } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import { cn } from '../lib/utils';
import {
  PIN_HOVER,
  PIN_HOVER_ON_SELECTED,
  PIN_PINNED,
  PIN_PINNED_ON_SELECTED,
  PIN_REST,
  PIN_REST_ON_SELECTED,
} from './categoryPinStyle';

interface CategoryBarProps {
  /** Overrides whether "All" reads as selected (the guide's Favorites chip also narrows the list). */
  allSelected?: boolean;
  /** Called after "All" clears the category, so a caller can clear its own narrowing too. */
  onAll?: () => void;
}

// The loading strip is built from these too, so it is exactly as tall as the row of chips.
// overflow-x-scroll, not auto: the scrollbar gutter is there from the first layout. With auto it
// appears once the chips overflow, and WebKitGTK does not grow the parent for it, so the channel
// list below covers the scrollbar and the thumb cannot be grabbed.
const ROW = 'flex gap-2 overflow-x-scroll bg-bg px-4 py-3 pb-6';
const CHIP_HEIGHT = 'h-[34px]';

const CHIP_BASE = `inline-flex ${CHIP_HEIGHT} shrink-0 items-center rounded-full border text-[13px] transition-colors`;
const CHIP_ACTIVE = 'border-text bg-text font-semibold text-bg';
const CHIP_IDLE = 'border-border bg-text/5 font-medium text-text-muted hover:bg-text/10';
const FOCUS =
  'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg';

/**
 * Horizontal scrollable bar showing provider categories (Sweden, Norway, F1, etc.)
 * Allows quick filtering of channels by category. Pinned categories come first, after
 * "All", set apart from the rest by a divider; the pin on each chip pins or unpins it.
 */
export const CategoryBar = memo(function CategoryBar({ allSelected, onAll }: CategoryBarProps) {
  const categories = usePlayerStore((s) => s.categories);
  const pinnedCategories = usePlayerStore((s) => s.pinnedCategories);
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);
  const setCategoryFilter = usePlayerStore((s) => s.setCategoryFilter);
  const toggleCategoryPin = usePlayerStore((s) => s.toggleCategoryPin);

  // Still loading: hold the row's height so the list below does not move when the chips arrive
  if (categories === null) {
    return (
      <div className={ROW}>
        <div aria-hidden="true" className={CHIP_HEIGHT} />
      </div>
    );
  }
  // This section has no categories
  if (categories.length === 0 && pinnedCategories.length === 0) return null;

  const allActive = allSelected ?? categoryFilter === null;

  const chip = (category: string, pinned: boolean) => {
    const selected = categoryFilter === category;
    const pinColour = pinned
      ? selected
        ? PIN_PINNED_ON_SELECTED
        : PIN_PINNED
      : selected
        ? `${PIN_REST_ON_SELECTED} ${PIN_HOVER_ON_SELECTED}`
        : `${PIN_REST} ${PIN_HOVER}`;
    return (
      <div key={category} className={cn(CHIP_BASE, selected ? CHIP_ACTIVE : CHIP_IDLE)}>
        <button
          type="button"
          onClick={() => setCategoryFilter(category)}
          aria-pressed={selected}
          className={cn('h-full whitespace-nowrap rounded-full pl-3.5 pr-1', FOCUS)}
        >
          {category}
        </button>
        <button
          type="button"
          onClick={() => void toggleCategoryPin(category)}
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${category}` : `Pin ${category}`}
          className={cn(
            'mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
            FOCUS,
            pinColour
          )}
        >
          <Pin className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  };

  return (
    <div className={ROW} role="group" aria-label="Channel categories">
      {/* "All" chip - shows all channels in current content type */}
      <button
        type="button"
        onClick={() => {
          setCategoryFilter(null);
          onAll?.();
        }}
        aria-pressed={allActive}
        className={cn(
          CHIP_BASE,
          'justify-center px-3.5',
          FOCUS,
          allActive ? CHIP_ACTIVE : CHIP_IDLE
        )}
      >
        All
      </button>

      {pinnedCategories.map((category) => chip(category, true))}
      {pinnedCategories.length > 0 && categories.length > 0 && (
        <div
          aria-hidden="true"
          className="mx-1 h-[22px] w-px shrink-0 self-center bg-border-strong"
        />
      )}
      {categories.map((category) => chip(category, false))}
    </div>
  );
});
