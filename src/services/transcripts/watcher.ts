import { existsSync, statSync, watch as fsWatch, createReadStream, readFileSync } from 'fs';
import { basename, join, resolve as resolvePath, sep as pathSep } from 'path';
import { logger } from '../../utils/logger.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptEventProcessor } from './processor.js';
import { decompressZstdFrame, scanZstdFrames, type ZstdScanResult } from './zstd-frames.js';

interface TailState {
  offset: number;
  partial: string;
}

class FileTailer {
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private tailState: TailState;
  private reading = false;
  private readQueued = false;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (offset: number) => void,
    private isZstd = false
  ) {
    this.tailState = { offset: initialOffset, partial: '' };
  }

  start(): void {
    this.readNewData().catch(() => undefined);
    this.watcher = fsWatch(this.filePath, { persistent: true }, () => {
      this.readNewData().catch(() => undefined);
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  poke(): void {
    this.readNewData().catch(() => undefined);
  }

  /**
   * Serialized read entry point. A notification or poke received while a read
   * is still dispatching lines (and has not yet committed its offset) would
   * otherwise start a second read from the same offset, duplicating side
   * effects. Instead the re-entrant call is coalesced and re-runs after the
   * current pass commits, so each byte range is dispatched exactly once.
   */
  private async readNewData(): Promise<void> {
    if (this.reading) {
      this.readQueued = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.readQueued = false;
        await this.readNewDataOnce();
      } while (this.readQueued);
    } finally {
      this.reading = false;
    }
  }

  private async readNewDataOnce(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to stat transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      return;
    }

    if (size < this.tailState.offset) {
      this.tailState.offset = 0;
    }

    if (size === this.tailState.offset) return;

    if (this.isZstd) {
      await this.readZstdNewData(size);
      return;
    }

    const stream = createReadStream(this.filePath, {
      start: this.tailState.offset,
      end: size - 1,
      encoding: 'utf8'
    });

    let data = '';
    for await (const chunk of stream) {
      data += chunk as string;
    }

    this.tailState.offset = size;
    this.onOffset(this.tailState.offset);

    const combined = this.tailState.partial + data;
    const lines = combined.split('\n');
    this.tailState.partial = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.onLine(trimmed);
    }
  }

  /**
   * Incremental read for concatenated-frame Zstandard session logs (e.g.
   * DeepSeek Harness `*.jsonl.zstd`). Every durable write appends one
   * independently decodable frame, so the tail offset always lands on a frame
   * boundary. Only complete frames past the stored offset are decoded; a torn
   * (incomplete) trailing frame is left for the next change event.
   */
  private async readZstdNewData(size: number): Promise<void> {
    let buffer: Buffer;
    try {
      buffer = readFileSync(this.filePath);
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to read zstd transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      return;
    }

    let scan: ZstdScanResult;
    try {
      scan = scanZstdFrames(buffer);
    } catch (error: unknown) {
      logger.warn('TRANSCRIPT', 'Failed to scan zstd transcript frames', {
        file: this.filePath,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    let processedEnd = this.tailState.offset;
    for (const frame of scan.frames) {
      if (frame.end <= this.tailState.offset) continue;
      let plain: string;
      try {
        plain = decompressZstdFrame(buffer, frame);
      } catch (error: unknown) {
        // Stop at the first failed complete frame instead of skipping it. The
        // durable offset only advances through the last consecutively decoded
        // frame, so a corrupted frame is retried on the next change event
        // rather than being permanently skipped (its events would otherwise be
        // silently lost once a later frame advanced the offset past it).
        logger.warn('TRANSCRIPT', 'Failed to decompress zstd transcript frame; retrying on next change', {
          file: this.filePath,
          start: frame.start,
          end: frame.end,
          error: error instanceof Error ? error.message : String(error)
        });
        break;
      }

      const combined = this.tailState.partial + plain;
      const lines = combined.split('\n');
      this.tailState.partial = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        await this.onLine(trimmed);
      }
      processedEnd = frame.end;
    }

    const nextOffset = scan.tornStart !== null && scan.tornStart > processedEnd ? scan.tornStart : processedEnd;
    if (nextOffset > this.tailState.offset) {
      this.tailState.offset = nextOffset;
      this.onOffset(nextOffset);
    }
  }
}

export class TranscriptWatcher {
  private processor = new TranscriptEventProcessor();
  private tailers = new Map<string, FileTailer>();
  private state: TranscriptWatchState;
  private rootWatchers: Array<ReturnType<typeof fsWatch>> = [];

  constructor(private config: TranscriptWatchConfig, private statePath: string) {
    this.state = loadWatchState(statePath);
  }

  async start(): Promise<void> {
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
        void this.addTailer(filePath, watch, schema);
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
          const jsonlPattern = join(inputPath, '**', '*.jsonl');
          const zstdPattern = join(inputPath, '**', '*.jsonl.zstd');
          return [
            ...this.scanGlob(this.normalizeGlobPattern(jsonlPattern)),
            ...this.scanGlob(this.normalizeGlobPattern(zstdPattern)),
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
    return Array.from(new Bun.Glob(pattern).scanSync({ absolute: true, onlyFiles: true }));
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
    schema: TranscriptSchema
  ): Promise<void> {
    if (this.tailers.has(filePath)) return;

    const sessionIdOverride = this.extractSessionIdFromPath(filePath);

    let offset = this.state.offsets[filePath] ?? 0;
    if (offset === 0 && watch.startAtEnd) {
      try {
        offset = statSync(filePath).size;
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
      (newOffset: number) => {
        this.state.offsets[filePath] = newOffset;
        saveWatchState(this.statePath, this.state);
      },
      filePath.endsWith('.jsonl.zstd')
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
