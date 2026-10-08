import { describe, it, expect } from 'vitest';
import { isAdultContent, shouldBlockChannel } from '../../lib/parentalControls';
import type { Channel } from '../../types';

describe('isAdultContent', () => {
  it.each([
    ['Movie +18', undefined],
    ['Late Night 18+', undefined],
    ['Film (18+)', undefined],
    ['Film [18+]', undefined],
    ['Film {18+}', undefined],
    ['XXX Channel', undefined],
    ['Some channel', 'ADULT'],
    ['Porn Hub TV', undefined],
    ['Erotica', undefined],
    ['Plain name', 'Erotic Movies'],
    ['Plain name', 'xXx'],
  ])('flags %s / %s', (name, group) => {
    expect(isAdultContent(name, group)).toBe(true);
  });

  it.each([
    ['SVT1', 'Sweden'],
    ['Kanal 18', 'Sport'],
    ['Top 100', undefined],
    ['Ch 1 8+', undefined],
    ['Family', '+ 18 tips'],
  ])('leaves %s / %s alone', (name, group) => {
    expect(isAdultContent(name, group)).toBe(false);
  });

  it('does not match across the name and group boundary', () => {
    // "18" ending the name and "+" starting the group are not "18+".
    expect(isAdultContent('Kanal 18', '+ Extra')).toBe(false);
    expect(isAdultContent('Rock XX', 'X Music')).toBe(false);
  });
});

describe('shouldBlockChannel', () => {
  const channel = (overrides: Partial<Channel>): Channel => ({
    id: 1,
    name: 'Ch',
    content_type: 'live',
    is_favorite: false,
    ...overrides,
  });
  const base = {
    enabled: true,
    autoDetect: true,
    blockedIds: new Set<number>(),
    blockedCategories: [] as string[],
    unlocked: false,
  };

  it('blocks auto-detected adult content only when auto-detect is on', () => {
    expect(shouldBlockChannel(channel({ name: 'XXX' }), base)).toBe(true);
    expect(shouldBlockChannel(channel({ name: 'XXX' }), { ...base, autoDetect: false })).toBe(
      false
    );
  });

  it('blocks by id and by category, and nothing while unlocked or off', () => {
    expect(shouldBlockChannel(channel({ id: 5 }), { ...base, blockedIds: new Set([5]) })).toBe(
      true
    );
    expect(
      shouldBlockChannel(channel({ group_name: 'Kids' }), { ...base, blockedCategories: ['Kids'] })
    ).toBe(true);
    expect(shouldBlockChannel(channel({ name: 'XXX' }), { ...base, unlocked: true })).toBe(false);
    expect(shouldBlockChannel(channel({ name: 'XXX' }), { ...base, enabled: false })).toBe(false);
  });
});
