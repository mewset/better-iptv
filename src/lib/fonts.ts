import '@fontsource/familjen-grotesk/500.css';
import '@fontsource/familjen-grotesk/600.css';
import '@fontsource/familjen-grotesk/700.css';
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import '@fontsource/schibsted-grotesk/600.css';
import '@fontsource/schibsted-grotesk/700.css';

/**
 * The faces imported above, as CSS font shorthands for `document.fonts.load`.
 * One entry per stylesheet: a face missing here is loaded late again.
 */
export const APP_FONT_FACES = [
  '500 1em "Familjen Grotesk"',
  '600 1em "Familjen Grotesk"',
  '700 1em "Familjen Grotesk"',
  '400 1em "Schibsted Grotesk"',
  '500 1em "Schibsted Grotesk"',
  '600 1em "Schibsted Grotesk"',
  '700 1em "Schibsted Grotesk"',
];

let loading: Promise<void> | undefined;

/**
 * Loads the app's own font faces. Left alone, a web font starts loading when
 * the first layout asks for it, and that layout then matches fallbacks among
 * the system fonts for every size and weight: with 2,500 fonts installed that
 * was 49 of the first layout's 71 ms, and the text changed font once the
 * faces arrived.
 *
 * The first call starts the loads; every call returns the same promise. It
 * resolves when each face has loaded or failed, and never rejects: a face
 * that cannot be loaded leaves that text on the fallback, as before.
 */
export function loadAppFonts(): Promise<void> {
  loading ??= Promise.allSettled(APP_FONT_FACES.map((face) => document.fonts.load(face))).then(
    () => undefined
  );
  return loading;
}
