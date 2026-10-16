import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  attachConsole: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-log', () => mocks);

import { logger } from '../../lib/logger';

describe('logger formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats an Error argument as name: message on one line', () => {
    logger.error('Failed to do it:', new Error('boom'));
    expect(mocks.error).toHaveBeenCalledWith('Failed to do it: Error: boom');
  });

  it('keeps the error subclass name', () => {
    logger.warn('x', new TypeError('bad'));
    expect(mocks.warn).toHaveBeenCalledWith('x TypeError: bad');
  });

  it('still formats plain objects as JSON', () => {
    logger.error('Failed:', { code: 'Database', details: 'locked' });
    expect(mocks.error).toHaveBeenCalledWith('Failed: {"code":"Database","details":"locked"}');
  });

  it('keeps strings as-is', () => {
    logger.info('msg', 'text');
    expect(mocks.info).toHaveBeenCalledWith('msg text');
  });

  it('returns the bare message without arguments', () => {
    logger.debug('only');
    expect(mocks.debug).toHaveBeenCalledWith('only');
  });
});
