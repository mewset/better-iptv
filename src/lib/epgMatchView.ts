import type { Channel } from '../types';
import {
  GUIDE_SEARCH_MIN_CHARS,
  type EpgChannelHit,
  type ManualMatch,
  type MatchDetails,
} from './epgIpc';
import { isAdultContent } from './parentalControls';

// Wording and searching for the manual match picker in Settings → EPG,
// kept apart from the components so it can be tested without rendering.

/** At most this many of your channels are listed per search. */
export const CHANNEL_HITS = 50;

/** A channel list ready to search: its names lower-cased once. */
export interface ChannelIndex {
  channels: Channel[];
  names: string[];
}

/** Built once per channel list, so a search never lower-cases 150,000 names again. */
export function channelIndex(channels: Channel[]): ChannelIndex {
  return { channels, names: channels.map((c) => c.name.toLowerCase()) };
}

export interface ChannelSearch {
  /** Names that start with the query first, then the rest, each in list order. */
  hits: Channel[];
  /** Every channel the query finds, listed or not. */
  total: number;
}

/**
 * The channels whose name contains `query` (case-insensitive), at most
 * `limit`. One pass; only the listed channels are collected. An empty
 * query finds nothing.
 */
export function findChannels(
  index: ChannelIndex,
  query: string,
  limit = CHANNEL_HITS
): ChannelSearch {
  const q = query.trim().toLowerCase();
  if (!q) return { hits: [], total: 0 };
  const starts: Channel[] = [];
  const contains: Channel[] = [];
  let total = 0;
  for (let i = 0; i < index.names.length; i++) {
    const at = index.names[i].indexOf(q);
    if (at < 0) continue;
    total++;
    if (at === 0) {
      if (starts.length < limit) starts.push(index.channels[i]);
    } else if (contains.length < limit) {
      contains.push(index.channels[i]);
    }
  }
  return { hits: starts.concat(contains).slice(0, limit), total };
}

/** `MatchDetails` keyed for lookups per channel. */
export interface MatchLookup {
  manual: Map<number, ManualMatch>;
  byName: Set<number>;
}

export function matchLookup(details: MatchDetails): MatchLookup {
  return {
    manual: new Map(details.manual.map((m) => [m.channel_id, m])),
    byName: new Set(details.by_name),
  };
}

/** How a channel finds its guide; `matched` while the details are not known yet. */
export type MatchKind = 'id' | 'name' | 'manual' | 'manual_empty' | 'matched' | 'none';

export interface MatchState {
  kind: MatchKind;
  text: string;
}

/** A channel's guide state, as the picker shows it under its name. */
export function matchState(channel: Channel, lookup: MatchLookup | null): MatchState {
  const manual = lookup?.manual.get(channel.id);
  if (manual) {
    return manual.has_programmes
      ? { kind: 'manual', text: `Set by hand · ${manual.guide_name ?? manual.key}` }
      : { kind: 'manual_empty', text: 'Set by hand, guide has no programmes now' };
  }
  if (!channel.epg_id) return { kind: 'none', text: 'No guide' };
  if (lookup === null) return { kind: 'matched', text: `Matched · ${channel.epg_id}` };
  if (lookup.byName.has(channel.id)) {
    return { kind: 'name', text: `Matched by name · ${channel.epg_id}` };
  }
  return { kind: 'id', text: `Matched by id · ${channel.epg_id}` };
}

/** A guide channel's name, or its key when the feed names it nowhere. */
export function hitTitle(hit: EpgChannelHit): string {
  return hit.name ?? hit.key;
}

/**
 * Whether the guide search takes `query`: at least `GUIDE_SEARCH_MIN_CHARS`
 * characters both trimmed (as a key) and with underscores and runs of
 * spaces read as one space (as a name), as the backend counts them.
 */
export function guideSearchable(query: string): boolean {
  const key = query.trim();
  const name = query.replace(/_/g, ' ').trim().replace(/\s+/g, ' ');
  return [...key].length >= GUIDE_SEARCH_MIN_CHARS && [...name].length >= GUIDE_SEARCH_MIN_CHARS;
}

/**
 * The guide hits to list. While parental controls are locked, a guide
 * channel whose name or key looks adult is left out: the guide has no
 * category to block by, so the auto-detection markers are all there is.
 */
export function visibleGuideHits(hits: EpgChannelHit[], locked: boolean): EpgChannelHit[] {
  if (!locked) return hits;
  return hits.filter((hit) => !isAdultContent(hitTitle(hit)) && !isAdultContent(hit.key));
}

/** The line under a guide channel: its key and where it comes from. */
export function hitDetails(hit: EpgChannelHit): string {
  return `${hit.key} · ${hit.source_label}`;
}

/** What the manual list shows a match as: the guide's name, or its key. */
export function manualTarget(match: ManualMatch): string {
  if (!match.has_programmes) return `${match.key} (guide has no programmes now)`;
  return match.guide_name ? `${match.guide_name} (${match.key})` : match.key;
}
