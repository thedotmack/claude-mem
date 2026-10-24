// SPDX-License-Identifier: Apache-2.0
//
// Before the Library first writes a file, the file is copied into the
// current change's backup folder (plan Phase 14 task 3). Ported from magpie
// internal/library/backup.go:17-124 (MIT, Copyright (c) 2026 yetone): one
// folder per change, only the newest 30 kept. As in magpie, a change is one
// user command: `claude-mem install` or `library sync|remove` may run several
// applies and removes (Cursor's hooks then its MCP server, Codex's settings
// then AGENTS.md), and they all share the command's folder, so 30 kept means
// the last 30 commands. Under npx each agent's installer runs in its own Bun
// child (npx-cli/commands/library.ts); the Node parent hands every child one
// change id (LIBRARY_CHANGE_ID_ENV), so one `npx claude-mem uninstall` is
// still one folder.
//
// A folder is named `<sequence>_<change id>`. The sequence is one more than
// the highest already there, taken under library.json's lock (folders are
// made only inside a change), so folders are ordered by when they were made
// whatever the wall clock did (a DST fall-back, a clock set back); the
// change id's time is only for people reading the folder names. Folders
// from before the sequence (named by local time) count as older than any
// numbered one.
//
// Inside a change folder a file is kept at <agent>/<its absolute path>, so
// two files of one name never meet; a file is kept once per change, with the
// bytes it had before the change's first write to it.

import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, parse } from 'path';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE } from '../../../shared/paths.js';
import type { LibraryBackupChangeHandle } from './types.js';

/**
 * How many changes' backups are kept: the plan's number (task 3), magpie's
 * `keepBackups`. Older change folders are deleted after each change.
 */
export const LIBRARY_BACKUPS_KEPT = 30;

export function libraryBackupsDirectory(libraryDirectory: string): string {
  return join(libraryDirectory, 'backups');
}

/** The environment variable a parent process sets so every Library child of one user command shares one backup folder. */
export const LIBRARY_CHANGE_ID_ENV = 'CLAUDE_MEM_LIBRARY_CHANGE_ID';

