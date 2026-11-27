import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpDown, Check, ChevronDown } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import { TITLE_SORTS, type SortableSection, type TitleSort } from '../lib/titleSort';
import { cn } from '../lib/utils';
import { BAR_CONTROL } from './barControl';

interface TitleSortMenuProps {
  section: SortableSection;
}

/**
 * The order of the Movies or Series grid: a chip that names the current
 * order and opens a small menu of the others. Built like the profile
 * switcher in TopBar (same panel, rows and keys): Escape or a press outside
 * closes it, the arrows, Home and End move between the options, and it
 * opens on the current one.
 */
export const TitleSortMenu = memo(function TitleSortMenu({ section }: TitleSortMenuProps) {
  const sort = usePlayerStore((s) => s.titleSorts[section]);
  const setTitleSort = usePlayerStore((s) => s.setTitleSort);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<globalThis.HTMLDivElement>(null);
  const triggerRef = useRef<globalThis.HTMLButtonElement>(null);
  const menuRef = useRef<globalThis.HTMLDivElement>(null);

  const current = TITLE_SORTS.find((s) => s.value === sort) ?? TITLE_SORTS[0];

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Outside press closes; Escape closes without reaching the global
  // shortcuts (capture phase, as in TopBar), which would stop playback.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: globalThis.MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as globalThis.Node)) close(false);
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close(true);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  // Focus the current option when the menu opens
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<globalThis.HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent<globalThis.HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<globalThis.HTMLButtonElement>('[role="menuitemradio"]') ??
        []
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as globalThis.HTMLButtonElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    if (e.key === 'End') next = items.length - 1;
    items[next].focus();
  };

  const choose = (value: TitleSort) => {
    setTitleSort(section, value);
    close(true);
  };

  // Leaving the menu with Tab closes it
  const onBlur = (e: React.FocusEvent<globalThis.HTMLDivElement>) => {
    if (open && !wrapRef.current?.contains(e.relatedTarget as globalThis.Node | null)) {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} onBlur={onBlur} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sort ${section === 'vod' ? 'movies' : 'series'}: ${current.label}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(BAR_CONTROL, open && 'border-text')}
      >
        <ArrowUpDown className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
        <span className="whitespace-nowrap">{current.label}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-text-muted', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Sort by"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-20 mt-2 min-w-48 rounded-xl border border-border bg-surface-2 p-1 shadow-xl"
        >
          <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
            Sort by
          </p>
          {TITLE_SORTS.map((option) => {
            const checked = option.value === sort;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => choose(option.value)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="flex-1 truncate">{option.label}</span>
                {checked && <Check className="h-4 w-4 text-accent-text" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
