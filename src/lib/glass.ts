/**
 * Whether the web view draws backdrop filters. WebKitGTK with its DMA-BUF
 * renderer off, the app's default on Linux, accepts `backdrop-filter` (so
 * `@supports` says yes) and draws nothing: a glass surface is then plain
 * see-through, with the text behind it showing through its own. The backend
 * knows which renderer runs and leaves a flag for the page before it loads.
 *
 * With the flag set, <html> gets `data-backdrop="none"` and the Tailwind
 * variant `no-backdrop:` makes glass surfaces opaque.
 */
declare global {
  interface Window {
    __BETTER_IPTV_NO_BACKDROP_FILTER__?: boolean;
  }
}

export function applyBackdropSupport(): void {
  if (window.__BETTER_IPTV_NO_BACKDROP_FILTER__ === true) {
    document.documentElement.dataset.backdrop = 'none';
  }
}
