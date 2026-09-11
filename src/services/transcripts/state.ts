import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';

export interface TranscriptWatchState {
  offsets: Record<string, number>;
  /**
   * Unterminated JSONL prefixes (per file) that a durable offset has advanced
   * past. zstd frames are only resumeable at frame boundaries, so when a frame
   * ends in the middle of a JSONL record the prefix must survive a watcher
   * restart or the completed record is never assembled. Older state files
   * predate this field and simply have no partials.
   */
  partials?: Record<string, string>;
}

export function loadWatchState(statePath: string): TranscriptWatchState {
  try {
    if (!existsSync(statePath)) {
      return { offsets: {}, partials: {} };
    }
    const raw = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as TranscriptWatchState;
    if (!parsed.offsets) return { offsets: {}, partials: {} };
    return { offsets: parsed.offsets, partials: parsed.partials ?? {} };
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to load watch state, starting fresh', {
      statePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return { offsets: {}, partials: {} };
  }
}

export function saveWatchState(statePath: string, state: TranscriptWatchState): void {
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to save watch state', {
      statePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
