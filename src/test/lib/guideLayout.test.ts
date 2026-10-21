import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  blockGeometry,
  guideChannels,
  guideDataRange,
  guideDayLabels,
  guideWindow,
  layoutLanes,
  normalizeEpgId,
} from '../../lib/guideLayout';
import type { Programme } from '../../lib/epgIpc';
import type { Channel } from '../../types';

// Local times via the Date constructor so these pass in any timezone.
const local = (h: number, min: number, day = 24) => new Date(2026, 8, day, h, min).getTime();
const iso = (t: number) => new Date(t).toISOString();

describe('guideWindow', () => {
  it('starts at the half hour before now, floored, and spans three hours', () => {
    const { from, to } = guideWindow(local(20, 12), 0);
    expect(from).toBe(local(19, 30));
    expect(to).toBe(local(22, 30));
  });

  it('treats a time exactly on the hour the same way', () => {
    const { from, to } = guideWindow(local(20, 0), 0);
    expect(from).toBe(local(19, 30));
    expect(to).toBe(local(22, 30));
  });

  it('drops seconds when flooring', () => {
    const now = new Date(2026, 8, 24, 20, 45, 59, 999).getTime();
    expect(guideWindow(now, 0).from).toBe(local(20, 0));
  });

  it('shows 18:00-21:00 local on a later day', () => {
    const { from, to } = guideWindow(local(20, 12), 1);
    expect(from).toBe(local(18, 0, 25));
    expect(to).toBe(local(21, 0, 25));
  });

  it('crosses a month boundary for later days', () => {
    const now = new Date(2026, 8, 30, 9, 0).getTime();
    expect(guideWindow(now, 2).from).toBe(new Date(2026, 9, 2, 18, 0).getTime());
  });
});

describe('layoutLanes', () => {
  // A programme from local h1:m1 to h2:m2 on one day.
  const prog = (title: string, h1: number, m1: number, h2: number, m2: number): Programme => ({
    title,
    description: null,
    start: iso(local(h1, m1)),
    stop: iso(local(h2, m2)),
  });
  const lanesOf = (programmes: Programme[]) =>
    layoutLanes(programmes).blocks.map((b) => [b.programme.title, b.lane]);

  it('places nothing for no programmes', () => {
    expect(layoutLanes([])).toEqual({ blocks: [], laneCount: 1, dropped: 0 });
  });

  it('keeps disjoint programmes in lane 0', () => {
    const layout = layoutLanes([prog('A', 19, 0, 19, 30), prog('B', 20, 0, 21, 0)]);
    expect(layout.blocks.map((b) => b.lane)).toEqual([0, 0]);
    expect(layout.laneCount).toBe(1);
    expect(layout.dropped).toBe(0);
  });

  it('keeps a programme starting exactly when the previous stops in the same lane', () => {
    const layout = layoutLanes([prog('A', 19, 0, 20, 0), prog('B', 20, 0, 21, 0)]);
    expect(layout.blocks.map((b) => b.lane)).toEqual([0, 0]);
    expect(layout.laneCount).toBe(1);
  });

  it('puts a nested programme in lane 1, below the one it sits in', () => {
    const layout = layoutLanes([prog('Movie night', 19, 0, 23, 0), prog('Film', 20, 0, 22, 0)]);
    expect(layout.blocks.map((b) => [b.programme.title, b.lane])).toEqual([
      ['Movie night', 0],
      ['Film', 1],
    ]);
    expect(layout.laneCount).toBe(2);
    expect(layout.dropped).toBe(0);
  });

  it('with one start, puts the longer programme in lane 0', () => {
    expect(lanesOf([prog('Film', 20, 0, 22, 0), prog('Movie night', 20, 0, 23, 0)])).toEqual([
      ['Movie night', 0],
      ['Film', 1],
    ]);
  });

  it('puts two disjoint nested programmes both in lane 1', () => {
    const layout = layoutLanes([
      prog('Block', 19, 0, 23, 0),
      prog('First', 19, 30, 20, 30),
      prog('Second', 20, 30, 21, 30),
    ]);
    expect(layout.blocks.map((b) => [b.programme.title, b.lane])).toEqual([
      ['Block', 0],
      ['First', 1],
      ['Second', 1],
    ]);
    expect(layout.dropped).toBe(0);
  });

  it('drops and counts a nested programme overlapping the other nested one', () => {
    const layout = layoutLanes([
      prog('Block', 19, 0, 23, 0),
      prog('First', 19, 30, 21, 0),
      prog('Second', 20, 30, 21, 30),
    ]);
    expect(layout.blocks.map((b) => [b.programme.title, b.lane])).toEqual([
      ['Block', 0],
      ['First', 1],
    ]);
    expect(layout.laneCount).toBe(2);
    expect(layout.dropped).toBe(1);
  });

  it('lays out unsorted input as if it were sorted', () => {
    const sorted = [
      prog('A', 19, 0, 20, 0),
      prog('Block', 20, 0, 23, 0),
      prog('Nested', 20, 30, 21, 0),
      prog('B', 23, 0, 23, 30),
    ];
    const shuffled = [sorted[3], sorted[1], sorted[0], sorted[2]];
    expect(layoutLanes(shuffled)).toEqual(layoutLanes(sorted));
    expect(lanesOf(shuffled)).toEqual([
      ['A', 0],
      ['Block', 0],
      ['Nested', 1],
      ['B', 0],
    ]);
  });

  it('leaves out programmes with unusable times without counting them', () => {
    const broken: Programme = { title: 'X', description: null, start: 'soon', stop: 'later' };
    const backwards = prog('Backwards', 21, 0, 20, 0);
    const layout = layoutLanes([prog('A', 19, 0, 20, 0), broken, backwards]);
    expect(layout.blocks.map((b) => b.programme.title)).toEqual(['A']);
    expect(layout.dropped).toBe(0);
  });
});

