// SPDX-License-Identifier: Apache-2.0
//
// File-level helpers for the format editors (plan Phase 7 tasks 1-2): read an
// agent's config, write it back atomically only when an edit changed it, and
// run a multi-file edit as one group that is put back exactly on a throw.
// Ported from magpie internal/edit/file.go:314-366 `Remove`/`Atomically`
// (MIT, Copyright (c) 2026 yetone).

import { chmodSync, lstatSync, readFileSync, statSync, unlinkSync } from 'fs';
import { resolveSymlinkWriteTarget, writeFileAtomic } from '../../../shared/atomic-json.js';

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** The file's bytes, or null when it does not exist. Any other read failure throws (unknown ≠ empty). */
export function readConfigFileBytes(configFilePath: string): Uint8Array | null {
  try {
    return readFileSync(configFilePath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function bytesAreEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(left.buffer, left.byteOffset, left.byteLength), Buffer.from(right.buffer, right.byteOffset, right.byteLength)) === 0;
}

/**
 * Run `editBytes` over the file's bytes (empty when the file is absent) and
 * write the result atomically, only when it differs. An absent file the edit
 * leaves empty (a delete from a file that is not there) is not created.
 * Returns whether the file was written. An editor that throws leaves the file
 * untouched.
 */
export function applyConfigFileEdit(configFilePath: string, editBytes: (originalBytes: Uint8Array) => Uint8Array): boolean {
  const originalBytes = readConfigFileBytes(configFilePath);
  const editedBytes = editBytes(originalBytes ?? new Uint8Array(0));
  if (bytesAreEqual(originalBytes ?? new Uint8Array(0), editedBytes)) return false;
  writeFileAtomic(configFilePath, editedBytes);
  return true;
}

/**
 * Take away a config file. A symlink stays and the file it points at is
 * emptied instead; a file with other hard links is emptied and kept, so every
 * name comes out empty rather than one name keeping the old text.
 */
export function removeConfigFile(configFilePath: string): void {
  let linkStats: ReturnType<typeof lstatSync>;
  try {
    linkStats = lstatSync(configFilePath);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  if (!linkStats.isSymbolicLink() && Number(linkStats.nlink) <= 1) {
    unlinkSync(configFilePath);
    return;
  }
  try {
    statSync(configFilePath);
  } catch (error) {
    if (isMissingFileError(error)) return; // A link to nothing: nothing to empty.
    throw error;
  }
  writeFileAtomic(configFilePath, new Uint8Array(0));
}

interface ConfigFileSnapshot {
  configFilePath: string;
  existedBefore: boolean;
  bytesBefore: Uint8Array;
  modeBefore: number;
}

/**
 * What a group must put back. A path that cannot be read or is not a regular
 * file throws: an edit the rollback could not undo is refused before it starts
 * (unknown ≠ empty).
 */
function snapshotConfigFile(configFilePath: string): ConfigFileSnapshot {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(configFilePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    // A link to nothing yet stays; only what the group made at its target goes.
    return { configFilePath: resolveSymlinkWriteTarget(configFilePath), existedBefore: false, bytesBefore: new Uint8Array(0), modeBefore: 0 };
  }
  if (!stats.isFile()) throw new Error(`${configFilePath} is not a regular file`);
  return { configFilePath, existedBefore: true, bytesBefore: readFileSync(configFilePath), modeBefore: Number(stats.mode) & 0o777 };
}

function restoreConfigFile(snapshot: ConfigFileSnapshot): void {
  if (!snapshot.existedBefore) {
    try {
      unlinkSync(snapshot.configFilePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return;
  }
  let currentBytes: Uint8Array | null = null;
  let currentMode = -1;
  try {
    currentBytes = readFileSync(snapshot.configFilePath);
    currentMode = Number(statSync(snapshot.configFilePath).mode) & 0o777;
  } catch {
    // Gone or unreadable now: rewrite it below.
  }
  if (currentBytes === null || !bytesAreEqual(currentBytes, snapshot.bytesBefore)) {
    writeFileAtomic(snapshot.configFilePath, snapshot.bytesBefore, { mode: snapshot.modeBefore });
  }
  if (currentMode !== snapshot.modeBefore) {
    chmodSync(snapshot.configFilePath, snapshot.modeBefore);
  }
}

/**
 * Run `editGroup`, which may write the files at `configFilePaths` in several
 * steps, and when it throws put each back as it was — its bytes and mode, or
 * its absence — so an edit that fails part way leaves no file half made. A
 * file that cannot be read beforehand refuses the group before it runs. The
 * group's error is rethrown; restore failures are joined to it.
 */
export function atomically<T>(configFilePaths: readonly string[], editGroup: () => T): T {
  const snapshots = configFilePaths.map(snapshotConfigFile);
  try {
    const result = editGroup();
    if (result instanceof Promise) {
      throw new Error('atomically() takes a synchronous edit group; an async group would escape the rollback');
    }
    return result;
  } catch (groupError) {
    const restoreErrors: unknown[] = [];
    for (const snapshot of snapshots) {
      try {
        restoreConfigFile(snapshot);
      } catch (restoreError) {
        restoreErrors.push(new Error(`put ${snapshot.configFilePath} back: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`));
      }
    }
    if (restoreErrors.length === 0) throw groupError;
    const groupMessage = groupError instanceof Error ? groupError.message : String(groupError);
    throw new AggregateError([groupError, ...restoreErrors], `${groupMessage} (and ${restoreErrors.length} file(s) could not be put back)`);
  }
}
