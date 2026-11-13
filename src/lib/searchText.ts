import type { Channel } from '../types';

/**
 * How the search compares text: without regard to case, accents on Latin
 * letters or stray spaces, so "tele", "TÉLÉ" and " télé " all find "Télé".
 *
 * An accent is a mark Unicode can split off its letter (é, å, ö, ñ, ç, š
 * and so on). Letters that are their own letter (ø, æ, ß) stay as they are,
 * and so does every other script, where such a mark often makes another
 * letter or another word (й, Hindi and Thai vowel signs). Spaces are trimmed
 * at both ends and a run of them counts as one.
 */
export function foldSearchText(text: string): string {
  let folded = text.toLowerCase();
  // Most channel names are plain ASCII with single spaces, and a 26,000-channel
  // list is folded in one go on the first search: the two steps below are
  // skipped for a name that does not need them.
  if (NON_ASCII.test(folded)) {
    folded = folded.normalize('NFD').replace(LATIN_ACCENTS, '$1').normalize('NFC');
  }
  if (UNTIDY_SPACES.test(folded)) {
    folded = folded.trim().replace(/\s+/g, ' ');
  }
  return folded;
}

const NON_ASCII = /[\u0080-\uffff]/;
/** A Latin letter (lower case, taken apart by NFD) and the marks on it. */
const LATIN_ACCENTS = /([a-z])\p{M}+/gu;
/** A space at either end, two in a row, or white space that is not a plain space. */
const UNTIDY_SPACES = /^\s|\s$|\s\s|[^\S ]/;

/**
 * The folded text of a channel, name and category, kept per channel object
 * so a 26,000-channel list is folded once rather than on every keystroke.
 * A renamed or regrouped channel is a new object (a reloaded list) and gets
 * a new key; the old key goes with its object.
 */
const keys = new WeakMap<Channel, string>();

function searchKey(channel: Channel): string {
  let key = keys.get(channel);
  if (key === undefined) {
    // The line break keeps a query from matching across name and category.
    key = `${foldSearchText(channel.name)}\n${foldSearchText(channel.group_name ?? '')}`;
    keys.set(channel, key);
  }
  return key;
}

/**
 * The channels whose name or category contains `query`. An empty query
 * (or only spaces) matches everything and returns `channels` itself.
 */
export function searchChannels<T extends Channel>(channels: T[], query: string): T[] {
  const folded = foldSearchText(query);
  if (folded === '') return channels;
  return channels.filter((channel) => searchKey(channel).includes(folded));
}
