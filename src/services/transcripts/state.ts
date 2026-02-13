import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';

export interface TranscriptWatchState {
  offsets: Record<string, number>;
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
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to save watch state', {
      statePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
