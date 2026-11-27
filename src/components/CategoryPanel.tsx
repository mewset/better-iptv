import { useMemo, useState } from 'react';
import { Check, Pin, Search, X } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import { useModalDialog } from '../hooks/useModalDialog';
import { foldSearchText } from '../lib/searchText';
import { cn } from '../lib/utils';
import { PIN_HOVER, PIN_ICON_PINNED, PIN_PINNED, PIN_REST } from './categoryPinStyle';

interface CategoryPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The provider's categories as a vertical list in a panel that slides over the
 * grid from the right, beside the Categories button in the Movies / Series bar: "All", the pinned ones, then the rest in provider order,
 * with a filter box. Picking one selects it and closes the panel; the pin on
 * each row pins or unpins it without closing. Shown and hidden at once, no
 * slide animation (see the DMA-BUF stale-frame note in ChannelCard).
 */
export function CategoryPanel({ open, onClose }: CategoryPanelProps) {
  const categories = usePlayerStore((s) => s.categories);
  const pinned = usePlayerStore((s) => s.pinnedCategories);
  const selected = usePlayerStore((s) => s.categoryFilter);
  const setCategoryFilter = usePlayerStore((s) => s.setCategoryFilter);
  const toggleCategoryPin = usePlayerStore((s) => s.toggleCategoryPin);
  const [query, setQuery] = useState('');
  const { dialogProps, titleId } = useModalDialog({ isOpen: open, onCancel: onClose });

  const folded = foldSearchText(query);
  const match = useMemo(
    () => (name: string) => folded === '' || foldSearchText(name).includes(folded),
    [folded]
  );
  const pinnedShown = pinned.filter(match);
  const othersShown = (categories ?? []).filter(match);

  if (!open) return null;

  const pick = (category: string | null) => {
    setCategoryFilter(category);
    setQuery('');
    onClose();
  };

  const row = (category: string, isPinned: boolean) => {
    const isSelected = selected === category;
    return (
      <li key={category} className="group/row flex items-center rounded-lg hover:bg-surface-hover">
        <button
          type="button"
          onClick={() => pick(category)}
          aria-current={isSelected ? 'true' : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            isSelected ? 'font-semibold text-text' : 'text-text-muted hover:text-text'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{category}</span>
          {isSelected && <Check className="h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => void toggleCategoryPin(category)}
          aria-pressed={isPinned}
          aria-label={isPinned ? `Unpin ${category}` : `Pin ${category}`}
          className={cn(
            'mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            isPinned ? PIN_PINNED : `${PIN_REST} ${PIN_HOVER}`
          )}
        >
          <Pin className={cn('h-3.5 w-3.5', isPinned && PIN_ICON_PINNED)} aria-hidden="true" />
        </button>
      </li>
    );
  };

  return (
    <div className="fixed inset-0 z-50">
      {/* A press on the dimmed grid closes the panel */}
      <div aria-hidden="true" className="absolute inset-0 bg-bg/60" onMouseDown={onClose} />
      <div
        {...dialogProps}
        className="absolute inset-y-0 right-0 flex w-[340px] max-w-[90vw] flex-col border-l border-border bg-surface shadow-2xl focus:outline-none"
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <h2 id={titleId} className="font-display text-lg font-semibold text-text">
            Categories
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close categories"
            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-text/10 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <label className="mx-5 mb-3 flex h-10 items-center gap-2 rounded-xl border border-border bg-text/5 px-3 focus-within:ring-2 focus-within:ring-accent">
          <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
          <span className="sr-only">Filter categories</span>
          <input
            // The filter box is what the panel opens for
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter categories"
            className="min-w-0 flex-1 appearance-none bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
        </label>

        <nav aria-label="Categories" className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
          {folded === '' && (
            <button
              type="button"
              onClick={() => pick(null)}
              aria-current={selected === null ? 'true' : undefined}
              className={cn(
                'mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                selected === null ? 'font-semibold text-text' : 'text-text-muted hover:text-text'
              )}
            >
              <span className="flex-1">All categories</span>
              {selected === null && (
                <Check className="h-4 w-4 text-accent-text" aria-hidden="true" />
              )}
            </button>
          )}

          {pinnedShown.length > 0 && (
            <>
              <h3 className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                Pinned
              </h3>
              <ul>{pinnedShown.map((c) => row(c, true))}</ul>
            </>
          )}

          {othersShown.length > 0 && (
            <>
              <h3 className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                {pinnedShown.length > 0 ? 'More categories' : 'Categories'}
              </h3>
              <ul>{othersShown.map((c) => row(c, false))}</ul>
            </>
          )}

          {categories === null && <p className="px-3 py-4 text-sm text-text-muted">Loading…</p>}
          {categories !== null && pinnedShown.length === 0 && othersShown.length === 0 && (
            <p className="px-3 py-4 text-sm text-text-muted">No category matches “{query}”.</p>
          )}
        </nav>
      </div>
    </div>
  );
}
