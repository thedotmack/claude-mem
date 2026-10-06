import { createHash } from 'crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync, watch as fsWatch } from 'fs';
import { open } from 'fs/promises';
import { basename, join, resolve as resolvePath, sep as pathSep } from 'path';
import { logger } from '../../utils/logger.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptAnchorError, TranscriptEventProcessor, TranscriptObservationError, type TranscriptFileContext } from './processor.js';
import { decompressZstdFrame, isZstdSupported, scanZstdFramesInFile, type ZstdScanResult } from './zstd-frames.js';

interface TailState {
  /**
   * The durable checkpoint: the first byte not yet dispatched (JSONL: the
   * start of the next record; zstd: a frame boundary). Persisted.
   */
  offset: number;
  /** How far the file has been read (JSONL: past `offset` by the pending partial record). */
  readOffset: number;
  /** zstd only: the unterminated JSONL text carried from earlier frames (persisted with `offset`). */
  partial: string;
}

// Coarse filesystem clocks (HFS+ 1 s, FAT 2 s) can stamp a file written just
// after startup with an mtime just before it.
const WRITTEN_SINCE_STARTUP_SLACK_MS = 2000;

/**
 * How long a transcript that disappeared has to come back (a rename away and
 * back) before the tool calls saved for it are retired.
 */
const MISSING_TRANSCRIPT_GRACE_MS = 1000;

/**
 * A transcript discovered after startup with a fresh mtime whose first record
 * carries no timestamp is read from byte 0 only while it is this small: a
 * session that just started (a Codex rollout's session_meta line is ~15-25
 * KB). Copying or restoring an old transcript also gives it a fresh mtime, and
 * replaying that history from byte 0 would send every old turn through the
 * observer again.
 */
const NEW_TRANSCRIPT_REPLAY_MAX_BYTES = 256 * 1024;

/**
 * One read pass handles at most this many bytes (JSONL text, or complete zstd
 * frames), so a large backlog is worked through in bounded steps that hand the
 * event loop back between them.
 */
const MAX_BYTES_PER_PASS = 4 * 1024 * 1024;

/** The startAtEnd frame scan of a zstd file walks this many bytes of frames between yields. */
const RESUME_SCAN_BYTES_PER_STEP = 16 * 1024 * 1024;

/**
 * A root watch that just started on a missing root's ancestor, or just moved,
 * is checked once more after this long. fs.watch registers asynchronously on
 * some platforms (macOS), so a directory or file created in its first few
 * milliseconds can raise no event on it.
 */
const WATCH_ROOT_SETTLE_MS = 100;

// A bulk backfill can walk hundreds of files and tens of thousands of lines on
// the Bun event loop that also serves the worker's HTTP API. Awaiting line
// after line back to back starves live hook capture, so dispatch hands a
// macrotask back to the loop every so often (#3653).
const YIELD_EVERY_N_LINES = 100;

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * Concatenated-frame Zstandard session logs (DeepSeek Harness writes
 * `session.jsonl.zstd`): every durable write appends one independently
 * decodable frame of JSONL.
 */
const ZSTD_TRANSCRIPT_SUFFIX = '.jsonl.zstd';

/**
 * Where startAtEnd resumes a zstd file: after its last complete frame, never
 * inside a torn one (a resume must land on a frame boundary). Only frame and
 * block headers are read, in bounded steps that yield to the event loop.
 */
async function zstdResumeOffset(filePath: string, size: number): Promise<number> {
  try {
    let position = 0;
    while (position < size) {
      const scan = scanZstdFramesInFile(filePath, position, size, RESUME_SCAN_BYTES_PER_STEP);
      if (scan.tornStart !== null) return scan.tornStart;
      if (scan.frames.length === 0) break;
      position = scan.frames[scan.frames.length - 1].end;
      await yieldToEventLoop();
    }
    return position;
  } catch {
    return size;
  }
}

/**
 * How far into a transcript its first line may end for it to be read on its
 * own (a resumed tail's context, a new file's start time). A Codex
 * session_meta line carries the base instructions (about 20 KB).
 */
const FIRST_LINE_MAX_BYTES = 1024 * 1024;

/**
 * A transcript's first line: of a JSONL file, or of the text in a zstd file's
 * first frame. Only the first `limit` bytes count; null when the line (or the
 * frame) does not end within them.
 */
async function readFirstLine(filePath: string, isZstd: boolean, limit: number): Promise<string | null> {
  let text: string;
  if (isZstd) {
    const { frames } = scanZstdFramesInFile(filePath, 0, Math.min(limit, FIRST_LINE_MAX_BYTES), 1);
    if (frames.length === 0) return null;
    text = decompressZstdFrame(await readByteRange(filePath, 0, frames[0].end), frames[0]);
  } else {
    text = (await readByteRange(filePath, 0, Math.min(limit, FIRST_LINE_MAX_BYTES))).toString('utf8');
  }
  const newline = text.indexOf('\n');
  return newline < 0 ? null : text.slice(0, newline);
}

/**
 * When a transcript's first record says it was written: a top-level
 * `timestamp` (Codex, Claude Code), `time` or `createdAt` (DeepSeek Harness),
 * as an ISO string or epoch seconds/milliseconds. Null when the first record
 * carries none or cannot be read.
 */
