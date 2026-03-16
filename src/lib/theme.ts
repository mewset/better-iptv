import type { Theme } from '../components/settings/constants';

const THEME_CACHE_KEY = 'better-iptv-theme';

let mediaQuery: MediaQueryList | null = null;
let mediaQueryHandler: ((e: MediaQueryListEvent) => void) | null = null;

function setDarkClass(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
}

export function applyTheme(theme: Theme) {
  // Cache in localStorage for instant apply on next launch
  localStorage.setItem(THEME_CACHE_KEY, theme);

  // Clean up previous system listener
  if (mediaQuery && mediaQueryHandler) {
    mediaQuery.removeEventListener('change', mediaQueryHandler);
    mediaQueryHandler = null;
  }

  if (theme === 'system') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setDarkClass(mediaQuery.matches);
    mediaQueryHandler = (e) => setDarkClass(e.matches);
    mediaQuery.addEventListener('change', mediaQueryHandler);
  } else {
    setDarkClass(theme === 'dark');
  }
}

/** Synchronous apply from localStorage cache — call before React renders */
export function applyThemeFromCache() {
  const cached = localStorage.getItem(THEME_CACHE_KEY) as Theme | null;
  applyTheme(cached || 'system');
}
