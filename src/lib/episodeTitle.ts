/**
 * Providers often name an episode after its whole address: "Absentia - S01E01
 * - Comeback", "Absentia 1x01: Comeback", "Season 1 Episode 1 - Comeback".
 * The detail view already shows the series, the season and the number, so
 * this keeps only the episode's own name. Returns null when nothing of its
 * own is left ("Absentia - S01E01"), so the caller can fall back to TMDB or
 * "Episode N".
 */

// Episode codes: S01E01, S1 E1, S01E01-E02, 1x01, Season 1 Episode 1, Episode 1, Ep. 1, E01
const CODE =
  /(?:s\d{1,3}\s*e\d{1,4}(?:\s*-?\s*e?\d{1,4})?|\d{1,3}x\d{1,4}|season\s*\d{1,3}\s*(?:episode|ep\.?)\s*\d{1,4}|(?:episode|ep\.?)\s*\d{1,4}|e\d{1,4})/i;
const LEADING_CODE = new RegExp(`^${CODE.source}(?![0-9a-z])`, 'i');
const TRAILING_CODE = new RegExp(`[\\s(\\[]*${CODE.source}[)\\]]*$`, 'i');
// Separators between the parts. A title may end in its own full stop
// ("Fire. Water. Flare."), so the end keeps "." and ",".
const EDGES = /^[\s\-–—:|·•.,]+|[\s\-–—:|·•]+$/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The forms a series name may take at the start of an episode title: as
 * given, without a trailing "(2017)" / "[2017]", without a "UK: " or
 * "EN - " style provider prefix.
 */
function nameForms(names: string[]): RegExp[] {
  const forms = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const noYear = name.replace(/\s*[([]\d{4}[)\]]\s*$/, '').trim();
    const noPrefix = noYear.replace(/^[A-Z]{2,4}\s*[:|-]\s*/, '').trim();
    for (const form of [name, noYear, noPrefix]) if (form.length >= 2) forms.add(form);
  }
  // Longest first, so "Absentia (2017)" goes before "Absentia"
  return [...forms]
    .sort((a, b) => b.length - a.length)
    .map((form) => new RegExp(`^${escapeRegExp(form).replace(/\s+/g, '\\s+')}(?![0-9a-z])`, 'i'));
}

export function cleanEpisodeTitle(raw: string | undefined, seriesNames: string[]): string | null {
  let title = (raw ?? '').trim();
  if (!title) return null;
  const names = nameForms(seriesNames);

  // Peel the series name and the code off the front (in either order), then
  // a code left at the end ("Comeback (S01E01)")
  for (let pass = 0; pass < 4; pass++) {
    const before = title;
    title = title.replace(EDGES, '');
    for (const name of names) {
      if (name.test(title)) {
        title = title.replace(name, '');
        break;
      }
    }
    title = title.replace(EDGES, '').replace(LEADING_CODE, '');
    if (title === before) break;
  }
  title = title.replace(TRAILING_CODE, '').replace(EDGES, '');

  if (!title || /^\d+$/.test(title)) return null;
  if (names.some((name) => name.test(title) && title.replace(name, '').trim() === '')) return null;
  return title;
}