describe('blockGeometry', () => {
  const from = local(19, 30);
  const to = local(22, 30);

  it('maps a 30-minute programme in a 3-hour window of 1080 px to 180 px', () => {
    expect(blockGeometry(iso(local(20, 0)), iso(local(20, 30)), from, to, 1080)).toEqual({
      left: 180,
      width: 180,
    });
  });

  it('clamps a programme that began before the window to left 0', () => {
    expect(blockGeometry(iso(local(19, 0)), iso(local(20, 0)), from, to, 1080)).toEqual({
      left: 0,
      width: 180,
    });
  });

  it('clamps a programme that runs past the window to its right edge', () => {
    expect(blockGeometry(iso(local(22, 0)), iso(local(23, 30)), from, to, 1080)).toEqual({
      left: 900,
      width: 180,
    });
  });

  it('returns null for a programme entirely before the window', () => {
    expect(blockGeometry(iso(local(18, 0)), iso(local(19, 30)), from, to, 1080)).toBeNull();
  });

  it('returns null for a programme entirely after the window', () => {
    expect(blockGeometry(iso(local(22, 30)), iso(local(23, 0)), from, to, 1080)).toBeNull();
  });

  it('returns null for unparsable or inverted times', () => {
    expect(blockGeometry('nope', iso(local(20, 0)), from, to, 1080)).toBeNull();
    expect(blockGeometry(iso(local(21, 0)), iso(local(20, 0)), from, to, 1080)).toBeNull();
  });
});

describe('normalizeEpgId', () => {
  // Pairs the backend's channel_key test (`epg_domain/key.rs`) gives the
  // same answer for: the guide matches its keys against these.
  it('trims and lower-cases like the backend', () => {
    expect(normalizeEpgId('  SVT1.se ')).toBe('svt1.se');
    expect(normalizeEpgId('KANAL5.SE')).toBe('kanal5.se');
    expect(normalizeEpgId('Ämne.se')).toBe('ämne.se');
    expect(normalizeEpgId('ÖRESUND.dk')).toBe('öresund.dk');
    // Final sigma, mapped by both languages.
    expect(normalizeEpgId('\u039F\u0394\u039F\u03A3')).toBe('\u03BF\u03B4\u03BF\u03C2');
  });

  it('trims a byte order mark but not U+0085, as the backend does', () => {
    expect(normalizeEpgId('\uFEFFSVT1.se\u00A0')).toBe('svt1.se');
    expect(normalizeEpgId('\u0085SVT1.se')).toBe('\u0085svt1.se');
  });
});

describe('guideDataRange', () => {
  it('runs from today 00:00 local to the same time five days later', () => {
    const now = new Date(2026, 9, 8, 20, 12).getTime();
    const { from, to } = guideDataRange(now);
    expect(from).toBe(new Date(2026, 9, 8).getTime());
    expect(to).toBe(new Date(2026, 9, 13).getTime());
  });

  it('crosses a month boundary', () => {
    const { to } = guideDataRange(new Date(2026, 9, 29, 9).getTime());
    expect(to).toBe(new Date(2026, 10, 3).getTime());
  });
});

