import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarRange, Lock, Play, X } from 'lucide-react';
import { usePlayerStore, type ChannelLoadStatus } from '../stores/player-store';
import type { Channel } from '../types';
import type { Programme } from '../lib/epgIpc';
import {
  blockGeometry,
  guideDayLabels,
  layoutLanes,
  type Lane,
  type LaneLayout,
} from '../lib/guideLayout';
import { formatClock, formatClockAt, minutesLeft, progressPercent } from '../lib/epgTime';
import { cn } from '../lib/utils';
import { useChannelLogo } from '../hooks/useChannelLogo';
import { useGuide } from '../hooks/useGuide';
import { hasNoEnabledSource, useEpgStatus } from '../hooks/useEpgStatus';
import { useNow } from '../hooks/useNow';
import { CategoryBar } from './CategoryBar';
import { ColorBars } from './ColorBars';
import { ChannelLoadError } from './ChannelLoadError';

const HALF_HOUR = 30 * 60_000;
const ROW_HEIGHT = 64; // h-16
/**
 * The strip at the track's right end that a row with a `+N` chip keeps free
 * for it: the chip is 32 px wide (w-8), plus the 4 px gap blocks keep between
 * each other. Blocks keep their time-true left edge and end before it.
 */
const CHIP_RESERVE_PX = 36;

/** "HH:MM–HH:MM", or '' when either time cannot be parsed. */
function timeRange(p: Programme): string {
  const start = formatClock(p.start);
  const end = formatClock(p.stop);
  return start && end ? `${start}–${end}` : '';
}

function isAiring(p: Programme, now: number): boolean {
  const start = Date.parse(p.start);
  const end = Date.parse(p.stop);
  return start <= now && now < end;
}

const CHIP =
  'inline-flex h-[34px] shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-3.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg';
const CHIP_ACTIVE = 'border-text bg-text font-semibold text-bg';
const CHIP_IDLE = 'border-border bg-text/5 font-medium text-text-muted hover:bg-text/10';

function LogoTile({
  channel,
  showLogo,
  className,
}: {
  channel: Channel;
  showLogo: boolean;
  className: string;
}) {
  const { src, onError } = useChannelLogo(channel);
  const initial = channel.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden bg-surface-2',
        className
      )}
    >
      {showLogo && src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={onError}
          className="h-full w-full object-contain p-1"
        />
      ) : (
        <span aria-hidden="true" className="text-sm font-semibold text-text-muted">
          {initial}
        </span>
      )}
    </div>
  );
}

interface Selection {
  channel: Channel;
  programme: Programme;
  lane: Lane;
}

/**
 * A block's identity within its row. Two lanes can hold programmes with one
 * start (a film opening a movie-night block), so the start alone is not.
 */
function blockKey(start: string, lane: Lane): string {
  return `${start}|${lane}`;
}

/** "1 overlapping programme not shown", "3 overlapping programmes not shown". */
function droppedLabel(n: number): string {
  return `${n} overlapping programme${n === 1 ? '' : 's'} not shown`;
}

interface GuideRowProps {
  channel: Channel;
  /** 1-based position among all rows, for aria-rowindex. */
  rowIndex: number;
  /** The row's programmes in lanes; laid out once per answer by GuideView. */
  layout: LaneLayout | undefined;
  from: number;
  to: number;
  now: number;
  loading: boolean;
  playing: boolean;
  blocked: boolean;
  /** `blockKey` of the selected block when it is in this row. */
  selectedKey: string | null;
  onSelect: (channel: Channel, programme: Programme, lane: Lane) => void;
}

