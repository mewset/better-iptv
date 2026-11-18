import type { WatchProgress } from './tauri';
import type { Episode, SeriesInfo } from '../types';

/** Less than this in is an accidental start (the backend's `MIN_POSITION_SECS`). */
export const MIN_RESUME_SECS = 30;

/** The key of a film's ('' episode) or an episode's progress. */
export function progressKey(channelId: number, episodeId = ''): string {
  return `${channelId}:${episodeId}`;
}

/** Progress per key, and each channel's latest entry (a series' last episode watched). */
export interface ProgressIndex {
  byKey: Map<string, WatchProgress>;
  latestByChannel: Map<number, WatchProgress>;
}

/** Index a profile's progress, which comes most recent first. */
export function indexProgress(entries: WatchProgress[]): ProgressIndex {
  const byKey = new Map<string, WatchProgress>();
  const latestByChannel = new Map<number, WatchProgress>();
  for (const e of entries) {
    byKey.set(progressKey(e.channel_id, e.episode_id), e);
    const seen = latestByChannel.get(e.channel_id);
    if (!seen || e.updated_at > seen.updated_at) latestByChannel.set(e.channel_id, e);
  }
  return { byKey, latestByChannel };
}

/** Where to pick a title up: its position, unless watched or barely started. */
export function resumeSecs(p: WatchProgress | undefined): number | undefined {
  if (!p || p.watched || p.position_secs < MIN_RESUME_SECS) return undefined;
  return p.position_secs;
}

/** How far through, 0 to 1; a watched title is all the way. */
export function progressFraction(p: WatchProgress | undefined): number {
  if (!p) return 0;
  if (p.watched) return 1;
  if (p.duration_secs <= 0) return 0;
  return Math.min(1, Math.max(0, p.position_secs / p.duration_secs));
}

/** "42:10" or "1:02:05". */
export function formatPosition(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A series' episodes in viewing order: seasons by number (specials last), episodes by number. */
export function episodesInOrder(series: SeriesInfo): { season: string; episode: Episode }[] {
  const seasons = Object.keys(series.episodes).sort((a, b) => {
    const [na, nb] = [Number(a), Number(b)];
    // Season 0 holds specials: after the real seasons
    if (na === 0 || nb === 0) return na === 0 ? 1 : -1;
    return na - nb;
  });
  return seasons.flatMap((season) =>
    [...(series.episodes[season] ?? [])]
      .sort((a, b) => a.episode_num - b.episode_num)
      .map((episode) => ({ season, episode }))
  );
}

/** What a series' Play button plays. */
export interface NextUp {
  season: string;
  episode: Episode;
  /** Set when the episode was left part-way. */
  resumeSecs?: number;
  /** 'resume' a half-watched episode, play the 'next' one, or 'start' the series. */
  kind: 'resume' | 'next' | 'start';
}

/**
 * The episode to carry on with: the last one watched if it was left part-way,
 * otherwise the one after it. Nothing watched yet, or the last one finished
 * the series: the first episode.
 */
export function nextUp(
  series: SeriesInfo,
  channelId: number,
  progress: ProgressIndex
): NextUp | null {
  const order = episodesInOrder(series);
  if (order.length === 0) return null;
  const latest = progress.latestByChannel.get(channelId);
  const at = latest ? order.findIndex((e) => e.episode.id === latest.episode_id) : -1;
  if (latest && at !== -1) {
    const resume = resumeSecs(latest);
    if (resume !== undefined) return { ...order[at], resumeSecs: resume, kind: 'resume' };
    // The first episode after it not yet watched (a season marked at once
    // leaves several watched in a row)
    if (latest.watched) {
      const next = order.findIndex(
        (e, i) => i > at && !progress.byKey.get(progressKey(channelId, e.episode.id))?.watched
      );
      if (next !== -1) return { ...order[next], kind: 'next' };
    }
  }
  // Specials come last in the order; start on the first real episode
  return { ...(order.find((e) => e.season !== '0') ?? order[0]), kind: 'start' };
}

/** The last episode of a series in viewing order (specials aside), or none. */
export function finaleOf(series: SeriesInfo): string | undefined {
  const order = episodesInOrder(series).filter((e) => e.season !== '0');
  return order[order.length - 1]?.episode.id;
}

/**
 * Home's Continue watching: titles with something left to watch, most recent
 * first. A film left part-way; a series being watched, until its final
 * episode (`finale`, when known) is watched. Watched films drop out.
 */
export function continueWatching(
  entries: WatchProgress[],
  isSeries: (id: number) => boolean,
  finale: (id: number) => string | undefined = () => undefined
) {
  const watched = new Set(
    entries.filter((e) => e.watched).map((e) => progressKey(e.channel_id, e.episode_id))
  );
  const out: number[] = [];
  const seen = new Set<number>();
  for (const e of entries) {
    if (seen.has(e.channel_id)) continue;
    seen.add(e.channel_id);
    if (isSeries(e.channel_id)) {
      const last = finale(e.channel_id);
      const finished = last !== undefined && watched.has(progressKey(e.channel_id, last));
      if (e.episode_id !== '' && !finished) out.push(e.channel_id);
    } else if (resumeSecs(e) !== undefined) {
      out.push(e.channel_id);
    }
  }
  return out;
}
