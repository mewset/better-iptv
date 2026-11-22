/**
 * Folds a provider's category list into groups for the category sidebar, so
 * 80 categories read as a dozen folders:
 *
 * - a country prefix: "UK Sports", "UK: Movies", "US | News" → under the
 *   country ("United Kingdom"), each shown without the prefix;
 * - a year family: "Drama 2025", "Drama 2024" → "2025", "2024" under "Drama";
 * - a shared note in brackets, three or more: "EPL (Match time only)",
 *   "NBA (Live events)", "NHL (Live Events)" → "EPL" under "Match time only",
 *   "NBA" and "NHL" under "Live events";
 * - a shared last word, three or more: "ABC Regionals", "CBS Regionals",
 *   "Fox Regionals" → "ABC", "CBS", "Fox" under "Regionals".
 *
 * A group needs two members (three for a shared word); a category that fits
 * none stays on its own. Groups sit where their first member was, so the
 * provider's order still shows through.
 */

export interface CategoryEntry {
  /** The provider's category name (what the filter uses). */
  name: string;
  /** How it reads inside its group ("Sports" for "UK Sports"). */
  label: string;
}

export type CategoryNode =
  | { kind: 'category'; entry: CategoryEntry }
  | {
      kind: 'group';
      key: string;
      label: string;
      /** A short code shown before the label ("UK"), for country groups. */
      badge: string | null;
      members: CategoryEntry[];
    };

const COUNTRIES: Record<string, string> = {
  UK: 'United Kingdom',
  GB: 'United Kingdom',
  US: 'United States',
  USA: 'United States',
  CA: 'Canada',
  IE: 'Ireland',
  AU: 'Australia',
  NZ: 'New Zealand',
  DE: 'Germany',
  AT: 'Austria',
  CH: 'Switzerland',
  FR: 'France',
  BE: 'Belgium',
  NL: 'Netherlands',
  ES: 'Spain',
  PT: 'Portugal',
  IT: 'Italy',
  PL: 'Poland',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  FI: 'Finland',
  TR: 'Turkey',
  GR: 'Greece',
  IN: 'India',
  PK: 'Pakistan',
  AR: 'Arabic',
  BR: 'Brazil',
  MX: 'Mexico',
  LAT: 'Latin America',
  EX: 'Ex-Yugoslavia',
  AF: 'Africa',
};

// "UK Sports", "UK: Sports", "UK | Sports", "UK - Sports" (the code in capitals)
const PREFIX = /^([A-Z]{2,3})\s*(?:[:|-]\s*|\s+)(\S.*)$/;
// "Drama 2025", "Drama (2025)", "Drama - 2025"
const YEAR = /^(.*\S)\s*(?:-\s*)?\(?((?:19|20)\d{2})\)?$/;

function prefixOf(name: string): { code: string; rest: string } | null {
  const m = PREFIX.exec(name.trim());
  if (!m || !(m[1] in COUNTRIES)) return null;
  return { code: m[1] === 'GB' ? 'UK' : m[1] === 'USA' ? 'US' : m[1], rest: m[2].trim() };
}

function yearOf(name: string): { base: string; year: string } | null {
  const m = YEAR.exec(name.trim());
  return m ? { base: m[1].trim(), year: m[2] } : null;
}

function noteOf(name: string): { head: string; note: string } | null {
  const m = /^(.*\S)\s*\(([^()]*[A-Za-z][^()]*)\)$/.exec(name.trim());
  return m ? { head: m[1].trim(), note: m[2].trim() } : null;
}

// A plain word only: "Regionals", not "only)" or "(EPL)"
function lastWord(name: string): { head: string; word: string } | null {
  const m = /^(.*\S)\s+([A-Za-z][A-Za-z&'+-]*)$/.exec(name.trim());
  return m ? { head: m[1], word: m[2] } : null;
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function groupCategories(names: readonly string[]): CategoryNode[] {
  // Each name's group (by rule, in priority order), or none
  const keyOf = new Map<
    string,
    { key: string; label: string; badge: string | null; entry: CategoryEntry }
  >();
  const size = new Map<string, number>();
  const assign = (
    name: string,
    key: string,
    label: string,
    badge: string | null,
    entryLabel: string
  ) => {
    keyOf.set(name, { key, label, badge, entry: { name, label: entryLabel } });
    size.set(key, (size.get(key) ?? 0) + 1);
  };
  const unassign = (name: string) => {
    const g = keyOf.get(name);
    if (!g) return;
    keyOf.delete(name);
    size.set(g.key, (size.get(g.key) ?? 1) - 1);
  };

  for (const name of names) {
    const p = prefixOf(name);
    if (p) assign(name, `country:${p.code}`, COUNTRIES[p.code], p.code, p.rest);
  }
  // A lone country member is not a group: back to a plain name
  for (const name of names) {
    const g = keyOf.get(name);
    if (g && (size.get(g.key) ?? 0) < 2) unassign(name);
  }
  for (const name of names) {
    if (keyOf.has(name)) continue;
    const y = yearOf(name);
    if (y) assign(name, `year:${y.base.toLowerCase()}`, y.base, null, y.year);
  }
  for (const name of names) {
    const g = keyOf.get(name);
    if (g?.key.startsWith('year:') && (size.get(g.key) ?? 0) < 2) unassign(name);
  }
  for (const name of names) {
    if (keyOf.has(name)) continue;
    const n = noteOf(name);
    if (n) assign(name, `note:${n.note.toLowerCase()}`, capitalised(n.note), null, n.head);
  }
  for (const name of names) {
    const g = keyOf.get(name);
    if (g?.key.startsWith('note:') && (size.get(g.key) ?? 0) < 3) unassign(name);
  }
  for (const name of names) {
    if (keyOf.has(name)) continue;
    const w = lastWord(name);
    if (w) assign(name, `word:${w.word.toLowerCase()}`, w.word, null, w.head);
  }
  for (const name of names) {
    const g = keyOf.get(name);
    if (g?.key.startsWith('word:') && (size.get(g.key) ?? 0) < 3) unassign(name);
  }

  const out: CategoryNode[] = [];
  const groups = new Map<string, Extract<CategoryNode, { kind: 'group' }>>();
  for (const name of names) {
    const g = keyOf.get(name);
    if (!g) {
      out.push({ kind: 'category', entry: { name, label: name } });
      continue;
    }
    let group = groups.get(g.key);
    if (!group) {
      group = { kind: 'group', key: g.key, label: g.label, badge: g.badge, members: [] };
      groups.set(g.key, group);
      out.push(group);
    }
    group.members.push(g.entry);
  }
  return out;
}
