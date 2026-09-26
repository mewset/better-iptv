import { describe, it, expect } from 'vitest';
import { greeting } from '../../lib/greeting';

function at(hour: number, minute = 0): Date {
  const d = new Date(2026, 8, 26);
  d.setHours(hour, minute, 0, 0);
  return d;
}

describe('greeting', () => {
  it.each([
    [0, 'Good evening'],
    [4, 'Good evening'],
    [5, 'Good morning'],
    [11, 'Good morning'],
    [12, 'Good afternoon'],
    [17, 'Good afternoon'],
    [18, 'Good evening'],
    [23, 'Good evening'],
  ])('at %i:00 says %s', (hour, expected) => {
    expect(greeting(at(hour))).toBe(expected);
  });

  it('uses the local hour, minutes do not matter', () => {
    expect(greeting(at(11, 59))).toBe('Good morning');
    expect(greeting(at(17, 59))).toBe('Good afternoon');
  });
});