const GuideRow = memo(function GuideRow({
  channel,
  rowIndex,
  layout,
  from,
  to,
  now,
  loading,
  playing,
  blocked,
  selectedKey,
  onSelect,
}: GuideRowProps) {
  // Pure per layout/window: geometry in percent of the track.
  const blocks = useMemo(() => {
    if (!layout) return [];
    const out: Array<{ programme: Programme; lane: Lane; left: number; width: number }> = [];
    for (const { programme, lane } of layout.blocks) {
      const g = blockGeometry(programme.start, programme.stop, from, to, 100);
      if (g) out.push({ programme, lane, ...g });
    }
    return out;
  }, [layout, from, to]);
  // A row with a second lane draws both as half-height blocks in the same
  // 64 px, so the virtualizer's fixed row height holds.
  const twoLanes = layout?.laneCount === 2;
  const dropped = layout?.dropped ?? 0;

  return (
    <div
      role="row"
      aria-label={channel.name}
      aria-rowindex={rowIndex}
      className="flex h-16 items-center gap-4"
    >
      <div role="rowheader" className="flex w-[184px] shrink-0 items-center gap-3">
        <LogoTile channel={channel} showLogo={!blocked} className="h-9 w-11 rounded-lg" />
        <span className="min-w-0 truncate text-[13px] font-semibold text-text">{channel.name}</span>
        {playing && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-accent">
            <span className="sr-only">Playing</span>
          </span>
        )}
      </div>
      <div role="cell" className="relative h-16 min-w-0 flex-1">
        {blocked ? (
          <p className="flex h-full items-center gap-2 text-[13px] text-text-faint">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            Locked
          </p>
        ) : blocks.length === 0 ? (
          !loading && (
            <p className="flex h-full items-center text-[13px] text-text-faint">No guide data</p>
          )
        ) : (
          <>
            {blocks.map(({ programme, lane, left, width }) => {
              const key = blockKey(programme.start, lane);
              const selected = selectedKey === key;
              const airing = isAiring(programme, now);
              const range = timeRange(programme);
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={[programme.title, range, channel.name].filter(Boolean).join(', ')}
                  // Native tooltip: short blocks truncate long names (children's
                  // programmes especially), and half-height blocks show no
                  // times, so hovering shows the whole thing.
                  title={[programme.title, range].filter(Boolean).join(' · ')}
                  aria-pressed={selected}
                  onClick={() => onSelect(channel, programme, lane)}
                  style={{
                    left: `calc(${left}% + 2px)`,
                    width: `max(0px, calc(${width}% - 4px))`,
                    // In a row with a +N chip, a block reaching the chip's strip
                    // ends before it, so the chip never covers a title or a click.
                    // A negative calc() result clamps to 0.
                    maxWidth:
                      dropped > 0 ? `calc(${100 - left}% - ${2 + CHIP_RESERVE_PX}px)` : undefined,
                  }}
                  className={cn(
                    'absolute overflow-hidden border px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                    twoLanes
                      ? cn('h-[26px] rounded-lg py-1', lane === 0 ? 'top-1' : 'top-[34px]')
                      : 'top-1 h-14 rounded-[10px] py-2',
                    selected
                      ? 'border-accent bg-accent text-on-accent'
                      : airing
                        ? 'border-accent bg-accent/15 text-text hover:bg-accent/25'
                        : 'border-border bg-text/5 text-text-muted hover:bg-text/10'
                  )}
                >
                  <span
                    className={cn(
                      'block truncate font-semibold',
                      twoLanes ? 'text-[12px] leading-4' : 'text-[13px]'
                    )}
                  >
                    {programme.title}
                  </span>
                  {range && !twoLanes && (
                    <span
                      className={cn(
                        'block truncate text-[11px] tabular-nums',
                        selected ? 'text-on-accent' : 'text-text-muted'
                      )}
                    >
                      {range}
                    </span>
                  )}
                </button>
              );
            })}
            {/* In the strip the blocks leave free at the track's right end. */}
            {dropped > 0 && (
              <span
                role="note"
                aria-label={droppedLabel(dropped)}
                title={droppedLabel(dropped)}
                className="absolute right-0 top-1/2 w-8 -translate-y-1/2 rounded-full border border-border-strong bg-surface-2 text-center text-[11px] font-semibold tabular-nums text-text-muted"
              >
                +{dropped}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
});

interface DetailPanelProps {
  selection: Selection;
  now: number;
  dockVisible: boolean;
  /** The selected channel is the one playing: Watch now would toggle it off. */
  playing: boolean;
  onWatch: (channel: Channel) => void;
  onClose: () => void;
}

function DetailPanel({ selection, now, dockVisible, playing, onWatch, onClose }: DetailPanelProps) {
  const { channel, programme } = selection;
  const logo = useChannelLogo(channel);
  const airing = isAiring(programme, now);
  const range = timeRange(programme);
  const mins = airing ? minutesLeft(programme.stop, now) : null;
  const pct = airing ? progressPercent(programme.start, programme.stop, now) : null;
  const meta = [channel.name, range, mins !== null ? `${mins} min left` : '']
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      aria-label="Selected programme"
      className={cn(
        'absolute left-1/2 z-20 flex w-[min(880px,calc(100%-80px))] -translate-x-1/2 items-center gap-4 rounded-[18px] border border-border-strong bg-surface/85 p-3 shadow-[0_20px_50px_rgba(0,0,0,.5)] backdrop-blur-2xl supports-[not(backdrop-filter:blur(1px))]:bg-surface',
        dockVisible ? 'bottom-[112px]' : 'bottom-6'
      )}
    >
      <div className="relative h-[52px] w-[52px] shrink-0 overflow-hidden rounded-xl bg-surface-2">
        {logo.src ? (
          <img
            src={logo.src}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={logo.onError}
            className="h-full w-full object-contain p-1"
          />
        ) : (
          <ColorBars label={channel.name} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <h2 className="truncate font-display text-xl font-semibold text-text">{programme.title}</h2>
        <p className="truncate text-sm text-text-muted">{meta}</p>
        {programme.description && (
          <p className="truncate text-sm text-text-muted">{programme.description}</p>
        )}
        {pct !== null && (
          <div data-progress className="mt-2 h-1 w-[360px] max-w-full rounded-full bg-text/10">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={playing}
        aria-disabled={playing}
        onClick={() => {
          if (!playing) onWatch(channel);
        }}
        className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-default disabled:hover:bg-accent"
      >
        {!playing && <Play className="h-4 w-4 fill-current" aria-hidden="true" />}
        {playing ? 'Playing' : 'Watch now'}
      </button>
      <button
        type="button"
        aria-label="Close programme details"
        onClick={onClose}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-text/10 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}

export interface GuideViewProps {
  /**
   * The guide section's filtered list (every live channel, narrowed by
   * category, parental hide and search). After the Favorites chip's own
   * narrowing, the rows are every channel in it with programmes in the
   * guide's five days.
   */
  channels: Channel[];
  playingChannelId: number | null;
  /** MainScreen's play path, so parental checks apply. */
  onPlay: (channel: Channel) => void;
  onOpenEpgSettings: () => void;
  /** The now-playing dock is on screen; the detail panel sits above it. */
  dockVisible: boolean;
  /** Parental blocking per channel id (lock/blur modes); hide mode already filtered. */
  blockedMap?: Map<number, boolean>;
  /** Live part of the channel list; the empty states wait for 'loaded'. */
  loadStatus: ChannelLoadStatus;
  onRetry: () => void;
}

/**
 * TV Guide (board 4): day chips and categories, a half-hour time header,
 * one 64 px row per channel with its programmes as positioned blocks (in two
 * half-height lanes where programmes nest), a now line on Today, and a glass
 * detail panel for the selected programme.
 */
export function GuideView({
  channels,
  playingChannelId,
  onPlay,
  onOpenEpgSettings,
  dockVisible,
  blockedMap,
  loadStatus,
  onRetry,
}: GuideViewProps) {
  const [dayOffset, setDayOffset] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const now = useNow();
  // Until the status is known the guide shows its loading line: neither
  // the table nor the empty state, so neither flashes. A failed status
  // request shows the guide rather than a wrong empty state.
  const { status, failed: statusFailed } = useEpgStatus();
  // Session-only: the view remembers it while mounted, a fresh guide starts on all.
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);

  const listed = useMemo(
    () => (favoritesOnly ? channels.filter((c) => c.is_favorite) : channels),
    [channels, favoritesOnly]
  );
  const { rows, programs, window: win, loading, rowsLoading } = useGuide(listed, dayOffset);
  // Lanes per guide key, once per programme answer: rows remount as they
  // scroll into view and re-render on every now tick, and neither lays out
  // again.
  const lanes = useMemo(() => {
    const out = new Map<string, LaneLayout>();
    for (const key in programs) out.set(key, layoutLanes(programs[key]));
    return out;
  }, [programs]);

  // Rows are virtualized: a guide can list over a thousand channels, and only
  // the rows in view (plus overscan) are in the DOM. Fixed height, so no
  // measuring. `scrollMargin` is the table's offset below the sticky time
  // header inside the scroll container.
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    scrollMargin,
  });
  const hasTable = rows.length > 0;
  useLayoutEffect(() => {
    setScrollMargin(tableRef.current?.offsetTop ?? 0);
  }, [hasTable]);

  // A new list (category, Favorites chip, search) starts at the top; a day
  // change keeps the place, since the rows are the same. The offset is reset
  // during render so the first render of the new list already picks its top
  // rows; the DOM follows before paint.
  const [shownList, setShownList] = useState({ channels, favoritesOnly, version: 0 });
  if (shownList.channels !== channels || shownList.favoritesOnly !== favoritesOnly) {
    setShownList({ channels, favoritesOnly, version: shownList.version + 1 });
    rowVirtualizer.scrollOffset = 0;
  }
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [shownList.version]);
  const virtualRows = rowVirtualizer.getVirtualItems();

  // Escape closes the detail panel before anything else sees it. A bubble
  // listener on document runs before useKeyboardShortcuts' window listener
  // (and after TopBar's capture-phase profile-menu handler, which stops the
  // event), and preventDefault tells that handler the key is spoken for.
  useEffect(() => {
    if (!selection) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      setSelection(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selection]);

  const handleSelect = useCallback((channel: Channel, programme: Programme, lane: Lane) => {
    setSelection({ channel, programme, lane });
  }, []);

  // Clicking the day already shown keeps the selection.
  const handleDay = (offset: number) => {
    if (offset === dayOffset) return;
    setDayOffset(offset);
    setSelection(null);
  };

  // Relabel once per calendar day, not on every now tick.
  const nowDate = new Date(now);
  const dayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const days = useMemo(() => guideDayLabels(dayStart), [dayStart]);

  // At midnight every day chip, and so the window, moves on a day: a
  // programme selected on the old one is closed, as a day change closes it.
  const [selectionDay, setSelectionDay] = useState(dayStart);
  if (selectionDay !== dayStart) {
    setSelectionDay(dayStart);
    setSelection(null);
  }

  const span = win.to - win.from;
  const ticks = useMemo(() => {
    const out: Array<{ at: number; label: string; pct: number }> = [];
    for (let t = win.from; t < win.to; t += HALF_HOUR) {
      out.push({
        at: t,
        label: formatClockAt(t),
        pct: ((t - win.from) / span) * 100,
      });
    }
    return out;
  }, [win.from, win.to, span]);

  const nowPct =
    dayOffset === 0 && now >= win.from && now <= win.to ? ((now - win.from) / span) * 100 : null;
  const nowLabel = formatClockAt(now);

  if (hasNoEnabledSource(status)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-10 pb-32 text-center">
        <CalendarRange className="h-8 w-8 text-text-muted" aria-hidden="true" />
        <p className="text-text-muted">Add an EPG source in Settings to see the guide</p>
        <button
          type="button"
          onClick={onOpenEpgSettings}
          className="h-10 rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Open EPG settings
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-4 px-10 pt-6">
        <div role="tablist" aria-label="Day" className="flex shrink-0 gap-2 py-3 pb-6">
          {days.map((label, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={dayOffset === i}
              onClick={() => handleDay(i)}
              className={cn(CHIP, dayOffset === i ? CHIP_ACTIVE : CHIP_IDLE)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 items-center">
          <div className="shrink-0 py-3 pb-6 pl-4">
            <button
              type="button"
              aria-pressed={favoritesOnly}
              onClick={() => {
                setFavoritesOnly((on) => !on);
                setSelection(null);
              }}
              className={cn(CHIP, favoritesOnly ? CHIP_ACTIVE : CHIP_IDLE)}
            >
              Favorites
            </button>
          </div>
          <div className="min-w-0 flex-1">
            <CategoryBar
              allSelected={!favoritesOnly && categoryFilter === null}
              onAll={() => setFavoritesOnly(false)}
            />
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={cn(
          // relative: the table's offsetTop (the virtualizer's scrollMargin) is
          // then measured from this scroll container, not from the chip row above.
          'relative flex-1 overflow-y-auto px-10',
          selection && dockVisible ? 'pb-56' : 'pb-32'
        )}
      >
        {loadStatus === 'error' ? (
          <ChannelLoadError onRetry={onRetry} />
        ) : loadStatus === 'loading' || rowsLoading || (status === null && !statusFailed) ? (
          <p className="py-16 text-center text-text-muted">Loading guide…</p>
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-text-muted">
            {listed.length === 0
              ? favoritesOnly
                ? 'No favorite channels yet'
                : 'No channels in this list'
              : 'None of these channels has guide data'}
          </p>
        ) : (
          <>
            <div className="sticky top-0 z-10 bg-bg pb-2">
              <div className="relative ml-[200px] h-6">
                {ticks.map((tick) => (
                  <span
                    key={tick.at}
                    className="absolute top-1 text-xs tabular-nums text-text-faint"
                    style={{ left: `${tick.pct}%` }}
                  >
                    {tick.label}
                  </span>
                ))}
                {nowPct !== null && (
                  <span
                    className="absolute top-0 -translate-x-1/2 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-on-accent"
                    style={{ left: `${nowPct}%` }}
                  >
                    {nowLabel}
                  </span>
                )}
              </div>
            </div>

            <div
              ref={tableRef}
              role="table"
              aria-label="TV guide"
              aria-rowcount={rows.length}
              className="relative"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {/* Before the rows so blocks paint over it: the line shows through
                  translucent blocks and never cuts through a title. */}
              {nowPct !== null && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-[200px] right-0"
                >
                  <div
                    data-testid="guide-now-line"
                    className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-accent"
                    style={{ left: `${nowPct}%` }}
                  />
                </div>
              )}
              <div role="rowgroup">
                {virtualRows.map((virtualRow) => {
                  const channel = rows[virtualRow.index];
                  return (
                    <div
                      key={channel.id}
                      className="absolute inset-x-0 top-0"
                      style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
                    >
                      <GuideRow
                        channel={channel}
                        rowIndex={virtualRow.index + 1}
                        layout={lanes.get(channel.epg_id!)}
                        from={win.from}
                        to={win.to}
                        now={now}
                        loading={loading}
                        playing={playingChannelId === channel.id}
                        blocked={blockedMap?.get(channel.id) ?? false}
                        selectedKey={
                          selection?.channel.id === channel.id
                            ? blockKey(selection.programme.start, selection.lane)
                            : null
                        }
                        onSelect={handleSelect}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {selection && (
        <DetailPanel
          selection={selection}
          now={now}
          dockVisible={dockVisible}
          playing={playingChannelId === selection.channel.id}
          onWatch={onPlay}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}
