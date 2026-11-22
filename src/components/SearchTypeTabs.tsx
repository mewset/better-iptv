import { memo } from 'react';
import { cn } from '../lib/utils';

export type SearchType = 'vod' | 'series' | 'live';

/** Tab order and labels. */
export const SEARCH_TYPES: ReadonlyArray<{ type: SearchType; label: string }> = [
  { type: 'vod', label: 'Movies' },
  { type: 'series', label: 'Series' },
  { type: 'live', label: 'Live TV' },
];

interface SearchTypeTabsProps {
  counts: Record<SearchType, number>;
  active: SearchType;
  onSelect: (type: SearchType) => void;
}

/**
 * While searching, the results are split by type so each gets its own card:
 * posters for Movies and Series, channel cards for Live TV. Types without a
 * result are left out. No animation.
 */
export const SearchTypeTabs = memo(function SearchTypeTabs({
  counts,
  active,
  onSelect,
}: SearchTypeTabsProps) {
  return (
    <div
      role="group"
      aria-label="Result types"
      className="flex h-[54px] items-stretch gap-[26px] border-b border-border"
    >
      {SEARCH_TYPES.filter(({ type }) => counts[type] > 0).map(({ type, label }) => {
        const on = type === active;
        return (
          <button
            key={type}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(type)}
            className={cn(
              'flex shrink-0 items-center gap-2 whitespace-nowrap border-y-2 border-t-transparent text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
              on
                ? 'border-b-accent font-semibold text-text'
                : 'border-b-transparent font-medium text-text-muted hover:text-text'
            )}
          >
            {label}
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-semibold',
                on ? 'bg-accent text-on-accent' : 'bg-text/10 text-text-muted'
              )}
            >
              {counts[type].toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
});
