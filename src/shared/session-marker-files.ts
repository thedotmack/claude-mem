// Per-session marker files for hook gates: one empty-ish file per key under
// <data dir>/state/<directoryName>/, so a fact about a session survives across
// the short-lived hook processes (kimi-context-gate, codex-compaction-gate).
//
// Fail-open throughout: a filesystem error must never break a hook. Errors are
// logged and reported as "no marker"; each gate documents what that means for it.
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { resolveDataDir } from './paths.js';
import { logger } from '../utils/logger.js';

const SAFE_MARKER_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export interface SessionMarkerFiles {
  /** True when the key's marker exists. */
  has(key: string): boolean;
  mark(key: string): void;
  clear(key: string): void;
  /**
   * Removes the key's marker and reports whether this call removed it. When
   * several hook processes race for one marker, exactly one of them gets true.
   */
  take(key: string): boolean;
}

export function sessionMarkerFiles(directoryName: string, logLabel: string): SessionMarkerFiles {
  function markerPath(key: string): string {
    const name = SAFE_MARKER_KEY.test(key)
      ? key
      : `sha256-${createHash('sha256').update(key).digest('hex')}`;
    // resolveDataDir() is consulted per call (not cached at module load) so
    // CLAUDE_MEM_DATA_DIR overrides work in tests and relocated installs.
    return join(resolveDataDir(), 'state', directoryName, name);
  }

  function warnFailedOpen(operation: string, error: unknown): void {
    logger.warn('HOOK', `${logLabel}: ${operation} failed open`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    has(key) {
      try {
        return existsSync(markerPath(key));
      } catch (error) {
        warnFailedOpen('has', error);
        return false;
      }
    },

    mark(key) {
      try {
        const marker = markerPath(key);
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, new Date().toISOString());
      } catch (error) {
        warnFailedOpen('mark', error);
      }
    },

    clear(key) {
      try {
        rmSync(markerPath(key), { force: true });
      } catch (error) {
        warnFailedOpen('clear', error);
      }
    },

    take(key) {
      try {
        unlinkSync(markerPath(key));
        return true;
      } catch (error) {
        // ENOENT is the common answer: no marker, or another process took it.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          warnFailedOpen('take', error);
        }
        return false;
      }
    },
  };
}
