import type { ChannelLoadStatus, Section } from '../stores/player-store';

/**
 * What a section can show right now, given the two parts of the channel list.
 * The guide and an unfiltered Live need only the live part. Everything else
 * needs the library too, and so does any search, because search spans every
 * content type.
 */
export function sectionLoadStatus(
  section: Section,
  hasQuery: boolean,
  load: { live: ChannelLoadStatus; library: ChannelLoadStatus }
): ChannelLoadStatus {
  if (section === 'home') return 'loaded';
  const liveOnly = section === 'guide' || (section === 'live' && !hasQuery);
  const parts = liveOnly ? [load.live] : [load.live, load.library];
  if (parts.includes('error')) return 'error';
  if (parts.includes('loading')) return 'loading';
  return 'loaded';
}
