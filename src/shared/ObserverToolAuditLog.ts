// SPDX-License-Identifier: Apache-2.0
//
// Observer SDK Tool Enforcement audit log.
//
// Append-only JSONL log of every SDK tool-use attempt made by the Observer
// (ClaudeProvider) or the Knowledge Agent. Each line is a single JSON object
// with: timestamp (ISO 8601), source ('observer' | 'knowledge_prime' |
// 'knowledge_query'), sessionDbId | corpusName, toolName, decision
// ('deny' | 'allow'), and reason. The log lives at
// `${CLAUDE_MEM_DATA_DIR}/audit/observer-tool-attempts.log`.
//
// Even though Observer/Knowledge SDK invocations pass `allowedTools: []`
// (so no tool ever runs), the SDK still calls `canUseTool` BEFORE the
// deny path, and we log every attempt here so a future SDK regression
// (re-introducing tools to the deny-list) leaves a forensic trail.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR
  ? process.env.CLAUDE_MEM_DATA_DIR
  : join(homedir(), '.claude-mem');

const AUDIT_DIR = join(DEFAULT_DATA_DIR, 'audit');
const AUDIT_PATH = join(AUDIT_DIR, 'observer-tool-attempts.log');

export interface ObserverToolAttempt {
  timestamp?: string;
  source: 'observer' | 'knowledge_prime' | 'knowledge_query';
  sessionDbId?: number | string | null;
  contentSessionId?: string | null;
  corpusName?: string | null;
  toolName: string;
  decision: 'deny' | 'allow';
  reason: string;
  input?: Record<string, unknown>;
}

/**
 * Append one JSONL entry to the audit log. Best-effort: if the write fails
 * (filesystem full, permission denied, etc.) we swallow the error rather
 * than break the SDK call — the deny decision itself is still in effect.
 *
 * The `input` field is summarised (key list only) so sensitive payloads
 * (file contents from a hypothetical future Edit/Write/Bash) never reach
 * disk.
 */
export function logObserverToolAttempt(entry: ObserverToolAttempt): void {
  try {
    mkdirSync(dirname(AUDIT_PATH), { recursive: true });
    const inputSummary = entry.input
      ? { keys: Object.keys(entry.input).slice(0, 16) }
      : undefined;
    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      input: inputSummary,
    }) + '\n';
    appendFileSync(AUDIT_PATH, line, 'utf8');
  } catch {
    // best-effort
  }
}

/** Exported for tests. */
export const __AUDIT_PATH = AUDIT_PATH;
