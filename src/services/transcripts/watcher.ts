import { existsSync, statSync, watch as fsWatch, createReadStream, openSync, readSync, closeSync } from 'fs';
import { basename, join, resolve as resolvePath, sep as pathSep } from 'path';
import { logger } from '../../utils/logger.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptEventProcessor } from './processor.js';
import { decompressZstdFrame, isZstdSupported, scanZstdFrames, type ZstdScanResult } from './zstd-frames.js';

interface TailState {
  offset: number;
  readOffset: number;
  partial: string;
}

// Coarse filesystem clocks (HFS+ 1 s, FAT 2 s) can stamp a file written just
// after startup with an mtime just before it.
const WRITTEN_SINCE_STARTUP_SLACK_MS = 2000;

/**
 * Concatenated-frame Zstandard session logs (DeepSeek Harness writes
 * `session.jsonl.zstd`): every durable write appends one independently
 * decodable frame of JSONL.
 */
const ZSTD_TRANSCRIPT_SUFFIX = '.jsonl.zstd';

/**
 * Where startAtEnd resumes a zstd file: after its last complete frame, never
 * inside a torn one (a resume must land on a frame boundary).
 */
function zstdResumeOffset(filePath: string, size: number): number {
  try {
    return scanZstdFrames(readByteRange(filePath, 0, size)).tornStart ?? size;
  } catch {
    return size;
  }
}

function readByteRange(filePath: string, start: number, length: number): Buffer {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

class FileTailer {
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private tailState: TailState;
  private readTask: Promise<void> | null = null;
  private readPending = false;
  private readonly isZstd: boolean;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (offset: number, partial?: string) => void,
    // zstd only: the unterminated JSONL prefix persisted with the frame-aligned offset.
    initialPartial = ''
  ) {
    this.isZstd = filePath.endsWith(ZSTD_TRANSCRIPT_SUFFIX);
    this.tailState = { offset: initialOffset, readOffset: initialOffset, partial: this.isZstd ? initialPartial : '' };
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
    }

    if (size === this.tailState.readOffset) return;

    if (this.isZstd) {
      await this.readNewZstdFrames(size);
      return;
    }

    const stream = createReadStream(this.filePath, {
      start: this.tailState.readOffset,
      end: size - 1,
      encoding: 'utf8'
    });

    let data = '';
    for await (const chunk of stream) {
      data += chunk as string;
    }
    this.tailState.readOffset = size;

    const combined = this.tailState.partial + data;
    const lines = combined.split('\n');
    this.tailState.partial = lines.pop() ?? '';

    // Keep live reads at EOF while restart recovery resumes before any partial record.
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.onLine(trimmed);
    }

    const checkpointOffset = size - Buffer.byteLength(this.tailState.partial, 'utf8');
    this.tailState.offset = checkpointOffset;
    this.onOffset(checkpointOffset);
  }

  /**
   * zstd mode. The offset always sits on a frame boundary, so only the bytes
   * after it are read, and only complete frames are decoded. A torn trailing
   * frame (an interrupted write) is left for the next change event. A frame
   * that fails to decode stops the pass without advancing past it, so it is
   * retried rather than skipped. Each frame's lines are dispatched before the
   * offset moves past it (the same dispatch-then-checkpoint order as JSONL).
   */
  private async readNewZstdFrames(size: number): Promise<void> {
    const start = this.tailState.offset;
    let bytes: Buffer;
    let scan: ZstdScanResult;
    try {
      bytes = readByteRange(this.filePath, start, size - start);
      scan = scanZstdFrames(bytes);
    } catch (error: unknown) {
      logger.warn('TRANSCRIPT', 'Failed to read zstd transcript frames', {
        file: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let processedEnd = 0;
    for (const frame of scan.frames) {
      let plain: string;
      try {
        plain = decompressZstdFrame(bytes, frame);
      } catch {
        // decompressZstdFrame logged it; retried on the next change event.
        break;
      }
      const lines = (this.tailState.partial + plain).split('\n');
      this.tailState.partial = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        await this.onLine(trimmed);
      }
      processedEnd = frame.end;
    }
    if (processedEnd === 0) return;

    this.tailState.offset = start + processedEnd;
    this.tailState.readOffset = this.tailState.offset;
    // A frame can end mid-record, and the offset is resumable only at frame
    // boundaries, so the unterminated prefix is persisted with it.
    this.onOffset(this.tailState.offset, this.tailState.partial);
  }
}

export class TranscriptWatcher {
  private processor = new TranscriptEventProcessor();
  private tailers = new Map<string, FileTailer>();
  private state: TranscriptWatchState;
  private rootWatchers: Array<ReturnType<typeof fsWatch>> = [];
  private startedAtMs = 0;
  private warnedZstdUnsupported = false;

  constructor(private config: TranscriptWatchConfig, private statePath: string) {
    this.state = loadWatchState(statePath);
  }

  async start(): Promise<void> {
    this.startedAtMs = Date.now();
    for (const watch of this.config.watches) {
      await this.setupWatch(watch);
    }
  }

  stop(): void {
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
    }

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
    if (this.tailers.has(filePath)) return;

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

    let offset = this.state.offsets[filePath] ?? 0;
    // `startAtEnd` means "do not replay history that predates this worker".
    // A transcript created after startup is read from byte 0: by the time the
    // recursive root watch reports it, session_meta and the opening turns are
    // already on disk, and jumping to EOF drops the user prompt the schema
    // exists to capture (#4211). A historical file moved in after startup is
    // still history: a rename keeps its old mtime (it does bump ctime, so ctime
    // cannot tell the two apart), so it starts at EOF like the initial scan.
    if (offset === 0 && watch.startAtEnd) {
      try {
        const stat = statSync(filePath);
        const writtenSinceStartup =
          discoveredAfterStartup && stat.mtimeMs >= this.startedAtMs - WRITTEN_SINCE_STARTUP_SLACK_MS;
        if (!writtenSinceStartup) offset = isZstd ? zstdResumeOffset(filePath, stat.size) : stat.size;
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat file for startAtEnd offset', { file: filePath }, error instanceof Error ? error : undefined);
        offset = 0;
      }
    }

    const tailer = new FileTailer(
      filePath,
      offset,
      async (line: string) => {
        await this.handleLine(line, watch, schema, filePath, sessionIdOverride);
      },
      (newOffset: number, partial = '') => {
        this.state.offsets[filePath] = newOffset;
        if (partial) {
          (this.state.partials ??= {})[filePath] = partial;
        } else if (this.state.partials) {
          delete this.state.partials[filePath];
        }
        saveWatchState(this.statePath, this.state);
      },
      this.state.partials?.[filePath] ?? ''
    );

    tailer.start();
    this.tailers.set(filePath, tailer);
    logger.info('TRANSCRIPT', 'Watching transcript file', {
      file: filePath,
      watch: watch.name,
      schema: schema.name
    });
  }

  private async handleLine(
    line: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    filePath: string,
    sessionIdOverride?: string | null
  ): Promise<void> {
    try {
      const entry = JSON.parse(line);
      await this.processor.processEntry(entry, watch, schema, sessionIdOverride ?? undefined);
    } catch (error: unknown) {
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
