import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

/** A fresh copy of the module, so each test starts without a load in flight. */
async function freshFonts() {
  vi.resetModules();
  return import('../../lib/fonts');
}

function mockLoad() {
  const load = vi.fn<(font: string) => Promise<unknown[]>>().mockResolvedValue([]);
  Object.defineProperty(document, 'fonts', { writable: true, value: { load } });
  return load;
}

describe('loadAppFonts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for every face once, however often it is called', async () => {
    const load = mockLoad();
    const { loadAppFonts, APP_FONT_FACES } = await freshFonts();

    const first = loadAppFonts();
    const second = loadAppFonts();
    await first;

    expect(second).toBe(first);
    expect(load.mock.calls.map((c) => c[0])).toEqual(APP_FONT_FACES);
  });

  it('resolves when a face cannot be loaded', async () => {
    const load = mockLoad();
    load.mockRejectedValueOnce(new Error('network error'));
    const { loadAppFonts } = await freshFonts();

    await expect(loadAppFonts()).resolves.toBeUndefined();
  });

  it('lists exactly the faces whose stylesheets it imports', async () => {
    const { APP_FONT_FACES } = await freshFonts();
    const source = readFileSync('src/lib/fonts.ts', 'utf8');
    const imported = [...source.matchAll(/^import '@fontsource\/([a-z-]+)\/(\d+)\.css';$/gm)].map(
      ([, family, weight]) => {
        const name = family
          .split('-')
          .map((word) => word[0].toUpperCase() + word.slice(1))
          .join(' ');
        return `${weight} 1em "${name}"`;
      }
    );

    expect(imported.length).toBeGreaterThan(0);
    expect(APP_FONT_FACES).toEqual(imported);
  });
});
