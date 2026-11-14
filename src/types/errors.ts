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
