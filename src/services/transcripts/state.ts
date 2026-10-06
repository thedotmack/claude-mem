import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';

export interface TranscriptWatchState {
  offsets: Record<string, number>;
  /** Device/inode pair belonging to each checkpoint; absent in legacy state. */
  fileIdentities?: Record<string, string>;
  /**
   * sha256 of the up-to-4 KiB just before each checkpoint. When a file's
   * device/inode changes, it is a replacement (read from byte 0) only if these
   * bytes changed too: a renumbered device or a sync tool's temp-plus-rename
   * keeps them, and keeps the checkpoint.
   */
  checkpointFingerprints?: Record<string, string>;
  /**
   * zstd files only: the unterminated JSONL prefix a durable offset has
   * advanced past. zstd frames are only resumable at frame boundaries, so when
   * a frame ends in the middle of a JSONL record the prefix must survive a
   * watcher restart or the completed record is never assembled. (A JSONL
   * checkpoint simply stops before its partial record.) Older state files
   * predate this field and simply have no partials.
   */
  partials?: Record<string, string>;
  /**
   * zstd files only: how many lines of the frame at the offset were already
   * dispatched when a turn later in that frame failed. The retry, in this
   * process or after a restart, resumes at the failed line, not at the frame
   * start.
   */
  frameLines?: Record<string, number>;
  /**
   * The working directory each file's session last reported. Some hosts write
   * it only on a session's first line (DeepSeek Harness), and a restarted
   * watcher resumes past that line, so it is kept here. Older state files
   * have none.
   */
  cwds?: Record<string, string>;
}

function normalizeMap<T>(value: unknown, valid: (value: unknown) => value is T): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, T] => valid(entry[1])));
}

export function loadWatchState(statePath: string): TranscriptWatchState {
  try {
    if (!existsSync(statePath)) {
      return { offsets: {} };
    }
    const parsed = readJsonFileWithBom<TranscriptWatchState>(statePath);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { offsets: {} };
    const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const text = (value: unknown): value is string => typeof value === 'string';
    const state: TranscriptWatchState = { offsets: normalizeMap(parsed.offsets, integer) };
    // Frame continuation is meaningful only at its matching durable offset.
    // Keeping it after a corrupt offset is dropped skips or prefixes fresh records.
    const continuation = <T>(map: Record<string, T>): Record<string, T> => Object.fromEntries(
      Object.entries(map).filter(([file]) => Object.hasOwn(state.offsets, file))
    );
    if (parsed.partials !== undefined) state.partials = continuation(normalizeMap(parsed.partials, text));
    if (parsed.frameLines !== undefined) state.frameLines = continuation(normalizeMap(parsed.frameLines, integer));
    if (parsed.fileIdentities !== undefined) state.fileIdentities = continuation(normalizeMap(parsed.fileIdentities, text));
    if (parsed.checkpointFingerprints !== undefined) state.checkpointFingerprints = continuation(normalizeMap(parsed.checkpointFingerprints, text));
    if (parsed.cwds !== undefined) state.cwds = normalizeMap(parsed.cwds, text);
    return state;
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
