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
   * Each file's tool calls still waiting for their results, by session key
   * and tool id, so a result retried after a restart keeps its tool's name and
   * input. An input larger than MAX_SAVED_TOOL_INPUT_BYTES is saved as the name
   * alone.
   */
  pendingTools?: Record<string, Record<string, Record<string, { toolName: string; toolInput?: unknown }>>>;
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
    if (parsed.pendingTools !== undefined) {
      const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
      const tool = (value: unknown): value is { toolName: string; toolInput?: unknown } =>
        record(value) && typeof value.toolName === 'string' && value.toolName.length > 0;
      state.pendingTools = Object.fromEntries(
        Object.entries(continuation(normalizeMap(parsed.pendingTools, record))).map(([file, sessions]) => [
          file, Object.fromEntries(Object.entries(normalizeMap(sessions, record)).map(([session, tools]) => [
            session, normalizeMap(tools, tool),
          ])),
        ]),
      );
    }
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

/** A pending tool call's input is saved only up to this many bytes of JSON (a Write's input is the whole file). */
const MAX_SAVED_TOOL_INPUT_BYTES = 64 * 1024;

type PendingToolCall = { toolName: string; toolInput?: unknown };
const savedToolCalls = new WeakMap<PendingToolCall, PendingToolCall>();

/** What the state file keeps of a pending tool call: all of it, or its name alone when its input is large. */
function savedToolCall(tool: PendingToolCall): PendingToolCall {
  let saved = savedToolCalls.get(tool);
  if (!saved) {
    const inputBytes = tool.toolInput === undefined ? 0 : Buffer.byteLength(JSON.stringify(tool.toolInput) ?? '');
    saved = inputBytes <= MAX_SAVED_TOOL_INPUT_BYTES ? tool : { toolName: tool.toolName };
    savedToolCalls.set(tool, saved);
  }
  return saved;
}

function savedPendingTools(pendingTools: NonNullable<TranscriptWatchState['pendingTools']>): NonNullable<TranscriptWatchState['pendingTools']> {
  const saved: NonNullable<TranscriptWatchState['pendingTools']> = {};
  for (const [file, sessions] of Object.entries(pendingTools)) {
    saved[file] = {};
    for (const [session, tools] of Object.entries(sessions)) {
      saved[file][session] = {};
      for (const [id, tool] of Object.entries(tools)) saved[file][session][id] = savedToolCall(tool);
    }
  }
  return saved;
}

export function saveWatchState(statePath: string, state: TranscriptWatchState): void {
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const saved = state.pendingTools ? { ...state, pendingTools: savedPendingTools(state.pendingTools) } : state;
    // Pending tool inputs may contain credentials: keep both new and replaced
    // state files private from the first byte written.
    writeJsonFileAtomic(statePath, saved, { mode: 0o600 });
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to save watch state', {
      statePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
