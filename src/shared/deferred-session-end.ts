import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { writeJsonFileAtomic } from './atomic-json.js';
import { DATA_DIR } from './paths.js';
import { normalizePlatformSource } from './platform-source.js';
import { logger } from '../utils/logger.js';

const SESSION_END_REPLAY_DIRNAME = 'session-end-replay';
const ENTRY_FILENAME = /^[a-f0-9]{64}\.json$/;

export interface DeferredSessionEndInput {
  contentSessionId: string;
  platformSource: string;
}

export interface DeferredSessionEnd extends DeferredSessionEndInput {
  requestedAtEpoch: number;
}

export interface DeferredSessionEndDrainResult {
  drained: number;
  retained: number;
}

interface DeferredSessionEndFile {
  entry: DeferredSessionEnd;
  path: string;
}

function parseDeferredSessionEnd(raw: string): DeferredSessionEnd | null {
  const parsed = JSON.parse(raw) as Partial<DeferredSessionEnd>;
  if (
    typeof parsed.contentSessionId !== 'string' || parsed.contentSessionId.length === 0 ||
    typeof parsed.platformSource !== 'string' || parsed.platformSource.length === 0 ||
    typeof parsed.requestedAtEpoch !== 'number' || !Number.isFinite(parsed.requestedAtEpoch)
  ) {
    return null;
  }

  return {
    contentSessionId: parsed.contentSessionId,
    platformSource: normalizePlatformSource(parsed.platformSource),
    requestedAtEpoch: parsed.requestedAtEpoch,
  };
}

/**
 * A durable, per-session SessionEnd spool for the short-lived hook process.
 *
 * SessionEnd cannot wait for a worker to start or retry an IPC request. A
 * deterministic filename makes duplicate hook deliveries overwrite one record
 * rather than growing the queue; the worker removes it only after accepting
 * the replay request.
 */
export class DeferredSessionEndQueue {
  constructor(private readonly directory = join(DATA_DIR, 'state', SESSION_END_REPLAY_DIRNAME)) {}

  enqueue(input: DeferredSessionEndInput, requestedAtEpoch = Date.now()): void {
    const entry: DeferredSessionEnd = {
      contentSessionId: input.contentSessionId,
      platformSource: normalizePlatformSource(input.platformSource),
      requestedAtEpoch,
    };
    writeJsonFileAtomic(this.entryPath(entry), entry);
  }

  entries(): DeferredSessionEnd[] {
    return this.readEntries().map(item => item.entry);
  }

  async drain(
    accept: (entry: DeferredSessionEnd) => boolean | Promise<boolean>,
  ): Promise<DeferredSessionEndDrainResult> {
    let drained = 0;
    let retained = 0;

    for (const queued of this.readEntries()) {
      let accepted: boolean;
      try {
        accepted = await accept(queued.entry);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('HOOK', 'Deferred SessionEnd replay failed; retaining it for a later worker recovery', {
          contentSessionId: queued.entry.contentSessionId,
          platformSource: queued.entry.platformSource,
        }, err);
        retained++;
        continue;
      }

      if (!accepted) {
        retained++;
        continue;
      }

      try {
        unlinkSync(queued.path);
        drained++;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('HOOK', 'Deferred SessionEnd replay was accepted but could not be removed', {
          contentSessionId: queued.entry.contentSessionId,
          platformSource: queued.entry.platformSource,
        }, err);
        retained++;
      }
    }

    return { drained, retained };
  }

  private entryPath(entry: DeferredSessionEndInput): string {
    const key = createHash('sha256')
      .update(normalizePlatformSource(entry.platformSource))
      .update('\0')
      .update(entry.contentSessionId)
      .digest('hex');
    return join(this.directory, `${key}.json`);
  }

  private readEntries(): DeferredSessionEndFile[] {
    if (!existsSync(this.directory)) return [];

    let filenames: string[];
    try {
      filenames = readdirSync(this.directory).filter(filename => ENTRY_FILENAME.test(filename));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('HOOK', 'Could not read deferred SessionEnd replay entries', {
        directory: this.directory,
      }, err);
      return [];
    }

    const entries: DeferredSessionEndFile[] = [];
    for (const filename of filenames) {
      const entryPath = join(this.directory, filename);
      try {
        const entry = parseDeferredSessionEnd(readFileSync(entryPath, 'utf-8'));
        if (entry === null) {
          logger.warn('HOOK', 'Ignoring malformed deferred SessionEnd replay entry', { entryPath });
          continue;
        }
        entries.push({ entry, path: entryPath });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('HOOK', 'Could not read deferred SessionEnd replay entry', { entryPath }, err);
      }
    }

    return entries;
  }
}

export function enqueueDeferredSessionEnd(input: DeferredSessionEndInput): void {
  new DeferredSessionEndQueue().enqueue(input);
}
