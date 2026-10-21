import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useErrorHandler, withErrorHandling } from '../../hooks/useErrorHandler';
import type { AppError } from '../../types/errors';

// Mock the logger
vi.mock('../../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('useErrorHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should initialize with empty toasts', () => {
    const { result } = renderHook(() => useErrorHandler());
    expect(result.current.toasts).toHaveLength(0);
  });

  it('should add toast when showError is called with AppError', () => {
    const { result } = renderHook(() => useErrorHandler());

    const appError: AppError = { code: 'Database', details: 'Connection failed' };

    act(() => {
      result.current.showError(appError);
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toContain('Database error');
    expect(result.current.toasts[0].severity).toBe('error');
  });

  it('should add toast when showError is called with Error', () => {
    const { result } = renderHook(() => useErrorHandler());

    act(() => {
      result.current.showError(new Error('Something went wrong'));
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toContain('Something went wrong');
  });

  it('should add toast when showError is called with context', () => {
    const { result } = renderHook(() => useErrorHandler());

    const appError: AppError = { code: 'Http', details: 'timeout' };

    act(() => {
      result.current.showError(appError, 'Failed to load channels');
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toContain('Failed to load channels');
  });

  it('should auto-dismiss toast after duration', () => {
    const { result } = renderHook(() => useErrorHandler());

    act(() => {
      result.current.showError(new Error('Test error'));
    });

    expect(result.current.toasts).toHaveLength(1);

    // Fast-forward past the auto-dismiss duration
    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(result.current.toasts).toHaveLength(0);
  });

  it('should dismiss specific toast', () => {
    const { result } = renderHook(() => useErrorHandler());

    act(() => {
      result.current.showError(new Error('Error 1'));
      result.current.showError(new Error('Error 2'));
    });

    expect(result.current.toasts).toHaveLength(2);

    const firstToastId = result.current.toasts[0].id;

    act(() => {
      result.current.dismissToast(firstToastId);
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toContain('Error 2');
  });

  it('should clear all toasts', () => {
    const { result } = renderHook(() => useErrorHandler());

    act(() => {
      result.current.showError(new Error('Error 1'));
      result.current.showError(new Error('Error 2'));
      result.current.showError(new Error('Error 3'));
    });

    expect(result.current.toasts).toHaveLength(3);

    act(() => {
      result.current.clearToasts();
    });

    expect(result.current.toasts).toHaveLength(0);
  });

  it('should set correct severity for different error types', () => {
    const { result } = renderHook(() => useErrorHandler());

    // Error severity for Database
    act(() => {
      result.current.showError({ code: 'Database', details: '' } as AppError);
    });
    expect(result.current.toasts[0].severity).toBe('error');

    // Warning severity for Http
    act(() => {
      result.current.showError({ code: 'Http', details: '' } as AppError);
    });
    expect(result.current.toasts[1].severity).toBe('warning');

    // Info severity for InvalidInput
    act(() => {
      result.current.showError({ code: 'InvalidInput', details: '' } as AppError);
    });
    expect(result.current.toasts[2].severity).toBe('info');
  });
});

describe('withErrorHandling', () => {
  it('should execute function successfully', async () => {
    const mockFn = vi.fn().mockResolvedValue('success');
    const mockOnError = vi.fn();

    const wrappedFn = withErrorHandling(mockFn, mockOnError);
    const result = await wrappedFn();

    expect(result).toBe('success');
    expect(mockOnError).not.toHaveBeenCalled();
  });

  it('should call onError when function throws', async () => {
    const error = new Error('Test error');
    const mockFn = vi.fn().mockRejectedValue(error);
    const mockOnError = vi.fn();

    const wrappedFn = withErrorHandling(mockFn, mockOnError, 'Operation failed');
    const result = await wrappedFn();

    expect(result).toBeUndefined();
    expect(mockOnError).toHaveBeenCalledWith(error, 'Operation failed');
  });

  it('should pass arguments to wrapped function', async () => {
    const mockFn = vi.fn().mockImplementation((a: number, b: number) => Promise.resolve(a + b));
    const mockOnError = vi.fn();

    const wrappedFn = withErrorHandling(mockFn, mockOnError);
    const result = await wrappedFn(2, 3);

    expect(result).toBe(5);
    expect(mockFn).toHaveBeenCalledWith(2, 3);
  });
});