/** Letters, digits and dashes only: it becomes part of a folder name. */
const CHANGE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/** A new change id: the UTC time (for people reading folder names; never used to order), this pid, and random bits so two commands never share one. */
export function newLibraryChangeId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-p${process.pid}-${randomBytes(3).toString('hex')}`;
}

/** Where `filePath` is kept inside an agent's part of a change folder: its absolute path, root (and drive) taken off. */
function pathInsideChange(filePath: string): string {
  const { root } = parse(filePath);
  return filePath.slice(root.length);
}

/** A numbered change folder: `<sequence>_<change id>`. */
const SEQUENCED_FOLDER_NAME = /^(\d+)_([A-Za-z0-9-]+)$/;
/** A folder from before the sequence: its local-time stamp, and the -N a same-millisecond change got. */
const LEGACY_FOLDER_NAME = /^(.*?)(?:-(\d+))?$/;
/** Width the sequence is zero-padded to, so `ls` lists folders in order; numbers past it still parse and sort. */
const SEQUENCE_PAD_WIDTH = 6;

/** One change's backup folder, made (or, for a later child of the same command, found) on its first kept file. */
export class LibraryBackupChange implements LibraryBackupChangeHandle {
  private changeDirectory: string | null = null;
  private readonly kept = new Set<string>();
  readonly changeId: string;

  constructor(private readonly libraryDirectory: string, now: () => Date, changeId?: string) {
    this.changeId = changeId ?? newLibraryChangeId(now());
    if (!CHANGE_ID_PATTERN.test(this.changeId)) {
      throw new Error(`Library backup change id ${JSON.stringify(this.changeId)} may hold only letters, digits and dashes (from ${LIBRARY_CHANGE_ID_ENV}?)`);
    }
  }

  /**
   * Copy `bytes` (the file as the agent had it) aside, once per agent and
   * file in this change: a copy an earlier child of the same command already
   * kept holds the earlier bytes and stays. A file that did not exist has
   * nothing to keep.
   */
  keep(agentId: string, filePath: string, bytes: Uint8Array | null): void {
    const key = `${agentId}\0${filePath}`;
    if (this.kept.has(key) || bytes === null) return;
    this.kept.add(key);
    const destination = join(this.ensureChangeDirectory(), agentId, pathInsideChange(filePath));
    if (existsSync(destination)) return;
    mkdirSync(dirname(destination), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    writeFileSync(destination, bytes, { mode: WIRE_GATEWAY_FILE_MODE, flag: 'wx' });
  }

  private ensureChangeDirectory(): string {
    if (this.changeDirectory) return this.changeDirectory;
    const root = libraryBackupsDirectory(this.libraryDirectory);
    mkdirSync(root, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    const names = readdirSync(root);
    const sequenced = names.map((name) => SEQUENCED_FOLDER_NAME.exec(name)).filter((match): match is RegExpExecArray => match !== null);
    const existing = sequenced.find((match) => match[2] === this.changeId);
    if (existing) {
      this.changeDirectory = join(root, existing[0]);
      return this.changeDirectory;
    }
    // After the highest number there, never in a gap pruning left: a reused lower number would sort as the oldest change and be pruned straight away.
    const sequence = sequenced.reduce((highest, match) => Math.max(highest, Number(match[1])), 0) + 1;
    const candidate = join(root, `${String(sequence).padStart(SEQUENCE_PAD_WIDTH, '0')}_${this.changeId}`);
    mkdirSync(candidate, { mode: WIRE_GATEWAY_DIR_MODE });
    this.changeDirectory = candidate;
    return candidate;
  }
}

const invocationChanges = new Map<string, LibraryBackupChange>();

/** This process's change for `libraryDirectory`: one per user command, shared with the command's other Library processes through LIBRARY_CHANGE_ID_ENV (see the file comment). */
export function invocationBackupChange(libraryDirectory: string, now: () => Date): LibraryBackupChange {
  let change = invocationChanges.get(libraryDirectory);
  if (!change) {
    change = new LibraryBackupChange(libraryDirectory, now, process.env[LIBRARY_CHANGE_ID_ENV] || undefined);
    invocationChanges.set(libraryDirectory, change);
  }
  return change;
}

/** Oldest first: folders from before the sequence (by stamp, then -N), then numbered folders by number. */
function compareChangeFolders(left: string, right: string): number {
  const leftSequence = SEQUENCED_FOLDER_NAME.exec(left);
  const rightSequence = SEQUENCED_FOLDER_NAME.exec(right);
  if (leftSequence && rightSequence) return Number(leftSequence[1]) - Number(rightSequence[1]);
  if (leftSequence || rightSequence) return leftSequence ? 1 : -1;
  const [, leftStamp, leftSuffix] = LEGACY_FOLDER_NAME.exec(left)!;
  const [, rightStamp, rightSuffix] = LEGACY_FOLDER_NAME.exec(right)!;
  if (leftStamp !== rightStamp) return leftStamp < rightStamp ? -1 : 1;
  return Number(leftSuffix ?? 1) - Number(rightSuffix ?? 1);
}

/** Change folders, oldest first. */
export function libraryBackupChangeFolders(libraryDirectory: string): string[] {
  const root = libraryBackupsDirectory(libraryDirectory);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort(compareChangeFolders);
}

/** Delete all but the newest LIBRARY_BACKUPS_KEPT change folders. Returns how many were deleted. */
export function pruneLibraryBackups(libraryDirectory: string): number {
  const changeFolders = libraryBackupChangeFolders(libraryDirectory);
  const excess = changeFolders.slice(0, Math.max(0, changeFolders.length - LIBRARY_BACKUPS_KEPT));
  for (const name of excess) rmSync(join(libraryBackupsDirectory(libraryDirectory), name), { recursive: true, force: true });
  return excess.length;
}
