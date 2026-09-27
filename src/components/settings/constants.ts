// Language options with ISO codes for MPV
export const LANGUAGE_OPTIONS = [
  { code: 'none', name: 'None (Original)', iso: '' },
  { code: 'sv', name: 'Svenska (Swedish)', iso: 'sv,swe,se' },
  { code: 'en', name: 'English', iso: 'en,eng' },
  { code: 'no', name: 'Norsk (Norwegian)', iso: 'no,nor,nb,nn' },
  { code: 'da', name: 'Dansk (Danish)', iso: 'da,dan' },
  { code: 'fi', name: 'Suomi (Finnish)', iso: 'fi,fin' },
  { code: 'de', name: 'Deutsch (German)', iso: 'de,deu,ger' },
  { code: 'fr', name: 'Francais (French)', iso: 'fr,fra,fre' },
  { code: 'es', name: 'Espanol (Spanish)', iso: 'es,spa' },
  { code: 'it', name: 'Italiano (Italian)', iso: 'it,ita' },
  { code: 'pt', name: 'Portugues (Portuguese)', iso: 'pt,por' },
  { code: 'nl', name: 'Nederlands (Dutch)', iso: 'nl,nld,dut' },
  { code: 'pl', name: 'Polski (Polish)', iso: 'pl,pol' },
  { code: 'ru', name: 'Russkij (Russian)', iso: 'ru,rus' },
  { code: 'ar', name: 'Al-Arabiya (Arabic)', iso: 'ar,ara' },
  { code: 'tr', name: 'Turkce (Turkish)', iso: 'tr,tur' },
  { code: 'ja', name: 'Nihongo (Japanese)', iso: 'ja,jpn' },
  { code: 'zh', name: 'Zhongwen (Chinese)', iso: 'zh,chi,zho' },
  { code: 'ko', name: 'Hangugeo (Korean)', iso: 'ko,kor' },
] as const;

export const USER_AGENT_OPTIONS = [
  { mode: 'default', label: 'Default (Better-IP-TV)' },
  { mode: 'tivimate', label: 'TiviMate' },
  { mode: 'vlc', label: 'VLC' },
  { mode: 'custom', label: 'Custom' },
] as const;

export type LanguageCode = (typeof LANGUAGE_OPTIONS)[number]['code'];
export type UserAgentMode = (typeof USER_AGENT_OPTIONS)[number]['mode'];
export type Theme = 'light' | 'dark' | 'system';
export type ParentalVisibility = 'hide' | 'lock' | 'blur';

// MPV playback settings
export type VideoOutput = 'gpu-next' | 'gpu' | 'x11';
export type DeinterlaceMode = 'no' | 'yes' | 'auto';

export const VIDEO_OUTPUT_OPTIONS = [
  {
    value: 'gpu-next' as const,
    label: 'GPU Next (Recommended)',
    description: 'Modern GPU rendering, best quality',
  },
  {
    value: 'gpu' as const,
    label: 'GPU',
    description: 'Standard GPU rendering, wider compatibility',
  },
  {
    value: 'x11' as const,
    label: 'X11 (Software)',
    description: 'Software fallback if GPU causes issues',
  },
];

export const DEINTERLACE_OPTIONS = [
  {
    value: 'auto' as const,
    label: 'Auto',
    description: 'Deinterlace only when interlaced content is detected',
  },
  { value: 'yes' as const, label: 'Always', description: 'Force deinterlacing on all content' },
  { value: 'no' as const, label: 'Off', description: 'Never deinterlace' },
];

export const CACHE_SECONDS_OPTIONS = [
  { value: 10, label: '10 seconds' },
  { value: 30, label: '30 seconds (Default)' },
  { value: 60, label: '60 seconds' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
];

// Metadata (TMDB) languages; tags are what TMDB's `language` parameter accepts.
export const TMDB_LANGUAGE_OPTIONS = [
  { tag: 'en-US', name: 'English' },
  { tag: 'sv-SE', name: 'Svenska' },
  { tag: 'da-DK', name: 'Dansk' },
  { tag: 'nb-NO', name: 'Norsk' },
  { tag: 'fi-FI', name: 'Suomi' },
  { tag: 'de-DE', name: 'Deutsch' },
  { tag: 'fr-FR', name: 'Français' },
  { tag: 'es-ES', name: 'Español' },
  { tag: 'it-IT', name: 'Italiano' },
  { tag: 'nl-NL', name: 'Nederlands' },
  { tag: 'pt-BR', name: 'Português' },
  { tag: 'pl-PL', name: 'Polski' },
  { tag: 'tr-TR', name: 'Türkçe' },
  { tag: 'ar-SA', name: 'العربية' },
] as const;
export type TmdbLanguage = (typeof TMDB_LANGUAGE_OPTIONS)[number]['tag'];
/** Required by TMDB's terms wherever their data is shown or configured. */
export const TMDB_ATTRIBUTION =
  'This product uses the TMDB API but is not endorsed or certified by TMDB.';
