import { ListFilter, PanelLeft, X } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import { cn } from '../lib/utils';
import { BAR_CONTROL } from './barControl';

/**
 * The bar's control for the category sidebar (Guide, Live TV). While the
 * sidebar is hidden and a category narrows the list, that must still be
 * plain: the button carries an amber dot, and a "Category: …" pill beside it
 * opens the sidebar on a click, with an × that clears the category.
 */
export function CategorySidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const category = usePlayerStore((s) => s.categoryFilter);
  const setCategoryFilter = usePlayerStore((s) => s.setCategoryFilter);
  const hiddenFilter = !open && category !== null;

  return (
    <>
      <button
        type="button"
        aria-pressed={open}
        aria-label={open ? 'Hide categories' : 'Show categories'}
        title={`${open ? 'Hide' : 'Show'} categories ([)`}
        onClick={onToggle}
        className={cn(BAR_CONTROL, 'relative px-2', open && 'border-accent bg-surface-hover')}
      >
        <PanelLeft className="h-4 w-4" aria-hidden="true" />
        {hiddenFilter && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-bg bg-accent"
          />
        )}
      </button>
      {hiddenFilter && (
        <span className="inline-flex h-[34px] min-w-0 max-w-[320px] shrink-0 items-center rounded-[9px] border border-accent bg-accent/10 text-[13px]">
          <button
            type="button"
            onClick={onToggle}
            title="Show categories"
            className="flex h-full min-w-0 items-center gap-2 rounded-l-[9px] pl-3 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <ListFilter className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
            <span className="shrink-0 text-text-muted">Category:</span>
            <span className="min-w-0 truncate font-semibold text-text">{category}</span>
          </button>
          <button
            type="button"
            aria-label={`Clear the category ${category}`}
            onClick={() => setCategoryFilter(null)}
            className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-text/10 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </span>
      )}
    </>
  );
}
