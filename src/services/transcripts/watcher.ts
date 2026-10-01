import { existsSync, statSync, watch as fsWatch } from 'fs';
import { open } from 'fs/promises';
import { basename, join, resolve as resolvePath, sep as pathSep } from 'path';
import { logger } from '../../utils/logger.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptAnchorError, TranscriptEventProcessor, type TranscriptFileContext } from './processor.js';
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

/** The first line of a JSONL transcript, read from at most `limit` bytes; null when it does not end there. */
async function readFirstLine(filePath: string, limit: number): Promise<string | null> {
  const head = (await readByteRange(filePath, 0, Math.min(limit, FIRST_LINE_MAX_BYTES))).toString('utf8');
  const newline = head.indexOf('\n');
  return newline < 0 ? null : head.slice(0, newline);
}

/**
 * When a transcript's first record says it was written: a top-level
 * `timestamp` (Codex, Claude Code), `time` or `createdAt` (DeepSeek Harness),
 * as an ISO string or epoch seconds/milliseconds. Null when the first record
 * carries none or cannot be read.
 */
async function firstRecordTimeMs(filePath: string, isZstd: boolean, size: number): Promise<number | null> {
  try {
    let line: string | null;
    if (isZstd) {
      const { frames } = scanZstdFramesInFile(filePath, 0, size, 1);
      if (frames.length === 0) return null;
      const text = decompressZstdFrame(await readByteRange(filePath, 0, frames[0].end), frames[0]);
      const newline = text.indexOf('\n');
      line = newline < 0 ? null : text.slice(0, newline);
    } else {
      line = await readFirstLine(filePath, size);
    }
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
  private readonly isZstd: boolean;
  /** JSONL only: the bytes of the unterminated record between `offset` and `readOffset`. */
  private pendingRecord: Buffer = Buffer.alloc(0);
  /**
   * zstd only: how many lines of the frame at `offset` were dispatched before
   * a turn in it failed, so the retry resumes at the failed line. Persisted
   * with the checkpoint.
   */
  private frameLinesDone: number;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (offset: number, partial: string, frameLinesDone: number) => void,
    // zstd only: the unterminated JSONL prefix and the lines of the frame at
    // the offset already dispatched, persisted with the frame-aligned offset.
    initialPartial = '',
    initialFrameLinesDone = 0
  ) {
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
    this.watcher?.close();
    this.watcher = null;
  }

  poke(): void {
    this.requestRead();
  }

  private requestRead(): void {
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
    } while (this.readPending);
  }

  private async readNewData(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to stat transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      return;
    }

    if (size < this.tailState.readOffset) {
      this.tailState.offset = 0;
      this.tailState.readOffset = 0;
      this.tailState.partial = '';
      this.pendingRecord = Buffer.alloc(0);
      this.frameLinesDone = 0;
    }

    if (size === this.tailState.readOffset) return;

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
    this.onOffset(offset, partial, this.frameLinesDone);
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
  private rootWatchers: Array<ReturnType<typeof fsWatch>> = [];
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
  }

  private async setupWatch(watch: WatchTarget): Promise<void> {
    const schema = this.resolveSchema(watch);
    if (!schema) {
      logger.warn('TRANSCRIPT', 'Missing schema for watch', { watch: watch.name });
      return;
    }

    const resolvedPath = expandHomePath(watch.path);
    const files = this.resolveWatchFiles(resolvedPath);

    for (const filePath of files) {
      await this.addTailer(filePath, watch, schema);
      await yieldToEventLoop();
    }
    // The startAtEnd offsets the initial scan chose, in one write.
    if (files.length > 0 && watch.startAtEnd) saveWatchState(this.statePath, this.state);

    const watchRoot = this.deepestNonGlobAncestor(resolvedPath);
    if (!watchRoot || !existsSync(watchRoot)) {
      logger.debug('TRANSCRIPT', 'Watch root does not exist, skipping fs.watch', { watch: watch.name, watchRoot });
      return;
    }

    try {
      const watcher = fsWatch(watchRoot, { recursive: true, persistent: true }, (event, name) => {
        this.handleRootWatchEvent(watchRoot, resolvedPath, watch, schema, name);
      });
      this.rootWatchers.push(watcher);
      logger.info('TRANSCRIPT', 'Watching transcript root recursively', { watch: watch.name, watchRoot });
    } catch (error) {
      logger.warn('TRANSCRIPT', 'Failed to start recursive fs.watch on transcript root', {
        watch: watch.name,
        watchRoot,
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
      existingTailer.poke();
      return;
    }
    const matches = this.resolveWatchFiles(resolvedPath);
    for (const filePath of matches) {
      if (!this.tailers.has(filePath)) {
        void this.addTailer(filePath, watch, schema, true).catch(error => {
          logger.debug('TRANSCRIPT', 'Failed to add transcript tailer', { file: filePath, watch: watch.name }, error instanceof Error ? error : undefined);
        });
      }
    }
  }

  private deepestNonGlobAncestor(inputPath: string): string {
    if (!this.hasGlob(inputPath)) {
      if (existsSync(inputPath)) {
        try {
          const stat = statSync(inputPath);
          return stat.isDirectory() ? inputPath : resolvePath(inputPath, '..');
        } catch (error: unknown) {
          logger.debug('TRANSCRIPT', 'Failed to stat watch path ancestor, falling back to parent directory', { path: inputPath }, error instanceof Error ? error : new Error(String(error)));
          return resolvePath(inputPath, '..');
        }
      }
      return inputPath;
    }

    const segments = inputPath.split(/[/\\]/);
    const literalSegments: string[] = [];
    for (const segment of segments) {
      if (/[*?[\]{}()]/.test(segment)) break;
      literalSegments.push(segment);
    }
    if (literalSegments.length === 0) return '';
    if (literalSegments.length === 1 && literalSegments[0] === '') {
      return '';
    }
    return literalSegments.join(pathSep);
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
    return Array.from(new Bun.Glob(pattern).scanSync({ absolute: true, onlyFiles: true, dot: true }));
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
    discoveredAfterStartup: boolean = false
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
      await this.startTailer(filePath, watch, schema, discoveredAfterStartup);
    } finally {
      this.startingTailers.delete(filePath);
    }
  }

  private async startTailer(
    filePath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    discoveredAfterStartup: boolean
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

    const savedOffset = this.state.offsets[filePath];
    let offset = savedOffset ?? 0;
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
        // The initial scan saves once for all its files (setupWatch).
        if (discoveredAfterStartup) saveWatchState(this.statePath, this.state);
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat file for startAtEnd offset', { file: filePath }, error instanceof Error ? error : undefined);
        offset = 0;
      }
    }

    // The session's working directory, restored for a watcher that resumes
    // past the line that reported it; saved with the next checkpoint.
    const fileContext: TranscriptFileContext = { cwd: this.state.cwds?.[filePath] };
    // A subagent-only watch learns the rollout's marker from its first line.
    // A tail that resumes past it reads that line once, before the first new
    // one, for its context only.
    let primeFirstLine = offset > 0 && Boolean(watch.subagentSource) && !isZstd;
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
          if (fileContext.cwd && fileContext.cwd !== this.state.cwds?.[filePath]) {
            (this.state.cwds ??= {})[filePath] = fileContext.cwd;
          }
        }
      },
      (newOffset: number, partial: string, frameLinesDone: number) => {
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
      this.state.frameLines?.[filePath] ?? 0
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
      const firstLine = await readFirstLine(filePath, resumedAt);
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
      // A turn whose prompt the worker did not record stops the pass with the
      // checkpoint at its line (or frame), so it is retried, not misfiled.
      if (error instanceof TranscriptAnchorError) {
        logger.warn('TRANSCRIPT', 'Transcript turn not anchored; it is retried from its own line', {
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
