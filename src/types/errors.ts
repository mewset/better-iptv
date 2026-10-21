/**
 * Application error types matching the Rust backend AppError enum
 */

/**
 * Error codes matching the Rust AppError variants
 */
export type AppErrorCode =
  | 'Database'
  | 'Http'
  | 'InvalidInput'
  | 'PlaylistNotFound'
  | 'ChannelNotFound'
  | 'Mpv'
  | 'Parse'
  | 'Epg'
  | 'Io'
  | 'Config';

/**
 * Application error structure from Tauri backend
 * This matches the serialized format of the Rust AppError enum
 */
export interface AppError {
  code: AppErrorCode;
  details: string;
}

/**
 * Type guard to check if an error is an AppError
 */
export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    'details' in e &&
    typeof (e as AppError).code === 'string' &&
    typeof (e as AppError).details === 'string'
  );
}

/**
 * Get a user-friendly error message based on error code
 */
export function getErrorMessage(error: AppError): string {
  switch (error.code) {
    case 'Database':
      return 'Database error. Try again later.';
    case 'Http':
      return 'Network error. Check your connection.';
    case 'InvalidInput':
      return error.details || 'Invalid input.';
    case 'PlaylistNotFound':
      return 'Playlist not found.';
    case 'ChannelNotFound':
      return 'Channel not found.';
    case 'Mpv':
      return `Playback error: ${error.details}`;
    case 'Parse':
      return 'Could not read the file. Check its format.';
    case 'Epg':
      return 'Could not fetch the programme guide.';
    case 'Io':
      return 'File error. Check permissions.';
    case 'Config':
      return 'Configuration error.';
    default:
      return 'An unexpected error occurred.';
  }
}

/**
 * Get error severity level for UI styling
 */
export function getErrorSeverity(error: AppError): 'error' | 'warning' | 'info' {
  switch (error.code) {
    case 'Database':
    case 'Io':
    case 'Config':
      return 'error';
    case 'Http':
    case 'Epg':
    case 'Parse':
      return 'warning';
    case 'InvalidInput':
    case 'PlaylistNotFound':
    case 'ChannelNotFound':
    case 'Mpv':
      return 'info';
    default:
      return 'error';
  }
}

/**
 * Parse an unknown error into a user-friendly message
 */
export function parseError(error: unknown): string {
  if (isAppError(error)) {
    return getErrorMessage(error);
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'An unexpected error occurred.';
}
