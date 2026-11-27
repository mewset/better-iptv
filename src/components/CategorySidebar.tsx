import { memo, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, LayoutGrid, Pin, Search, X } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import type { Channel } from '../types';
import { foldSearchText } from '../lib/searchText';
import { groupCategories, type CategoryEntry } from '../lib/categoryGroups';
import { cn } from '../lib/utils';
import { PIN_HOVER, PIN_ICON_PINNED, PIN_PINNED, PIN_REST } from './categoryPinStyle';

interface CategorySidebarProps {
  /** The section's whole list, for the counts (not the filtered one). */
  channels: Channel[];
  /** The "All" row's label ("All channels"). */
  allLabel: string;
}

/**
 * The provider's categories as a column beside the content, like a file
 * browser: a filter, "All", the pinned categories, then the rest folded into
 * groups that open and close (`groupCategories`: countries, year families,
 * shared notes and words), each with its count. The selected one carries the
 * rail's amber mark. The filter box has no shortcut of its own: "/" stays the
 * top bar's search.
 *
 * Nothing animates (see the DMA-BUF stale-frame note in ChannelCard).
 */
export const CategorySidebar = memo(function CategorySidebar({
  channels,
  allLabel,
}: CategorySidebarProps) {
  const others = usePlayerStore((s) => s.categories);
  const pinned = usePlayerStore((s) => s.pinnedCategories);
  const selected = usePlayerStore((s) => s.categoryFilter);
  const setCategoryFilter = usePlayerStore((s) => s.setCategoryFilter);
  const toggleCategoryPin = usePlayerStore((s) => s.toggleCategoryPin);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of channels) {
      if (c.group_name) map.set(c.group_name, (map.get(c.group_name) ?? 0) + 1);
    }
    return map;
  }, [channels]);
  const tree = useMemo(() => groupCategories(others ?? []), [others]);

  // The selected category's group opens, so the mark is never hidden in a folder
  useEffect(() => {
    if (!selected) return;
    const group = tree.find(
      (n) => n.kind === 'group' && n.members.some((m) => m.name === selected)
    );
    if (group && group.kind === 'group' && !open.has(group.key)) {
      setOpen((prev) => new Set(prev).add(group.key));
    }
  }, [selected, tree, open]);

  const folded = foldSearchText(query.trim());
  const matches = useMemo(() => {
    if (folded === '') return null;
    return [...pinned, ...(others ?? [])].filter((name) => foldSearchText(name).includes(folded));
  }, [folded, pinned, others]);

  const toggleGroup = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const row = (entry: CategoryEntry, opts: { child?: boolean; isPinned?: boolean } = {}) => {
    const isSelected = selected === entry.name;
    const isPinned = opts.isPinned ?? pinned.includes(entry.name);
    return (
      <li key={entry.name} className="group/row relative">
        {isSelected && (
          <span
            aria-hidden="true"
            className="absolute -left-3 bottom-[7px] top-[7px] w-[3px] rounded-r bg-accent"
          />
        )}
        <div
          className={cn(
            'flex h-8 items-center gap-2 rounded-lg pr-1.5 text-[13.5px]',
            opts.child ? 'pl-[30px]' : 'pl-2.5',
            isSelected
              ? 'bg-text/5 font-semibold text-text'
              : 'text-text-muted hover:bg-surface-hover hover:text-text'
          )}
        >
          <button
            type="button"
            aria-current={isSelected ? 'true' : undefined}
            title={entry.name}
            onClick={() => setCategoryFilter(entry.name)}
            className="flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          >
            {opts.isPinned && (
              <Pin
                className={cn('h-3.5 w-3.5 shrink-0', PIN_PINNED, PIN_ICON_PINNED)}
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            <span className="shrink-0 text-xs tabular-nums text-text-faint group-hover/row:hidden">
              {counts.get(entry.name) ?? ''}
            </span>
          </button>
          <button
            type="button"
            aria-label={isPinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
            aria-pressed={isPinned}
            onClick={() => void toggleCategoryPin(entry.name)}
            className={cn(
              'hidden h-6 w-6 shrink-0 items-center justify-center rounded-full focus-visible:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover/row:flex',
              isPinned ? PIN_PINNED : cn(PIN_REST, PIN_HOVER)
            )}
          >
            <Pin className={cn('h-3.5 w-3.5', isPinned && PIN_ICON_PINNED)} aria-hidden="true" />
          </button>
        </div>
      </li>
    );
  };

  const heading = (text: string) => (
    <li className="px-2.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-text-muted">
      {text}
    </li>
  );

  return (
    <nav
      aria-label="Categories"
      className="flex w-[272px] shrink-0 flex-col border-r border-border bg-bg py-3.5 pl-10 pr-3"
    >
      <label className="mb-2.5 flex h-9 shrink-0 items-center gap-2 rounded-[10px] border border-border bg-text/5 px-3 focus-within:ring-2 focus-within:ring-accent">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        <span className="sr-only">Filter categories</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Escape empties the filter here, and goes no further (the
            // global Escape would leave the section)
            if (e.key === 'Escape' && query !== '') {
              e.preventDefault();
              e.stopPropagation();
              setQuery('');
            }
          }}
          placeholder="Filter categories"
          className="min-w-0 flex-1 appearance-none bg-transparent text-[13.5px] text-text placeholder:text-text-muted focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear the filter"
            onClick={() => setQuery('')}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-text/10 hover:text-text"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </label>

      <ul className="-mr-3 min-h-0 flex-1 overflow-y-auto pr-3 [scrollbar-width:thin]">
        <li className="group/row relative">
          {selected === null && (
            <span
              aria-hidden="true"
              className="absolute -left-3 bottom-[7px] top-[7px] w-[3px] rounded-r bg-accent"
            />
          )}
          <button
            type="button"
            aria-current={selected === null ? 'true' : undefined}
            onClick={() => setCategoryFilter(null)}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
              selected === null
                ? 'bg-text/5 font-semibold text-text'
                : 'text-text-muted hover:bg-surface-hover hover:text-text'
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{allLabel}</span>
            <span className="shrink-0 text-xs tabular-nums text-text-faint">{channels.length}</span>
          </button>
        </li>

        {matches !== null ? (
          <>
            {heading(`${matches.length} matching`)}
            {matches.map((name) => row({ name, label: name }))}
          </>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                {heading('Pinned')}
                {pinned.map((name) => row({ name, label: name }, { isPinned: true }))}
              </>
            )}
            {heading('All categories')}
            {tree.map((node) => {
              if (node.kind === 'category') return row(node.entry);
              const isOpen = open.has(node.key);
              const total = node.members.reduce((n, m) => n + (counts.get(m.name) ?? 0), 0);
              return (
                <li key={node.key}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggleGroup(node.key)}
                    className="flex h-8 w-full items-center gap-2 rounded-lg pl-1 pr-1.5 text-left text-[13.5px] font-medium text-text hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                  >
                    {isOpen ? (
                      <ChevronDown
                        className="h-3.5 w-3.5 shrink-0 text-text-faint"
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronRight
                        className="h-3.5 w-3.5 shrink-0 text-text-faint"
                        aria-hidden="true"
                      />
                    )}
                    {node.badge && (
                      <span className="inline-flex h-[18px] min-w-[26px] shrink-0 items-center justify-center rounded-[5px] border border-border-strong bg-surface-2 px-1 text-[10.5px] font-bold tracking-[0.04em] text-text-muted">
                        {node.badge}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{node.label}</span>
                    <span className="shrink-0 text-xs tabular-nums text-text-faint">{total}</span>
                  </button>
                  {isOpen && <ul>{node.members.map((m) => row(m, { child: true }))}</ul>}
                </li>
              );
            })}
          </>
        )}
      </ul>
    </nav>
  );
});
