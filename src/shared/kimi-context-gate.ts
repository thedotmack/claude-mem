// Once-per-session gate for Kimi context injection.
//
// Kimi only appends hook stdout to model context for UserPromptSubmit (a
// blockable event); SessionStart stdout is dropped. The kimi harness therefore
// injects the observation timeline from the UserPromptSubmit composite hook
// (session-init-context) — which fires on EVERY prompt. To keep the timeline
// from being re-injected on every message, the composite handler records a
// marker here after a successful injection and skips the context fetch while
// the marker exists. summarizeHandler clears the marker on kimi PreCompact/Stop
// so the first prompt after a compaction re-injects a fresh timeline.
//
// Fail-open throughout: a filesystem error must never break a hook. On error
// hasInjected reports false (prefer a duplicate injection over losing context).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { resolveDataDir } from './paths.js';
import { logger } from '../utils/logger.js';

const GATE_DIR_NAME = 'kimi-context-injected';
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function markerPath(sessionId: string): string {
  const name = SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : `sha256-${createHash('sha256').update(sessionId).digest('hex')}`;
  // resolveDataDir() is consulted per call (not cached at module load) so
  // CLAUDE_MEM_DATA_DIR overrides work in tests and relocated installs.
  return join(resolveDataDir(), 'state', GATE_DIR_NAME, name);
}

export function hasInjected(sessionId: string): boolean {
  try {
    return existsSync(markerPath(sessionId));
  } catch (error) {
    logger.warn('HOOK', 'kimi-context-gate: hasInjected failed open', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function markInjected(sessionId: string): void {
  try {
    const marker = markerPath(sessionId);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, new Date().toISOString());
  } catch (error) {
    logger.warn('HOOK', 'kimi-context-gate: markInjected failed open', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function clearInjected(sessionId: string): void {
  try {
    rmSync(markerPath(sessionId), { force: true });
  } catch (error) {
    logger.warn('HOOK', 'kimi-context-gate: clearInjected failed open', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
