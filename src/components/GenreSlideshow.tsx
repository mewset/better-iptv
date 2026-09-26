import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { HomeRow } from '../lib/tauri';
import { heroMetaLine } from '../lib/tmdb';
import { ColorBars } from './ColorBars';

export const SLIDE_INTERVAL_MS = 8000;

interface GenreSlideshowProps {
  row: HomeRow;
  onOpen: (channelId: number) => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * One Home slideshow: a genre heading, dots, and one full-width backdrop at
 * a time. Autoplays every 8 s; pauses on hover and while the tab is hidden;
 * never autoplays under reduced motion. The whole slide is a button that
 * opens the title's detail view.
 */
export function GenreSlideshow({ row, onOpen }: GenreSlideshowProps) {
  const count = row.items.length;
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [broken, setBroken] = useState<Set<number>>(() => new Set());
  const current = row.items[Math.min(index, count - 1)];
  const label = row.content_type === 'series' ? 'Series' : 'Movies';

  const go = useCallback((delta: number) => setIndex((i) => (i + delta + count) % count), [count]);

  // A new row (profile switch, next day) starts at its first slide.
  useEffect(() => setIndex(0), [row]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // The interval restarts whenever `index` changes, so a manual step gets
  // the full interval before the next automatic one.
  useEffect(() => {
    if (count < 2 || hovered || hidden || prefersReducedMotion()) return;
    const id = window.setInterval(() => go(1), SLIDE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [count, hovered, hidden, go, index]);

  // Preload the next backdrop so the switch does not flash.
  useEffect(() => {
    if (count < 2) return;
    const next = row.items[(index + 1) % count];
    if (next?.backdrop_url) {
      const img = new globalThis.Image();
      img.src = next.backdrop_url;
    }
  }, [index, count, row.items]);

  if (!current) return null;
  const art = broken.has(current.channel_id) ? null : current.backdrop_url;

  return (
    <section aria-label={`${row.genre} ${label}`} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-2xl font-bold">
          {row.genre}
          <span className="ml-3 text-xs font-bold tracking-[0.12em] text-text-faint">{label}</span>
        </h2>
        {count > 1 && (
          <div role="tablist" aria-label={`${row.genre} slides`} className="flex gap-1.5">
            {row.items.map((item, i) => (
              <button
                key={item.channel_id}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`Slide ${i + 1} of ${count}`}
                onClick={() => setIndex(i)}
                className={`h-1.5 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  i === index ? 'w-6 bg-accent' : 'w-1.5 bg-text/30 hover:bg-text/60'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      <div
        data-testid="slide"
        className="group relative overflow-hidden rounded-[18px] border border-border bg-surface-2"
        style={{ height: 'clamp(320px, 45vh, 600px)' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {art ? (
          <img
            key={current.channel_id}
            src={art}
            alt=""
            aria-hidden="true"
            draggable={false}
            onError={() =>
              setBroken((prev) => {
                const next = new Set(prev);
                next.add(current.channel_id);
                return next;
              })
            }
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0">
            <ColorBars label={current.title} />
          </div>
        )}
        {/* Scrim: the one gradient the design allows. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-transparent"
        />

        <button
          type="button"
          onClick={() => onOpen(current.channel_id)}
          aria-label={`${current.title}, open details`}
          className="absolute inset-0 flex flex-col justify-end gap-2 p-10 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          <h3 className="line-clamp-2 font-display text-[40px] font-bold leading-none">
            {current.title}
          </h3>
          <p className="text-[13px] text-text-muted">{heroMetaLine(current, '')}</p>
          {current.overview && (
            <p className="line-clamp-2 max-w-[640px] text-sm text-text-muted">{current.overview}</p>
          )}
        </button>

        {count > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous"
              onClick={() => go(-1)}
              className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-bg/70 p-2 text-text opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Next"
              onClick={() => go(1)}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-bg/70 p-2 text-text opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
            >
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export default GenreSlideshow;
