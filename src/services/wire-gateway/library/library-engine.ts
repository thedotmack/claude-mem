// SPDX-License-Identifier: Apache-2.0
//
// The Library engine (plan Phase 14 tasks 1-3): writes an agent's items,
// records what it wrote in library.json, and removes only that. The rules,
// from magpie internal/library (sync.go:77-206, hooks.go:225-377,
// instructions.go:192-222, mcp.go:1007-1117; MIT, Copyright (c) 2026 yetone):
//
//   - Nothing outside the record is ever removed. Entries claude-mem wrote
//     before the record existed are recognized by their own signature
//     (`isPreLibraryEntry`, `isPreLibraryValue`, a block's markers, a file at
//     claude-mem's own path) and taken over or removed like recorded ones.
//   - An entry the user changed or removed since claude-mem wrote it is
//     theirs: it is never written or removed again (`releasedToUser`).
//     An instruction block the user edited stays theirs until claude-mem's
//     own text for it changes (magpie instructions.go:192-222).
//   - An unparseable file is never written: the whole change refuses.
//   - A change is worked out in memory first; then library.json is saved
//     with it pending, its files are written as one group (`atomically`,
//     each backed up first, backups.ts), and only then does the agent's new
//     record replace the pending change. A throw part way puts every file
//     back and leaves the record as it was; a crash part way leaves the
//     pending change, which the next Library command rolls back
//     (library-record.ts). Either way no config write is left unrecorded.
//   - A remove that finds a file exactly as claude-mem last wrote it puts
//     back the bytes it had before claude-mem's first write — unless those
//     bytes already held claude-mem's own entries (an install from before
//     the record): such a file only loses claude-mem's entries, so an
//     uninstall after an upgrade never brings the old ones back.

