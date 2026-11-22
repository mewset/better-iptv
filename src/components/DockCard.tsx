import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';

export interface DockCardProps {
  /** The artwork: a 2:3 poster, or (`wide`) a channel's logo on a wider tile. */
  art: ReactNode;
  wide: boolean;
  /** Small caps tags before the eyebrow: PAUSED, LIVE. */
  tags?: string[];
  eyebrow: string;
  /** Fainter text after the eyebrow ("2008 · Drama", "23:30–00:00"). */
  detail?: string | null;
  title: string;
  /** The title as a heading (a panel of its own, the guide's selection). */
  titleHeading?: boolean;
  /** What is on next (live), at the title line's end. */
  next?: { time: string; title: string } | null;
  /** One line under the title; the card is 20 px taller with it. */
  description?: string | null;
  /** Progress, 0–1; null for none. */
  fraction?: number | null;
  /** Beside the progress bar ("28 min left"). */
  left?: string | null;
  /** A quiet line in the progress row's place ("No guide for this channel"). */
  quiet?: string | null;
  /** The amber button at the right (play / pause), in the same place on every card. */
  action: ReactNode;
  closeLabel: string;
  closeTitle?: string;
  onClose: () => void;
  /** Makes the whole card a button (the now-playing dock brings the player forward). */
  surface?: {
    label: string;
    title: string;
    onActivate: () => void;
  };
}

/** The amber square button the cards share (pause in the dock, play in the guide). */
export const DOCK_ACTION =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-default disabled:opacity-60 disabled:hover:bg-accent';

/**
 * The card at the bottom of the window: the now-playing dock, and the guide's
 * selected programme, drawn alike so that pressing play on a programme turns
 * one into the other without anything moving:
 *
 *   [art]  LIVE  Channel · detail                          [▶/⏸]  ✕
 *          Title                          Next · 19:30 Title
 *          Description
 *          ━━━━━━━━━━━━━━━━━━━━━━──────────────── 28 min left
 *
 * Solid, no backdrop blur and no transitions (blurring the scrolling grid
 * behind it on every frame is costly in WebKitGTK; see ChannelCard).
 */
export function DockCard({
  art,
  wide,
  tags = [],
  eyebrow,
  detail,
  title,
  titleHeading = false,
  next,
  description,
  fraction = null,
  left,
  quiet,
  action,
  closeLabel,
  closeTitle,
  onClose,
  surface,
}: DockCardProps) {
  return (
    <div
      {...(surface && {
        role: 'button',
        tabIndex: 0,
        title: surface.title,
        'aria-label': surface.label,
        onClick: surface.onActivate,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            surface.onActivate();
          }
        },
      })}
      className={cn(
        'relative flex items-center gap-4 rounded-[18px] border border-border-strong bg-surface py-0 pl-3 pr-11 shadow-[0_20px_50px_rgba(0,0,0,.5)]',
        description ? 'h-[112px]' : 'h-[92px]',
        surface &&
          'cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
      )}
    >
      <div
        className={cn(
          'relative shrink-0 overflow-hidden rounded-md bg-surface-2',
          wide ? 'h-[66px] w-[100px] border border-border-strong' : 'h-[66px] w-[44px]'
        )}
      >
        {art}
      </div>

      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] text-text-muted">
          {tags.map((tag) => (
            <span
              key={tag}
              className="shrink-0 rounded border border-border-strong bg-text/5 px-1.5 text-[10px] font-bold leading-4 tracking-[0.08em] text-text"
            >
              {tag}
            </span>
          ))}
          <span className="min-w-0 truncate">{eyebrow}</span>
          {detail && <span className="min-w-0 truncate text-text-faint">· {detail}</span>}
        </div>
        {/* The title keeps its room: what is next gives way first */}
        <div className="flex min-w-0 items-baseline gap-4 pr-[100px]">
          {titleHeading ? (
            <h2 className="min-w-0 truncate font-display text-[17px] font-semibold leading-snug text-text">
              {title}
            </h2>
          ) : (
            <span className="min-w-0 truncate font-display text-[17px] font-semibold leading-snug text-text">
              {title}
            </span>
          )}
          {next && (
            <span className="ml-auto min-w-0 shrink-[100] truncate text-[12.5px] text-text-muted">
              Next · <b className="font-semibold text-text">{next.time}</b> {next.title}
            </span>
          )}
        </div>
        {description && (
          <p className="min-w-0 truncate text-[12.5px] text-text-muted">{description}</p>
        )}
        {quiet ? (
          <p className="mt-0.5 min-h-[18px] text-[12.5px] text-text-faint">{quiet}</p>
        ) : (
          <div className="mt-1 flex items-center gap-3">
            <div
              role="progressbar"
              aria-label="Progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
              className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-text/10"
            >
              {fraction !== null && (
                <div
                  data-progress
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${fraction * 100}%` }}
                />
              )}
            </div>
            <span className="w-[88px] shrink-0 text-xs text-text-muted">{left ?? ''}</span>
          </div>
        )}
      </div>

      {action}

      <button
        type="button"
        aria-label={closeLabel}
        title={closeTitle}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-md text-text-faint hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
