// SPDX-License-Identifier: Apache-2.0
//
// What connect changed, and what was there before (plan Phase 8 task 2.7):
//
//   wiring/applied.json  {version, agents: {<agentId>: AppliedAgentRecord}}
//   wiring/stash.json    {version, agents: {<agentId>: StashedAgentEntry}}
//
// applied.json holds the values connect wrote, so disconnect resets only the
// fields still equal to them (magpie internal/agent/applied.go:28-77,
// 662-726). stash.json holds the prior text: each file's bytes and each
// field's prior value, where "\u0000" means "was absent" (magpie
// plugged.go:246). Both are edited read-modify-write under a file lock (magpie
// guards its stash with an in-process mutex only, stash.go:41-59). A stash
// that does not parse is copied aside to stash.json.bad-<ts> (magpie
// stash.go:63-74) and is never read as "nothing stashed". Ported from magpie
// (MIT, Copyright (c) 2026 yetone).

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { WIRE_GATEWAY_DIR, WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE } from '../../../shared/paths.js';
import { withExclusiveFileLock } from '../edit/file-lock.js';
import type { AgentConfigFormat } from '../agents/types.js';
import type { WireGatewayCaptureSource } from '../routes.js';
import { logger } from '../../../utils/logger.js';

export const WIRING_RECORDS_VERSION = 1;

/** Stash value for "the key (or file) was absent before connect". */
export const STASHED_ABSENT = '\u0000';

export function defaultWiringDirectory(): string {
  return join(WIRE_GATEWAY_DIR, 'wiring');
}

export function appliedRecordsPath(wiringDirectory: string): string {
  return join(wiringDirectory, 'applied.json');
}

export function stashPath(wiringDirectory: string): string {
  return join(wiringDirectory, 'stash.json');
}

export interface AppliedFileRecord {
  path: string;
  format: AgentConfigFormat;
  /** connect made the file; disconnect removes it again when it is left empty. */
  createdByConnect: boolean;
  /** sha256 of the bytes connect wrote: unchanged since, disconnect puts the prior bytes back exactly. */
  writtenSha256: string;
}

export interface AppliedAgentRecord {
  at: string;
  captureSource: WireGatewayCaptureSource;
  routeIds: string[];
  files: Record<string, AppliedFileRecord>;
  /** file key → key path → the value connect wrote. */
  fields: Record<string, Record<string, unknown>>;
  /** file key → parent key paths (tables, objects) connect created; removed again when disconnect leaves them empty. */
  createdParents: Record<string, string[]>;
}

export interface StashedAgentEntry {
  /** file key → base64 of the file's bytes before connect, or STASHED_ABSENT. */
  files: Record<string, string>;
  /** file key → key path → JSON text of the prior value, or STASHED_ABSENT. */
  fields: Record<string, Record<string, string>>;
}

interface RecordsFile<T> {
  version: typeof WIRING_RECORDS_VERSION;
  agents: Record<string, T>;
}

