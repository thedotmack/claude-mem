/**
 * Structured logger for the viewer UI.
 *
 * In enterprise deployments with thousands of developers, raw console.error /
 * console.warn calls pollute browser dev-tools and leak internal details.
 * This logger:
 *  - Silences all output by default (LOG_LEVEL = 'none').
 *  - Can be enabled at runtime via localStorage for debugging:
 *      localStorage.setItem('viewer-log-level', 'debug');
 *  - Never exposes raw Error objects or stack traces to the console.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

function getConfiguredLevel(): LogLevel {
  try {
    const stored = localStorage.getItem('viewer-log-level');
    if (stored && stored in LEVEL_ORDER) {
      return stored as LogLevel;
    }
  } catch {
    // localStorage may be unavailable (SSR, security restrictions)
  }
  return 'none';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getConfiguredLevel()];
}

function formatMessage(prefix: string, message: string): string {
  return `[viewer:${prefix}] ${message}`;
}

export const logger = {
  debug(prefix: string, message: string): void {
    if (shouldLog('debug')) {
      console.debug(formatMessage(prefix, message));
    }
  },

  info(prefix: string, message: string): void {
    if (shouldLog('info')) {
      console.info(formatMessage(prefix, message));
    }
  },

  warn(prefix: string, message: string): void {
    if (shouldLog('warn')) {
      console.warn(formatMessage(prefix, message));
    }
  },

  error(prefix: string, message: string): void {
    if (shouldLog('error')) {
      console.error(formatMessage(prefix, message));
    }
  },
};
