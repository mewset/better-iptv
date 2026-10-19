import { describe, it, expect } from 'vitest';
import { truncateAddress } from '../../lib/truncateAddress';

describe('truncateAddress', () => {
  it('returns first 6 chars + ... + last 4 chars for long addresses', () => {
    expect(truncateAddress('bc1qk68zvuc75uzxn2p70se9p6jqrdydjddxk3c4nm')).toBe('bc1qk6...c4nm');
  });

  it('returns address unchanged if 13 chars or fewer', () => {
    expect(truncateAddress('shortaddr123')).toBe('shortaddr123');
  });

  it('handles empty string', () => {
    expect(truncateAddress('')).toBe('');
  });

  it('returns address unchanged if exactly 13 chars', () => {
    expect(truncateAddress('shortaddr1234')).toBe('shortaddr1234');
  });

  it('truncates an address of exactly 14 chars', () => {
    expect(truncateAddress('12345678901234')).toBe('123456...1234');
  });
});
