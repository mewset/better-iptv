import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { TmdbCard } from '../lib/tauri';
import type { Channel } from '../types';
import { MoviesHero } from './MoviesHero';
import { backgroundProgressLine, type TmdbBackgroundProgress } from '../lib/tmdb';
import { HomeRail } from './HomeRail';

/** The day's pick, resolved to its channel and filtered for parental controls by MainScreen. */
export interface HomePickView {
  channel: Channel;
  card: TmdbCard;
  /** Where it came from: "Trending on TMDB today" or "Highest rated in your library". */
  note: string;
}

/** One title the Home banner rotates through. */
export interface HomeHeroItem {
  channel: Channel;
  card: TmdbCard;
  /** "Our pick of the day", "Trending today", "Popular" */
  eyebrow: string;
  note?: string;
}

/** One Home row: posters (movies, series) or live channel cards. */
export interface HomeRailSpec {
  key: string;
  title: string;
  subtitle?: string;
  kind: 'poster' | 'live';
  items: Channel[];
  /** Rows that share a group get one heading above the first of them. */
  group?: { title: string; subtitle?: string };
  /** Opens the full list behind the row ("See all"). */
  onSeeAll?: () => void;
}

interface HomeViewProps {
  hero: HomeHeroItem[];
  rails: HomeRailSpec[];
  /** Draws one poster, with the grid's handlers and TMDB data; `railKey` lets a row add its own touches. */
  renderPoster: (channel: Channel, railKey: string) => ReactNode;
  /** Draws one live channel card with its guide now/next. */
  renderLive: (channel: Channel) => ReactNode;
  onPlay: (channel: Channel) => void;
  onOpenTitle: (channel: Channel) => void;
  /** The channel playing now, so the banner can say "Playing". */
  playingId?: number | null;
  loading: boolean;
  progress: TmdbBackgroundProgress | null;
  /**
   * Where Home was last scrolled to, kept by MainScreen: this view is
   * unmounted while a title or Settings is open, and comes back to the same
   * place. Read once at mount, written on every scroll.
   */
  scrollTopRef?: { current: number };
}

/** How long each banner title shows, as in Movies and Series. */
const HERO_ROTATE_MS = 6_000;

/**
 * Home: a rotating banner of the day's pick, what is trending and what is
 * popular in the library, then rows of posters (and favourite channels on
 * now) that each show a screenful of titles. The greeting lives in the top
 * bar. Everything arrives filtered for parental controls from MainScreen.
 */
export function HomeView({
  hero,
  rails,
  renderPoster,
  renderLive,
  onPlay,
  onOpenTitle,
  playingId = null,
  loading,
  progress,
  scrollTopRef,
}: HomeViewProps) {
  const scanLine = progress?.running ? backgroundProgressLine(progress) : '';

  const scrollerRef = useRef<HTMLDivElement>(null);
  // Before paint, so coming back never shows the top first.
  useLayoutEffect(() => {
    if (scrollerRef.current && scrollTopRef) scrollerRef.current.scrollTop = scrollTopRef.current;
    // Mount only: afterwards the view itself is the source of the position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The banner swaps at once every HERO_ROTATE_MS, and holds still under the
  // pointer or the focus and while the window is hidden.
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroHeld, setHeroHeld] = useState(false);
  useEffect(() => {
    if (hero.length < 2 || heroHeld) return;
    const timer = setInterval(() => {
      if (!document.hidden) setHeroIndex((i) => i + 1);
    }, HERO_ROTATE_MS);
    return () => clearInterval(timer);
  }, [hero.length, heroHeld]);
  const current = hero.length > 0 ? hero[heroIndex % hero.length] : null;

  const rows = rails.filter((r) => r.items.length > 0);

  return (
    <div
      ref={scrollerRef}
      onScroll={(e) => {
        if (scrollTopRef) scrollTopRef.current = e.currentTarget.scrollTop;
      }}
      className="flex-1 overflow-y-auto px-10 pb-32 pt-6"
      role="region"
      aria-label="Home"
    >
      {current && !loading && (
        <div
          className="mb-9"
          onMouseEnter={() => setHeroHeld(true)}
          onMouseLeave={() => setHeroHeld(false)}
          onFocus={() => setHeroHeld(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) setHeroHeld(false);
          }}
        >
          <MoviesHero
            key={current.channel.id}
            channel={current.channel}
            tmdb={current.card}
            eyebrow={current.eyebrow}
            note={current.note}
            onPlay={onPlay}
            onOpen={onOpenTitle}
            isPlaying={playingId === current.channel.id}
            rotation={{
              index: heroIndex % hero.length,
              count: hero.length,
              onSelect: setHeroIndex,
            }}
          />
        </div>
      )}

      {loading ? (
        <div data-testid="home-skeleton" className="flex flex-col gap-9" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-3">
              <div className="h-6 w-48 rounded bg-surface-2" />
              <div className="flex gap-4">
                {Array.from({ length: 8 }, (_, j) => (
                  <div key={j} className="h-[270px] w-[180px] shrink-0 rounded-xl bg-surface-2" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 && !current ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-text-muted">
          {scanLine ? (
            <>
              <p>{scanLine}</p>
              <p>Home fills in as the scan completes.</p>
            </>
          ) : (
            <p>
              Nothing to show yet. Home needs a few well-rated movies or series in your library.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-9">
          {rows.map((rail, i) => {
            const opensGroup =
              rail.group && (i === 0 || rows[i - 1].group?.title !== rail.group.title);
            return (
              <Fragment key={rail.key}>
                {opensGroup && (
                  <div className="-mb-4 mt-2 flex items-baseline gap-3 border-t border-border pt-7">
                    <h2 className="font-display text-2xl font-bold text-text">
                      {rail.group!.title}
                    </h2>
                    {rail.group!.subtitle && (
                      <span className="text-sm text-text-muted">{rail.group!.subtitle}</span>
                    )}
                  </div>
                )}
                <HomeRail
                  title={rail.title}
                  subtitle={rail.subtitle}
                  items={rail.items}
                  itemKey={(c) => c.id}
                  itemWidth={rail.kind === 'live' ? 300 : 180}
                  renderItem={(c) =>
                    rail.kind === 'live' ? renderLive(c) : renderPoster(c, rail.key)
                  }
                  onSeeAll={rail.onSeeAll}
                />
              </Fragment>
            );
          })}
          {scanLine && <p className="text-center text-xs text-text-faint">{scanLine}</p>}
        </div>
      )}
    </div>
  );
}