import { existsSync, readdirSync, rmdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { writeFileAtomic } from '../../../shared/atomic-json.js';
import { atomically, ConfigFilesNotPutBackError, readConfigFileBytes, removeConfigFile } from '../edit/config-file.js';
import { decodeConfigText } from '../edit/text-shape.js';
import { invocationBackupChange, pruneLibraryBackups } from './backups.js';
import { isEmptyContainer, openConfigSession, type ConfigSession } from './config-session.js';
import {
  canonicalSha256,
  emptyAgentLibraryRecord,
  isAgentLibraryRecordEmpty,
  readLibraryRecords,
  recordedItemsOf,
  setRecordedItems,
  sha256Hex,
  withLibraryRecords,
  type AgentLibraryRecord,
  type LibraryRecordTransaction,
  type RecordedFile,
  type RecordedItem,
} from './library-record.js';
import { findTextBlock, removeTextBlock, textBlockBody, upsertTextBlock } from './text-block.js';
import { SCRIPT_PATH_NOT_FOUND_FOR_REMOVAL } from './types.js';
import type {
  ConfigMemberItem,
  JsonArrayEntryItem,
  JsonFileStyle,
  LibraryApplyRequest,
  LibraryApplyResult,
  LibraryBackupChangeHandle,
  LibraryConfigFormat,
  LibraryContext,
  LibraryItem,
  LibraryItemReport,
  LibraryMigration,
  LibraryValue,
  OwnedFileItem,
  TextBlockItem,
} from './types.js';

/**
 * The Library edits TOML and YAML through the Phase 7 editors, which check
 * every edit with Bun.TOML/Bun.YAML. Under Node (the npx installer) the
 * engine must run in a Bun child instead (npx-cli/commands/library.ts).
 */
export function assertLibraryRuntime(): void {
  if (typeof Bun === 'undefined') {
    throw new Error('The claude-mem Library runs under Bun: its TOML and YAML checks use Bun.TOML and Bun.YAML. Run it through `npx claude-mem library …` or `bun`.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

const utf8Encoder = new TextEncoder();

// --- the files of one change ------------------------------------------------------------------

interface TextFileState {
  original: Uint8Array | null;
  text: string | null;
  validateAs?: 'toml';
  deleteFile?: boolean;
}

interface OwnedFileState {
  original: Uint8Array | null;
  next: Uint8Array | null;
}

/** One file a change writes: its bytes now (null: absent) and what it is to hold (null: removed). */
interface PlannedWrite {
  path: string;
  before: Uint8Array | null;
  next: Uint8Array | null;
}

/** Every file one change reads and writes, opened once; nothing is written here (see `writeChange`). */
class ChangeFiles {
  private readonly configs = new Map<string, ConfigSession>();
  private readonly configDeletes = new Set<string>();
  private readonly texts = new Map<string, TextFileState>();
  private readonly owned = new Map<string, OwnedFileState>();
  private readonly restores = new Map<string, Uint8Array | null>();
  /**
   * Files whose bytes before this change held claude-mem's own entries (an
   * install from before the record, migrated or taken over now). A first
   * write to one is recorded without exact restore: putting those bytes back
   * would put claude-mem's old entries back.
   */
  readonly migrated = new Set<string>();
  /** Arrays whose pre-Library entries this change already took out (once per array, not once per item). */
  readonly preLibraryFiltered = new Set<string>();
  /** Containers this change created, per file: an item that adds to one another item created owns it too. */
  readonly createdThisChange = new Map<string, string[][]>();

  /** `readBytes`: where a file's current bytes come from (a remove reads a file's bytes from before claude-mem through it to look for claude-mem's old entries). */
  constructor(private readonly jsonStyles: Record<string, JsonFileStyle>, private readonly readBytes: (path: string) => Uint8Array | null = readConfigFileBytes) {}

  noteCreated(path: string, keyPaths: string[][]): void {
    const list = this.createdThisChange.get(path) ?? [];
    for (const keyPath of keyPaths) if (!list.some((known) => JSON.stringify(known) === JSON.stringify(keyPath))) list.push(keyPath);
    this.createdThisChange.set(path, list);
  }

  /** Of `keyPath` and its parents, those this change created. */
  createdAlongPath(path: string, keyPath: string[]): string[][] {
    const created = this.createdThisChange.get(path) ?? [];
    return created.filter((candidate) => candidate.length <= keyPath.length && candidate.every((key, index) => keyPath[index] === key));
  }

  config(path: string, format: LibraryConfigFormat): ConfigSession {
    let session = this.configs.get(path);
    if (!session) {
      session = openConfigSession(path, format, this.readBytes(path), this.jsonStyles[path] ?? { finalNewline: true });
      this.configs.set(path, session);
    }
    if (session.format !== format) throw new Error(`${path} is used as both ${session.format} and ${format}`);
    return session;
  }

  deleteConfigFile(path: string): void {
    this.configDeletes.add(path);
  }

  text(path: string, validateAs?: 'toml'): TextFileState {
    let state = this.texts.get(path);
    if (!state) {
      const original = this.readBytes(path);
      const text = original === null ? null : decodeConfigText(original);
      if (validateAs && text !== null && text.trim() !== '') validateText(path, text, validateAs);
      state = { original, text, validateAs };
      this.texts.set(path, state);
    }
    return state;
  }

  ownedFile(path: string): OwnedFileState {
    let state = this.owned.get(path);
    if (!state) {
      const original = this.readBytes(path);
      state = { original, next: original };
      this.owned.set(path, state);
    }
    return state;
  }

  restore(path: string, bytes: Uint8Array | null): void {
    this.restores.set(path, bytes);
  }

  /**
   * Work out every file write of the change and bring the file records up
   * to date (in memory). Nothing is written.
   */
  plan(fileRecords: Record<string, RecordedFile>): PlannedWrite[] {
    const writes: PlannedWrite[] = [];
    const write = (path: string, original: Uint8Array | null, next: Uint8Array | null) => {
      if (bytesEqual(original, next)) return;
      writes.push({ path, before: original, next });
      if (next === null) {
        delete fileRecords[path];
        return;
      }
      const previous = fileRecords[path];
      const migrated = this.migrated.has(path);
      if (!previous) {
        fileRecords[path] = { bytesBeforeBase64: original === null ? null : base64(original), writtenSha256: sha256Hex(next), exactRestore: !migrated };
        return;
      }
      // Still exactly what claude-mem last wrote: the bytes from before its first write are still the ones to put back.
      const untouchedSinceLastWrite = original !== null && sha256Hex(original) === previous.writtenSha256;
      fileRecords[path] = { ...previous, writtenSha256: sha256Hex(next), exactRestore: previous.exactRestore && untouchedSinceLastWrite && !migrated };
    };
    for (const [path, bytes] of this.restores) {
      write(path, this.readBytes(path), bytes);
      delete fileRecords[path];
    }
    // A file claude-mem created that a remove leaves with nothing in it goes again.
    const createdByLibrary = (path: string) => fileRecords[path]?.bytesBeforeBase64 === null;
    for (const [path, session] of this.configs) {
      if (this.configDeletes.has(path)) write(path, session.originalBytes, null);
      else if (session.changed() && createdByLibrary(path) && isEmptyContainer(session.document())) write(path, session.originalBytes, null);
      else if (session.changed()) write(path, session.originalBytes, session.render());
    }
    for (const [path, state] of this.texts) {
      if (state.text !== null && state.text.trim() === '' && state.original !== null && createdByLibrary(path)) state.deleteFile = true;
      const next = state.deleteFile ? null : state.text === null ? null : utf8Encoder.encode(state.text);
      if (state.validateAs && state.text !== null && state.text.trim() !== '') validateText(path, state.text, state.validateAs);
      write(path, state.original, next);
    }
    for (const [path, state] of this.owned) write(path, state.original, state.next);
    return writes;
  }
}

function validateText(path: string, text: string, format: 'toml'): void {
  try {
    Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`${path} would not be valid ${format.toUpperCase()} (${errorMessage(error)}); it is left as it is`);
  }
}

// --- migrations -------------------------------------------------------------------------------

function runMigrations(migrations: LibraryMigration[], files: ChangeFiles): void {
  for (const migration of migrations) {
    if (migration.format === 'text') {
      const state = files.text(migration.file);
      if (state.text === null) continue;
      const result = migration.computeText(state.text);
      if (!result) continue;
      if ('deleteFile' in result) state.deleteFile = true;
      else if (result.text === state.text) continue;
      else state.text = result.text;
      files.migrated.add(migration.file);
      continue;
    }
    const session = files.config(migration.file, migration.format);
    if (!session.existedBefore) continue;
    const edits = migration.compute(session.document());
    for (const edit of edits) {
      if (edit.op === 'set') session.set(edit.keyPath, edit.value);
      else session.delete(edit.keyPath);
    }
    if (edits.length > 0) files.migrated.add(migration.file);
  }
}

// --- applying one item ------------------------------------------------------------------------

interface ItemResult {
  report: LibraryItemReport;
  /** What to record for the item; undefined: nothing (the user's, or skipped). */
  recorded?: RecordedItem;
}

function baseRecord(item: LibraryItem, path: string, writtenSha256: string): RecordedItem {
  return { id: item.id, kind: item.kind, group: item.group, place: item.place, path, writtenSha256 };
}

function report(item: LibraryItem | RecordedItem, outcome: LibraryItemReport['outcome'], detail?: string): LibraryItemReport {
  return { id: item.id, kind: item.kind, outcome, ...(detail ? { detail } : {}) };
}

const RELEASED_DETAIL = 'changed or removed by the user since claude-mem wrote it; theirs now, left as it is';

function releaseToUser(recorded: RecordedItem): ItemResult {
  return { report: report(recorded, 'left-to-user', RELEASED_DETAIL), recorded: { ...recorded, releasedToUser: true } };
}

function readArray(session: ConfigSession, item: Pick<JsonArrayEntryItem, 'arrayKeyPath' | 'scalarIsOneEntryArray'>): unknown[] | undefined {
  const value = session.get(item.arrayKeyPath);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return [...value];
  if (item.scalarIsOneEntryArray && (value === null || typeof value !== 'object')) return [value];
  throw new Error(`${session.path}: ${item.arrayKeyPath.join('.')} is not a list; it is left as it is`);
}

/** A scalar standing for a one-entry list (OpenCode's `plugin: "x"`) becomes that list before an element edit. */
function ensureArrayForm(session: ConfigSession, item: JsonArrayEntryItem): void {
  const value = session.get(item.arrayKeyPath);
  if (value !== undefined && !Array.isArray(value)) session.set(item.arrayKeyPath, [value as LibraryValue]);
}

function keyPathIn(list: string[][], keyPath: string[]): boolean {
  return list.some((known) => JSON.stringify(known) === JSON.stringify(keyPath));
}

/**
 * One entry of a JSON array. Every edit is one element (added, replaced or
 * taken out), never the array rewritten, so a JSONC file keeps its comments
 * and the other entries' formatting (config-session.ts).
 */
function applyArrayEntry(item: JsonArrayEntryItem, recorded: RecordedItem | undefined, files: ChangeFiles, fileHadRecord: boolean): ItemResult {
  const session = files.config(item.file, 'json');
  if (recorded?.releasedToUser) return { report: report(item, 'left-to-user', RELEASED_DETAIL), recorded };
  const existing = readArray(session, item);
  const createdContainers = [...(recorded?.createdContainers ?? [])];
  const arrayKey = JSON.stringify([item.file, item.arrayKeyPath]);
  const wantedSha = canonicalSha256(item.entry);
  // Entries an earlier, record-less install wrote: taken out once, so this
  // change's own entries take their place. One identical to what is wanted
  // is kept where it is and taken over.
  if (!fileHadRecord && item.isPreLibraryEntry && !files.preLibraryFiltered.has(arrayKey)) {
    files.preLibraryFiltered.add(arrayKey);
    const stale = (existing ?? []).map((entry, index) => ({ entry, index })).filter(({ entry }) => item.isPreLibraryEntry!(entry) && canonicalSha256(entry) !== wantedSha);
    if (stale.length > 0) {
      ensureArrayForm(session, item);
      for (const { index } of stale.reverse()) session.removeFromArray(item.arrayKeyPath, index);
      // A list that held nothing but claude-mem's entries is claude-mem's to take away again.
      if (stale.length === existing!.length && !keyPathIn(createdContainers, item.arrayKeyPath)) createdContainers.push(item.arrayKeyPath);
      files.migrated.add(item.file);
    }
  }
  const entries = readArray(session, item) ?? [];
  let index = -1;
  if (recorded) {
    index = entries.findIndex((entry) => canonicalSha256(entry) === recorded.writtenSha256);
    // Not there as written: an entry with claude-mem's signature is the user's edit of it (theirs now);
    // with none, it was taken out (or the file reset) and is written again (magpie hooks.go:358-377).
    if (index === -1 && item.isPreLibraryEntry && entries.some((entry) => item.isPreLibraryEntry!(entry))) return releaseToUser(recorded);
  } else if (!fileHadRecord && item.isPreLibraryEntry) {
    const adopted = entries.findIndex((entry) => canonicalSha256(entry) === wantedSha && item.isPreLibraryEntry!(entry));
    if (adopted !== -1) {
      files.migrated.add(item.file);
      return { report: report(item, 'unchanged', 'taken over from an install before the Library record'), recorded: { ...baseRecord(item, item.file, wantedSha), keyPath: item.arrayKeyPath, ...(createdContainers.length > 0 ? { createdContainers } : {}) } };
    }
  }
  let outcome: LibraryItemReport['outcome'] = 'unchanged';
  if (index === -1) {
    // An equal entry alone proves nothing: it may be the user's own (a remove leaves it too).
    if (entries.some((entry) => canonicalSha256(entry) === wantedSha)) {
      return { report: report(item, 'left-to-user', 'an identical entry of the user\'s already runs; it is not written twice') };
    }
    if (session.get(item.arrayKeyPath) === undefined) {
      const created = session.set(item.arrayKeyPath, [item.entry]);
      createdContainers.push(...created, item.arrayKeyPath);
      files.noteCreated(item.file, [...created, item.arrayKeyPath]);
    } else {
      ensureArrayForm(session, item);
      session.appendToArray(item.arrayKeyPath, item.entry);
    }
    outcome = 'written';
  } else if (recorded!.writtenSha256 !== wantedSha) {
    ensureArrayForm(session, item);
    session.replaceInArray(item.arrayKeyPath, index, item.entry);
    outcome = 'written';
  }
  for (const keyPath of files.createdAlongPath(item.file, item.arrayKeyPath)) {
    if (!keyPathIn(createdContainers, keyPath)) createdContainers.push(keyPath);
  }
  return {
    report: report(item, outcome),
    recorded: { ...baseRecord(item, item.file, wantedSha), keyPath: item.arrayKeyPath, ...(createdContainers.length > 0 ? { createdContainers } : {}) },
  };
}

function applyMember(item: ConfigMemberItem, recorded: RecordedItem | undefined, files: ChangeFiles): ItemResult {
  const session = files.config(item.file, item.format);
  if (recorded?.releasedToUser) return { report: report(item, 'left-to-user', RELEASED_DETAIL), recorded };
  const current = session.get(item.keyPath);
  const wantedSha = canonicalSha256(item.value);
  const record = (previous: RecordedItem['previous'], createdContainers: string[][] | undefined): RecordedItem => ({
    ...baseRecord(item, item.file, wantedSha),
    keyPath: item.keyPath,
    value: item.value,
    previous,
    ...(createdContainers && createdContainers.length > 0 ? { createdContainers } : {}),
    ...(item.keepOnRemove ? { keepOnRemove: true } : {}),
    ...(item.dropEmptiedParentOnRemove ? { dropEmptiedParentOnRemove: true } : {}),
  });
  if (recorded && current === undefined) {
    // Taken out since (or the file reset): written again, keeping what the record says was there before.
    const created = session.set(item.keyPath, item.value);
    files.noteCreated(item.file, created);
    return { report: report(item, 'written'), recorded: record(recorded.previous, [...(recorded.createdContainers ?? []), ...created]) };
  }
  if (recorded) {
    if (canonicalSha256(current) !== recorded.writtenSha256) return releaseToUser(recorded);
    if (recorded.writtenSha256 === wantedSha) return { report: report(item, 'unchanged'), recorded: { ...recorded, group: item.group } };
    session.set(item.keyPath, item.value);
    return { report: report(item, 'written'), recorded: record(recorded.previous, recorded.createdContainers) };
  }
  if (current === undefined) {
    const created = session.set(item.keyPath, item.value);
    files.noteCreated(item.file, created);
    return { report: report(item, 'written'), recorded: record({ absent: true }, [...created, ...files.createdAlongPath(item.file, item.keyPath.slice(0, -1)).filter((keyPath) => !created.some((own) => JSON.stringify(own) === JSON.stringify(keyPath)))]) };
  }
  const preLibrary = item.isPreLibraryValue?.(current) ?? false;
  // The bytes from before this write hold claude-mem's own pre-Library value: a remove must not put them back whole.
  if (preLibrary) files.migrated.add(item.file);
  if (item.onlyWhenAbsent) return { report: report(item, 'skipped', 'already set; claude-mem sets it only when absent') };
  const same = canonicalSha256(current) === wantedSha;
  switch (item.whenUnrecorded) {
    case 'leave':
      return { report: report(item, 'left-to-user', same ? 'an identical value of the user\'s is already there' : 'the key holds a value of the user\'s; left as it is') };
    case 'adopt':
      // An earlier install's value: the bytes from before this write hold claude-mem's entry, so a remove must not put them back whole.
      files.migrated.add(item.file);
      if (!same) session.set(item.keyPath, item.value);
      return { report: report(item, same ? 'unchanged' : 'written'), recorded: record({ absent: true }, undefined) };
    case 'replace-and-stash': {
      if (!same) session.set(item.keyPath, item.value);
      // claude-mem's own value from before the record is not the user's to get back.
      const previous: RecordedItem['previous'] = !preLibrary
        ? { absent: false, value: current as LibraryValue }
        : item.valueAfterRemoveOfPreLibraryValue !== undefined ? { absent: false, value: item.valueAfterRemoveOfPreLibraryValue } : { absent: true };
      return { report: report(item, same ? 'unchanged' : 'written'), recorded: record(previous, undefined) };
    }
  }
}

function applyTextBlock(item: TextBlockItem, recorded: RecordedItem | undefined, files: ChangeFiles): ItemResult {
  const state = files.text(item.file, item.validateAs);
  if (recorded?.releasedToUser) return { report: report(item, 'left-to-user', RELEASED_DETAIL), recorded };
  const bodySha = sha256Hex(item.body);
  const range = state.text === null ? null : findTextBlock(state.text, item.open, item.close);
  // A block between claude-mem's markers with no record: an install from before the record wrote it, so the file's earlier bytes are not the user's alone.
  if (!recorded && range) files.migrated.add(item.file);
  const record: RecordedItem = {
    ...baseRecord(item, item.file, bodySha),
    open: item.open,
    close: item.close,
    ...(item.bodyManagedAtRuntime ? { bodyManagedAtRuntime: true } : {}),
  };
  if (recorded && !item.bodyManagedAtRuntime && range) {
    const currentSha = sha256Hex(textBlockBody(state.text!, range, item.open, item.close));
    // Edited by the user, and claude-mem's own text unchanged since: the edit stands (magpie instructions.go:192-222).
    if (currentSha !== recorded.writtenSha256 && recorded.writtenSha256 === bodySha) {
      return { report: report(item, 'left-to-user', 'the block was edited by the user; kept until claude-mem\'s own text for it changes'), recorded };
    }
  }
  const next = upsertTextBlock(state.text, item.open, item.close, item.body, item.placement, item.headerLineForNewFile);
  if (next === state.text) return { report: report(item, 'unchanged'), recorded: record };
  state.text = next;
  state.deleteFile = false;
  return { report: report(item, 'written'), recorded: record };
}

function applyOwnedFile(item: OwnedFileItem, recorded: RecordedItem | undefined, files: ChangeFiles): ItemResult {
  const state = files.ownedFile(item.path);
  if (recorded?.releasedToUser) return { report: report(item, 'left-to-user', RELEASED_DETAIL), recorded };
  const extras = {
    ...(item.bundleRoot ? { bundleRoot: item.bundleRoot } : {}),
    ...(item.contentsManagedAtRuntime ? { contentsManagedAtRuntime: true } : {}),
  };
  if (item.contents === null) {
    // Written by claude-mem's runtime just now: recorded so a remove takes it away.
    if (state.next === null) return { report: report(item, 'skipped', 'not there to record') };
    return { report: report(item, 'unchanged'), recorded: { ...baseRecord(item, item.path, sha256Hex(state.next)), ...extras } };
  }
  if (recorded && !item.contentsManagedAtRuntime && state.next !== null && sha256Hex(state.next) !== recorded.writtenSha256) {
    return releaseToUser(recorded);
  }
  // A file already at claude-mem's own path with no record: an install from before the record copied it; a remove must not put it back.
  if (!recorded && state.next !== null) files.migrated.add(item.path);
  const outcome = bytesEqual(state.next, item.contents) ? 'unchanged' : 'written';
  state.next = item.contents;
  return { report: report(item, outcome), recorded: { ...baseRecord(item, item.path, sha256Hex(item.contents)), ...extras } };
}

// --- removing one recorded item ---------------------------------------------------------------

function cleanUpCreatedContainers(session: ConfigSession, createdContainers: string[][] | undefined): void {
  const deepestFirst = [...(createdContainers ?? [])].sort((left, right) => right.length - left.length);
  for (const keyPath of deepestFirst) {
    if (isEmptyContainer(session.get(keyPath))) session.delete(keyPath);
  }
}

function dropEmptiedParent(session: ConfigSession, keyPath: string[]): void {
  if (keyPath.length > 1 && isEmptyContainer(session.get(keyPath.slice(0, -1)))) session.delete(keyPath.slice(0, -1));
}

const KEPT_ON_REMOVE_DETAIL = 'kept: something of the user\'s may rely on it; it is no longer recorded';

function removeRecordedItem(recorded: RecordedItem, files: ChangeFiles, formatOf: (path: string) => LibraryConfigFormat, bundleRootsToPrune: Set<string>): LibraryItemReport {
  if (recorded.releasedToUser) return report(recorded, 'left-to-user', RELEASED_DETAIL);
  if (recorded.keepOnRemove) return report(recorded, 'skipped', KEPT_ON_REMOVE_DETAIL);
  switch (recorded.place) {
    case 'json-array-entry': {
      const session = files.config(recorded.path, 'json');
      const value = session.get(recorded.keyPath!);
      if (!Array.isArray(value)) return report(recorded, 'skipped', 'already gone');
      const index = value.findIndex((entry) => canonicalSha256(entry) === recorded.writtenSha256);
      if (index === -1) return report(recorded, 'left-to-user', RELEASED_DETAIL);
      session.removeFromArray(recorded.keyPath!, index);
      cleanUpCreatedContainers(session, recorded.createdContainers);
      return report(recorded, 'removed');
    }
    case 'member': {
      const session = files.config(recorded.path, formatOf(recorded.path));
      const current = session.get(recorded.keyPath!);
      if (current === undefined) return report(recorded, 'skipped', 'already gone');
      if (canonicalSha256(current) !== recorded.writtenSha256) return report(recorded, 'left-to-user', RELEASED_DETAIL);
      if (recorded.previous && !recorded.previous.absent) {
        session.set(recorded.keyPath!, recorded.previous.value);
        return report(recorded, 'restored');
      }
      session.delete(recorded.keyPath!);
      cleanUpCreatedContainers(session, recorded.createdContainers);
      if (recorded.dropEmptiedParentOnRemove) dropEmptiedParent(session, recorded.keyPath!);
      return report(recorded, 'removed');
    }
    case 'text-block': {
      const state = files.text(recorded.path);
      const range = state.text === null ? null : findTextBlock(state.text, recorded.open!, recorded.close!);
      if (!range) return report(recorded, 'skipped', 'already gone');
      if (!recorded.bodyManagedAtRuntime && sha256Hex(textBlockBody(state.text!, range, recorded.open!, recorded.close!)) !== recorded.writtenSha256) {
        return report(recorded, 'left-to-user', 'edited by the user since claude-mem wrote it; left as it is');
      }
      state.text = removeTextBlock(state.text!, range);
      return report(recorded, 'removed');
    }
    case 'file': {
      const state = files.ownedFile(recorded.path);
      if (state.next === null) return report(recorded, 'skipped', 'already gone');
      if (!recorded.contentsManagedAtRuntime && sha256Hex(state.next) !== recorded.writtenSha256) {
        return report(recorded, 'left-to-user', 'changed by the user since claude-mem wrote it; left as it is');
      }
      state.next = null;
      if (recorded.bundleRoot) bundleRootsToPrune.add(`${recorded.bundleRoot}\0${dirname(recorded.path)}`);
      return report(recorded, 'removed');
    }
  }
}

/** Remove empty folders from `start` up to and including `bundleRoot`; never above it. */
function pruneEmptyBundleFolders(bundleRoot: string, start: string): void {
  const root = resolve(bundleRoot);
  let current = resolve(start);
  while (current === root || current.startsWith(`${root}/`) || current.startsWith(`${root}\\`)) {
    if (!existsSync(current) || readdirSync(current).length > 0) return;
    rmdirSync(current);
    if (current === root) return;
    current = dirname(current);
  }
}

// --- removing what claude-mem wrote before the record existed ---------------------------------

function removeUnrecordedItem(item: LibraryItem, files: ChangeFiles, bundleRootsToPrune: Set<string>): LibraryItemReport | null {
  switch (item.place) {
    case 'json-array-entry': {
      const session = files.config(item.file, 'json');
      const value = readArray(session, item);
      if (!value || !item.isPreLibraryEntry) return null;
      // An equal entry alone proves nothing (it may be the user's own); only claude-mem's signature does.
      const ours = value.map((entry, index) => ({ entry, index })).filter(({ entry }) => item.isPreLibraryEntry!(entry));
      if (ours.length === 0) return null;
      if (ours.length === value.length) session.delete(item.arrayKeyPath);
      else for (const { index } of ours.reverse()) session.removeFromArray(item.arrayKeyPath, index);
      return report(item, 'removed', 'written by an install from before the Library record');
    }
    case 'member': {
      if (item.keepOnRemove) return null;
      const session = files.config(item.file, item.format);
      const current = session.get(item.keyPath);
      if (current === undefined) return null;
      // An equal value alone proves nothing (it may be the user's own); only claude-mem's name or signature does.
      const ours = item.whenUnrecorded === 'adopt' || (item.isPreLibraryValue?.(current) ?? false);
      if (!ours) return null;
      if (item.valueAfterRemoveOfPreLibraryValue !== undefined) {
        if (canonicalSha256(current) === canonicalSha256(item.valueAfterRemoveOfPreLibraryValue)) return null;
        session.set(item.keyPath, item.valueAfterRemoveOfPreLibraryValue);
        return report(item, 'restored', 'an install from before the Library record left it on; turned off');
      }
      session.delete(item.keyPath);
      if (item.dropEmptiedParentOnRemove) dropEmptiedParent(session, item.keyPath);
      return report(item, 'removed', 'written by an install from before the Library record');
    }
    case 'text-block': {
      const state = files.text(item.file);
      const range = state.text === null ? null : findTextBlock(state.text, item.open, item.close);
      if (!range) return null;
      state.text = removeTextBlock(state.text!, range);
      return report(item, 'removed', 'claude-mem\'s markers');
    }
    case 'file': {
      const state = files.ownedFile(item.path);
      if (state.next === null) return null;
      state.next = null;
      if (item.bundleRoot) bundleRootsToPrune.add(`${item.bundleRoot}\0${dirname(item.path)}`);
      return report(item, 'removed', 'claude-mem\'s own path');
    }
  }
}

// --- the change -------------------------------------------------------------------------------

function formatResolver(items: LibraryItem[], recorded: RecordedItem[], migrations: LibraryMigration[]): (path: string) => LibraryConfigFormat {
  const formats = new Map<string, LibraryConfigFormat>();
  for (const item of items) {
    if (item.place === 'member') formats.set(item.file, item.format);
    if (item.place === 'json-array-entry') formats.set(item.file, 'json');
  }
  for (const migration of migrations) if (migration.format !== 'text') formats.set(migration.file, migration.format);
  for (const item of recorded) {
    if (item.place === 'json-array-entry') formats.set(item.path, 'json');
    if (item.place === 'member' && !formats.has(item.path)) {
      formats.set(item.path, item.path.endsWith('.toml') ? 'toml' : /\.ya?ml$/.test(item.path) ? 'yaml' : 'json');
    }
  }
  return (path) => formats.get(path) ?? 'json';
}

function itemPath(item: LibraryItem): string {
  return item.place === 'file' ? item.path : item.file;
}

/**
 * An item's identity in the record: its id within the file it is in. The
 * same id in another file (KIMI_CODE_HOME moved, another transcript-watch
 * config) is another item.
 */
function itemKey(item: LibraryItem): string {
  return `${item.id}\0${itemPath(item)}`;
}

function recordedKey(item: RecordedItem): string {
  return `${item.id}\0${item.path}`;
}

function instructionsHashOf(items: RecordedItem[]): string | undefined {
  const instructionShas = items.filter((item) => item.kind === 'instructions').map((item) => `${item.id}\0${item.writtenSha256}`).sort();
  return instructionShas.length > 0 ? sha256Hex(instructionShas.join('\n')) : undefined;
}

function cloneRecord(record: AgentLibraryRecord | undefined, at: string): AgentLibraryRecord {
  return record ? JSON.parse(JSON.stringify(record)) as AgentLibraryRecord : emptyAgentLibraryRecord(at);
}

function finishRecord(agents: Record<string, AgentLibraryRecord>, agentId: string, record: AgentLibraryRecord, items: RecordedItem[], at: string): void {
  setRecordedItems(record, items);
  record.at = at;
  const hash = instructionsHashOf(items);
  if (hash) record.instructionsHash = hash;
  else delete record.instructionsHash;
  if (isAgentLibraryRecordEmpty(record)) delete agents[agentId];
  else agents[agentId] = record;
}

/** A remove's stand-in for a script path it could not find (agent-library-targets.ts); never written into an agent's config. */
function refuseRemovalPlaceholders(items: LibraryItem[]): void {
  for (const item of items) {
    const written = item.place === 'json-array-entry' ? item.entry : item.place === 'member' ? item.value : item.place === 'text-block' ? item.body : null;
    if (written !== null && JSON.stringify(written).includes(SCRIPT_PATH_NOT_FOUND_FOR_REMOVAL)) {
      throw new Error(`${item.id}: claude-mem's script path was not found, so this entry cannot be written; reinstall claude-mem and retry`);
    }
  }
}

/**
 * Write a worked-out change: library.json first holds it as pending, then
 * every file is written (backed up first) as one group, then `commitRecord`
 * puts the agent's new record in and library.json is saved without the
 * pending change. A throw puts every file back and saves the record as it
 * was; a crash leaves the pending change for the next command to roll back.
 * Returns the paths written or removed.
 */
function writeChange(
  transaction: LibraryRecordTransaction,
  context: LibraryContext,
  agentId: string,
  at: string,
  writes: PlannedWrite[],
  backups: LibraryBackupChangeHandle,
  commitRecord: () => void,
): string[] {
  if (writes.length === 0) {
    commitRecord();
    transaction.save();
    return [];
  }
  transaction.save({
    agentId,
    at,
    files: writes.map((write) => ({ path: write.path, bytesBeforeBase64: write.before === null ? null : base64(write.before), writtenSha256: write.next === null ? null : sha256Hex(write.next) })),
  });
  try {
    atomically(writes.map((write) => write.path), () => {
      for (const write of writes) {
        backups.keep(agentId, write.path, write.before);
        if (write.next === null) removeConfigFile(write.path);
        else writeFileAtomic(write.path, write.next);
      }
      context.afterConfigFilesWritten?.();
    });
  } catch (error) {
    if (error instanceof ConfigFilesNotPutBackError) {
      // Some files still hold this change's writes: the pending change stays in
      // library.json, so the next Library command puts them back (or says why it cannot).
      throw new Error(`${error.message}; library.json keeps this change as pending, and the next claude-mem Library command puts those files back`, { cause: error });
    }
    // `atomically` put every file back; the record stays as it was, with nothing pending.
    transaction.save();
    throw error;
  }
  commitRecord();
  transaction.save();
  return writes.map((write) => write.path);
}

function pruneBundleFolders(bundleRootsToPrune: Set<string>): void {
  for (const entry of bundleRootsToPrune) {
    const [bundleRoot, start] = entry.split('\0');
    pruneEmptyBundleFolders(bundleRoot, start);
  }
}

/**
 * Write the agent's items: new ones are added, recorded ones brought up to
 * date, recorded ones of an owned group that are no longer asked for are
 * removed. Throws, with every file put back and the record unchanged, when
 * any file cannot be read or written.
 */
export function applyLibrary(request: LibraryApplyRequest, context: LibraryContext): LibraryApplyResult {
  assertLibraryRuntime();
  refuseRemovalPlaceholders(request.items);
  const now = context.now ?? (() => new Date());
  const backups = context.backupChange ?? invocationBackupChange(context.libraryDirectory, now);
  const result = withLibraryRecords(context.libraryDirectory, (transaction) => {
    const agents = transaction.agents;
    const at = now().toISOString();
    const record = cloneRecord(agents[request.agentId], at);
    // Pre-Library entries are recognized only in a file the record has never held anything in.
    const recordedPaths = new Set(recordedItemsOf(record).map((item) => item.path));
    const recordedById = new Map(recordedItemsOf(record).map((item) => [recordedKey(item), item]));
    const wantedIds = new Set(request.items.map(itemKey));
    const owned = new Set(request.ownedGroups);
    const toRemove = recordedItemsOf(record).filter((item) => owned.has(item.group) && !wantedIds.has(recordedKey(item)));
    const migrations = request.migrations ?? [];
    const reports: LibraryItemReport[] = [];
    const next = new Map(recordedById);
    const formatOf = formatResolver(request.items, toRemove, migrations);
    const bundleRootsToPrune = new Set<string>();
    const files = new ChangeFiles(request.jsonStyles ?? {});
    runMigrations(migrations, files);
    for (const recorded of toRemove) {
      reports.push(removeRecordedItem(recorded, files, formatOf, bundleRootsToPrune));
      next.delete(recordedKey(recorded));
    }
    for (const item of request.items) {
      const recorded = recordedById.get(itemKey(item));
      const itemResult = item.place === 'json-array-entry' ? applyArrayEntry(item, recorded, files, recordedPaths.has(item.file))
        : item.place === 'member' ? applyMember(item, recorded, files)
        : item.place === 'text-block' ? applyTextBlock(item, recorded, files)
        : applyOwnedFile(item, recorded, files);
      reports.push(itemResult.report);
      if (itemResult.recorded) next.set(itemKey(item), itemResult.recorded);
      else next.delete(itemKey(item));
    }
    const writes = files.plan(record.files);
    const filesWritten = writeChange(transaction, context, request.agentId, at, writes, backups, () => finishRecord(agents, request.agentId, record, [...next.values()], at));
    return { result: { agentId: request.agentId, items: reports, filesWritten, ...(transaction.recoveryNotes.length > 0 ? { recoveryNotes: transaction.recoveryNotes } : {}) }, bundleRootsToPrune };
  });
  pruneBundleFolders(result.bundleRootsToPrune);
  pruneLibraryBackups(context.libraryDirectory);
  return result.result;
}

export interface LibraryRemoveRequest {
  agentId: string;
  /**
   * What the agent's install would write. Items the record does not hold are
   * removed only by claude-mem's own signature (an install from before the
   * record existed).
   */
  items: LibraryItem[];
  jsonStyles?: Record<string, JsonFileStyle>;
  migrations?: LibraryMigration[];
  /** Remove only these groups (default: everything recorded for the agent). */
  groups?: string[];
}

/**
 * Whether a file's bytes from before claude-mem's first write already hold
 * claude-mem's own entries, by the same signatures a remove of an unrecorded
 * install uses (migrations, pre-Library entries, markers, claude-mem's own
 * path). Such bytes are never put back whole.
 */
function bytesHoldClaudeMemEntries(path: string, bytes: Uint8Array | null, items: LibraryItem[], migrations: LibraryMigration[], jsonStyles: Record<string, JsonFileStyle>): boolean {
  if (bytes === null) return false;
  const probe = new ChangeFiles(jsonStyles, (candidate) => (candidate === path ? bytes : readConfigFileBytes(candidate)));
  runMigrations(migrations.filter((migration) => migration.file === path), probe);
  if (probe.migrated.has(path)) return true;
  return items.some((item) => itemPath(item) === path && removeUnrecordedItem(item, probe, new Set()) !== null);
}

/**
 * Take out what claude-mem wrote into the agent. A file found exactly as
 * claude-mem last wrote it gets its bytes from before claude-mem's first
 * write back, when those bytes held nothing of claude-mem's; any other file
 * loses only claude-mem's entries.
 */
export function removeLibrary(request: LibraryRemoveRequest, context: LibraryContext): LibraryApplyResult {
  assertLibraryRuntime();
  const now = context.now ?? (() => new Date());
  const backups = context.backupChange ?? invocationBackupChange(context.libraryDirectory, now);
  const result = withLibraryRecords(context.libraryDirectory, (transaction) => {
    const agents = transaction.agents;
    const at = now().toISOString();
    const record = cloneRecord(agents[request.agentId], at);
    const inScope = (group: string) => !request.groups || request.groups.includes(group);
    const recorded = recordedItemsOf(record).filter((item) => inScope(item.group));
    const kept = recordedItemsOf(record).filter((item) => !inScope(item.group));
    const recordedIds = new Set(recordedItemsOf(record).map(recordedKey));
    const itemsInScope = request.items.filter((item) => inScope(item.group));
    const unrecorded = itemsInScope.filter((item) => !recordedIds.has(itemKey(item)));
    const migrations = request.migrations ?? [];
    const jsonStyles = request.jsonStyles ?? {};
    const reports: LibraryItemReport[] = [];
    const formatOf = formatResolver(request.items, recorded, migrations);
    const bundleRootsToPrune = new Set<string>();
    const fileRecords = record.files;
    // A file that keeps items of other groups, or an item kept on remove, is never put back whole.
    const pathsNotRestoredWhole = new Set([...kept, ...recorded.filter((item) => item.keepOnRemove)].map((item) => item.path));
    const files = new ChangeFiles(jsonStyles);
    const restored = new Set<string>();
    for (const [path, fileRecord] of Object.entries(fileRecords)) {
      if (pathsNotRestoredWhole.has(path) || !fileRecord.exactRestore) continue;
      const current = readConfigFileBytes(path);
      if (current === null || sha256Hex(current) !== fileRecord.writtenSha256) continue;
      const before = fileRecord.bytesBeforeBase64 === null ? null : new Uint8Array(Buffer.from(fileRecord.bytesBeforeBase64, 'base64'));
      if (bytesHoldClaudeMemEntries(path, before, itemsInScope, migrations, jsonStyles)) continue;
      files.restore(path, before);
      restored.add(path);
    }
    for (const item of recorded) {
      if (restored.has(item.path)) {
        reports.push(report(item, 'restored', 'the file is back to its bytes from before claude-mem'));
        if (item.place === 'file' && item.bundleRoot) bundleRootsToPrune.add(`${item.bundleRoot}\0${dirname(item.path)}`);
        continue;
      }
      reports.push(removeRecordedItem(item, files, formatOf, bundleRootsToPrune));
    }
    runMigrations(migrations.filter((migration) => !restored.has(migration.file)), files);
    for (const item of unrecorded) {
      if (restored.has(itemPath(item))) continue;
      const itemReport = removeUnrecordedItem(item, files, bundleRootsToPrune);
      if (itemReport) reports.push(itemReport);
    }
    const writes = files.plan(fileRecords);
    for (const path of restored) delete fileRecords[path];
    // Files whose items all went: no record left to restore them from.
    const pathsWithKeptItems = new Set(kept.map((item) => item.path));
    for (const path of Object.keys(fileRecords)) if (!pathsWithKeptItems.has(path)) delete fileRecords[path];
    const filesWritten = writeChange(transaction, context, request.agentId, at, writes, backups, () => finishRecord(agents, request.agentId, record, kept, at));
    return { result: { agentId: request.agentId, items: reports, filesWritten, ...(transaction.recoveryNotes.length > 0 ? { recoveryNotes: transaction.recoveryNotes } : {}) }, bundleRootsToPrune };
  });
  pruneBundleFolders(result.bundleRootsToPrune);
  pruneLibraryBackups(context.libraryDirectory);
  return result.result;
}

export type LibraryItemState = 'present' | 'missing' | 'edited-by-user' | 'released-to-user';

export interface LibraryStatusItem {
  id: string;
  kind: RecordedItem['kind'];
  group: string;
  path: string;
  state: LibraryItemState;
}

/** What library.json records for the agent, each item checked against its file. Never writes. */
export function libraryStatus(agentId: string, context: LibraryContext): { recordedAt: string | null; items: LibraryStatusItem[] } {
  const record = readLibraryRecords(context.libraryDirectory)[agentId];
  if (!record) return { recordedAt: null, items: [] };
  const items = recordedItemsOf(record).map((item): LibraryStatusItem => {
    const base = { id: item.id, kind: item.kind, group: item.group, path: item.path };
    if (item.releasedToUser) return { ...base, state: 'released-to-user' };
    try {
      return { ...base, state: recordedItemState(item) };
    } catch (error) {
      // Unreadable is not "missing" (unknown ≠ empty): reported as edited, so nothing acts on it.
      return { ...base, state: 'edited-by-user', path: `${base.path} (unreadable: ${errorMessage(error)})` };
    }
  });
  return { recordedAt: record.at, items };
}

function recordedItemState(item: RecordedItem): LibraryItemState {
  const bytes = readConfigFileBytes(item.path);
  if (bytes === null) return 'missing';
  if (item.place === 'file') return item.contentsManagedAtRuntime || sha256Hex(bytes) === item.writtenSha256 ? 'present' : 'edited-by-user';
  if (item.place === 'text-block') {
    const text = decodeConfigText(bytes);
    const range = findTextBlock(text, item.open!, item.close!);
    if (!range) return 'missing';
    return item.bodyManagedAtRuntime || sha256Hex(textBlockBody(text, range, item.open!, item.close!)) === item.writtenSha256 ? 'present' : 'edited-by-user';
  }
  const format: LibraryConfigFormat = item.path.endsWith('.toml') ? 'toml' : /\.ya?ml$/.test(item.path) ? 'yaml' : 'json';
  const session = openConfigSession(item.path, format, bytes);
  const value = session.get(item.keyPath!);
  if (item.place === 'json-array-entry') {
    if (!Array.isArray(value)) return 'missing';
    return value.some((entry) => canonicalSha256(entry) === item.writtenSha256) ? 'present' : 'edited-by-user';
  }
  if (value === undefined) return 'missing';
  return canonicalSha256(value) === item.writtenSha256 ? 'present' : 'edited-by-user';
}
