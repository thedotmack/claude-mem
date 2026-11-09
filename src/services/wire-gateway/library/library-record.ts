// SPDX-License-Identifier: Apache-2.0
//
// library.json (plan Phase 14 task 3): what the Library wrote into each
// agent, so a sync or remove touches only that. Shaped as the plan names it,
// {agent: {hooks[], mcp[], instructionsHash, skills[], bundles[]}}, plus
// `settings[]` and `files{}`: each file's bytes from before claude-mem's
// first write, so a remove that finds the file as claude-mem left it puts
// those bytes back exactly (the wiring stash does the same,
// wiring/wiring-records.ts). magpie keeps the same record as `Applied`
// (internal/library/library.go:87-120), MIT, Copyright (c) 2026 yetone.
//
// Read-modify-write under a file lock (edit/file-lock.ts), which is never
// broken while its holder is alive, and every save first checks the lock is
// still this command's: a change never commits after another process took
// over (and possibly rolled it back). A record that does not parse is
// never read as "nothing recorded" (unknown ≠ empty): every Library command
// refuses until it is fixed.
//
// Crash safety: before a change writes any agent config, library.json is
// saved with that change as `pendingChange` (each file's bytes before and
// the sha256 of what is about to be written); the agent's new record replaces
// it only after every file is written. A change cut off between the two (a
// killed process, a full disk) is found by the next Library command, which
// puts each of its files back the way they were before it — so no config
// write is ever left outside the record.

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { writeFileAtomic, writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { WIRE_GATEWAY_DIR, WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE } from '../../../shared/paths.js';
import { readConfigFileBytes, removeConfigFile } from '../edit/config-file.js';
import { withExclusiveFileLock } from '../edit/file-lock.js';
import { logger } from '../../../utils/logger.js';
import type { LibraryItem, LibraryItemKind, LibraryValue } from './types.js';

export const LIBRARY_RECORD_VERSION = 1;

export function defaultLibraryDirectory(): string {
  return join(WIRE_GATEWAY_DIR, 'library');
}

export function libraryRecordPath(libraryDirectory: string): string {
  return join(libraryDirectory, 'library.json');
}

/** What was at a member's key before claude-mem set it. */
export type RecordedPrevious = { absent: true } | { absent: false; value: LibraryValue };

export interface RecordedItem {
  id: string;
  kind: LibraryItemKind;
  group: string;
  place: LibraryItem['place'];
  /** The config file, or the owned file's path. */
  path: string;
  /** Key path of an array (json-array-entry) or a member. */
  keyPath?: string[];
  /** Markers of a text block. */
  open?: string;
  close?: string;
  /** sha256 of what claude-mem wrote: canonical JSON of an entry or value, a block's body, a file's bytes. */
  writtenSha256: string;
  /** A member's written value (put back exactly by reference on remove). */
  value?: LibraryValue;
  previous?: RecordedPrevious;
  /** Containers (objects, arrays, tables) claude-mem created for this item; removed again when a remove leaves them empty. */
  createdContainers?: string[][];
  /** The user changed or removed it since claude-mem wrote it: theirs now, never written or removed again. */
  releasedToUser?: boolean;
  bodyManagedAtRuntime?: boolean;
  contentsManagedAtRuntime?: boolean;
  bundleRoot?: string;
  /** Never removed (ConfigMemberItem.keepOnRemove): a remove only drops it from the record. */
  keepOnRemove?: boolean;
  /** A remove that leaves the member's parent object empty takes it out too (ConfigMemberItem.dropEmptiedParentOnRemove). */
  dropEmptiedParentOnRemove?: boolean;
}

export interface RecordedFile {
  /** base64 of the bytes before claude-mem's first write, or null when the file did not exist. */
  bytesBeforeBase64: string | null;
  /** sha256 of the bytes claude-mem last wrote. */
  writtenSha256: string;
  /**
   * Nothing but claude-mem has changed the file since its first write, and
   * that write migrated nothing: a remove may put `bytesBefore` back exactly.
   */
  exactRestore: boolean;
}

export interface AgentLibraryRecord {
  at: string;
  hooks: RecordedItem[];
  mcp: RecordedItem[];
  settings: RecordedItem[];
  instructions: RecordedItem[];
  /** sha256 of the instruction blocks claude-mem last wrote (plan task 3's `instructionsHash`). */
  instructionsHash?: string;
  skills: RecordedItem[];
  bundles: RecordedItem[];
  files: Record<string, RecordedFile>;
}

/** One file a change is writing: what it held before (base64, null: absent) and the sha256 of what it is about to hold (null: removed). */
export interface PendingLibraryFile {
  path: string;
  bytesBeforeBase64: string | null;
  writtenSha256: string | null;
}

/** A change whose config files are being written; library.json holds it until the agent's new record replaces it. */
export interface PendingLibraryChange {
  agentId: string;
  at: string;
  files: PendingLibraryFile[];
}

interface LibraryRecordFile {
  version: typeof LIBRARY_RECORD_VERSION;
  agents: Record<string, AgentLibraryRecord>;
  pendingChange?: PendingLibraryChange;
}

const KIND_LISTS: Record<LibraryItemKind, keyof Pick<AgentLibraryRecord, 'hooks' | 'mcp' | 'settings' | 'instructions' | 'skills' | 'bundles'>> = {
  hook: 'hooks',
  mcp: 'mcp',
  setting: 'settings',
  instructions: 'instructions',
  skills: 'skills',
  bundle: 'bundles',
};

export function emptyAgentLibraryRecord(at: string): AgentLibraryRecord {
  return { at, hooks: [], mcp: [], settings: [], instructions: [], skills: [], bundles: [], files: {} };
}

export function recordedItemsOf(record: AgentLibraryRecord): RecordedItem[] {
  return [...record.hooks, ...record.mcp, ...record.settings, ...record.instructions, ...record.skills, ...record.bundles];
}

/** Replace every item list from one flat list (kept in each kind's list). */
export function setRecordedItems(record: AgentLibraryRecord, items: RecordedItem[]): void {
  for (const list of Object.values(KIND_LISTS)) record[list] = [];
  for (const item of items) record[KIND_LISTS[item.kind]].push(item);
}

export function isAgentLibraryRecordEmpty(record: AgentLibraryRecord): boolean {
  return recordedItemsOf(record).length === 0 && Object.keys(record.files).length === 0;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A JSON value written one way, keys sorted, so two spellings of one value compare equal (magpie hooks.go `canonical`). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function parseRecordFile(raw: string, label: string): LibraryRecordFile {
  const parsed = JSON.parse(raw) as Partial<LibraryRecordFile>;
  if (parsed.version !== LIBRARY_RECORD_VERSION || !parsed.agents || typeof parsed.agents !== 'object' || Array.isArray(parsed.agents)) {
    throw new Error(`${label}: not a version ${LIBRARY_RECORD_VERSION} Library record`);
  }
  return parsed as LibraryRecordFile;
}

function readRecordFile(libraryDirectory: string): LibraryRecordFile {
  const filePath = libraryRecordPath(libraryDirectory);
  if (!existsSync(filePath)) return { version: LIBRARY_RECORD_VERSION, agents: {} };
  try {
    return parseRecordFile(readFileSync(filePath, 'utf-8'), filePath);
  } catch (error) {
    throw new Error(`${filePath} cannot be read (${error instanceof Error ? error.message : String(error)}); fix or remove it by hand before installing or removing claude-mem integrations`);
  }
}

/** Every agent's record; absent is empty. Throws when the file exists but cannot be used. A pending change is not part of any record. */
export function readLibraryRecords(libraryDirectory: string): Record<string, AgentLibraryRecord> {
  return readRecordFile(libraryDirectory).agents;
}

/**
 * Put the files of a change that was cut off back the way they were before
 * it: a file holding what the change wrote gets its earlier bytes back; a
 * file still as it was is left; a file changed since by someone else is left
 * as it is and named in the returned notes (its earlier bytes are in the
 * change's backup folder).
 */
export function rollBackPendingChange(pendingChange: PendingLibraryChange): string[] {
  const notes: string[] = [];
  for (const file of pendingChange.files) {
    const current = readConfigFileBytes(file.path);
    const before = file.bytesBeforeBase64 === null ? null : new Uint8Array(Buffer.from(file.bytesBeforeBase64, 'base64'));
    const currentSha = current === null ? null : sha256Hex(current);
    const beforeSha = before === null ? null : sha256Hex(before);
    if (currentSha === beforeSha) continue;
    if (currentSha !== file.writtenSha256) {
      notes.push(`${file.path} was changed after an interrupted claude-mem Library change (${pendingChange.agentId}, ${pendingChange.at}); it is left as it is, and its earlier bytes are in the Library backups`);
      continue;
    }
    if (before === null) removeConfigFile(file.path);
    else writeFileAtomic(file.path, before);
    notes.push(`${file.path}: put back as it was before an interrupted claude-mem Library change (${pendingChange.agentId}, ${pendingChange.at})`);
  }
  return notes;
}

export interface LibraryRecordTransaction {
  /** Every agent's record; the caller changes it in place and saves. */
  agents: Record<string, AgentLibraryRecord>;
  /** Write library.json now: the agents as they are, plus `pendingChange` while a change writes its files. */
  save(pendingChange?: PendingLibraryChange): void;
  /** What rolling back a change an earlier command left pending did (empty when there was none). */
  recoveryNotes: string[];
}

/**
 * Run `work` with library.json read under its lock. A change an earlier
 * command left pending is rolled back first (see the file comment); what
 * that did is written to the log and handed to `work` as `recoveryNotes`,
 * which the engine returns with its result, never dropped.
 */
export function withLibraryRecords<T>(libraryDirectory: string, work: (transaction: LibraryRecordTransaction) => T): T {
  const filePath = libraryRecordPath(libraryDirectory);
  mkdirSync(libraryDirectory, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
  return withExclusiveFileLock(filePath, (lock) => {
    const recordFile = readRecordFile(libraryDirectory);
    const agents = recordFile.agents;
    const save = (pendingChange?: PendingLibraryChange) => {
      // Every save is a commit: never after another process took the lock (it may have rolled this change back).
      lock.assertStillHeld();
      writeJsonFileAtomic(filePath, { version: LIBRARY_RECORD_VERSION, agents, ...(pendingChange ? { pendingChange } : {}) }, { mode: WIRE_GATEWAY_FILE_MODE });
    };
    const recoveryNotes: string[] = [];
    if (recordFile.pendingChange) {
      let notes: string[];
      try {
        notes = rollBackPendingChange(recordFile.pendingChange);
      } catch (error) {
        throw new Error(describeStuckPendingChange(filePath, recordFile.pendingChange, error));
      }
      for (const note of notes) {
        logger.warn('LIBRARY', note);
        recoveryNotes.push(note);
      }
      save();
    }
    return work({ agents, save, recoveryNotes });
  });
}

/**
 * What a user reads when an interrupted change cannot be rolled back: every
 * Library command (for every agent) stops until it is, so the message names
 * the record, the change, its files, and both ways out.
 */
export function describeStuckPendingChange(recordFilePath: string, pendingChange: PendingLibraryChange, error: unknown): string {
  const files = pendingChange.files.map((file) => file.path);
  return [
    `claude-mem's Library cannot continue: ${recordFilePath} holds an interrupted change (agent ${pendingChange.agentId}, ${pendingChange.at}) that could not be rolled back: ${error instanceof Error ? error.message : String(error)}.`,
    `Files of that change: ${files.join(', ')}.`,
    'Every Library command (install, uninstall, library sync/remove) waits until this is resolved. Either make those files and their folders writable again and rerun the command (the change is then rolled back), '
      + `or, to keep the files as they are now, delete the "pendingChange" entry from ${recordFilePath} by hand (their earlier bytes are in ${join(dirname(recordFilePath), 'backups')}).`,
  ].join('\n');
}
