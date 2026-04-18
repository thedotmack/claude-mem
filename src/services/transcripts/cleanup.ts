/**
 * JSONL File Cleanup Service
 *
 * Addresses Bug #1937: JSONL files under ~/.claude/projects/ accumulate indefinitely
 * after their content has been extracted into SQLite. This module provides:
 *
 * 1. Marking JSONL files as "processed" once fully read (offset === file size)
 * 2. Age-based cleanup: delete processed files older than 7 days
 * 3. Size-based cleanup: if total JSONL size exceeds 1GB, delete oldest processed files first
 * 4. Periodic execution via setInterval (every hour)
 */

import { existsSync, statSync, unlinkSync } from 'fs';
import { extname } from 'path';
import { logger } from '../../utils/logger.js';
import type { TranscriptWatchState } from './state.js';
import { saveWatchState } from './state.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_GB_BYTES = 1024 * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface JsonlCleanupOptions {
  /** Maximum age in milliseconds for processed files before deletion. Default: 7 days */
  maxAgeMs?: number;
  /** Maximum total JSONL size in bytes before oldest processed files are deleted. Default: 1GB */
  maxTotalSizeBytes?: number;
}

interface JsonlFileInfo {
  filePath: string;
  sizeBytes: number;
  modifiedAtMs: number;
  isProcessed: boolean;
}

/**
 * Determine if a JSONL file has been fully processed.
 * A file is "processed" when the watcher's tracked offset equals or exceeds the file size,
 * meaning all content has been read and sent to SQLite.
 */
export function isFileFullyProcessed(filePath: string, state: TranscriptWatchState): boolean {
  const trackedOffset = state.offsets[filePath];
  if (trackedOffset === undefined) return false;

  try {
    const fileSize = statSync(filePath).size;
    return trackedOffset >= fileSize;
  } catch {
    // File may have been deleted already
    return false;
  }
}

/**
 * Gather info about all JSONL files tracked in the watcher state.
 */
function gatherJsonlFileInfo(state: TranscriptWatchState): JsonlFileInfo[] {
  const files: JsonlFileInfo[] = [];

  for (const filePath of Object.keys(state.offsets)) {
    if (extname(filePath) !== '.jsonl') continue;
    if (!existsSync(filePath)) continue;

    try {
      const stat = statSync(filePath);
      files.push({
        filePath,
        sizeBytes: stat.size,
        modifiedAtMs: stat.mtimeMs,
        isProcessed: (state.offsets[filePath] ?? 0) >= stat.size,
      });
    } catch {
      // Skip files we can't stat
    }
  }

  return files;
}

/**
 * Run a single cleanup pass: delete processed JSONL files that are either too old
 * or that push the total JSONL footprint over the size cap.
 *
 * Returns the number of files deleted.
 */
export function runJsonlCleanup(
  state: TranscriptWatchState,
  statePath: string,
  options: JsonlCleanupOptions = {}
): number {
  const maxAgeMs = options.maxAgeMs ?? SEVEN_DAYS_MS;
  const maxTotalSizeBytes = options.maxTotalSizeBytes ?? ONE_GB_BYTES;
  const now = Date.now();

  const allFiles = gatherJsonlFileInfo(state);
  const processedFiles = allFiles.filter(f => f.isProcessed);
  let totalSizeBytes = allFiles.reduce((sum, f) => sum + f.sizeBytes, 0);

  let deletedCount = 0;
  const deletedPaths: string[] = [];

  // Phase 1: Age-based cleanup — delete processed files older than maxAgeMs
  for (const file of processedFiles) {
    const ageMs = now - file.modifiedAtMs;
    if (ageMs > maxAgeMs) {
      if (deleteJsonlFile(file.filePath, state)) {
        totalSizeBytes -= file.sizeBytes;
        deletedCount++;
        deletedPaths.push(file.filePath);
      }
    }
  }

  // Phase 2: Size-based cleanup — if still over cap, delete oldest processed files first
  if (totalSizeBytes > maxTotalSizeBytes) {
    // Re-gather after phase 1 deletions
    const remainingProcessed = processedFiles
      .filter(f => !deletedPaths.includes(f.filePath))
      .sort((a, b) => a.modifiedAtMs - b.modifiedAtMs); // oldest first

    for (const file of remainingProcessed) {
      if (totalSizeBytes <= maxTotalSizeBytes) break;

      if (deleteJsonlFile(file.filePath, state)) {
        totalSizeBytes -= file.sizeBytes;
        deletedCount++;
        deletedPaths.push(file.filePath);
      }
    }
  }

  // Persist updated state (offsets for deleted files are removed)
  if (deletedCount > 0) {
    saveWatchState(statePath, state);
    logger.info('TRANSCRIPT', `JSONL cleanup: deleted ${deletedCount} processed files`, {
      deletedCount,
      remainingTotalSizeMB: Math.round(totalSizeBytes / (1024 * 1024)),
    });
  }

  return deletedCount;
}

/**
 * Delete a single JSONL file and remove its offset tracking from state.
 * Returns true if deletion succeeded.
 */
function deleteJsonlFile(filePath: string, state: TranscriptWatchState): boolean {
  try {
    unlinkSync(filePath);
    delete state.offsets[filePath];
    logger.debug('TRANSCRIPT', 'Deleted processed JSONL file', { filePath });
    return true;
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to delete JSONL file', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Also clean up stale offset entries for files that no longer exist on disk.
 * This prevents the state file from growing indefinitely with references to deleted files.
 */
export function cleanStaleOffsets(state: TranscriptWatchState, statePath: string): number {
  let cleanedCount = 0;
  for (const filePath of Object.keys(state.offsets)) {
    if (!existsSync(filePath)) {
      delete state.offsets[filePath];
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    saveWatchState(statePath, state);
    logger.debug('TRANSCRIPT', `Cleaned ${cleanedCount} stale offset entries from watch state`);
  }

  return cleanedCount;
}

/**
 * Start periodic JSONL cleanup. Returns a stop function.
 */
export function startPeriodicJsonlCleanup(
  state: TranscriptWatchState,
  statePath: string,
  options: JsonlCleanupOptions = {}
): () => void {
  // Run immediately on startup
  try {
    cleanStaleOffsets(state, statePath);
    runJsonlCleanup(state, statePath, options);
  } catch (error) {
    logger.error('TRANSCRIPT', 'Initial JSONL cleanup failed', {}, error as Error);
  }

  // Then run every hour
  const intervalId = setInterval(() => {
    try {
      cleanStaleOffsets(state, statePath);
      runJsonlCleanup(state, statePath, options);
    } catch (error) {
      logger.error('TRANSCRIPT', 'Periodic JSONL cleanup failed', {}, error as Error);
    }
  }, CLEANUP_INTERVAL_MS);

  return () => {
    clearInterval(intervalId);
  };
}
