// SPDX-License-Identifier: Apache-2.0
//
// When a request from each agent last reached the gateway (plan Phase 9 task
// 1): an in-memory map updated on every routed request, persisted to
// <DATA_DIR>/wire-gateway/state/last-seen.json every 10 s, so `wire status`
// in another process (and the gateway after a restart) can read it. magpie
// keeps the same answer in memory plus its usage log (internal/usage/usage.go:
// 998-1028, MIT, Copyright (c) 2026 yetone).

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { WIRE_GATEWAY_DIR, WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';

export const LAST_SEEN_PERSIST_INTERVAL_MS = 10_000;
const LAST_SEEN_FILE_VERSION = 1;

export function defaultLastSeenFilePath(): string {
  return join(WIRE_GATEWAY_DIR, 'state', 'last-seen.json');
}

/** agentId → epoch milliseconds of its last request. */
export type LastSeenByAgent = Record<string, number>;

export type LastSeenFileReadResult =
  | { kind: 'read'; lastSeenByAgent: LastSeenByAgent }
  | { kind: 'unreadable'; reason: string };

/** last-seen.json; absent is empty. One that cannot be read is reported, never returned as empty (unknown ≠ empty). */
export function readLastSeenFile(filePath: string = defaultLastSeenFilePath()): LastSeenFileReadResult {
  if (!existsSync(filePath)) return { kind: 'read', lastSeenByAgent: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { version?: unknown; agents?: unknown };
    if (parsed.version !== LAST_SEEN_FILE_VERSION || !parsed.agents || typeof parsed.agents !== 'object' || Array.isArray(parsed.agents)) {
      return { kind: 'unreadable', reason: `${filePath} is not a version ${LAST_SEEN_FILE_VERSION} last-seen file` };
    }
    const lastSeenByAgent: LastSeenByAgent = {};
    for (const [agentId, seenAt] of Object.entries(parsed.agents as Record<string, unknown>)) {
      if (typeof seenAt === 'number' && Number.isFinite(seenAt)) lastSeenByAgent[agentId] = seenAt;
    }
    return { kind: 'read', lastSeenByAgent };
  } catch (error) {
    return { kind: 'unreadable', reason: `${filePath} cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
}

export class AgentLastSeenTracker {
  private readonly lastSeenByAgent = new Map<string, number>();
  private readonly filePath: string;
  private readonly now: () => number;
  private changedSinceFlush = false;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { filePath?: string; now?: () => number } = {}) {
    this.filePath = options.filePath ?? defaultLastSeenFilePath();
    this.now = options.now ?? Date.now;
  }

  /** Called for every request routed to an agent; never touches the disk. */
  noteRequestFromAgent(agentId: string): void {
    this.lastSeenByAgent.set(agentId, this.now());
    this.changedSinceFlush = true;
  }

  lastSeenAt(agentId: string): number | null {
    return this.lastSeenByAgent.get(agentId) ?? null;
  }

  snapshot(): LastSeenByAgent {
    return Object.fromEntries(this.lastSeenByAgent);
  }

  /**
   * Carry over what an earlier gateway persisted (newest wins), then flush
   * every 10 s while anything changed. An unreadable file is logged and left
   * for the next flush to replace.
   */
  startPersisting(intervalMs: number = LAST_SEEN_PERSIST_INTERVAL_MS): void {
    const persisted = readLastSeenFile(this.filePath);
    if (persisted.kind === 'read') {
      for (const [agentId, seenAt] of Object.entries(persisted.lastSeenByAgent)) {
        if (seenAt > (this.lastSeenByAgent.get(agentId) ?? 0)) this.lastSeenByAgent.set(agentId, seenAt);
      }
    } else {
      logger.warn('WIRE', 'last-seen.json could not be read; it is rewritten on the next flush', { reason: persisted.reason });
    }
    this.stopPersisting();
    this.persistTimer = setInterval(() => this.flush(), intervalMs);
    this.persistTimer.unref?.();
  }

  stopPersisting(): void {
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.persistTimer = null;
  }

  /** Write the map when it changed since the last write. A failed write is logged and retried on the next flush. */
  flush(): void {
    if (!this.changedSinceFlush) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
      writeJsonFileAtomic(this.filePath, { version: LAST_SEEN_FILE_VERSION, agents: this.snapshot() }, { mode: WIRE_GATEWAY_FILE_MODE });
      this.changedSinceFlush = false;
    } catch (error) {
      logger.warn('WIRE', 'Could not persist last-seen.json', { path: this.filePath }, error instanceof Error ? error : new Error(String(error)));
    }
  }
}
