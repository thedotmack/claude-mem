import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';

export interface TranscriptWatchState {
  offsets: Record<string, number>;
  /**
   * zstd files only: the unterminated JSONL prefix a durable offset has
   * advanced past. zstd frames are only resumable at frame boundaries, so when
   * a frame ends in the middle of a JSONL record the prefix must survive a
   * watcher restart or the completed record is never assembled. (A JSONL
   * checkpoint simply stops before its partial record.) Older state files
   * predate this field and simply have no partials.
   */
  partials?: Record<string, string>;
}

export function loadWatchState(statePath: string): TranscriptWatchState {
  try {
    if (!existsSync(statePath)) {
      return { offsets: {} };
    }
    const raw = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as TranscriptWatchState;
    if (!parsed.offsets) return { offsets: {} };
    return parsed;
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to load watch state, starting fresh', {
      statePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return { offsets: {} };
  }
}

export function saveWatchState(statePath: string, state: TranscriptWatchState): void {
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeJsonFileAtomic(statePath, state);
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to save watch state', {
      statePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
