import { memo } from 'react';
import { usePlayerStore } from '../stores/player-store';

interface CategoryBarProps {
  /** Overrides whether "All" reads as selected (the guide's Favorites chip also narrows the list). */
  allSelected?: boolean;
  /** Called after "All" clears the category, so a caller can clear its own narrowing too. */
  onAll?: () => void;
}

/**
 * Horizontal scrollable bar showing provider categories (Sweden, Norway, F1, etc.)
 * Allows quick filtering of channels by category.
 */
export const CategoryBar = memo(function CategoryBar({ allSelected, onAll }: CategoryBarProps) {
  const categories = usePlayerStore((s) => s.categories);
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);
  const setCategoryFilter = usePlayerStore((s) => s.setCategoryFilter);

  // Don't render if no categories available
  if (categories.length === 0) return null;

  const allActive = allSelected ?? categoryFilter === null;

  return (
    <div
      className="scrollbar-hide flex gap-2 overflow-x-auto bg-bg px-4 py-3 pb-6"
      role="tablist"
      aria-label="Channel categories"
    >
      {/* "All" chip - shows all channels in current content type */}
      <button
        onClick={() => {
          setCategoryFilter(null);
          onAll?.();
        }}
        role="tab"
        aria-selected={allActive}
        className={`inline-flex h-[34px] shrink-0 items-center justify-center rounded-full border px-3.5 text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg ${
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
          className={`inline-flex h-[34px] shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-3.5 text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg ${
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
