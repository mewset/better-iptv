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
