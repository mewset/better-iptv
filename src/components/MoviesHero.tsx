import { Play } from 'lucide-react';
import type { Channel } from '../types';
import { ColorBars } from './ColorBars';

interface MoviesHeroProps {
  channel: Channel;
  onPlay: (channel: Channel) => void;
}

/**
 * "Recently added" hero for the Movies section: the newest title, shown
 * full-width above the poster grid. Rendered as virtual row 0 of the grid's
 * virtualiser by the caller (`MainScreen`) — this component only renders the
 * row's content, it does not manage its own position or measurement.
 */
export function MoviesHero({ channel, onPlay }: MoviesHeroProps) {
  return (
    <section
      aria-label="Recently added"
      className="relative h-[272px] overflow-hidden rounded-[18px] border border-border bg-surface-2"
    >
      {channel.logo ? (
        <img
          src={channel.logo}
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
        <h2 className="font-display text-[44px] font-bold leading-none">{channel.name}</h2>
        <p className="text-[13px] text-text-muted">{channel.group_name ?? ''}</p>
        <button
          type="button"
          aria-label={`Play ${channel.name}`}
          onClick={() => onPlay(channel)}
          className="flex h-11 w-fit items-center gap-2 rounded-xl bg-accent px-5 font-bold text-on-accent focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Play className="h-4 w-4" aria-hidden="true" />
          <span>Play</span>
        </button>
      </div>
    </section>
  );
}

export default MoviesHero;