async function firstRecordTimeMs(filePath: string, isZstd: boolean, size: number): Promise<number | null> {
  try {
    const line = await readFirstLine(filePath, isZstd, size);
    if (line === null) return null;
    const record = JSON.parse(line) as Record<string, unknown> | null;
    for (const key of ['timestamp', 'time', 'createdAt']) {
      const value = record?.[key];
      const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value)
        : typeof value === 'string' ? Date.parse(value)
          : Number.NaN;
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    return null;
  } catch {
    return null;
  }
}

/** A file's device/inode pair: which file a path held when its checkpoint was saved. */
function fileIdentityOf(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`;
}

/** True only when a path is gone (ENOENT, ENOTDIR); any other stat failure is not proof of that. */
function isMissingPath(filePath: string): boolean {
  try {
    statSync(filePath);
    return false;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/** A checkpoint's fingerprint covers at most this many bytes just before its offset. */
const CHECKPOINT_FINGERPRINT_BYTES = 4096;

/**
 * sha256 of the up-to-4 KiB of a transcript just before `offset`, read from
 * the file whose identity is `identity`. Null when the path now holds another
 * file, ends before `offset`, or cannot be read.
 */
function fingerprintBeforeOffset(filePath: string, offset: number, identity: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    if (fileIdentityOf(fstatSync(fd)) !== identity) return null;
    const start = Math.max(0, offset - CHECKPOINT_FINGERPRINT_BYTES);
    const window = Buffer.alloc(offset - start);
    if (readSync(fd, window, 0, window.length, start) < window.length) return null;
    return createHash('sha256').update(window).digest('hex');
  } catch (error: unknown) {
    logger.debug('TRANSCRIPT', 'Could not fingerprint a transcript checkpoint', { file: filePath }, error instanceof Error ? error : undefined);
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether a file still holds the bytes up to a checkpoint: it does not end
 * before the checkpoint, and the bytes just before it match the checkpoint's
 * fingerprint. A new identity alone is not a replacement: device numbers can
 * change across a reboot or remount, and sync tools rewrite a file through
 * temp-plus-rename with its bytes intact, so resetting on it would replay
 * every transcript through the observer. A checkpoint saved without a
 * fingerprint keeps its offset, as it did before identities were tracked.
 */
function keepsCheckpointBytes(filePath: string, identity: string, size: number, offset: number, fingerprint: string | undefined): boolean {
  if (size < offset) return false;
  if (fingerprint === undefined) return true;
  return fingerprintBeforeOffset(filePath, offset, identity) === fingerprint;
}

async function readByteRange(filePath: string, start: number, length: number): Promise<Buffer> {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

class FileTailer {
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private tailState: TailState;
  private readTask: Promise<void> | null = null;
  private readPending = false;
  private closed = false;
  private readonly isZstd: boolean;
  /** JSONL only: the bytes of the unterminated record between `offset` and `readOffset`. */
  private pendingRecord: Buffer = Buffer.alloc(0);
  /**
   * zstd only: how many lines of the frame at `offset` were dispatched before
   * a turn in it failed, so the retry resumes at the failed line. Persisted
   * with the checkpoint.
   */
  private frameLinesDone: number;
  /** The device/inode of the file the checkpoint was taken from. Persisted. */
  private fileIdentity?: string;
  /** sha256 of the up-to-4 KiB before the checkpoint (fingerprintBeforeOffset). Persisted. */
  private checkpointFingerprint?: string;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (
      offset: number,
      partial: string,
      frameLinesDone: number,
      fileIdentity?: string,
      checkpointFingerprint?: string
    ) => void,
    // zstd only: the unterminated JSONL prefix and the lines of the frame at
    // the offset already dispatched, persisted with the frame-aligned offset.
    initialPartial = '',
    initialFrameLinesDone = 0,
    initialFileIdentity?: string,
    initialCheckpointFingerprint?: string,
    // Called when the file is read again from byte 0 (replaced or truncated).
    private onReset?: () => void
  ) {
    this.fileIdentity = initialFileIdentity;
    this.checkpointFingerprint = initialCheckpointFingerprint;
    this.isZstd = filePath.endsWith(ZSTD_TRANSCRIPT_SUFFIX);
    this.tailState = { offset: initialOffset, readOffset: initialOffset, partial: this.isZstd ? initialPartial : '' };
    this.frameLinesDone = this.isZstd ? initialFrameLinesDone : 0;
  }

  start(): void {
    this.requestRead();
    try {
      this.watcher = fsWatch(this.filePath, { persistent: true }, () => {
        this.requestRead();
      });
    } catch (error: unknown) {
      // The file can disappear between the glob scan and this watch call. A file
      // that is already gone needs no tailer, so log and leave the watcher null.
      logger.debug('WORKER', 'Failed to watch transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      this.watcher = null;
    }
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
  }

  poke(): void {
    this.requestRead();
  }

  private requestRead(): void {
    if (this.closed) return;
    if (this.readTask) {
      this.readPending = true;
      return;
    }

    this.readTask = this.drainReads().finally(() => {
      this.readTask = null;
    });
  }

  private async drainReads(): Promise<void> {
    do {
      this.readPending = false;
      await this.readNewData().catch(() => undefined);
      // A bounded pass that left work behind asks for another; hand the
      // event loop back first so the worker's HTTP API keeps being served.
      if (this.readPending) await yieldToEventLoop();
    } while (this.readPending && !this.closed);
  }

  private async readNewData(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    let size = 0;
    let identity: string;
    try {
      const stat = statSync(this.filePath);
      size = stat.size;
      identity = fileIdentityOf(stat);
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to stat transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      return;
    }

    // An atomic replacement (a new device/inode with other bytes) is a new
    // file, read from byte 0: an equal-size or larger one passes the shrink
    // check below. The same bytes under a new identity keep the checkpoint.
    const identityChanged = identity !== this.fileIdentity;
    let replaced = false;
    if (identityChanged && this.fileIdentity !== undefined) {
      if (keepsCheckpointBytes(this.filePath, identity, size, this.tailState.offset, this.checkpointFingerprint)) {
        // An unterminated record past the checkpoint is read again, from the new file.
        this.tailState.readOffset = this.tailState.offset;
        this.pendingRecord = Buffer.alloc(0);
      } else {
        replaced = true;
      }
    }
    this.fileIdentity = identity;

    const reset = replaced || size < this.tailState.readOffset;
    if (reset) {
      this.onReset?.();
      this.tailState.offset = 0;
      this.tailState.readOffset = 0;
      this.tailState.partial = '';
      this.pendingRecord = Buffer.alloc(0);
      this.frameLinesDone = 0;
    }

    if (size === this.tailState.readOffset) {
      // Record a new identity (or a reset) even at an unchanged end of file.
      if (identityChanged || reset) this.checkpoint(this.tailState.offset, this.tailState.partial);
      return;
    }

    if (this.isZstd) {
      await this.readNewZstdFrames(size);
    } else {
      await this.readNewJsonl(size);
    }
  }

  /** Durable checkpoint: record and persist where the next pass (or a restart) resumes. */
  private checkpoint(offset: number, partial = ''): void {
    this.tailState.offset = offset;
    this.tailState.partial = partial;
    this.checkpointFingerprint = this.fileIdentity === undefined
      ? undefined
      : fingerprintBeforeOffset(this.filePath, offset, this.fileIdentity) ?? undefined;
    this.onOffset(offset, partial, this.frameLinesDone, this.fileIdentity, this.checkpointFingerprint);
  }

  /**
   * JSONL mode. Reads at most MAX_BYTES_PER_PASS past the read offset and
   * dispatches each complete line in order. The checkpoint follows the lines
   * that went through, byte-exact, so a restart resumes at the first record
   * not yet dispatched, never inside the unterminated one still being written.
   *
   * A turn that fails (the worker did not record its prompt) ends the pass
   * with the checkpoint AT that line: the retry resends it and everything
   * after it, and nothing before it.
   */
  private async readNewJsonl(size: number): Promise<void> {
    const readFrom = this.tailState.readOffset;
    let chunk: Buffer;
    try {
      chunk = await readByteRange(this.filePath, readFrom, Math.min(size - readFrom, MAX_BYTES_PER_PASS));
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to read transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      return;
    }
    if (chunk.length === 0) return;
    this.tailState.readOffset = readFrom + chunk.length;

    // buffer[0] is the byte at the checkpoint.
    const buffer = this.pendingRecord.length > 0 ? Buffer.concat([this.pendingRecord, chunk]) : chunk;
    const base = this.tailState.offset;
    let lineStart = 0;
    let dispatched = 0;
    for (let newline = buffer.indexOf(0x0a); newline !== -1; newline = buffer.indexOf(0x0a, lineStart)) {
      if (this.closed) {
        this.checkpoint(base + lineStart);
        return;
      }
      const line = buffer.toString('utf8', lineStart, newline).trim();
      if (line) {
        try {
          await this.onLine(line);
        } catch {
          this.pendingRecord = Buffer.alloc(0);
          this.tailState.readOffset = base + lineStart;
          this.checkpoint(base + lineStart);
          return;
        }
      }
      lineStart = newline + 1;
      this.tailState.offset = base + lineStart;
      if (line && ++dispatched % YIELD_EVERY_N_LINES === 0) {
        this.checkpoint(this.tailState.offset);
        await yieldToEventLoop();
      }
    }

    this.pendingRecord = Buffer.from(buffer.subarray(lineStart));
    this.checkpoint(base + lineStart);
    if (this.tailState.readOffset < size) this.readPending = true;
  }

  /**
   * zstd mode. The offset always sits on a frame boundary. Each pass finds
   * the complete frames after it from their headers alone, at most
   * MAX_BYTES_PER_PASS of them, reads just those bytes, and decodes them in
   * order. A torn trailing frame (an interrupted write) is left for the next
   * change event. A frame that fails to decode stops the pass without
   * advancing past it, so it is retried rather than skipped.
   *
   * The checkpoint moves past a frame once its lines are dispatched. A turn
   * that fails keeps the checkpoint at its frame, with the partial record that
   * frame began with, and the retry resumes at the failed line: frames before
   * it are never sent twice.
   */
  private async readNewZstdFrames(size: number): Promise<void> {
    const start = this.tailState.offset;
    let scan: ZstdScanResult;
    let bytes: Buffer;
    try {
      scan = scanZstdFramesInFile(this.filePath, start, size, MAX_BYTES_PER_PASS);
      if (scan.frames.length === 0) return;
      const end = scan.frames[scan.frames.length - 1].end;
      bytes = await readByteRange(this.filePath, start, end - start);
      if (bytes.length < end - start) return;
    } catch (error: unknown) {
      logger.warn('TRANSCRIPT', 'Failed to read zstd transcript frames', {
        file: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let dispatched = 0;
    for (const frame of scan.frames) {
      let plain: string;
      try {
        plain = decompressZstdFrame(bytes, { start: frame.start - start, end: frame.end - start });
      } catch {
        // decompressZstdFrame logged it; retried on the next change event.
        this.checkpoint(this.tailState.offset, this.tailState.partial);
        return;
      }

      const partialBefore = this.tailState.partial;
      const lines = (partialBefore + plain).split('\n');
      const partialAfter = lines.pop() ?? '';
      for (let index = this.frameLinesDone; index < lines.length; index++) {
        if (this.closed) {
          this.frameLinesDone = index;
          this.checkpoint(frame.start, partialBefore);
          return;
        }
        const line = lines[index].trim();
        if (!line) continue;
        try {
          await this.onLine(line);
        } catch {
          this.frameLinesDone = index;
          this.tailState.readOffset = frame.start;
          this.checkpoint(frame.start, partialBefore);
          return;
        }
        if (++dispatched % YIELD_EVERY_N_LINES === 0) await yieldToEventLoop();
      }

      this.frameLinesDone = 0;
      this.tailState.offset = frame.end;
      this.tailState.readOffset = frame.end;
      this.tailState.partial = partialAfter;
    }

    // A frame can end mid-record, and the offset is resumable only at frame
    // boundaries, so the unterminated prefix is persisted with it.
    this.checkpoint(this.tailState.offset, this.tailState.partial);
    if (scan.tornStart === null && this.tailState.offset < size) this.readPending = true;
  }
}

export class TranscriptWatcher {
  private processor = new TranscriptEventProcessor();
  private tailers = new Map<string, FileTailer>();
  private state: TranscriptWatchState;
  /** Each transcript's context (its session's directory, its outstanding tool calls), shared with the processor. */
  private fileContexts = new Map<string, TranscriptFileContext>();
  /** Transcripts with saved tool calls that may be gone, checked together once the grace has passed. */
  private retirementCandidates = new Set<string>();
  private retirementTimer: ReturnType<typeof setTimeout> | null = null;
  private missingTranscriptGraceMs = MISSING_TRANSCRIPT_GRACE_MS;
  private rootWatchers: Array<ReturnType<typeof fsWatch>> = [];
  /** One-shot re-checks of a root watch on a missing root's ancestor, or one that just moved (WATCH_ROOT_SETTLE_MS). */
  private rootWatchSettleTimers = new Set<ReturnType<typeof setTimeout>>();
  private startedAtMs = 0;
  private warnedZstdUnsupported = false;
  private startingTailers = new Set<string>();
  /** Set by stop(): a tailer still awaiting its start offset then never starts. */
  private stopped = false;

  constructor(private config: TranscriptWatchConfig, private statePath: string) {
    this.state = loadWatchState(statePath);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.startedAtMs = Date.now();
    for (const watch of this.config.watches) {
      await this.setupWatch(watch);
    }
    if (this.stopped) return;
    // The saved tool calls of a transcript that is gone are retired: their inputs can hold secrets.
    for (const file of Object.keys(this.state.pendingTools ?? {})) {
      if (!this.tailers.has(file)) this.scheduleRetirementCheck(file);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const tailer of this.tailers.values()) {
      tailer.close();
    }
    this.tailers.clear();
    for (const watcher of this.rootWatchers) {
      watcher.close();
    }
    this.rootWatchers = [];
    for (const timer of this.rootWatchSettleTimers) clearTimeout(timer);
    this.rootWatchSettleTimers.clear();
    if (this.retirementTimer) clearTimeout(this.retirementTimer);
    this.retirementTimer = null;
    this.retirementCandidates.clear();
  }

  private async setupWatch(watch: WatchTarget): Promise<void> {
    const schema = this.resolveSchema(watch);
    if (!schema) {
      logger.warn('TRANSCRIPT', 'Missing schema for watch', { watch: watch.name });
      return;
    }

    const resolvedPath = expandHomePath(watch.path);
    const files = this.resolveWatchFiles(resolvedPath);

    // Every file of the scan is registered before any tailer dispatches, so a
    // result can find its tool call in a file enumerated after its own.
    for (const filePath of files) this.getFileContext(filePath);
    const initialScan = { stateChanged: false };
    for (const filePath of files) {
      await this.addTailer(filePath, watch, schema, false, initialScan);
      await yieldToEventLoop();
    }
    // The startAtEnd offsets and file identities the initial scan recorded, in one write.
    if (initialScan.stateChanged) saveWatchState(this.statePath, this.state);

    this.watchTranscriptRoot(resolvedPath, watch, schema);
  }

  /**
   * Puts the watch's fs.watch on its root. Once the literal prefix exists, that
   * is the prefix (a literal file: its directory), watched recursively. While
   * it is missing, the closest existing ancestor is watched non-recursively and
   * the watch moves down as the host creates each directory: a recursive watch
   * on a broad ancestor (the home directory, for a tool that is not installed)
   * registers one inotify watch per subdirectory on Linux, on every start.
   */
  private watchTranscriptRoot(resolvedPath: string, watch: WatchTarget, schema: TranscriptSchema, moved = false): void {
    const target = this.selectWatchRoot(resolvedPath);
    if (!target) {
      logger.debug('TRANSCRIPT', 'Watch root does not exist, skipping fs.watch', { watch: watch.name, path: resolvedPath });
      return;
    }

    const { root, recursive } = target;
    try {
      const watcher: ReturnType<typeof fsWatch> = fsWatch(root, { recursive, persistent: true }, (_event, name) => {
        if (recursive) {
          this.handleRootWatchEvent(root, resolvedPath, watch, schema, name);
        } else {
          this.handleAncestorWatchEvent(watcher, root, resolvedPath, watch, schema, name);
        }
      });
      this.rootWatchers.push(watcher);
      if (moved || !recursive) this.settleRootWatch(watcher, root, recursive, resolvedPath, watch, schema);
      logger.info('TRANSCRIPT', recursive
        ? 'Watching transcript root recursively'
        : 'Transcript root does not exist yet; watching its closest existing directory', { watch: watch.name, watchRoot: root });
    } catch (error) {
      logger.warn('TRANSCRIPT', 'Failed to start fs.watch on transcript root', {
        watch: watch.name,
        watchRoot: root,
      }, error instanceof Error ? error : undefined);
    }
  }

  private handleRootWatchEvent(
    watchRoot: string,
    resolvedPath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    name: string | null
  ): void {
    if (!name) return;
    const changed = resolvePath(watchRoot, name).replace(/\\/g, '/');
    const existingTailer = this.tailers.get(changed);
    if (existingTailer) {
      // A transcript that is gone is no longer tailed. Its saved tool calls are
      // retired unless it comes back within the grace (a rename away and back).
      if (!existsSync(changed)) {
        existingTailer.close();
        this.tailers.delete(changed);
        this.scheduleRetirementCheck(changed);
        return;
      }
      existingTailer.poke();
      return;
    }
    // Sibling writes (a literal file's directory) cannot add matches.
    if (!this.touchesLiteralPrefix(changed, resolvedPath)) return;
    this.addDiscoveredTailers(resolvedPath, watch, schema);
  }

  /**
   * An event on the closest existing ancestor of a missing transcript root.
   * Only a change on the path to the literal prefix can move the watch. When
   * the closest existing directory changes, this watch is replaced by the next
   * one, and files the host already created below it are picked up at once.
   */
  private handleAncestorWatchEvent(
    ancestorWatcher: ReturnType<typeof fsWatch>,
    ancestor: string,
    resolvedPath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    name: string | null
  ): void {
    // A watch already replaced (its late events, its settle check) does nothing.
    if (this.stopped || !this.rootWatchers.includes(ancestorWatcher)) return;
    if (name && !this.touchesLiteralPrefix(resolvePath(ancestor, name), resolvedPath)) return;
    const next = this.selectWatchRoot(resolvedPath);
    if (next && next.root === ancestor && !next.recursive) return;

    ancestorWatcher.close();
    this.rootWatchers = this.rootWatchers.filter(watcher => watcher !== ancestorWatcher);
    this.watchTranscriptRoot(resolvedPath, watch, schema, true);
    this.addDiscoveredTailers(resolvedPath, watch, schema);
  }

  /**
   * Checks a root watch that just started on a missing root's ancestor, or just
   * moved, once more after WATCH_ROOT_SETTLE_MS: a directory created while it
   * registered moves it again, and a file created then is picked up.
   */
  private settleRootWatch(
    watcher: ReturnType<typeof fsWatch>,
    root: string,
    recursive: boolean,
    resolvedPath: string,
    watch: WatchTarget,
    schema: TranscriptSchema
  ): void {
    const timer = setTimeout(() => {
      this.rootWatchSettleTimers.delete(timer);
      if (this.stopped || !this.rootWatchers.includes(watcher)) return;
      if (recursive) {
        this.addDiscoveredTailers(resolvedPath, watch, schema);
      } else {
        this.handleAncestorWatchEvent(watcher, root, resolvedPath, watch, schema, null);
      }
    }, WATCH_ROOT_SETTLE_MS);
    this.rootWatchSettleTimers.add(timer);
  }

  /**
   * A transcript's context: its session's directory and its outstanding tool
   * calls, restored from the watch state. It is registered with the processor
   * so that a result in another file of the session can find its tool call.
   */
  private getFileContext(file: string): TranscriptFileContext {
    let context = this.fileContexts.get(file);
    if (!context) {
      context = {
        cwd: this.state.cwds?.[file],
        pendingTools: this.state.pendingTools?.[file],
        // A path that holds another file than the checkpointed one (replaced
        // or truncated, and not read again yet) lends no tool calls.
        isCurrent: () => this.isCheckpointedFile(file),
      };
      this.fileContexts.set(file, context);
    }
    this.processor.registerFileContext(context);
    return context;
  }

  private isCheckpointedFile(file: string): boolean {
    try {
      const stat = statSync(file);
      return fileIdentityOf(stat) === this.state.fileIdentities?.[file] && stat.size >= (this.state.offsets[file] ?? 0);
    } catch {
      return false;
    }
  }

  private scheduleRetirementCheck(file: string): void {
    this.retirementCandidates.add(file);
    this.retirementTimer ??= setTimeout(() => this.retireMissingTranscripts(), this.missingTranscriptGraceMs);
  }

  /**
   * A candidate still missing after the grace is gone: the tool calls saved
   * for it are dropped, all in one state write. Nothing else is: a file that
   * exists but has no tailer (a watch removed or skipped, a zstd file this
   * runtime cannot read, the other watcher's file) keeps its tool calls, and
   * every file keeps its checkpoint.
   */
  private retireMissingTranscripts(): void {
    this.retirementTimer = null;
    const candidates = [...this.retirementCandidates];
    this.retirementCandidates.clear();
    if (this.stopped) return;
    let retired = false;
    for (const file of candidates) {
      if (this.tailers.has(file) || !isMissingPath(file)) continue;
      const context = this.fileContexts.get(file);
      if (context) this.processor.retireFileContext(context);
      this.fileContexts.delete(file);
      if (this.state.pendingTools?.[file]) {
        delete this.state.pendingTools[file];
        retired = true;
      }
    }
    if (retired) saveWatchState(this.statePath, this.state);
  }

  /** A replaced transcript's tool calls and directory belonged to the old file. */
  private forgetReplacedTranscript(filePath: string, fileContext: TranscriptFileContext): void {
    this.processor.resetFileContext(fileContext);
    delete this.state.pendingTools?.[filePath];
    delete this.state.cwds?.[filePath];
  }

  private addDiscoveredTailers(resolvedPath: string, watch: WatchTarget, schema: TranscriptSchema): void {
    for (const filePath of this.resolveWatchFiles(resolvedPath)) {
      if (!this.tailers.has(filePath)) {
        void this.addTailer(filePath, watch, schema, true).catch(error => {
          logger.debug('TRANSCRIPT', 'Failed to add transcript tailer', { file: filePath, watch: watch.name }, error instanceof Error ? error : undefined);
        });
      }
    }
  }

  /** Whether a changed path is the watch's literal prefix, inside it, or one of its ancestors. */
  private touchesLiteralPrefix(changedPath: string, resolvedPath: string): boolean {
    const changed = changedPath.replace(/\\/g, '/');
    const prefix = resolvePath(this.literalWatchPrefix(resolvedPath)).replace(/\\/g, '/');
    const isInside = (path: string, directory: string) => path.startsWith(directory.endsWith('/') ? directory : directory + '/');
    return changed === prefix || isInside(changed, prefix) || isInside(prefix, changed);
  }

  private literalWatchPrefix(inputPath: string): string {
    let candidate = inputPath;
    if (this.hasGlob(inputPath)) {
      const segments = inputPath.split(/[/\\]/);
      const literalSegments: string[] = [];
      for (const segment of segments) {
        if (/[*?[\]{}()]/.test(segment)) break;
        literalSegments.push(segment);
      }
      // Do not turn a pattern with no literal root into a filesystem-wide watch.
      if (literalSegments.length === 0 || (literalSegments.length === 1 && literalSegments[0] === '')) return '';
      candidate = literalSegments.join(pathSep);
    }
    return candidate;
  }

  /**
   * Where a watch's fs.watch goes. Once the literal prefix exists: the prefix
   * (a literal file: its directory), recursively. While it is missing (a host
   * creates its directories only after the watcher starts): the closest
   * existing ancestor, non-recursively, and never the filesystem root unless
   * that root is the prefix. resolveWatchFiles stays the selector, so files
   * outside the pattern are never ingested. Null for a pattern with no literal
   * root.
   */
  private selectWatchRoot(inputPath: string): { root: string; recursive: boolean } | null {
    const literalPrefix = this.literalWatchPrefix(inputPath);
    if (!literalPrefix) return null;
    const prefix = resolvePath(literalPrefix);
    try {
      return { root: statSync(prefix).isDirectory() ? prefix : resolvePath(prefix, '..'), recursive: true };
    } catch {
      // Missing or inaccessible: watch the closest existing ancestor below.
    }
    for (let candidate = resolvePath(prefix, '..'); resolvePath(candidate, '..') !== candidate; candidate = resolvePath(candidate, '..')) {
      try {
        if (statSync(candidate).isDirectory()) return { root: candidate, recursive: false };
      } catch {
        // Missing or inaccessible candidates are retried from their parent.
      }
    }
    return null;
  }

  private resolveSchema(watch: WatchTarget): TranscriptSchema | null {
    if (typeof watch.schema === 'string') {
      return this.config.schemas?.[watch.schema] ?? null;
    }
    return watch.schema;
  }

  private resolveWatchFiles(inputPath: string): string[] {
    if (this.hasGlob(inputPath)) {
      return this.scanGlob(this.normalizeGlobPattern(inputPath));
    }

    if (existsSync(inputPath)) {
      try {
        const stat = statSync(inputPath);
        if (stat.isDirectory()) {
          return [
            ...this.scanGlob(this.normalizeGlobPattern(join(inputPath, '**', '*.jsonl'))),
            ...this.scanGlob(this.normalizeGlobPattern(join(inputPath, '**', `*${ZSTD_TRANSCRIPT_SUFFIX}`))),
          ];
        }
        return [inputPath];
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat watch path', { path: inputPath }, error instanceof Error ? error : undefined);
        return [];
      }
    }

    return [];
  }

  private scanGlob(pattern: string): string[] {
    try {
      return Array.from(new Bun.Glob(pattern).scanSync({ absolute: true, onlyFiles: true, dot: true }));
    } catch (error) {
      // An absent literal prefix is a valid initial state: the parent watch
      // will discover its files when the host creates the directories.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw error;
    }
  }

  private normalizeGlobPattern(inputPath: string): string {
    return inputPath.replace(/\\/g, '/');
  }

  private hasGlob(inputPath: string): boolean {
    return /[*?[\]{}()]/.test(inputPath);
  }

  private async addTailer(
    filePath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    discoveredAfterStartup: boolean = false,
    // The initial scan (setupWatch) saves the state its tailers recorded once, here flagged.
    initialScan?: { stateChanged: boolean }
  ): Promise<void> {
    // Expand a leading tilde here, the single point every path feeds through.
    // Some path sources skip expandHomePath, so a literal '~' can reach fs.watch
    // and can never resolve to a real file.
    filePath = expandHomePath(filePath);
    // The zstd startAtEnd scan awaits, so a burst of root-watch events for one
    // new file must not start a second tailer meanwhile.
    if (this.tailers.has(filePath) || this.startingTailers.has(filePath)) return;
    this.startingTailers.add(filePath);
    try {
      await this.startTailer(filePath, watch, schema, discoveredAfterStartup, initialScan);
    } finally {
      this.startingTailers.delete(filePath);
    }
  }

  private async startTailer(
    filePath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    discoveredAfterStartup: boolean,
    initialScan?: { stateChanged: boolean }
  ): Promise<void> {
    const isZstd = filePath.endsWith(ZSTD_TRANSCRIPT_SUFFIX);
    if (isZstd && !isZstdSupported()) {
      if (!this.warnedZstdUnsupported) {
        this.warnedZstdUnsupported = true;
        logger.warn('TRANSCRIPT', 'Skipping zstd transcripts: this runtime has no zlib.zstdDecompressSync (update Bun or Node)', {
          file: filePath,
        });
      }
      return;
    }

    const sessionIdOverride = this.extractSessionIdFromPath(filePath);
    // The session's working directory and outstanding tool calls, restored
    // for a watcher that resumes past the lines that reported them.
    const fileContext = this.getFileContext(filePath);

    const savedOffset = this.state.offsets[filePath];
    let offset = savedOffset ?? 0;
    let stateChanged = false;
    // `startAtEnd` means "do not replay history that predates this worker".
    // A transcript created after startup is read from byte 0: by the time the
    // recursive root watch reports it, session_meta and the opening turns are
    // already on disk, and jumping to EOF drops the user prompt the schema
    // exists to capture (#4211). A historical file moved in after startup is
    // still history: a rename keeps its old mtime (it does bump ctime, so ctime
    // cannot tell the two apart), so it starts at EOF like the initial scan. So
    // does a large one with a fresh mtime: copying or restoring an old
    // transcript writes it anew, and a session that just started is small.
    //
    // The chosen start is saved at once, so a file that never changes is not
    // stat'ed or frame-scanned again on every boot. A saved offset is a
    // checkpoint, 0 included, and is never replaced by the startAtEnd rule.
    if (savedOffset === undefined && watch.startAtEnd) {
      try {
        const stat = statSync(filePath);
        const writtenSinceStartup =
          discoveredAfterStartup && stat.mtimeMs >= this.startedAtMs - WRITTEN_SINCE_STARTUP_SLACK_MS;
        const replayFromStart = writtenSinceStartup && await this.startedAfterThisWatcher(filePath, isZstd, stat.size);
        if (!replayFromStart) offset = isZstd ? await zstdResumeOffset(filePath, stat.size) : stat.size;
        if (this.stopped) return;
        this.state.offsets[filePath] = offset;
        stateChanged = true;
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat file for startAtEnd offset', { file: filePath }, error instanceof Error ? error : undefined);
        offset = 0;
      }
    }

    // The checkpoint belongs to the bytes it was taken from. A file replaced
    // or rewritten while nothing was reading it (the watcher was down, or the
    // file had vanished) is read from byte 0 when the bytes before the
    // checkpoint changed. That is checked whatever the device/inode says: a
    // file created again at the same path can get the freed inode back (ext4
    // reuses them), and a renumbered device keeps the bytes and the
    // checkpoint. The current identity is recorded either way.
    try {
      const stat = statSync(filePath);
      const identity = fileIdentityOf(stat);
      const savedIdentity = this.state.fileIdentities?.[filePath];
      const replaced = savedOffset !== undefined && savedIdentity !== undefined &&
        !keepsCheckpointBytes(filePath, identity, stat.size, savedOffset, this.state.checkpointFingerprints?.[filePath]);
      if (replaced) {
        offset = 0;
        this.state.offsets[filePath] = 0;
        delete this.state.partials?.[filePath];
        delete this.state.frameLines?.[filePath];
        this.forgetReplacedTranscript(filePath, fileContext);
      }
      if (replaced || identity !== savedIdentity) {
        (this.state.fileIdentities ??= {})[filePath] = identity;
        const fingerprint = fingerprintBeforeOffset(filePath, offset, identity);
        if (fingerprint !== null) {
          (this.state.checkpointFingerprints ??= {})[filePath] = fingerprint;
        } else {
          delete this.state.checkpointFingerprints?.[filePath];
        }
        stateChanged = true;
      }
    } catch (error: unknown) {
      // Gone since the scan: the tailer finds nothing to read.
      logger.debug('WORKER', 'Failed to stat transcript file for its identity', { file: filePath }, error instanceof Error ? error : undefined);
    }
    if (stateChanged) {
      // The initial scan saves once for all its files (setupWatch).
      if (discoveredAfterStartup) saveWatchState(this.statePath, this.state);
      else if (initialScan) initialScan.stateChanged = true;
    }

    // A subagent-only watch learns the rollout's marker from its first line,
    // and a session whose directory is not known yet learns it there too
    // (DeepSeek Harness writes it on that line only; a turn without one is
    // skipped). A tail that resumes past that line reads it once, before the
    // first new one, for its context only.
    let primeFirstLine = offset > 0 && (Boolean(watch.subagentSource) || !fileContext.cwd);
    const tailer = new FileTailer(
      filePath,
      offset,
      async (line: string) => {
        try {
          if (primeFirstLine) {
            primeFirstLine = false;
            await this.primeFromFirstLine(filePath, offset, watch, schema, sessionIdOverride, fileContext);
          }
          await this.handleLine(line, watch, schema, filePath, sessionIdOverride, fileContext);
        } finally {
          // Saved with the next checkpoint.
          if (fileContext.pendingTools) {
            (this.state.pendingTools ??= {})[filePath] = fileContext.pendingTools;
          }
          if (fileContext.cwd && fileContext.cwd !== this.state.cwds?.[filePath]) {
            (this.state.cwds ??= {})[filePath] = fileContext.cwd;
          }
        }
      },
      (newOffset: number, partial: string, frameLinesDone: number, fileIdentity?: string, checkpointFingerprint?: string) => {
        if (fileIdentity !== undefined) (this.state.fileIdentities ??= {})[filePath] = fileIdentity;
        if (checkpointFingerprint !== undefined) {
          (this.state.checkpointFingerprints ??= {})[filePath] = checkpointFingerprint;
        } else if (this.state.checkpointFingerprints) {
          delete this.state.checkpointFingerprints[filePath];
        }
        this.state.offsets[filePath] = newOffset;
        if (partial) {
          (this.state.partials ??= {})[filePath] = partial;
        } else if (this.state.partials) {
          delete this.state.partials[filePath];
        }
        if (frameLinesDone > 0) {
          (this.state.frameLines ??= {})[filePath] = frameLinesDone;
        } else if (this.state.frameLines) {
          delete this.state.frameLines[filePath];
        }
        saveWatchState(this.statePath, this.state);
      },
      this.state.partials?.[filePath] ?? '',
      this.state.frameLines?.[filePath] ?? 0,
      this.state.fileIdentities?.[filePath],
      this.state.checkpointFingerprints?.[filePath],
      () => this.forgetReplacedTranscript(filePath, fileContext)
    );

    tailer.start();
    this.tailers.set(filePath, tailer);
    logger.info('TRANSCRIPT', 'Watching transcript file', {
      file: filePath,
      watch: watch.name,
      schema: schema.name
    });
  }

  /**
   * Whether a transcript that appeared after startup with a fresh mtime holds
   * a session that began after this watcher started. A copied or restored old
   * transcript gets a fresh mtime too; its first record's own timestamp tells
   * the two apart. A transcript whose first record has none counts as new only
   * while it is small, as a session that just started is.
   */
  private async startedAfterThisWatcher(filePath: string, isZstd: boolean, size: number): Promise<boolean> {
    const firstRecordAt = await firstRecordTimeMs(filePath, isZstd, size);
    if (firstRecordAt !== null) return firstRecordAt >= this.startedAtMs - WRITTEN_SINCE_STARTUP_SLACK_MS;
    return size <= NEW_TRANSCRIPT_REPLAY_MAX_BYTES;
  }

  private async primeFromFirstLine(
    filePath: string,
    resumedAt: number,
    watch: WatchTarget,
    schema: TranscriptSchema,
    sessionIdOverride: string | null,
    fileContext: TranscriptFileContext
  ): Promise<void> {
    try {
      const firstLine = await readFirstLine(filePath, filePath.endsWith(ZSTD_TRANSCRIPT_SUFFIX), resumedAt);
      if (firstLine === null) return;
      await this.processor.primeSessionContext(JSON.parse(firstLine), watch, schema, sessionIdOverride, fileContext);
    } catch (error: unknown) {
      logger.debug('TRANSCRIPT', 'Could not read the first line of a resumed transcript', {
        watch: watch.name,
        file: basename(filePath),
      }, error instanceof Error ? error : undefined);
    }
  }

  private async handleLine(
    line: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    filePath: string,
    sessionIdOverride: string | null,
    fileContext: TranscriptFileContext
  ): Promise<void> {
    try {
      const entry = JSON.parse(line);
      await this.processor.processEntry(entry, watch, schema, sessionIdOverride ?? undefined, fileContext);
    } catch (error: unknown) {
      // A turn whose prompt the worker did not record, or an event it did not
      // accept, stops the pass with the checkpoint at its line (or frame), so
      // it is retried, not misfiled or lost.
      if (error instanceof TranscriptAnchorError || error instanceof TranscriptObservationError) {
        logger.warn('TRANSCRIPT', 'Transcript event not accepted; it is retried from its own line', {
          watch: watch.name,
          file: basename(filePath),
          error: error.message,
        });
        throw error;
      }
      if (error instanceof Error) {
        logger.debug('TRANSCRIPT', 'Failed to parse transcript line', {
          watch: watch.name,
          file: basename(filePath)
        }, error);
      } else {
        logger.warn('TRANSCRIPT', 'Failed to parse transcript line (non-Error thrown)', {
          watch: watch.name,
          file: basename(filePath),
          error: String(error)
        });
      }
    }
  }

  private extractSessionIdFromPath(filePath: string): string | null {
    const match = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
  }
}
