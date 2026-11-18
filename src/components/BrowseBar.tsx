import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ListFilter } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import { getTitleGenres } from '../lib/tauri';
import { logger } from '../lib/logger';
import { cn } from '../lib/utils';
import type { SortableSection } from '../lib/titleSort';
import { TitleSortMenu } from './TitleSortMenu';
import { BAR_CONTROL } from './barControl';

interface BrowseBarProps {
  section: SortableSection;
  /** Opens the provider category panel. */
  onOpenCategories: () => void;
  /** While searching only the category button shows; genres, 4K and sort are browse tools. */
  searching: boolean;
}

/** How often Movies re-reads its genres while open: TMDB matching keeps adding them. */
const MOVIE_GENRE_REFRESH_MS = 60_000;

/**
 * The Movies / Series bar under the top bar: genre tabs on the left (one line
 * that scrolls sideways, edge fades and ‹ › buttons instead of a scrollbar),
 * then the provider category button, a 4K switch in Movies and the sort menu.
 * Genres come from the provider for series and from TMDB for movies.
 *
 * Nothing here animates: scrolling jumps, the fades are static (see the
 * DMA-BUF stale-frame note in ChannelCard).
 */
export const BrowseBar = memo(function BrowseBar({
  section,
  onOpenCategories,
  searching,
}: BrowseBarProps) {
  const playlistId = usePlayerStore((s) => s.currentPlaylist?.id ?? null);
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);
  const titleGenres = usePlayerStore((s) => s.titleGenres);
  const setTitleGenres = usePlayerStore((s) => s.setTitleGenres);
  const genreFilter = usePlayerStore((s) => s.genreFilter);
  const setGenreFilter = usePlayerStore((s) => s.setGenreFilter);
  const fourKOnly = usePlayerStore((s) => s.fourKOnly);
  const setFourKOnly = usePlayerStore((s) => s.setFourKOnly);

  // Load the section's genres; Movies keeps them fresh as TMDB matches more.
  useEffect(() => {
    if (playlistId === null) return;
    let alive = true;
    const load = () =>
      getTitleGenres(playlistId, section)
        .then((genres) => {
          if (alive) setTitleGenres(genres);
        })
        .catch((err) => logger.warn('Could not load genres:', err));
    void load();
    const timer = section === 'vod' ? setInterval(load, MOVIE_GENRE_REFRESH_MS) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [playlistId, section, setTitleGenres]);

  // Genres by how many titles carry them, most first
  const genres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const list of Object.values(titleGenres ?? {})) {
      for (const g of list) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  }, [titleGenres]);

  // Which ends of the tab strip have more to scroll to
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
  }, [measure, genres, searching]);

  const scrollStrip = (direction: 1 | -1) => {
    const el = stripRef.current;
    if (el) el.scrollLeft += direction * Math.max(160, el.clientWidth * 0.7);
  };

  // A mouse wheel over the strip scrolls it sideways
  const onWheel = (e: React.WheelEvent<globalThis.HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
  };

  const tab = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center whitespace-nowrap border-y-2 border-t-transparent text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
        active
          ? 'border-b-accent font-semibold text-text'
          : 'border-b-transparent font-medium text-text-muted hover:text-text'
      )}
    >
      {label}
    </button>
  );

  const edgeButton = (side: 'left' | 'right') => (
    <div
      className={cn(
        'pointer-events-none absolute inset-y-0 flex w-24 items-center',
        side === 'left'
          ? 'left-0 justify-start bg-gradient-to-r from-bg via-bg/90 to-transparent'
          : 'right-0 justify-end bg-gradient-to-l from-bg via-bg/90 to-transparent'
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={side === 'left' ? 'Scroll genres left' : 'Scroll genres right'}
        onClick={() => scrollStrip(side === 'left' ? -1 : 1)}
        className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border-strong bg-surface text-text hover:bg-surface-hover"
      >
        {side === 'left' ? (
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );

  return (
    <div className="flex h-[54px] items-center gap-3 border-b border-border">
      {searching ? (
        <div className="flex-1" />
      ) : (
        <div className="relative min-w-0 flex-1 self-stretch">
          <div
            ref={stripRef}
            onScroll={measure}
            onWheel={onWheel}
            role="group"
            aria-label="Genres"
            className="flex h-full gap-[26px] overflow-x-auto pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tab('All', genreFilter === null, () => setGenreFilter(null))}
            {genres.map((genre) =>
              tab(genre, genreFilter === genre, () =>
                setGenreFilter(genreFilter === genre ? null : genre)
              )
            )}
            {titleGenres !== null && genres.length === 0 && section === 'vod' && (
              <span className="self-center whitespace-nowrap text-[13px] text-text-muted">
                Genres appear as TMDB matches your movies
              </span>
            )}
          </div>
          {more.left && edgeButton('left')}
          {more.right && edgeButton('right')}
        </div>
      )}

      <button
        type="button"
        onClick={onOpenCategories}
        aria-haspopup="dialog"
        aria-label={`Category: ${categoryFilter ?? 'All categories'}`}
        className={cn(BAR_CONTROL, 'max-w-[220px]', categoryFilter && 'border-accent')}
      >
        <ListFilter className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        <span className="truncate">{categoryFilter ?? 'All categories'}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
      </button>

      {!searching && section === 'vod' && (
        <button
          type="button"
          role="switch"
          aria-checked={fourKOnly}
          onClick={() => setFourKOnly(!fourKOnly)}
          className={cn(BAR_CONTROL, 'font-semibold')}
        >
          4K
          <span
            aria-hidden="true"
            className={cn(
              'relative block h-[18px] w-[30px] rounded-full',
              fourKOnly ? 'bg-accent' : 'bg-border-strong'
            )}
          >
            <span
              className={cn(
                'absolute top-[2px] h-[14px] w-[14px] rounded-full',
                fourKOnly ? 'right-[2px] bg-on-accent' : 'left-[2px] bg-text-muted'
              )}
            />
          </span>
        </button>
      )}

      {!searching && <TitleSortMenu section={section} />}
    </div>
  );
});
