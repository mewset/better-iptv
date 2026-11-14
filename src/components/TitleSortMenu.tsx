import { memo } from 'react';
import { ArrowUpDown, ChevronDown } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import { isTitleSort, TITLE_SORTS, type SortableSection } from '../lib/titleSort';
import { cn } from '../lib/utils';

interface TitleSortMenuProps {
  section: SortableSection;
}

/**
 * The order of the Movies or Series grid. A native select, so the keyboard,
 * screen readers and the popup come from the platform; styled as one of the
 * category chips it sits beside.
 */
export const TitleSortMenu = memo(function TitleSortMenu({ section }: TitleSortMenuProps) {
  const sort = usePlayerStore((s) => s.titleSorts[section]);
  const setTitleSort = usePlayerStore((s) => s.setTitleSort);

  return (
    <div
      className={cn(
        'relative inline-flex h-[34px] shrink-0 items-center rounded-full border text-[13px]',
        'border-border bg-text/5 font-medium text-text-muted transition-colors hover:bg-text/10',
        'focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:ring-offset-bg'
      )}
    >
      <ArrowUpDown className="pointer-events-none absolute left-3 h-3.5 w-3.5" aria-hidden="true" />
      <select
        aria-label={section === 'vod' ? 'Sort movies' : 'Sort series'}
        value={sort}
        onChange={(e) => {
          if (isTitleSort(e.target.value)) setTitleSort(section, e.target.value);
        }}
        className="h-full cursor-pointer appearance-none rounded-full bg-transparent pl-8 pr-8 focus:outline-none"
      >
        {TITLE_SORTS.map((option) => (
          <option key={option.value} value={option.value} className="bg-bg text-text">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 h-3.5 w-3.5"
        aria-hidden="true"
      />
    </div>
  );
});
