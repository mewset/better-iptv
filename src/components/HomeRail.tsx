import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';

interface HomeRailProps<T> {
  title: string;
  /** A short line beside the title: where the row comes from. */
  subtitle?: string;
  items: T[];
  itemKey: (item: T) => string | number;
  renderItem: (item: T) => ReactNode;
  /** The width of one item, in px; the row fits as many as the window allows. */
  itemWidth: number;
  /** Shows a "See all" link that opens the full list behind the row. */
  onSeeAll?: () => void;
}

/**
 * One Home row: a title, then items side by side in a strip that scrolls
 * sideways. No scrollbar; ‹ › buttons appear where there is more (a
 * touchpad or tilt wheel scrolls it too). The vertical wheel is left to the
 * page, so scrolling Home never gets caught by a row. Scrolling jumps rather than glides
 * and nothing fades (see the DMA-BUF stale-frame note in ChannelCard).
 */
export function HomeRail<T>({
  title,
  subtitle,
  items,
  itemKey,
  renderItem,
  itemWidth,
  onSeeAll,
}: HomeRailProps<T>) {
  const stripRef = useRef<globalThis.HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    measure();
    const observer = new globalThis.ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, items.length]);

  const scroll = (direction: 1 | -1) => {
    const el = stripRef.current;
    if (el) el.scrollLeft += direction * Math.max(itemWidth, el.clientWidth - itemWidth);
  };

  if (items.length === 0) return null;

  const arrow = (direction: 1 | -1, enabled: boolean) => (
    <button
      type="button"
      onClick={() => scroll(direction)}
      disabled={!enabled}
      aria-label={`${direction < 0 ? 'Scroll left' : 'Scroll right'} in ${title}`}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full border border-border-strong bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        enabled ? 'text-text hover:bg-surface-hover' : 'cursor-default text-text-faint opacity-50'
      )}
    >
      {direction < 0 ? (
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      ) : (
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="font-display text-xl font-semibold text-text">{title}</h2>
        {subtitle && <span className="text-xs text-text-faint">{subtitle}</span>}
        <span className="flex-1" />
        {onSeeAll && (
          <button
            type="button"
            onClick={onSeeAll}
            aria-label={`See all: ${title}`}
            className="rounded-md px-2 py-1 text-sm font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            See all
          </button>
        )}
        {(more.left || more.right) && (
          <div className="flex gap-2">
            {arrow(-1, more.left)}
            {arrow(1, more.right)}
          </div>
        )}
      </div>
      <div
        ref={stripRef}
        onScroll={measure}
        className="flex gap-4 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item) => (
          <div key={itemKey(item)} className="shrink-0" style={{ width: itemWidth }}>
            {renderItem(item)}
          </div>
        ))}
      </div>
    </section>
  );
}
