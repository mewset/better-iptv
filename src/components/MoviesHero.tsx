import { useState } from 'react';
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
  /** The small label above the title; also the section's accessible name. */
  eyebrow?: string;
  /** An extra line under the meta row, e.g. where a pick came from. */
  note?: string;
  /**
   * Set when the banner rotates through several titles: which one this is,
   * how many there are, and a jump to another (the dots).
   */
  rotation?: { index: number; count: number; onSelect: (index: number) => void };
}

/**
 * "Recently added" hero for the Movies and Series sections: the newest title, shown
 * full-width above the poster grid. Rendered as virtual row 0 of the grid's
 * virtualiser by the caller (`MainScreen`) — this component only renders the
 * row's content, it does not manage its own position or measurement.
 */

/** Transparent at the image's left edge, fully opaque from 40% across. */
const ART_FADE = {
  WebkitMaskImage: 'linear-gradient(to right, transparent, black 40%)',
  maskImage: 'linear-gradient(to right, transparent, black 40%)',
} as const;

export function MoviesHero({
  channel,
  onPlay,
  onOpen,
  isPlaying = false,
  tmdb,
  eyebrow = 'Recently added',
  note,
  rotation,
}: MoviesHeroProps) {
  const artUrl = tmdb?.backdrop_url ?? channel.logo;
  // Remember which URL failed rather than a flag: a new URL gets a fresh try
  // without an effect.
  const [failedArt, setFailedArt] = useState<string | null>(null);
  const art = artUrl && artUrl !== failedArt ? artUrl : null;
  const isSeries = channel.content_type === 'series';
  // TMDB's title over the provider's ("The.Great.Flood.2025.1080p") once matched.
  const title = tmdb?.title || channel.name;
  return (
    <section
      aria-label={eyebrow}
      className="relative h-[340px] overflow-hidden rounded-[18px] border border-border bg-surface-2"
    >
      {art ? (
        <img
          src={art}
          alt=""
          aria-hidden="true"
          draggable={false}
          onError={() => setFailedArt(artUrl ?? null)}
          // Never wider than 2.4:1 at the banner's 340 px. The image fills
          // its box, so on a very wide window 55% of the banner left only a
          // thin strip of the artwork showing.
          className="absolute inset-y-0 right-0 w-[55%] max-w-[816px] object-cover"
          // The artwork's left edge fades out instead of starting on a hard
          // line where a bright backdrop meets the panel. A mask, not a
          // second gradient: it only shapes the image's own alpha.
          style={ART_FADE}
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
        <span className="text-xs font-bold tracking-[0.12em] text-accent-text">
          {eyebrow.toUpperCase()}
        </span>
        <h2 className="font-display text-[44px] font-bold leading-none">{title}</h2>
        <p className="text-[13px] text-text-muted">
          {heroMetaLine(tmdb, channel.group_name ?? '')}
        </p>
        {note && <p className="text-[13px] text-text-muted">{note}</p>}
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

      {rotation && rotation.count > 1 && (
        <div
          role="group"
          aria-label="Featured titles"
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-bg/70 px-2 py-1.5"
        >
          {Array.from({ length: rotation.count }, (_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Show featured title ${i + 1} of ${rotation.count}`}
              aria-current={i === rotation.index ? 'true' : undefined}
              onClick={() => rotation.onSelect(i)}
              className="flex h-5 w-5 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span
                aria-hidden="true"
                className={
                  i === rotation.index
                    ? 'h-2 w-5 rounded-full bg-accent'
                    : 'h-2 w-2 rounded-full bg-text/40 hover:bg-text/70'
                }
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
