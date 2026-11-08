import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PIN_HOVER,
  PIN_HOVER_ON_SELECTED,
  PIN_PINNED,
  PIN_PINNED_ON_SELECTED,
  PIN_REST,
  PIN_REST_ON_SELECTED,
} from '../../components/categoryPinStyle';

// Measures the pin in the category bar against its chip, from the same token values and class
// strings the app ships: every state must clear 3:1 (WCAG 1.4.11, non-text contrast), and the
// faint pin at rest must use the lowest opacity (in steps of 5 %) that does.

type Rgb = [number, number, number];
type Theme = 'light' | 'dark';
const THEMES: Theme[] = ['light', 'dark'];
const FLOOR = 3;

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../../index.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in index.css`);
  return css.slice(start, css.indexOf('}', start));
}

const tokens: Record<Theme, Record<string, Rgb>> = { light: {}, dark: {} };
for (const [theme, selector] of [
  ['light', ':root'],
  ['dark', '.dark'],
] as const) {
  for (const m of block(selector).matchAll(/--color-([a-z0-9-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    tokens[theme][m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
}

function token(theme: Theme, name: string): Rgb {
  const value = tokens[theme][name] ?? (theme === 'dark' ? tokens.light[name] : undefined);
  if (!value) throw new Error(`--color-${name} missing for ${theme}`);
  return value;
}

/** The text colour a class string gives the pin in a theme: colour token and opacity (0..1). */
function pinColour(classes: string, theme: Theme): { name: string; alpha: number } {
  let plain: { name: string; alpha: number } | null = null;
  let dark: { name: string; alpha: number } | null = null;
  for (const cls of classes.split(/\s+/)) {
    const isDark = cls.startsWith('dark:');
    const m = (isDark ? cls.slice(5) : cls).match(/^text-([a-z-]+?)(?:\/(\d+))?$/);
    if (!m) continue;
    const value = { name: m[1], alpha: m[2] ? Number(m[2]) / 100 : 1 };
    if (isDark) dark = value;
    else plain = value;
  }
  // The dark: variant wins in the dark theme; otherwise the plain class applies
  const found = theme === 'dark' ? (dark ?? plain) : plain;
  if (!found) throw new Error(`no text colour in "${classes}"`);
  return found;
}

const mix = (fg: Rgb, bg: Rgb, a: number): Rgb =>
  [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)) as Rgb;

function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Unselected chip: `bg-text/5` over the page; selected chip: solid `bg-text`. */
function chip(theme: Theme, selected: boolean): Rgb {
  return selected ? token(theme, 'text') : mix(token(theme, 'text'), token(theme, 'bg'), 0.05);
}

function measure(classes: string, theme: Theme, selected: boolean, alpha?: number): number {
  const c = pinColour(classes, theme);
  const bg = chip(theme, selected);
  return contrast(mix(token(theme, c.name), bg, alpha ?? c.alpha), bg);
}

describe('category pin contrast', () => {
  for (const theme of THEMES) {
    it(`clears ${FLOOR}:1 in every state, ${theme} theme`, () => {
      expect(measure(PIN_REST, theme, false)).toBeGreaterThanOrEqual(FLOOR);
      expect(measure(PIN_REST_ON_SELECTED, theme, true)).toBeGreaterThanOrEqual(FLOOR);
      expect(measure(PIN_PINNED, theme, false)).toBeGreaterThanOrEqual(FLOOR);
      expect(measure(PIN_PINNED_ON_SELECTED, theme, true)).toBeGreaterThanOrEqual(FLOOR);
    });

    it(`uses one rest opacity on both chips, the lowest that clears ${FLOOR}:1, ${theme} theme`, () => {
      const alpha = pinColour(PIN_REST, theme).alpha;
      expect(pinColour(PIN_REST_ON_SELECTED, theme).alpha).toBe(alpha);
      const lower = alpha - 0.05;
      const lowerPasses =
        measure(PIN_REST, theme, false, lower) >= FLOOR &&
        measure(PIN_REST_ON_SELECTED, theme, true, lower) >= FLOOR;
      expect(lowerPasses).toBe(false);
    });
  }

  it('hovers in the pinned colour, in both themes', () => {
    const colourOf = (classes: string) => classes.split(/\s+/).find((c) => c.startsWith('text-'));
    for (const [hover, pinned] of [
      [PIN_HOVER, PIN_PINNED],
      [PIN_HOVER_ON_SELECTED, PIN_PINNED_ON_SELECTED],
    ]) {
      const colour = colourOf(pinned);
      // dark: comes after hover: in Tailwind's order, so the dark theme needs its own hover class
      expect(hover.split(/\s+/).sort()).toEqual([`dark:hover:${colour}`, `hover:${colour}`]);
    }
  });
});
