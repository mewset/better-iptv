import { describe, expect, it } from 'vitest';
import {
  APP_VERSION_FILES,
  findVersionChanges,
  findVersionLine,
  formatAnnotation,
  readAppVersion,
} from './version-files.mjs';

describe('readAppVersion', () => {
  it('reads the top-level version from package.json', () => {
    const text = '{"name":"better-ip-tv","version":"2.8.1","dependencies":{"react":"18.3.1"}}';
    expect(readAppVersion('package.json', text)).toBe('2.8.1');
  });

  it('reads the top-level version from tauri.conf.json', () => {
    const text = '{"productName":"Better IPTV","version":"2.8.1","bundle":{"active":true}}';
    expect(readAppVersion('src-tauri/tauri.conf.json', text)).toBe('2.8.1');
  });

  it('reads the package version from Cargo.toml, not a dependency version', () => {
    const text = [
      '[package]',
      'name = "better-ip-tv"',
      'version = "2.8.1"',
      'edition = "2021"',
      '',
      '[dependencies]',
      'serde = { version = "1.0.99" }',
      'tokio = "9.9.9"',
    ].join('\n');
    expect(readAppVersion('src-tauri/Cargo.toml', text)).toBe('2.8.1');
  });

  it('reads only the app entry from Cargo.lock, never a dependency entry', () => {
    // Cargo.lock carries a version line for every dependency. A PR that bumps
    // one of those is legitimate and must not read as an app version change.
    const text = [
      'version = 4',
      '',
      '[[package]]',
      'name = "anyhow"',
      'version = "1.0.100"',
      '',
      '[[package]]',
      'name = "better-ip-tv"',
      'version = "2.8.1"',
      'dependencies = [',
      ' "anyhow",',
      ']',
      '',
      '[[package]]',
      'name = "zerocopy"',
      'version = "0.8.27"',
    ].join('\n');
    expect(readAppVersion('src-tauri/Cargo.lock', text)).toBe('2.8.1');
  });

  it('is not fooled by an app entry that sorts after a similarly named crate', () => {
    const text = [
      '[[package]]',
      'name = "better-ip-tv-helper"',
      'version = "0.1.0"',
      '',
      '[[package]]',
      'name = "better-ip-tv"',
      'version = "2.8.1"',
    ].join('\n');
    expect(readAppVersion('src-tauri/Cargo.lock', text)).toBe('2.8.1');
  });

  it('throws a named error when the file does not carry a version at all', () => {
    expect(() => readAppVersion('package.json', '{"name":"x"}')).toThrow(/package\.json/);
    expect(() => readAppVersion('src-tauri/Cargo.lock', '[[package]]\nname = "anyhow"')).toThrow(
      /Cargo\.lock/
    );
  });

  it('throws for a path it does not know how to read', () => {
    expect(() => readAppVersion('README.md', 'hello')).toThrow(/README\.md/);
  });
});

describe('APP_VERSION_FILES', () => {
  it('lists exactly the four files CONTRIBUTING.md names', () => {
    expect(APP_VERSION_FILES).toEqual([
      'package.json',
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
      'src-tauri/tauri.conf.json',
    ]);
  });
});

describe('findVersionChanges', () => {
  it('is empty when every file agrees with the base', () => {
    const same = { 'package.json': '2.8.1', 'src-tauri/Cargo.toml': '2.8.1' };
    expect(findVersionChanges(same, { ...same })).toEqual([]);
  });

  it('reports each file whose version moved, with both values', () => {
    const base = { 'package.json': '2.8.1', 'src-tauri/Cargo.toml': '2.8.1' };
    const head = { 'package.json': '2.9.0', 'src-tauri/Cargo.toml': '2.8.1' };
    expect(findVersionChanges(base, head)).toEqual([
      { path: 'package.json', base: '2.8.1', head: '2.9.0' },
    ]);
  });

  it('reports a downgrade the same as a bump', () => {
    const changes = findVersionChanges({ 'package.json': '2.8.1' }, { 'package.json': '1.0.0' });
    expect(changes).toEqual([{ path: 'package.json', base: '2.8.1', head: '1.0.0' }]);
  });
});

describe('findVersionLine', () => {
  it('points at the version line in package.json', () => {
    const text = ['{', '  "name": "better-ip-tv",', '  "version": "2.8.1"', '}'].join('\n');
    expect(findVersionLine('package.json', text)).toBe(3);
  });

  it('points at the [package] version in Cargo.toml, not a dependency', () => {
    const text = [
      '[package]',
      'name = "better-ip-tv"',
      'version = "2.8.1"',
      '',
      '[dependencies]',
      'serde = "1.0.99"',
    ].join('\n');
    expect(findVersionLine('src-tauri/Cargo.toml', text)).toBe(3);
  });

  it('points inside the app entry of Cargo.lock, not an earlier dependency', () => {
    const text = [
      '[[package]]',
      'name = "anyhow"',
      'version = "1.0.100"',
      '',
      '[[package]]',
      'name = "better-ip-tv"',
      'version = "2.8.1"',
    ].join('\n');
    expect(findVersionLine('src-tauri/Cargo.lock', text)).toBe(7);
  });

  it('returns null rather than guessing when it cannot find the line', () => {
    expect(findVersionLine('package.json', '{"name":"x"}')).toBeNull();
  });
});

describe('formatAnnotation', () => {
  const change = { path: 'package.json', base: '2.8.1', head: '2.9.0', line: 3 };

  it('is a GitHub error annotation anchored to the file and line', () => {
    const out = formatAnnotation(change);
    expect(out.startsWith('::error file=package.json,line=3::')).toBe(true);
  });

  it('names both versions so the contributor sees what to put back', () => {
    const out = formatAnnotation(change);
    expect(out).toContain('2.8.1');
    expect(out).toContain('2.9.0');
  });

  it('says what to do and where the rule is written down', () => {
    const out = formatAnnotation(change);
    expect(out.toLowerCase()).toContain('revert');
    expect(out).toContain('CONTRIBUTING.md');
  });

  it('stays on one line, since a newline would end the annotation early', () => {
    expect(formatAnnotation(change)).not.toContain('\n');
  });

  it('drops the line anchor when the line is unknown', () => {
    const out = formatAnnotation({ ...change, line: null });
    expect(out.startsWith('::error file=package.json::')).toBe(true);
  });
});
