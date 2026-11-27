/**
 * When an episode aired, from TMDB's `air_date` or the provider's
 * `releaseDate`: "14 Jun 2024", or "Airs 3 Dec 2026" for one still to come.
 * Read as a calendar date (no time zone shift); anything else gives null.
 */
export function airDateLabel(raw: string | null | undefined, today = new Date()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw?.trim() ?? '');
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  const text = AIR_DATE.format(date);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return date > startOfToday ? `Airs ${text}` : text;
}

const AIR_DATE = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
