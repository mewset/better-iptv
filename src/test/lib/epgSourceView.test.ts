import { describe, it, expect } from 'vitest';
import {
  agoText,
  clampShift,
  errorText,
  formatShift,
  nextUpdateText,
  shiftPreview,
  sourceTitle,
  statusDetails,
  statusLine,
} from '../../lib/epgSourceView';
import { formatClockAt } from '../../lib/epgTime';
import { epgSource, epgStatus } from '../epgFixtures';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe('time correction wording', () => {
  it('formats a shift in hours and minutes with a real minus sign', () => {
    expect(formatShift(0)).toBe('none');
    expect(formatShift(-30)).toBe('−30 min');
    expect(formatShift(-120)).toBe('−2 h');
    expect(formatShift(90)).toBe('+1 h 30 min');
    expect(formatShift(840)).toBe('+14 h');
  });

  it('clamps to the backend bounds, −12 h to +14 h', () => {
    expect(clampShift(-750)).toBe(-720);
    expect(clampShift(870)).toBe(840);
    expect(clampShift(-720)).toBe(-720);
    expect(clampShift(30)).toBe(30);
  });

  it('previews where a 20:00 programme lands', () => {
    expect(shiftPreview(-120)).toBe('A programme the guide lists at 20:00 shows at 18:00');
    expect(shiftPreview(90)).toBe('A programme the guide lists at 20:00 shows at 21:30');
    expect(shiftPreview(-720)).toBe('A programme the guide lists at 20:00 shows at 08:00');
    expect(shiftPreview(840)).toBe(
      'A programme the guide lists at 20:00 shows at 10:00 the next day'
    );
  });
});

describe('source names', () => {
  it("never shows a provider's or a playlist's address", () => {
    const secret = 'http://p.example/xmltv.php?username=u&password=s3cret';
    expect(sourceTitle(epgSource({ origin: 'xtream', display_url: secret }))).toBe(
      "Your provider's guide · signed in with your account"
    );
    expect(sourceTitle(epgSource({ origin: 'm3u_header', display_url: secret }))).toBe(
      'From the playlist (url-tvg)'
    );
  });

  it('shows a URL added by hand as the backend masked it', () => {
    expect(
      sourceTitle(
        epgSource({ origin: 'manual', display_url: 'http://e.example/g.xml', label: 'e.example' })
      )
    ).toBe('http://e.example/g.xml');
    expect(
      sourceTitle(epgSource({ origin: 'manual', display_url: null, label: 'e.example' }))
    ).toBe('e.example');
  });
});

describe('status line', () => {
  it('says how long ago in minutes, hours and days', () => {
    expect(agoText(ago(0), NOW)).toBe('just now');
    expect(agoText(ago(12), NOW)).toBe('12 min ago');
    expect(agoText(ago(180), NOW)).toBe('3 h ago');
    expect(agoText(ago(24 * 60), NOW)).toBe('1 day ago');
    expect(agoText(ago(3 * 24 * 60), NOW)).toBe('3 days ago');
    expect(agoText(null, NOW)).toBeNull();
    expect(agoText('garbage', NOW)).toBeNull();
  });

  it('reads ok, partial, error, never and updating', () => {
    expect(statusLine(epgSource({ last_success_at: ago(12), programme_count: 42_809 }), NOW)).toBe(
      'Updated 12 min ago · 42,809 programmes'
    );
    expect(statusLine(epgSource({ last_success_at: ago(5), programme_count: 1 }), NOW)).toBe(
      'Updated 5 min ago · 1 programme'
    );
    expect(statusLine(epgSource({ last_result: 'partial', last_success_at: ago(180) }), NOW)).toBe(
      'Partial update 3 h ago: the download broke off; programmes read so far were kept'
    );
    expect(
      statusLine(
        epgSource({
          last_result: 'error',
          last_attempt_at: ago(180),
          last_error: 'The EPG server answered 403 Forbidden',
        }),
        NOW
      )
    ).toBe('Failed 3 h ago: The EPG server answered 403 Forbidden');
    expect(
      statusLine(
        epgSource({ last_result: 'never', last_attempt_at: null, last_success_at: null }),
        NOW
      )
    ).toBe('Never updated');
    expect(statusLine(epgSource({ last_result: 'error', refreshing: true }), NOW)).toBe(
      'Updating…'
    );
  });

  it('puts the zone and decoder counters in the details, not the line', () => {
    expect(statusDetails(epgSource())).toBeNull();
    const details = statusDetails(
      epgSource({ unknown_zone_count: 312, unknown_zone_sample: 'CEST', decode_replacements: 1 })
    );
    expect(details).toContain('312 programme times name a time zone the app does not know');
    expect(details).toContain('"CEST"');
    expect(details).toContain('1 character in the guide could not be read and was replaced');
  });
});

describe('automatic updates', () => {
  it('names the next update, or why there is none', () => {
    const next = NOW + 90 * 60_000;
    expect(
      nextUpdateText(epgStatus(true, { next_auto_refresh: new Date(next).toISOString() }), NOW)
    ).toMatch(new RegExp(`^Next automatic update around ${formatClockAt(next)}`));
    expect(
      nextUpdateText(
        epgStatus(true, { next_auto_refresh: new Date(NOW - 1000).toISOString() }),
        NOW
      )
    ).toBe('Next automatic update within 15 minutes');
    expect(nextUpdateText(epgStatus(true, { sources: [epgSource({ enabled: false })] }), NOW)).toBe(
      'No source is enabled, so nothing is updated automatically'
    );
  });

  it('reads a backend error by its details', () => {
    expect(errorText({ code: 'InvalidInput', details: 'Bad URL' })).toBe('Bad URL');
    expect(errorText('plain')).toBe('plain');
    expect(errorText(new Error('boom'))).toBe('boom');
  });
});
