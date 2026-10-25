import { memo } from 'react';
import { usePlayerStore } from '../stores/player-store';

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

/**
 * Horizontal scrollable bar showing provider categories (Sweden, Norway, F1, etc.)
 * Allows quick filtering of channels by category.
 */
export const CategoryBar = memo(function CategoryBar({ allSelected, onAll }: CategoryBarProps) {
  const categories = usePlayerStore((s) => s.categories);
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);
  const setCategoryFilter = usePlayerStore((s) => s.setCategoryFilter);

  // Still loading: hold the row's height so the list below does not move when the chips arrive
  if (categories === null) {
    return (
      <div className={ROW}>
        <div aria-hidden="true" className={CHIP_HEIGHT} />
      </div>
    );
  }
  // This section has no categories
  if (categories.length === 0) return null;

  const allActive = allSelected ?? categoryFilter === null;

  return (
    <div className={ROW} role="tablist" aria-label="Channel categories">
      {/* "All" chip - shows all channels in current content type */}
      <button
        onClick={() => {
          setCategoryFilter(null);
          onAll?.();
        }}
        role="tab"
        aria-selected={allActive}
        className={`inline-flex ${CHIP_HEIGHT} shrink-0 items-center justify-center rounded-full border px-3.5 text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg ${
          allActive
            ? 'border-text bg-text font-semibold text-bg'
            : 'border-border bg-text/5 font-medium text-text-muted hover:bg-text/10'
        } `}
      >
        All
      </button>

      {/* Category chips from provider */}
      {categories.map((category) => (
        <button
          key={category}
          onClick={() => setCategoryFilter(category)}
          role="tab"
          aria-selected={categoryFilter === category}
          className={`inline-flex ${CHIP_HEIGHT} shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-3.5 text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg ${
            categoryFilter === category
              ? 'border-text bg-text font-semibold text-bg'
              : 'border-border bg-text/5 font-medium text-text-muted hover:bg-text/10'
          } `}
        >
          {category}
        </button>
      ))}
    </div>
  );
});
