import { existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, statSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';

export interface BufferedRequest {
  ts: string;          // ISO timestamp
  method: string;      // 'POST'
  path: string;        // '/api/sessions/observations'
  body: any;           // JSON body
  node: string;        // source machine
  headers?: Record<string, string>; // extra headers to replay
}

export class OfflineBuffer {
  private bufferPath: string;
  private replaying = false;  // serialization lock

  constructor(dataDir: string) {
    this.bufferPath = path.join(dataDir, 'buffer.jsonl');
    mkdirSync(dataDir, { recursive: true });

    // Recover stale .replaying file from a previous crash during replay
    const replayPath = this.bufferPath + '.replaying';
    if (existsSync(replayPath)) {
      try {
        const staleContent = readFileSync(replayPath, 'utf-8');
        const existingContent = existsSync(this.bufferPath) ? readFileSync(this.bufferPath, 'utf-8') : '';
        const tmpPath = this.bufferPath + '.tmp';
        writeFileSync(tmpPath, staleContent + existingContent, 'utf-8');
        renameSync(tmpPath, this.bufferPath);
        unlinkSync(replayPath);
        logger.info('BUFFER', 'Recovered stale replay file', { path: replayPath });
      } catch (error) {
        logger.error('BUFFER', 'Failed to recover stale replay file', { path: replayPath }, error as Error);
      }
    }
  }

  /** Append a request to the buffer file. Thread-safe (append-only). */
  append(request: BufferedRequest): void {
    const line = JSON.stringify(request) + '\n';
    appendFileSync(this.bufferPath, line, 'utf-8');
    logger.info('BUFFER', 'Request buffered', { path: request.path, node: request.node });

    // Warn if buffer is getting large
    try {
      const stats = statSync(this.bufferPath);
      if (stats.size > 10 * 1024 * 1024) {
        logger.warn('BUFFER', 'Buffer exceeds 10MB', { sizeBytes: stats.size });
      }
    } catch {}
  }

  /** Read all buffered requests (FIFO order). Skips corrupt lines silently. */
  readAll(): BufferedRequest[] {
    if (!existsSync(this.bufferPath)) return [];
    const content = readFileSync(this.bufferPath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n')
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean) as BufferedRequest[];
  }

  /** Get number of pending requests. */
  pendingCount(): number {
    if (!existsSync(this.bufferPath)) return 0;
    const content = readFileSync(this.bufferPath, 'utf-8').trim();
    if (!content) return 0;
    return content.split('\n').filter(line => line.trim().length > 0).length;
  }

  /**
   * Replay buffered requests by calling replayFn for each.
   * Removes successfully replayed entries via atomic rewrite.
   * Stops on first failure (retry next cycle).
   * Returns { replayed, remaining }.
   */
  async replay(replayFn: (req: BufferedRequest) => Promise<boolean>): Promise<{ replayed: number; remaining: number }> {
    if (this.replaying) return { replayed: 0, remaining: this.pendingCount() };
    this.replaying = true;

    // Atomic rename: move buffer to .replaying so new appends go to a fresh file.
    // This eliminates the race between replay processing and concurrent appends.
    const replayPath = this.bufferPath + '.replaying';
    let replayed = 0;  // Declared outside try so catch can use it for partial recovery
    try {
      if (!existsSync(this.bufferPath)) return { replayed: 0, remaining: 0 };
      try { renameSync(this.bufferPath, replayPath); } catch {
        return { replayed: 0, remaining: this.pendingCount() };
      }

      const raw = readFileSync(replayPath, 'utf-8');
      const entries: BufferedRequest[] = raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      if (entries.length === 0) {
        try { unlinkSync(replayPath); } catch {}
        return { replayed: 0, remaining: 0 };
      }
      for (const entry of entries) {
        try {
          const ok = await replayFn(entry);
          if (!ok) break;
          replayed++;
        } catch (replayError) {
          logger.warn('BUFFER', 'replayFn threw, stopping replay', { replayed, total: entries.length }, replayError as Error);
          break;
        }
      }

      // Write back ONLY unreplayed entries, then merge any new appends
      const unreplayed = entries.slice(replayed);

      if (unreplayed.length > 0) {
        // Prepend unreplayed entries to whatever was appended during replay
        const unreplayedContent = unreplayed.map(e => JSON.stringify(e)).join('\n') + '\n';
        const newAppends = existsSync(this.bufferPath) ? readFileSync(this.bufferPath, 'utf-8') : '';
        const tmpPath = this.bufferPath + '.tmp';
        writeFileSync(tmpPath, unreplayedContent + newAppends, 'utf-8');
        renameSync(tmpPath, this.bufferPath);
      }
      // Delete replayPath AFTER unreplayed data is safely written to bufferPath.
      try { unlinkSync(replayPath); } catch {}

      const remaining = existsSync(this.bufferPath) ? this.pendingCount() : 0;
      logger.info('BUFFER', 'Replay complete', { replayed, remaining });
      return { replayed, remaining };
    } catch (error) {
      // On error, merge ONLY unreplayed entries with any new appends (not full file).
      // 'replayed' is scoped above; entries that succeeded should not be requeued.
      if (existsSync(replayPath)) {
        try {
          const allLines = readFileSync(replayPath, 'utf-8').split('\n').filter(Boolean);
          // Only keep entries that were NOT successfully replayed
          const unreplayedLines = allLines.slice(replayed);
          const unreplayedContent = unreplayedLines.length > 0 ? unreplayedLines.join('\n') + '\n' : '';
          const newAppends = existsSync(this.bufferPath) ? readFileSync(this.bufferPath, 'utf-8') : '';
          if (unreplayedContent || newAppends) {
            const tmpPath = this.bufferPath + '.tmp';
            writeFileSync(tmpPath, unreplayedContent + newAppends, 'utf-8');
            renameSync(tmpPath, this.bufferPath);
          }
          unlinkSync(replayPath);
        } catch {
          // Last resort: keep replay file only if bufferPath doesn't exist (avoid overwriting fresh appends)
          if (!existsSync(this.bufferPath)) {
            try { renameSync(replayPath, this.bufferPath); } catch {}
          } else {
            logger.error('BUFFER', 'Recovery failed, replay file preserved', { replayPath });
          }
        }
      }
      throw error;
    } finally {
      this.replaying = false;
    }
  }
}
