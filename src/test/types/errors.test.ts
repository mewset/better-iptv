import { describe, it, expect } from 'vitest';
import { isAppError, type AppError } from '../../types/errors';

describe('Error Types', () => {
  describe('isAppError', () => {
    it('should return true for valid AppError objects', () => {
      const error: AppError = {
        code: 'Database',
        details: 'Connection failed',
      };
      expect(isAppError(error)).toBe(true);
    });

    it('should return false for regular Error objects', () => {
      const error = new Error('Something went wrong');
      expect(isAppError(error)).toBe(false);
    });

    it('should return false for strings', () => {
      expect(isAppError('error message')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isAppError(null)).toBe(false);
      expect(isAppError(undefined)).toBe(false);
    });

    it('should return false for objects missing required fields', () => {
      expect(isAppError({ code: 'Database' })).toBe(false);
      expect(isAppError({ details: 'error' })).toBe(false);
    });
  });
});
