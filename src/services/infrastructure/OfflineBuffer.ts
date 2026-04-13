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

/** Outcome of replaying a single buffered request. */
export type ReplayResult = 'ok' | 'skip' | 'retry';

export class OfflineBuffer {
  private bufferPath: string;
  private deadLetterPath: string;
  private replaying = false;  // serialization lock

  constructor(dataDir: string) {
    this.bufferPath = path.join(dataDir, 'buffer.jsonl');
    this.deadLetterPath = path.join(dataDir, 'dead-letter.jsonl');
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

  /** Append a permanently-failed request to the dead-letter file. */
  private deadLetter(entry: BufferedRequest, reason?: string): void {
    const record = { ...entry, _deadLetterTs: new Date().toISOString(), _reason: reason };
    appendFileSync(this.deadLetterPath, JSON.stringify(record) + '\n', 'utf-8');
  }

  /** Get number of dead-lettered requests. */
  deadLetterCount(): number {
    if (!existsSync(this.deadLetterPath)) return 0;
    const content = readFileSync(this.deadLetterPath, 'utf-8').trim();
    if (!content) return 0;
    return content.split('\n').filter(line => line.trim().length > 0).length;
  }

  /**
   * Replay buffered requests by calling replayFn for each.
   * replayFn returns: 'ok' (success), 'skip' (permanent failure → dead-letter), 'retry' (transient → stop).
   * Returns { replayed, skipped, remaining }.
   */
  async replay(replayFn: (req: BufferedRequest) => Promise<ReplayResult>): Promise<{ replayed: number; skipped: number; remaining: number }> {
    if (this.replaying) return { replayed: 0, skipped: 0, remaining: this.pendingCount() };
    this.replaying = true;

    // Atomic rename: move buffer to .replaying so new appends go to a fresh file.
    // This eliminates the race between replay processing and concurrent appends.
    const replayPath = this.bufferPath + '.replaying';
    let processedUpTo = 0;  // index of first unprocessed entry
    let replayed = 0;
    let skipped = 0;
    try {
      if (!existsSync(this.bufferPath)) return { replayed: 0, skipped: 0, remaining: 0 };
      try { renameSync(this.bufferPath, replayPath); } catch {
        return { replayed: 0, skipped: 0, remaining: this.pendingCount() };
      }

      const raw = readFileSync(replayPath, 'utf-8');
      const entries: BufferedRequest[] = raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch (e) {
          logger.warn('BUFFER', 'Corrupt JSONL line skipped during replay', { line: line.slice(0, 100), path: replayPath });
          return null;
        }
      }).filter(Boolean);
      if (entries.length === 0) {
        try { unlinkSync(replayPath); } catch {}
        return { replayed: 0, skipped: 0, remaining: 0 };
      }
      for (let i = 0; i < entries.length; i++) {
        try {
          const result = await replayFn(entries[i]);
          if (result === 'ok') {
            replayed++;
            processedUpTo = i + 1;
          } else if (result === 'skip') {
            this.deadLetter(entries[i], 'permanent_failure');
            skipped++;
            processedUpTo = i + 1;
            logger.warn('BUFFER', 'Skipped permanently-failed request to dead-letter', {
              path: entries[i].path, node: entries[i].node, ts: entries[i].ts,
            });
          } else {
            // 'retry' — stop here, keep this entry and all following for next cycle
            break;
          }
        } catch (replayError) {
          logger.warn('BUFFER', 'replayFn threw, stopping replay', { replayed, skipped, total: entries.length }, replayError as Error);
          break;
        }
      }

      // Write back ONLY unprocessed entries, then merge any new appends
      const unprocessed = entries.slice(processedUpTo);

      if (unprocessed.length > 0) {
        const unprocessedContent = unprocessed.map(e => JSON.stringify(e)).join('\n') + '\n';
        const newAppends = existsSync(this.bufferPath) ? readFileSync(this.bufferPath, 'utf-8') : '';
        const tmpPath = this.bufferPath + '.tmp';
        writeFileSync(tmpPath, unprocessedContent + newAppends, 'utf-8');
        renameSync(tmpPath, this.bufferPath);
      }
      // Delete replayPath AFTER unprocessed data is safely written to bufferPath.
      try { unlinkSync(replayPath); } catch {}

      const remaining = existsSync(this.bufferPath) ? this.pendingCount() : 0;
      logger.info('BUFFER', 'Replay complete', { replayed, skipped, remaining });
      return { replayed, skipped, remaining };
    } catch (error) {
      // On error, merge ONLY unprocessed entries with any new appends (not full file).
      if (existsSync(replayPath)) {
        try {
          const allEntries: BufferedRequest[] = readFileSync(replayPath, 'utf-8').split('\n').filter(Boolean)
            .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
          const unprocessedEntries = allEntries.slice(processedUpTo);
          const unprocessedContent = unprocessedEntries.length > 0
            ? unprocessedEntries.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
          const newAppends = existsSync(this.bufferPath) ? readFileSync(this.bufferPath, 'utf-8') : '';
          if (unprocessedContent || newAppends) {
            const tmpPath = this.bufferPath + '.tmp';
            writeFileSync(tmpPath, unprocessedContent + newAppends, 'utf-8');
            renameSync(tmpPath, this.bufferPath);
          }
          unlinkSync(replayPath);
        } catch {
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
