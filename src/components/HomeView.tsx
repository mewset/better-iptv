import { useEffect, useState } from 'react';
import type { HomeRow, TmdbCard } from '../lib/tauri';
import type { Channel } from '../types';
import { MoviesHero } from './MoviesHero';
import { backgroundProgressLine, type TmdbBackgroundProgress } from '../lib/tmdb';
import { greeting } from '../lib/greeting';
import { GenreSlideshow } from './GenreSlideshow';

/** The day's pick, resolved to its channel and filtered for parental controls by MainScreen. */
export interface HomePickView {
  channel: Channel;
  card: TmdbCard;
  /** Where it came from: "Trending on TMDB today" or "Highest rated in your library". */
  note: string;
}

interface HomeViewProps {
  pick: HomePickView | null;
  onPlay: (channel: Channel) => void;
  onOpenTitle: (channel: Channel) => void;
  /** The pick is the title playing right now. */
  isPlaying?: boolean;
  rows: HomeRow[];
  loading: boolean;
  progress: TmdbBackgroundProgress | null;
  onOpen: (channelId: number) => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/**
 * The Home section: a greeting by the clock and the day's genre slideshows.
 * Rows arrive filtered for parental controls from MainScreen.
 */
export function HomeView({
  pick,
  onPlay,
  onOpenTitle,
  isPlaying = false,
  rows,
  loading,
  progress,
  onOpen,
}: HomeViewProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const scanLine = progress?.running ? backgroundProgressLine(progress) : '';

  return (
    <div className="flex-1 overflow-y-auto px-10 pb-32 pt-6" role="region" aria-label="Home">
      <header className="mb-8">
        <h2 className="font-display text-[44px] font-bold leading-none">{greeting(now)}</h2>
        <p className="mt-2 text-sm text-text-faint">{dateFormat.format(now)}</p>
        <p className="mt-4 max-w-[640px] text-sm text-text-muted">
          Your daily pick and six genre slideshows, drawn from the best-rated movies and series
          already in your playlist. A new set every day.
        </p>
      </header>

      {pick && !loading && (
        <div className="mb-10">
          <MoviesHero
            channel={pick.channel}
            tmdb={pick.card}
            eyebrow="Our pick of the day"
            note={pick.note}
            onPlay={onPlay}
            onOpen={onOpenTitle}
            isPlaying={isPlaying}
          />
        </div>
      )}

      {loading ? (
        <div data-testid="home-skeleton" className="flex flex-col gap-10" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-3">
              <div className="h-7 w-40 animate-pulse rounded bg-surface-2" />
              <div
                className="animate-pulse rounded-[18px] bg-surface-2"
                style={{ height: 'clamp(320px, 45vh, 600px)' }}
              />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
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
        <div className="flex flex-col gap-10">
          {rows.map((row) => (
            <GenreSlideshow key={`${row.content_type}-${row.genre}`} row={row} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

export default HomeView;
