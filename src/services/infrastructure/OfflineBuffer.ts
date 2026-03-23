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

  /** Read all buffered requests (FIFO order). */
  readAll(): BufferedRequest[] {
    if (!existsSync(this.bufferPath)) return [];
    const content = readFileSync(this.bufferPath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
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

    try {
      const entries = this.readAll();
      if (entries.length === 0) return { replayed: 0, remaining: 0 };

      let replayed = 0;
      for (const entry of entries) {
        const ok = await replayFn(entry);
        if (!ok) break;
        replayed++;
      }

      // Atomic rewrite: keep only unreplayed entries
      const remaining = entries.slice(replayed);
      if (remaining.length === 0) {
        // All replayed — delete buffer
        try { unlinkSync(this.bufferPath); } catch {}
      } else {
        // Atomic: write temp -> rename
        const tmpPath = this.bufferPath + '.tmp';
        const content = remaining.map(e => JSON.stringify(e)).join('\n') + '\n';
        writeFileSync(tmpPath, content, 'utf-8');
        renameSync(tmpPath, this.bufferPath);
      }

      logger.info('BUFFER', 'Replay complete', { replayed, remaining: remaining.length });
      return { replayed, remaining: remaining.length };
    } finally {
      this.replaying = false;
    }
  }
}
