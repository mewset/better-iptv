import { describe, it, expect } from 'vitest';
import { foldSearchText, searchChannels } from '../../lib/searchText';
import type { Channel } from '../../types';

const channel = (id: number, name: string, group_name?: string): Channel => ({
  id,
  name,
  group_name,
  content_type: 'live',
  is_favorite: false,
});

describe('foldSearchText', () => {
  it('ignores case', () => {
    expect(foldSearchText('SVT1 HD')).toBe('svt1 hd');
  });

  it('ignores accents on Latin letters', () => {
    expect(foldSearchText('Télé Québec')).toBe('tele quebec');
    expect(foldSearchText('Malmö Åre Ängelholm')).toBe('malmo are angelholm');
    expect(foldSearchText('España Açık Štúdio')).toBe('espana acık studio');
    expect(foldSearchText('İstanbul')).toBe('istanbul');
  });

  it('reads a letter written with a separate accent like the one written whole', () => {
    // "é" as one character and as "e" followed by a combining acute accent
    expect(foldSearchText('Télé')).toBe(foldSearchText('Télé'));
  });

  it('keeps letters that are letters of their own', () => {
    expect(foldSearchText('Søndag Æ ß')).toBe('søndag æ ß');
  });

  it('keeps other scripts as they are, apart from case', () => {
    // й is not и with an accent, and a Hindi vowel sign is not decoration
    expect(foldSearchText('Первый канал')).toBe('первый канал');
    expect(foldSearchText('हिंदी')).toBe('हिंदी');
    expect(foldSearchText('ช่อง 3')).toBe('ช่อง 3');
    expect(foldSearchText('قناة الجزيرة')).toBe('قناة الجزيرة');
    expect(foldSearchText('中央电视台')).toBe('中央电视台');
    expect(foldSearchText('한국방송')).toBe('한국방송');
  });

  it('folds Vietnamese, where a letter carries two accents', () => {
    expect(foldSearchText('Truyền hình Việt Nam')).toBe('truyen hinh viet nam');
  });

  it('trims spaces and counts a run of them as one', () => {
    expect(foldSearchText('  sky   sports \t f1 ')).toBe('sky sports f1');
    expect(foldSearchText('   ')).toBe('');
  });
});

describe('searchChannels', () => {
  const channels = [
    channel(1, 'Télé Québec HD', 'Canada'),
    channel(2, 'Sky Sports F1', 'UK Sports'),
    channel(3, 'Sports Sky', 'Other'),
    channel(4, 'No group'),
  ];
  const ids = (query: string) => searchChannels(channels, query).map((c) => c.id);

  it('finds by a part of the name', () => {
    expect(ids('quebec')).toEqual([1]);
    expect(ids('Sky Sp')).toEqual([2]);
  });

  it('finds by a part of the category', () => {
    expect(ids('uk sports')).toEqual([2]);
    expect(ids('canada')).toEqual([1]);
  });

  it('keeps the words of the query together and in order', () => {
    expect(ids('sky sports')).toEqual([2]);
    expect(ids('sports sky')).toEqual([3]);
  });

  it('never matches across the name and the category', () => {
    expect(ids('hd canada')).toEqual([]);
    expect(ids('f1 uk')).toEqual([]);
  });

  it('returns the list itself for an empty query', () => {
    expect(searchChannels(channels, '')).toBe(channels);
    expect(searchChannels(channels, '   ')).toBe(channels);
  });

  it('gives a changed channel a fresh look', () => {
    const before = channel(9, 'Old name');
    const after = { ...before, name: 'New name' };
    expect(searchChannels([before], 'old')).toHaveLength(1);
    expect(searchChannels([after], 'old')).toHaveLength(0);
    expect(searchChannels([after], 'new')).toHaveLength(1);
  });
});
