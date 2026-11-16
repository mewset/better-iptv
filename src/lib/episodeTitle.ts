/**
 * Providers often name an episode after its whole address: "Absentia - S01E01
 * - Comeback", "Absentia 1x01: Comeback", "Season 1 Episode 1 - Comeback".
 * The detail view already shows the series, the season and the number, so
 * this keeps only the episode's own name.
 *
 * Only an address is removed: an episode code at the start, with the series
 * name in front of it or not, and a season-and-episode code at the end. A
 * title without a code is returned as it is, so an episode that is itself
 * named after the series ("Chuck Versus the Intersect", "House's Head") or
 * after a number ("4 Days Out", "Step 2") keeps its name.
 *
 * Returns null when nothing of the episode's own is left ("Absentia -
 * S01E01", or only the series name), so the caller can fall back to TMDB or
 * "Episode N".
 */

// Codes that name a season and an episode: S01E01, S1 E1, S01E01-E02,
// S01E01E02, S01E01-02, Season 1 Episode 1. A second episode has to sit right
// against the first, so "S02E09 - 4 Days Out" keeps its 4.
const SEASON_EPISODE = String.raw`s\d{1,3}\s*e\d{1,4}(?:-?e\d{1,4}|-\d{1,4})?|season\s*\d{1,3}\s*(?:episode|ep\.?)\s*\d{1,4}`;
// Codes read as one only at the start of a title: 1x01, Episode 1, Ep. 1, E01
const START_ONLY = String.raw`\d{1,3}x\d{1,4}|(?:episode|ep\.?)\s*\d{1,4}|e\d{1,4}`;
// A code ends where its digits end: "Episodes of Doubt" and "Exodus" are names
const CODE_AT_START = String.raw`(?:${SEASON_EPISODE}|${START_ONLY})(?![0-9a-z])`;

const LEADING_CODE = new RegExp(`^${CODE_AT_START}`, 'i');
// One separator between the code and the name. No more than one: a title
// may open with its own punctuation ("...In Translation").
const AFTER_CODE = /^\s*[-–—:|·•.,]?\s*/;
// "Comeback (S01E01)", "Comeback - S01E01", "Comeback S01E01"
const TRAILING_CODE = new RegExp(
  String.raw`(?:[\s\-–—:|·•]+[([]?|[([])\s*(?:${SEASON_EPISODE})\s*[)\]]?$`,
  'i'
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The forms a series name may take in an episode title: as given, without a
 * trailing "(2017)" / "[2017]", without a "UK: " or "EN - " style provider
 * prefix. Longest first, each as a pattern source with loose whitespace.
 */
function nameForms(names: string[]): string[] {
  const forms = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const noYear = name.replace(/\s*[([]\d{4}[)\]]\s*$/, '').trim();
    const noPrefix = noYear.replace(/^[A-Z]{2,4}\s*[:|-]\s*/, '').trim();
    for (const form of [name, noYear, noPrefix]) if (form.length >= 2) forms.add(form);
  }
  return [...forms]
    .sort((a, b) => b.length - a.length)
    .map((form) => escapeRegExp(form).replace(/\s+/g, '\\s+'));
}

export function cleanEpisodeTitle(raw: string | undefined, seriesNames: string[]): string | null {
  const title = (raw ?? '').trim();
  if (!title) return null;
  const forms = nameForms(seriesNames);
  // Only the series name, as providers without episode names send it
  if (forms.some((form) => new RegExp(`^${form}$`, 'i').test(title))) return null;

  let rest = title;
  // The series name counts as part of the address only with a code after it
  for (const form of forms) {
    const name = new RegExp(`^${form}[\\s\\-–—:|·•.,]*(?=${CODE_AT_START})`, 'i').exec(rest);
    if (name) {
      rest = rest.slice(name[0].length);
      break;
    }
  }
  const code = LEADING_CODE.exec(rest);
  if (code) rest = rest.slice(code[0].length).replace(AFTER_CODE, '');
  rest = rest.replace(TRAILING_CODE, '').trim();

  return rest || null;
}
