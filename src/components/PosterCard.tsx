import { memo, useState } from 'react';
import { Play, Clapperboard, Star, Lock } from 'lucide-react';
import type { Channel } from '../types';
import { ColorBars } from './ColorBars';

interface PosterCardProps {
  channel: Channel;
  /** Callback when the card is opened: plays a movie, opens a series. */
  onOpen: (channel: Channel) => void;
  /** Whether this channel is blocked by parental controls */
  isBlocked?: boolean;
  /** Visibility mode for blocked channels */
  parentalVisibility?: 'hide' | 'lock' | 'blur';
  /** Callback when the favourite star is toggled */
  onToggleFavorite?: (channelId: number) => void;
}

/** 2/3, the target poster ratio. */
const TARGET_RATIO = 2 / 3;

/**
 * Poster-shaped card for movies and series: an uncropped 2:3 frame with a
 * meta line underneath, and a hover/focus overlay carrying the title and
 * primary action. Shares its parental-control and click-target conventions
 * with the live `ChannelCard`.
 */
export const PosterCard = memo(function PosterCard({
  channel,
  onOpen,
  isBlocked = false,
  parentalVisibility = 'hide',
  onToggleFavorite,
}: PosterCardProps) {
  const [artFailed, setArtFailed] = useState(false);
  const [fit, setFit] = useState<'cover' | 'contain'>('cover');
  const isSeries = channel.content_type === 'series';
  const blocked = isBlocked && parentalVisibility !== 'hide';
  const lockMode = blocked && parentalVisibility === 'lock';
  const blurMode = blocked && parentalVisibility === 'blur';
  // Artwork is not rendered at all in lock mode (nothing to reveal via
  // inspecting the DOM); in blur mode it renders blurred underneath the
  // overlay, same as the live card.
  const showArt = Boolean(channel.logo) && !artFailed && !lockMode;

  const handleLoad = (e: React.SyntheticEvent<globalThis.HTMLImageElement>) => {
    const img = e.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const ratio = img.naturalWidth / img.naturalHeight;
    const deviates = Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO > 0.1;
    setFit(deviates ? 'contain' : 'cover');
  };

  return (
    // Same mouse-shortcut convention as ChannelCard (issue #55): the frame's
    // onClick is the click target everyone reaches for, the Play/Open button
    // in the overlay is the keyboard path, and every inner control stops
    // propagation so it doesn't also trigger the frame's onClick.
    <article
      onClick={() => onOpen(channel)}
      className="group relative flex cursor-pointer flex-col gap-2"
    >
      <div
        className={`relative aspect-[2/3] overflow-hidden rounded-xl border border-border bg-surface-2 transition-transform duration-150 group-focus-within:scale-[1.04] group-focus-within:border-accent group-hover:scale-[1.04] group-hover:border-accent group-hover:shadow-2xl`}
      >
        {showArt ? (
          <img
            src={channel.logo!}
            alt={channel.name}
            loading="lazy"
            decoding="async"
            // Images are draggable by default, and a click that starts with a
            // few pixels of drag becomes a drag gesture that never fires a
            // click - on the poster, the largest target on the card.
            draggable={false}
            onError={() => setArtFailed(true)}
            onLoad={handleLoad}
            className={`h-full w-full ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${
              blurMode ? 'blur-xl' : ''
            }`}
          />
        ) : (
          !lockMode && (
            <>
              <ColorBars label={channel.name} className={blurMode ? 'blur-xl' : ''} />
              <div className="absolute inset-x-0 bottom-[16%] px-3 text-center">
                <span className="line-clamp-2 font-display text-sm font-semibold text-[#F2F2F0] [text-shadow:0_2px_12px_rgba(0,0,0,.6)]">
                  {channel.name}
                </span>
              </div>
            </>
          )
        )}

        {isSeries && !blocked && (
          <span className="absolute bottom-2 left-2 rounded-full bg-bg/70 px-2 py-0.5 text-[11px] font-semibold text-text">
            Series
          </span>
        )}

        {/* A blocked card's only control is the unlock button below: the
            favourite and Play/Open controls are not rendered here at all, so
            a blocked title never exposes a way to favourite it (no PIN
            required) or a second, invisible tab stop underneath the overlay. */}
        {!blocked && (
          <div
            // The one allowed gradient (see global constraints): a scrim
            // behind the hover/focus overlay's title and controls, not
            // decoration.
            className="absolute inset-x-0 bottom-0 flex flex-col justify-end gap-2 bg-gradient-to-t from-bg/95 via-bg/40 to-transparent p-2.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
          >
            <span className="truncate font-display text-lg font-bold text-text">
              {channel.name}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(channel);
                }}
                className="flex h-9 flex-1 items-center justify-center gap-1.5 truncate rounded-[10px] bg-accent px-2 text-sm font-semibold text-on-accent focus-visible:ring-2 focus-visible:ring-accent"
              >
                {isSeries ? (
                  <Clapperboard className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Play className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">
                  {isSeries ? 'Open' : 'Play'} {channel.name}
                </span>
              </button>
              <button
                type="button"
                aria-label={channel.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite?.(channel.id);
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-text/10 focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Star
                  className={`h-4 w-4 ${channel.is_favorite ? 'fill-current text-accent-text' : 'text-text-muted'}`}
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        )}

        {blocked && (
          // backdrop-blur on a list item is otherwise off-limits (see global
          // constraints), but the parental "blur" visibility mode is this
          // exception by definition: it is the opt-in feature this button
          // renders, not incidental glass styling, so the blur stays.
          <button
            type="button"
            aria-label={`Unlock ${channel.name} with PIN`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(channel);
            }}
            className={`absolute inset-0 flex flex-col items-center justify-center gap-2 text-text focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
              blurMode ? 'bg-bg/55 backdrop-blur-md' : 'bg-bg/80'
            }`}
          >
            <Lock className="h-7 w-7" aria-hidden="true" />
            <span className="text-xs font-semibold text-text">Enter PIN to watch</span>
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate text-text-faint">{channel.group_name ?? ''}</span>
      </div>
    </article>
  );
});

export default PosterCard;
