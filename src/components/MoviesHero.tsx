import { Clapperboard, Play } from 'lucide-react';
import type { Channel } from '../types';
import { ColorBars } from './ColorBars';
import { heroMetaLine } from '../lib/tmdb';
import type { TmdbCard } from '../lib/tauri';

interface MoviesHeroProps {
  channel: Channel;
  onPlay: (channel: Channel) => void;
  /** Series: the button reads "Open" and opens the title instead of playing it. */
  onOpen?: (channel: Channel) => void;
  /** This title is the one playing: the button reads "Playing" and is inert (play would toggle it off). */
  isPlaying?: boolean;
  /** TMDB card data when known: backdrop and the year · genres · rating row. */
  tmdb?: TmdbCard;
}

/**
 * "Recently added" hero for the Movies and Series sections: the newest title, shown
 * full-width above the poster grid. Rendered as virtual row 0 of the grid's
 * virtualiser by the caller (`MainScreen`) — this component only renders the
 * row's content, it does not manage its own position or measurement.
 */
export function MoviesHero({ channel, onPlay, onOpen, isPlaying = false, tmdb }: MoviesHeroProps) {
  const art = tmdb?.backdrop_url ?? channel.logo;
  const isSeries = channel.content_type === 'series';
  // TMDB's title over the provider's ("The.Great.Flood.2025.1080p") once matched.
  const title = tmdb?.title || channel.name;
  return (
    <section
      aria-label="Recently added"
      className="relative h-[272px] overflow-hidden rounded-[18px] border border-border bg-surface-2"
    >
      {art ? (
        <img
          src={art}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-y-0 right-0 w-[55%] object-cover"
        />
      ) : (
        <div className="absolute inset-y-0 right-0 w-[40%]">
          <ColorBars label={channel.name} />
        </div>
      )}

      {/* The one allowed gradient (see global constraints): a left-to-right
          scrim so the text column reads over any artwork behind it. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-r from-bg via-bg/60 to-transparent"
      />

      <div className="relative flex h-full max-w-[640px] flex-col justify-center gap-3 px-10">
        <span className="text-xs font-bold tracking-[0.12em] text-accent-text">RECENTLY ADDED</span>
        <h2 className="font-display text-[44px] font-bold leading-none">{title}</h2>
        <p className="text-[13px] text-text-muted">
          {heroMetaLine(tmdb, channel.group_name ?? '')}
        </p>
        {isSeries ? (
          <button
            type="button"
            aria-label={`Open ${channel.name}`}
            onClick={() => (onOpen ?? onPlay)(channel)}
            className="flex h-11 w-fit items-center gap-2 rounded-xl bg-accent px-5 font-bold text-on-accent focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Clapperboard className="h-4 w-4" aria-hidden="true" />
            <span>Open</span>
          </button>
        ) : (
          <button
            type="button"
            aria-label={`${isPlaying ? 'Playing' : 'Play'} ${channel.name}`}
            disabled={isPlaying}
            aria-disabled={isPlaying}
            onClick={() => {
              if (!isPlaying) onPlay(channel);
            }}
            className="flex h-11 w-fit items-center gap-2 rounded-xl bg-accent px-5 font-bold text-on-accent focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
          >
            {!isPlaying && <Play className="h-4 w-4" aria-hidden="true" />}
            <span>{isPlaying ? 'Playing' : 'Play'}</span>
          </button>
        )}
      </div>
    </section>
  );
}

export default MoviesHero;
