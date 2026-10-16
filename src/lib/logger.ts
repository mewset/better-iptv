import { info, warn, error, debug, attachConsole } from '@tauri-apps/plugin-log';

// Attach console in development mode
// This makes Rust logs appear in the browser console
if (import.meta.env.DEV) {
  attachConsole();
}

// Helper to format multiple arguments into a single string
const formatArgs = (message: string, ...args: unknown[]): string => {
  if (args.length === 0) return message;
  const formatted = args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      // JSON.stringify(new Error('x')) is '{}', which would drop the message
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
  return `${message} ${formatted}`;
};

// Export logger functions for use throughout the app
export const logger = {
  info: (message: string, ...args: unknown[]) => info(formatArgs(message, ...args)),
  warn: (message: string, ...args: unknown[]) => warn(formatArgs(message, ...args)),
  error: (message: string, ...args: unknown[]) => error(formatArgs(message, ...args)),
  debug: (message: string, ...args: unknown[]) => debug(formatArgs(message, ...args)),
};
