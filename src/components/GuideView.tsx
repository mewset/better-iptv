import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarRange, Lock, Play, X } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import type { Channel } from '../types';
import { getEpgStatus, type GuideProgram } from '../lib/tauri';
import { blockGeometry, guideChannels } from '../lib/guideLayout';
import { formatClock, minutesLeft, progressPercent } from '../lib/epgTime';
import { logger } from '../lib/logger';
import { cn } from '../lib/utils';
import { useGuide } from '../hooks/useGuide';
import { CategoryBar } from './CategoryBar';
import { ColorBars } from './ColorBars';

const DAY_COUNT = 5;
const HALF_HOUR = 30 * 60_000;
const NOW_TICK_MS = 30_000;

const weekdayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

/** "Today", then "Fri 25"-style labels for the next four days. */
function dayLabels(now: number): string[] {
  const base = new Date(now);
  return Array.from({ length: DAY_COUNT }, (_, i) => {
    if (i === 0) return 'Today';
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    return `${weekdayShort.format(d)} ${d.getDate()}`;
  });
}

/** "HH:MM–HH:MM", or '' when either time cannot be parsed. */
function timeRange(p: GuideProgram): string {
  const start = formatClock(p.start_time);
  const end = formatClock(p.end_time);
  return start && end ? `${start}–${end}` : '';
}

function isAiring(p: GuideProgram, now: number): boolean {
  const start = Date.parse(p.start_time);
  const end = Date.parse(p.end_time);
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
  const [failed, setFailed] = useState(false);
  const initial = channel.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden bg-surface-2',
        className
      )}
    >
      {showLogo && channel.logo && !failed ? (
        <img
          src={channel.logo}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
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
  program: GuideProgram;
}

interface GuideRowProps {
  channel: Channel;
  programmes: GuideProgram[] | undefined;
  from: number;
  to: number;
  now: number;
  loading: boolean;
  playing: boolean;
  blocked: boolean;
  selectedStart: string | null;
  onSelect: (channel: Channel, program: GuideProgram) => void;
}

const GuideRow = memo(function GuideRow({
  channel,
  programmes,
  from,
  to,
  now,
  loading,
  playing,
  blocked,
  selectedStart,
  onSelect,
}: GuideRowProps) {
  // Pure per programmes/window: geometry in percent of the track.
  const blocks = useMemo(() => {
    if (!programmes) return [];
    const out: Array<{ program: GuideProgram; left: number; width: number }> = [];
    for (const program of programmes) {
      const g = blockGeometry(program.start_time, program.end_time, from, to, 100);
      if (g) out.push({ program, ...g });
    }
    return out;
  }, [programmes, from, to]);

  return (
    <div role="row" aria-label={channel.name} className="flex h-16 items-center gap-4">
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
          blocks.map(({ program, left, width }) => {
            const selected = selectedStart === program.start_time;
            const airing = isAiring(program, now);
            const range = timeRange(program);
            return (
              <button
                key={`${program.start_time}|${program.title}`}
                type="button"
                aria-label={[program.title, range, channel.name].filter(Boolean).join(', ')}
                aria-pressed={selected}
                onClick={() => onSelect(channel, program)}
                style={{
                  left: `calc(${left}% + 2px)`,
                  width: `max(0px, calc(${width}% - 4px))`,
                }}
                className={cn(
                  'absolute top-1 h-14 overflow-hidden rounded-[10px] border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  selected
                    ? 'border-accent bg-accent text-on-accent'
                    : airing
                      ? 'border-accent bg-accent/15 text-text hover:bg-accent/25'
                      : 'border-border bg-text/5 text-text-muted hover:bg-text/10'
                )}
              >
                <span className="block truncate text-[13px] font-semibold">{program.title}</span>
                {range && (
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
          })
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
  const { channel, program } = selection;
  const airing = isAiring(program, now);
  const range = timeRange(program);
  const mins = airing ? minutesLeft(program.end_time, now) : null;
  const pct = airing ? progressPercent(program.start_time, program.end_time, now) : null;
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
        {channel.logo ? (
          <img
            src={channel.logo}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full w-full object-contain p-1"
          />
        ) : (
          <ColorBars label={channel.name} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <h2 className="truncate font-display text-xl font-semibold text-text">{program.title}</h2>
        <p className="truncate text-sm tabular-nums text-text-muted">{meta}</p>
        {program.description && (
          <p className="truncate text-sm text-text-muted">{program.description}</p>
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
   * category, parental hide and search); rows are its first 100 with an
   * `epg_id`, after the Favorites chip's own narrowing.
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
}

/**
 * TV Guide (board 4): day chips and categories, a half-hour time header,
 * one 64 px row per channel with its programmes as positioned blocks, a now
 * line on Today, and a glass detail panel for the selected programme.
 */
export function GuideView({
  channels,
  playingChannelId,
  onPlay,
  onOpenEpgSettings,
  dockVisible,
  blockedMap,
}: GuideViewProps) {
  const [dayOffset, setDayOffset] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [hasSource, setHasSource] = useState<boolean | null>(null);
  // Session-only: the view remembers it while mounted, a fresh guide starts on all.
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getEpgStatus()
      .then((status) => {
        if (!cancelled) setHasSource(status.has_url);
      })
      .catch((err) => {
        // Unknown status: show the guide rather than a wrong empty state.
        logger.warn('Failed to read EPG status for the guide:', err);
        if (!cancelled) setHasSource(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const listed = useMemo(
    () => (favoritesOnly ? channels.filter((c) => c.is_favorite) : channels),
    [channels, favoritesOnly]
  );
  const rows = useMemo(() => guideChannels(listed), [listed]);
  const { programs, window: win, loading } = useGuide(listed, dayOffset);

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

  const handleSelect = useCallback((channel: Channel, program: GuideProgram) => {
    setSelection({ channel, program });
  }, []);

  const handleDay = (offset: number) => {
    setDayOffset(offset);
    setSelection(null);
  };

  // Relabel once per calendar day, not on every now tick.
  const nowDate = new Date(now);
  const dayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const days = useMemo(() => dayLabels(dayStart), [dayStart]);

  const span = win.to - win.from;
  const ticks = useMemo(() => {
    const out: Array<{ at: number; label: string; pct: number }> = [];
    for (let t = win.from; t < win.to; t += HALF_HOUR) {
      out.push({
        at: t,
        label: formatClock(new Date(t).toISOString()),
        pct: ((t - win.from) / span) * 100,
      });
    }
    return out;
  }, [win.from, win.to, span]);

  const nowPct =
    dayOffset === 0 && now >= win.from && now <= win.to ? ((now - win.from) / span) * 100 : null;
  const nowLabel = formatClock(new Date(now).toISOString());

  if (hasSource === false) {
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
        className={cn('flex-1 overflow-y-auto px-10', selection && dockVisible ? 'pb-56' : 'pb-32')}
      >
        {rows.length === 0 ? (
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

            <div role="table" aria-label="TV guide" className="relative">
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
                {rows.map((channel) => (
                  <GuideRow
                    key={channel.id}
                    channel={channel}
                    programmes={programs[channel.epg_id!.trim()]}
                    from={win.from}
                    to={win.to}
                    now={now}
                    loading={loading}
                    playing={playingChannelId === channel.id}
                    blocked={blockedMap?.get(channel.id) ?? false}
                    selectedStart={
                      selection?.channel.id === channel.id ? selection.program.start_time : null
                    }
                    onSelect={handleSelect}
                  />
                ))}
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
