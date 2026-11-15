import { describe, expect, it } from 'vitest';
import {
  collapseVersions,
  groupVersions,
  pickVersion,
  titleKey,
  versionLanguage,
  versionQuality,
} from '../../lib/versions';
import type { Channel } from '../../types';

function film(id: number, name: string, group_name: string): Channel {
  return { id, name, group_name, content_type: 'vod', is_favorite: false };
}

const standard = film(1, 'The Dark Knight (2008)', 'Drama 2000s');
const german = film(2, 'The Dark Knight (2008)', 'German Movies');
const fourK = film(3, 'The Dark Knight (2008) 4K', '4K Releases');
const french = film(4, 'The Dark Knight (2008)', 'Films Français');
const rises = film(5, 'The Dark Knight Rises (2012)', 'Action 2010s');

describe('versionQuality / versionLanguage', () => {
  it('reads 4K from the name or the category', () => {
    expect(versionQuality(fourK)).toBe('4k');
    expect(versionQuality(film(9, 'Dune (2021)', '2024 4K Movies'))).toBe('4k');
    expect(versionQuality(standard)).toBe('standard');
    expect(versionQuality(film(9, 'Bruno Mars: 24K Magic (2017)', 'Concerts'))).toBe('standard');
  });

  it('reads the dub language from the category or a name tag', () => {
    expect(versionLanguage(german)).toBe('German');
    expect(versionLanguage(french)).toBe('French');
    expect(versionLanguage(film(9, 'Dune (2021)', 'Películas Español'))).toBe('Spanish');
    expect(versionLanguage(film(9, '[DE] Dune (2021)', 'Sci-Fi'))).toBe('German');
    expect(versionLanguage(film(9, 'FR - Dune (2021)', 'Sci-Fi'))).toBe('French');
    expect(versionLanguage(standard)).toBeNull();
    expect(versionLanguage(fourK)).toBeNull();
    // A word that merely contains a language name does not count
    expect(versionLanguage(film(9, 'Germany Year Zero (1948)', 'Drama'))).toBeNull();
  });
});

describe('titleKey', () => {
  it('ignores quality and language tags but keeps the year', () => {
    const key = titleKey('The Dark Knight (2008)');
    expect(titleKey('The Dark Knight (2008) 4K')).toBe(key);
    expect(titleKey('[DE] The Dark Knight (2008)')).toBe(key);
    expect(titleKey('DE - The Dark Knight (2008) UHD')).toBe(key);
    expect(titleKey('The Dark Knight Rises (2012)')).not.toBe(key);
    expect(titleKey('The Dark Knight (2009)')).not.toBe(key);
  });
});

describe('pickVersion', () => {
  const all = [standard, german, fourK, french];

  it('prefers the chosen language and quality, then falls back sensibly', () => {
    expect(pickVersion(all, { quality: '4k', language: null })).toBe(fourK);
    expect(pickVersion(all, { quality: 'standard', language: null })).toBe(standard);
    expect(pickVersion(all, { quality: '4k', language: 'German' })).toBe(german);
    expect(pickVersion(all, { quality: 'standard', language: 'Italian' })).toBe(standard);
    expect(pickVersion([german, french], { quality: '4k', language: null })).toBe(german);
  });
});

describe('collapseVersions', () => {
  it('keeps one entry per film where its first version was, as the preferred version', () => {
    const list = [german, rises, standard, fourK, french];
    const groups = groupVersions(list);
    const out = collapseVersions(list, groups, { quality: '4k', language: null });
    expect(out).toEqual([fourK, rises]);
  });
});