describe('guideChannels', () => {
  const ch = (id: number, epg_id: string | null | undefined): Channel =>
    ({ id, name: `C${id}`, content_type: 'live', epg_id }) as Channel;

  it('keeps channels whose normalized id has data, in list order', () => {
    const list = [ch(1, 'b.se'), ch(2, ' SVT1.se '), ch(3, 'none.se'), ch(4, 'a.se')];
    const rows = guideChannels(list, new Set(['a.se', 'b.se', 'svt1.se']));
    expect(rows.map((c) => c.id)).toEqual([1, 2, 4]);
  });

  it('keeps every channel sharing an id with data', () => {
    const rows = guideChannels([ch(1, 'svt1.se'), ch(2, 'SVT1.se')], new Set(['svt1.se']));
    expect(rows.map((c) => c.id)).toEqual([1, 2]);
  });

  it('drops channels without an id or with a blank one', () => {
    const list = [ch(1, null), ch(2, undefined), ch(3, '   '), ch(4, 'a.se')];
    expect(guideChannels(list, new Set(['a.se', ''])).map((c) => c.id)).toEqual([4]);
  });

  it('has no cap', () => {
    const list = Array.from({ length: 1500 }, (_, i) => ch(i + 1, `e${i}`));
    const ids = new Set(list.map((c) => c.epg_id!));
    expect(guideChannels(list, ids)).toHaveLength(1500);
  });

  it('without a set keeps every channel with a non-blank id', () => {
    const list = [ch(1, 'a'), ch(2, null), ch(3, '  '), ch(4, 'b')];
    expect(guideChannels(list, null).map((c) => c.id)).toEqual([1, 4]);
  });
});

// Instants next to a clock change. `npm run test:tz` runs these under
// Pacific/Auckland, the CI default is UTC, and a maintainer's machine is
// often Europe/Stockholm; every assertion is in local calendar terms, so
// each holds in any of them.
//   2026-10-25T00:30Z: 02:30 CEST, half an hour before the EU clocks go back
//     (13:30 NZDT in Auckland).
//   2026-04-04T13:30Z: 2026-04-05 02:30 NZDT, half an hour before the
//     Auckland clocks go back (15:30 CEST in Stockholm).
describe.each(['2026-10-25T00:30:00Z', '2026-04-04T13:30:00Z'])(
  'around a DST change, at %s',
  (at) => {
    const HOUR = 3_600_000;
    const now = Date.parse(at);
    /** The local calendar date `days` after now's, read at local noon so a DST hour cannot shift it. */
    const dateAfter = (days: number) => {
      const d = new Date(now);
      const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
      return new Date(noon + days * 24 * HOUR).getDate();
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("today's window starts at the half hour before now and spans three real hours", () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const { from, to } = guideWindow(Date.now(), 0);
      const minutesPastHalfHour = new Date(now).getMinutes() % 30;
      expect(from).toBe(now - minutesPastHalfHour * 60_000 - 30 * 60_000);
      expect(to - from).toBe(3 * HOUR);
    });

    it("a later day's window is 18:00-21:00 local on that calendar day", () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      for (let day = 1; day < 5; day++) {
        const { from, to } = guideWindow(Date.now(), day);
        expect([new Date(from).getHours(), new Date(from).getMinutes()]).toEqual([18, 0]);
        expect([new Date(to).getHours(), new Date(to).getMinutes()]).toEqual([21, 0]);
        expect(new Date(from).getDate()).toBe(dateAfter(day));
      }
    });

    it('the data range runs from local midnight today to local midnight five days on', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const { from, to } = guideDataRange(Date.now());
      expect([new Date(from).getHours(), new Date(from).getMinutes()]).toEqual([0, 0]);
      expect(new Date(from).getDate()).toBe(dateAfter(0));
      expect([new Date(to).getHours(), new Date(to).getMinutes()]).toEqual([0, 0]);
      expect(new Date(to).getDate()).toBe(dateAfter(5));
      // Five calendar days; one of them may be an hour short or long.
      expect(Math.abs(to - from - 5 * 24 * HOUR)).toBeLessThanOrEqual(HOUR);
    });

    it('the day chips name today and the next four calendar days, none twice', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const labels = guideDayLabels(Date.now());
      expect(labels[0]).toBe('Today');
      for (let day = 1; day < 5; day++) {
        expect(labels[day]).toMatch(new RegExp(` ${dateAfter(day)}$`));
      }
      expect(new Set(labels).size).toBe(5);
    });
  }
);
