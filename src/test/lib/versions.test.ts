import { describe, expect, it } from 'vitest';
import {
  collapseVersions,
  indexVersions,
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

describe('indexVersions', () => {
  it('treats punctuation as spelling: a French "Title : Subtitle" joins its film', () => {
    const list = [
      film(1, 'Top Gun: Maverick (2022)', 'Action'),
      film(2, 'Top Gun: Maverick (2022) 4K', '4K Releases'),
      film(3, 'Top Gun : Maverick (2022)', 'Films Français'),
      film(4, 'Avatar: Aang, The Last Airbender (2026)', '2026 Movies'),
      film(5, 'Avatar Aang: The Last Airbender (2026) 4K', '4K Releases'),
    ];
    const index = indexVersions(list);
    expect(index.groups.size).toBe(2);
    expect(index.keyOf.get(3)).toBe(index.keyOf.get(1));
    expect(index.keyOf.get(5)).toBe(index.keyOf.get(4));
  });

  it('joins translated titles TMDB matched to the same film', () => {
    const list = [
      film(1, 'The Truman Show (1998)', 'Comedy'),
      film(2, 'Die Truman Show (1998)', 'German Movies'),
      film(3, 'Truman & Tennessee (2021)', 'Documentary'),
    ];
    const index = indexVersions(list, { 1: 37165, 2: 37165, 3: 730081 });
    expect(index.keyOf.get(2)).toBe(index.keyOf.get(1));
    expect(index.keyOf.get(3)).not.toBe(index.keyOf.get(1));
  });

  it('lets one matched copy bring its unmatched copies along', () => {
    const list = [
      film(1, "Schindler's List (1993)", 'Drama'),
      film(2, "Schindler's List (1993) 4K", '4K Releases'),
      film(3, 'Schindlers Liste (1993)', 'German Movies'),
    ];
    // Only the plain copy and the German one are matched yet
    const index = indexVersions(list, { 1: 424, 3: 424 });
    expect(index.groups.size).toBe(1);
    expect(index.groups.values().next().value).toHaveLength(3);
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
    const out = collapseVersions(list, indexVersions(list), { quality: '4k', language: null });
    expect(out).toEqual([fourK, rises]);
  });
});
