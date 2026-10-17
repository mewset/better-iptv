import { describe, it, expect } from 'vitest';
import { sectionLoadStatus } from '../../lib/channelLoad';
import type { ChannelLoadStatus, Section } from '../../stores/player-store';

const STATUSES: ChannelLoadStatus[] = ['loading', 'loaded', 'error'];

function combine(parts: ChannelLoadStatus[]): ChannelLoadStatus {
  if (parts.includes('error')) return 'error';
  if (parts.includes('loading')) return 'loading';
  return 'loaded';
}

describe('sectionLoadStatus', () => {
  const sections: Section[] = ['home', 'live', 'vod', 'series', 'favorites', 'guide'];

  for (const section of sections) {
    for (const hasQuery of [false, true]) {
      for (const live of STATUSES) {
        for (const library of STATUSES) {
          const needsBoth = section !== 'home' && section !== 'live' && section !== 'guide';
          const needsBothWithQuery = section !== 'home' && section !== 'guide' && hasQuery;
          const expected =
            section === 'home'
              ? 'loaded'
              : needsBoth || needsBothWithQuery
                ? combine([live, library])
                : live;
          it(`${section}, query ${hasQuery}, live ${live}, library ${library} -> ${expected}`, () => {
            expect(sectionLoadStatus(section, hasQuery, { live, library })).toBe(expected);
          });
        }
      }
    }
  }

  it('named cases from the spec', () => {
    expect(sectionLoadStatus('vod', false, { live: 'loaded', library: 'loading' })).toBe('loading');
    expect(sectionLoadStatus('live', false, { live: 'loaded', library: 'loading' })).toBe('loaded');
    expect(sectionLoadStatus('favorites', false, { live: 'loaded', library: 'error' })).toBe(
      'error'
    );
    expect(sectionLoadStatus('home', false, { live: 'loading', library: 'loading' })).toBe(
      'loaded'
    );
    expect(sectionLoadStatus('guide', true, { live: 'loaded', library: 'error' })).toBe('loaded');
    expect(sectionLoadStatus('live', true, { live: 'loaded', library: 'loading' })).toBe('loading');
  });
});