function ensureWiringDirectory(wiringDirectory: string): void {
  mkdirSync(wiringDirectory, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
}

function parseRecordsFile<T>(raw: string, label: string): RecordsFile<T> {
  const parsed = JSON.parse(raw) as Partial<RecordsFile<T>>;
  if (parsed.version !== WIRING_RECORDS_VERSION || !parsed.agents || typeof parsed.agents !== 'object' || Array.isArray(parsed.agents)) {
    throw new Error(`${label}: not a version ${WIRING_RECORDS_VERSION} wiring record`);
  }
  return parsed as RecordsFile<T>;
}

/** applied.json; absent is empty. Throws when the file exists but cannot be used (unknown ≠ empty). */
export function readAppliedRecords(wiringDirectory: string): Record<string, AppliedAgentRecord> {
  const filePath = appliedRecordsPath(wiringDirectory);
  if (!existsSync(filePath)) return {};
  try {
    return parseRecordsFile<AppliedAgentRecord>(readFileSync(filePath, 'utf-8'), filePath).agents;
  } catch (error) {
    throw new Error(`${filePath} cannot be read (${error instanceof Error ? error.message : String(error)}); fix or remove it by hand`);
  }
}

/** Read-modify-write one records file (applied.json, stash.json) under its lock. */
function updateRecordsFile<T>(
  wiringDirectory: string,
  filePath: string,
  readAgents: () => Record<string, T>,
  mutate: (agents: Record<string, T>) => void,
): void {
  withExclusiveFileLock(filePath, () => {
    const agents = readAgents();
    mutate(agents);
    ensureWiringDirectory(wiringDirectory);
    writeJsonFileAtomic(filePath, { version: WIRING_RECORDS_VERSION, agents }, { mode: WIRE_GATEWAY_FILE_MODE });
  });
}

/** Read-modify-write applied.json under its lock. */
export function updateAppliedRecords(wiringDirectory: string, mutate: (agents: Record<string, AppliedAgentRecord>) => void): void {
  updateRecordsFile(wiringDirectory, appliedRecordsPath(wiringDirectory), () => readAppliedRecords(wiringDirectory), mutate);
}

/** `stash.json.bad-20261015-143005.123` — magpie's name, in local time (millisecond precision here). */
function badStashCopyPath(filePath: string, now: Date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  let candidate = `${filePath}.bad-${stamp}`;
  for (let suffix = 1; existsSync(candidate); suffix++) candidate = `${filePath}.bad-${stamp}-${suffix}`;
  return candidate;
}

export type StashReadResult =
  | { kind: 'read'; agents: Record<string, StashedAgentEntry> }
  | { kind: 'unreadable'; copiedAsidePath: string; reason: string };

/**
 * stash.json; absent is empty. One that does not parse is copied aside and
 * reported, never returned as empty.
 */
export function readStash(wiringDirectory: string): StashReadResult {
  const filePath = stashPath(wiringDirectory);
  if (!existsSync(filePath)) return { kind: 'read', agents: {} };
  const raw = readFileSync(filePath, 'utf-8');
  try {
    return { kind: 'read', agents: parseRecordsFile<StashedAgentEntry>(raw, filePath).agents };
  } catch (error) {
    const copiedAsidePath = badStashCopyPath(filePath);
    copyFileSync(filePath, copiedAsidePath);
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('WIRE', 'stash.json did not parse; copied it aside', { copiedAsidePath, reason });
    return { kind: 'unreadable', copiedAsidePath, reason };
  }
}

/**
 * Read-modify-write stash.json under its lock. A stash that does not parse is
 * copied aside first, so its text survives, and the write starts from the
 * entries that could be kept: none.
 */
export function updateStash(wiringDirectory: string, mutate: (agents: Record<string, StashedAgentEntry>) => void): void {
  updateRecordsFile(wiringDirectory, stashPath(wiringDirectory), () => {
    const current = readStash(wiringDirectory);
    return current.kind === 'read' ? current.agents : {};
  }, mutate);
}

/** The stash entry connect left for an agent. Throws when it cannot be had: disconnect never guesses prior values. */
export function requireStashedAgentEntry(wiringDirectory: string, agentId: string): StashedAgentEntry {
  const stash = readStash(wiringDirectory);
  if (stash.kind === 'unreadable') {
    throw new Error(
      `${stashPath(wiringDirectory)} cannot be read (${stash.reason}); it was copied to ${stash.copiedAsidePath}. `
      + `The values ${agentId} had before connect are in that copy; restore them by hand.`,
    );
  }
  const entry = Object.hasOwn(stash.agents, agentId) ? stash.agents[agentId] : undefined;
  if (!entry) {
    throw new Error(
      `${stashPath(wiringDirectory)} holds nothing for ${agentId}, so its prior values are unknown. `
      + `If an earlier stash was copied aside (stash.json.bad-*), its values are there; restore them by hand.`,
    );
  }
  return entry;
}
