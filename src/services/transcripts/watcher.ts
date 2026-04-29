import { existsSync, statSync, watch as fsWatch, createReadStream } from 'fs';
import { basename, join, resolve as resolvePath, sep as pathSep } from 'path';
import { globSync } from 'glob';
import { logger } from '../../utils/logger.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptEventProcessor } from './processor.js';

interface TailState {
  offset: number;
  partial: string;
}

class FileTailer {
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private tailState: TailState;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (offset: number) => void
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

  // Public wrapper so the recursive root watcher can prod an existing tailer
  // when fs.watch on the file itself misses an append event on Windows
  // (#2192). Per-file fs.watch is unreliable on Windows ReFS/SMB; the root
  // recursive watcher is the only signal we can trust there.
  poke(): void {
    this.readNewData().catch(() => undefined);
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

    if (size < this.tailState.offset) {
      this.tailState.offset = 0;
    }

    if (size === this.tailState.offset) return;

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
      await this.addTailer(filePath, watch, schema, true);
    }

    // PATHFINDER plan 03 phase 5: 5-second rescan timer replaced by a
    // recursive fs.watch on the configured root. Requires Node 20+ on Linux
    // for recursive mode (engines.node >= 20.0.0 — already enforced in
    // package.json).
    const watchRoot = this.deepestNonGlobAncestor(resolvedPath);
    if (!watchRoot || !existsSync(watchRoot)) {
      logger.debug('TRANSCRIPT', 'Watch root does not exist, skipping fs.watch', { watch: watch.name, watchRoot });
      return;
    }

    try {
      const watcher = fsWatch(watchRoot, { recursive: true, persistent: true }, (event, name) => {
        if (!name) return;                                  // some events omit filename
        // Skip the glob scan for paths we already tail — JSONL appends fire
        // here on every line and a full resolveWatchFiles() per append is
        // more expensive than the prior 5-s interval. Only unknown paths
        // warrant a rescan (new transcript files surface here first).
        // Normalize so the key matches what globSync stored (forward slashes
        // on Windows). Without this, every append from the recursive watcher
        // looks like a "new file" and we re-scan instead of poking the tailer.
        const changed = resolvePath(watchRoot, name).replace(/\\/g, '/');
        const existingTailer = this.tailers.get(changed);
        if (existingTailer) {
          // #2192: per-file fs.watch on Windows misses appends to live JSONL
          // files. The recursive root watcher fires reliably; poke the tailer
          // so it picks up new lines without a full glob rescan.
          existingTailer.poke();
          return;
        }
        const matches = this.resolveWatchFiles(resolvedPath);
        for (const filePath of matches) {
          if (!this.tailers.has(filePath)) {
            void this.addTailer(filePath, watch, schema, false);
          }
        }
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

  /**
   * Return the deepest path component that contains no glob meta-characters.
   * Used to anchor `fs.watch(recursive: true)` for both literal directories
   * and patterns like `~/.codex/sessions/**\/*.jsonl`.
   *
   * Handles both `/` and `\` as separators so Windows-native paths
   * (e.g. `C:\Users\x\codex\sessions\**\*.jsonl`) resolve correctly. When
   * the input is purely glob meta (no literal prefix) we return an empty
   * string so the caller skips the watch instead of anchoring at the
   * filesystem root.
   */
  private deepestNonGlobAncestor(inputPath: string): string {
    if (!this.hasGlob(inputPath)) {
      // Literal path: if it's a file, return its directory; otherwise return as-is.
      if (existsSync(inputPath)) {
        try {
          const stat = statSync(inputPath);
          return stat.isDirectory() ? inputPath : resolvePath(inputPath, '..');
        } catch {
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
      // Input started with a separator but the first real segment was a
      // glob (e.g. `/**/foo`). Don't silently broaden the watch to `/`.
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
      // #2192: glob treats backslashes as escape chars, not separators. On
      // Windows, expandHomePath() emits backslash paths from Node's path.join
      // which globSync silently fails to match. Normalize separators here
      // before passing to glob — leaves Unix paths untouched.
      return globSync(this.normalizeGlobPattern(inputPath), { nodir: true, absolute: true });
    }

    if (existsSync(inputPath)) {
      try {
        const stat = statSync(inputPath);
        if (stat.isDirectory()) {
          const pattern = join(inputPath, '**', '*.jsonl');
          return globSync(this.normalizeGlobPattern(pattern), { nodir: true, absolute: true });
        }
        return [inputPath];
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat watch path', { path: inputPath }, error instanceof Error ? error : undefined);
        return [];
      }
    }

    return [];
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
    initialDiscovery: boolean
  ): Promise<void> {
    if (this.tailers.has(filePath)) return;

    const sessionIdOverride = this.extractSessionIdFromPath(filePath);

    let offset = this.state.offsets[filePath] ?? 0;
    // `startAtEnd` is useful on worker startup to avoid replaying the full backlog,
    // but new transcript files must be read from byte 0 or we lose session_meta/user_message.
    if (offset === 0 && watch.startAtEnd && initialDiscovery) {
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
      }
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
