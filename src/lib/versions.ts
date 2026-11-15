import type { Channel } from '../types';
import { foldSearchText } from './searchText';

/**
 * Providers often list one film several times: a standard copy, a 4K copy
 * and dubbed copies in language categories ("German Movies", "Films
 * Français"), each its own stream. These helpers tell the copies of one film
 * apart (quality, language) and group them, so the grid can show one card
 * per film and the detail view a version picker.
 */

export type Quality = 'standard' | '4k';

/** The viewer's default pick among versions. `language` null: the original. */
export interface VersionPrefs {
  quality: Quality;
  language: string | null;
}

export const DEFAULT_VERSION_PREFS: VersionPrefs = { quality: '4k', language: null };

// "4K", "UHD" or "2160p" as a word of its own, so "24K Magic" is not 4K.
const FOUR_K = /(^|[^0-9a-z])(4k|uhd|2160p?)(?![0-9a-z])/i;

/** Languages a dub is labelled with: the name shown, then the words and codes that mark it. */
export const LANGUAGES: ReadonlyArray<{ name: string; words: string[]; codes: string[] }> = [
  { name: 'German', words: ['german', 'deutsch', 'deutsche'], codes: ['de', 'ger'] },
  {
    name: 'French',
    words: ['french', 'francais', 'francaise', 'films francais'],
    codes: ['fr', 'fre', 'vf', 'vff'],
  },
  {
    name: 'Spanish',
    words: ['spanish', 'espanol', 'castellano', 'latino'],
    codes: ['es', 'esp', 'spa', 'lat'],
  },
  { name: 'Italian', words: ['italian', 'italiano', 'italiani'], codes: ['it', 'ita'] },
  { name: 'Dutch', words: ['dutch', 'nederlands', 'nederlandse'], codes: ['nl'] },
  { name: 'Polish', words: ['polish', 'polski', 'polskie'], codes: ['pl'] },
  {
    name: 'Portuguese',
    words: ['portuguese', 'portugues', 'brasil', 'brazil', 'brazilian'],
    codes: ['pt', 'br'],
  },
  { name: 'Turkish', words: ['turkish', 'turk', 'turkce'], codes: ['tr'] },
  { name: 'Arabic', words: ['arabic', 'arab', 'arabe'], codes: ['ar'] },
  { name: 'Hindi', words: ['hindi', 'bollywood'], codes: ['hi', 'in'] },
  { name: 'Swedish', words: ['swedish', 'svenska', 'svensk'], codes: ['sv', 'se'] },
  { name: 'Norwegian', words: ['norwegian', 'norsk'], codes: ['no'] },
  { name: 'Danish', words: ['danish', 'dansk'], codes: ['da', 'dk'] },
  { name: 'Finnish', words: ['finnish', 'suomi', 'suomalainen'], codes: ['fi'] },
];

function hasWord(folded: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${word.replace(/\s+/g, '\\s+')}(?![a-z])`).test(folded);
}

// A language code as a tag of its own: "[DE]", "|FR|", "(ES)", or "DE - " / "DE: " at the start
function codeTag(name: string): string | null {
  const folded = foldSearchText(name);
  const bracketed = /[[|(]\s*([a-z]{2,3})\s*[\]|)]/.exec(folded);
  if (bracketed) return bracketed[1];
  const leading = /^([a-z]{2,3})\s*[-:|]\s+/.exec(folded);
  return leading ? leading[1] : null;
}

/** Whether a version is 4K, by its name or its category. */
export function versionQuality(channel: Pick<Channel, 'name' | 'group_name'>): Quality {
  return FOUR_K.test(channel.name) || FOUR_K.test(channel.group_name ?? '') ? '4k' : 'standard';
}

/**
 * The dub language of a version, from its category ("German Movies") or a
 * tag in its name ("[DE] Title", "FR - Title"); null when it is the
 * original (nothing marks a language).
 */
export function versionLanguage(channel: Pick<Channel, 'name' | 'group_name'>): string | null {
  const group = foldSearchText(channel.group_name ?? '');
  for (const lang of LANGUAGES) {
    if (lang.words.some((w) => hasWord(group, w))) return lang.name;
  }
  const code = codeTag(channel.name);
  if (code) {
    const lang = LANGUAGES.find((l) => l.codes.includes(code));
    if (lang) return lang.name;
  }
  return null;
}

/**
 * What makes two entries the same film: the folded title and year without
 * quality or language tags. "The Dark Knight (2008) 4K", "[DE] The Dark
 * Knight (2008)" and "The Dark Knight (2008)" share one key.
 */
export function titleKey(name: string): string {
  let key = foldSearchText(name);
  key = key.replace(/[[|(]\s*[a-z]{2,3}\s*[\]|)]/g, ' '); // [DE], |FR|, (ES)
  key = key.replace(/^[a-z]{2,3}\s*[-:|]\s+/, ''); // "DE - Title"
  key = key.replace(
    /(^|[^0-9a-z])(4k|uhd|2160p?|1080p|720p|fhd|hd|hdr|multi[\s-]?sub)(?![0-9a-z])/g,
    ' '
  );
  return key
    .replace(/[\s\-–—:|.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The section's entries grouped by film; each group in list order. */
export function groupVersions(channels: Channel[]): Map<string, Channel[]> {
  const groups = new Map<string, Channel[]>();
  for (const channel of channels) {
    const key = titleKey(channel.name);
    const group = groups.get(key);
    if (group) group.push(channel);
    else groups.set(key, [channel]);
  }
  return groups;
}

/**
 * The version to play by default: the preferred language and quality; else
 * the preferred language in any quality; else the original in the preferred
 * quality; else the first.
 */
export function pickVersion(versions: Channel[], prefs: VersionPrefs): Channel {
  const lang = (c: Channel) => versionLanguage(c);
  return (
    versions.find((c) => lang(c) === prefs.language && versionQuality(c) === prefs.quality) ??
    versions.find((c) => lang(c) === prefs.language) ??
    versions.find((c) => lang(c) === null && versionQuality(c) === prefs.quality) ??
    versions.find((c) => lang(c) === null) ??
    versions[0]
  );
}

/**
 * One entry per film, in the list's order (a film sits where its first
 * version did), each the version `pickVersion` prefers among all its
 * versions in `groups`. Entries whose film has a single version pass as is,
 * and so does anything that is not a movie (a search mixes types).
 */
export function collapseVersions(
  list: Channel[],
  groups: Map<string, Channel[]>,
  prefs: VersionPrefs
): Channel[] {
  const seen = new Set<string>();
  const out: Channel[] = [];
  for (const channel of list) {
    if (channel.content_type !== 'vod') {
      out.push(channel);
      continue;
    }
    const key = titleKey(channel.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const group = groups.get(key);
    out.push(group && group.length > 1 ? pickVersion(group, prefs) : channel);
  }
  return out;
}
