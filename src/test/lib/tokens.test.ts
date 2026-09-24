import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../../index.css'), 'utf8');
const tw = readFileSync(resolve(here, '../../../tailwind.config.js'), 'utf8');

const TOKENS = [
  'bg',
  'surface',
  'surface-2',
  'surface-hover',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'text-faint',
  'accent',
  'accent-hover',
  'accent-text',
  'on-accent',
  'danger',
  'on-danger',
  'success',
];

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block missing`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('design tokens', () => {
  it.each(TOKENS)('defines --color-%s in :root', (t) => {
    expect(block(':root')).toMatch(new RegExp(`--color-${t}:\\s*\\d+ \\d+ \\d+;`));
  });

  it.each(TOKENS.filter((t) => !['accent', 'accent-hover', 'on-accent'].includes(t)))(
    'defines --color-%s in .dark',
    (t) => {
      expect(block('.dark')).toMatch(new RegExp(`--color-${t}:\\s*\\d+ \\d+ \\d+;`));
    }
  );

  it.each(TOKENS)('maps %s in tailwind.config.js', (t) => {
    expect(tw).toContain(`var(--color-${t})`);
  });
});

function value(selector: string, token: string): string {
  const m = block(selector).match(new RegExp(`--color-${token}:\\s*([\\d ]+);`));
  return m ? m[1].trim() : '';
}

describe('3.0 palette', () => {
  it('uses the measured dark values', () => {
    expect(value('.dark', 'bg')).toBe('15 16 19');
    expect(value('.dark', 'text')).toBe('242 242 240');
    expect(value('.dark', 'text-faint')).toBe('133 137 148');
    expect(value('.dark', 'accent')).toBe('242 180 65');
    expect(value('.dark', 'on-accent')).toBe('20 20 20');
  });

  it('keeps accent text readable in light mode', () => {
    // Raw amber on white measures 1.85:1; this dark amber measures 5.67:1 on gray-50.
    expect(value(':root', 'accent-text')).toBe('138 90 0');
    expect(value(':root', 'on-accent')).toBe('20 20 20');
  });
});
