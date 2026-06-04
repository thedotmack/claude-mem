/**
 * Observer / KnowledgeAgent tool-attempt audit log.
 *
 * SECURITY-SENSITIVE. The Observer and KnowledgeAgent SDK sessions are
 * configured to forbid all tool use (see src/sdk/hardened-options.ts). This
 * module records every attempted tool invocation to an append-only NDJSON log
 * so that prompt-injection attempts (the model emitting a tool_use the SDK then
 * denies) leave an authoritative, persistent trail for post-incident review.
 *
 * DEPENDENCY-FREE BY DESIGN: this util intentionally does NOT import the
 * application logger. The logger writes through its own code path; if it ever
 * routed through the audit recorder we would risk infinite recursion. Mirrors
 * the best-effort appendFileSync pattern in src/utils/logger.ts (try/catch,
 * never throw, fall back to stderr).
 */

import { appendFileSync, statSync, renameSync, existsSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from '../shared/paths.js';

const AUDIT_LOG_PATH = join(DATA_DIR, 'observer-audit.log');
const ROTATE_AT_BYTES = 50 * 1024 * 1024; // 50MB
const KEEP_GENERATIONS = 3;
const MAX_INPUT_BYTES = 4096;

export interface ObserverToolAttempt {
  source: 'Observer' | 'KnowledgeAgent';
  sessionDbId?: number;
  contentSessionId?: string;
  project?: string;
  tool_name: string;
  tool_input: unknown;
  result: 'allowed' | 'denied' | 'error';
  error_message?: string;
}

/** Exposed for tests; never mutate at runtime. */
export function getObserverAuditLogPath(): string {
  return AUDIT_LOG_PATH;
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(AUDIT_LOG_PATH)) return;
    const { size } = statSync(AUDIT_LOG_PATH);
    if (size < ROTATE_AT_BYTES) return;
    for (let i = KEEP_GENERATIONS - 1; i >= 1; i--) {
      const from = `${AUDIT_LOG_PATH}.${i}`;
      const to = `${AUDIT_LOG_PATH}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(AUDIT_LOG_PATH, `${AUDIT_LOG_PATH}.1`);
  } catch {
    // best-effort rotation; never fail the recording call
  }
}

function truncateInput(input: unknown, maxBytes = MAX_INPUT_BYTES): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    if (s === undefined) return '[UNSERIALIZABLE]';
    if (s.length <= maxBytes) return s;
    return s.slice(0, maxBytes) + '…[TRUNCATED]';
  } catch {
    return '[UNSERIALIZABLE]';
  }
}

/**
 * Record a single attempted tool invocation. Best-effort: a failed write is
 * logged to stderr and swallowed so the SDK message loop is never broken by an
 * audit failure.
 */
export function recordObserverToolAttempt(attempt: ObserverToolAttempt): void {
  try {
    rotateIfNeeded();
    const entry = {
      ts: new Date().toISOString(),
      source: attempt.source,
      sessionDbId: attempt.sessionDbId ?? null,
      contentSessionId: attempt.contentSessionId ?? null,
      project: attempt.project ?? null,
      tool_name: attempt.tool_name,
      tool_input: truncateInput(attempt.tool_input),
      result: attempt.result,
      error_message: attempt.error_message ?? null,
    };
    appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(
      `[OBSERVER-AUDIT] failed to write: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}
