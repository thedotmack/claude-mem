import { mkdirSync, watch as fsWatch } from 'fs';
import { HookSpool, type HookSpoolDrainResult, type HookSpoolEntry } from '../../shared/hook-spool.js';
import { logger } from '../../utils/logger.js';
import { ingestAdvisorCalls, ingestObservation, ingestSessionEnd, ingestSummarize } from './http/shared.js';

const SAFETY_SWEEP_INTERVAL_MS = 30_000;

/**
 * Hand one spool entry to the SAME ingest function its HTTP route uses.
 * true = done (accepted or deliberately skipped) → unlink; false = keep.
 */
async function ingestHookSpoolEntry(entry: HookSpoolEntry): Promise<boolean> {
  switch (entry.kind) {
    case 'observation':
    case 'file_edit': {
      // Attribute it to the prompt that was current when the hook saw it, not
      // the one current now (the drain may run prompts later).
      const result = await ingestObservation({ ...entry.payload, enqueuedAtEpochMs: entry.enqueuedAtEpochMs });
      if (!result.ok) {
        logger.warn('HOOK', 'Spooled observation was not ingested; keeping it for the next drain', {
          kind: entry.kind,
          contentSessionId: entry.payload.contentSessionId,
          toolName: entry.payload.toolName,
          reason: result.reason,
        });
        return false;
      }
      return true;
    }
    case 'summarize':
      // unknown_session: init may not have landed yet (it raced the same
      // outage) — keep the entry, exactly like the old SessionEnd replay.
      return (await ingestSummarize({ ...entry.payload, enqueuedAtEpochMs: entry.enqueuedAtEpochMs })).status !== 'unknown_session';
    case 'session_end':
      return (await ingestSessionEnd(entry.payload)).status !== 'unknown_session';
    case 'advisor_calls':
      ingestAdvisorCalls(entry.payload);
      return true;
  }
}

export async function drainHookSpool(spool: HookSpool = new HookSpool()): Promise<HookSpoolDrainResult> {
  const result = await spool.drain(ingestHookSpoolEntry);
  if (result.drained > 0 || result.quarantined > 0 || result.expired > 0) {
    logger.info('HOOK', 'Drained hook spool', { ...result });
  }
  return result;
}

/**
 * Drives drainHookSpool: single-flight (a request during a drain schedules
 * exactly one more pass, never a concurrent one — FileTailer's requestRead
 * pattern), triggered by an fs.watch of the spool directory, the hook's nudge
 * route, and a slow safety sweep for anything a watch event missed.
 */
export class HookSpoolDrainer {
  private drainTask: Promise<void> | null = null;
  private drainPending = false;
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly spool: HookSpool = new HookSpool(),
    private readonly drain: (spool: HookSpool) => Promise<unknown> = drainHookSpool,
  ) {}

  /** Resolves when the drain that covers this request has finished. */
  requestDrain(): Promise<void> {
    if (this.drainTask) {
      this.drainPending = true;
      return this.drainTask;
    }

    this.drainTask = this.drainUntilSettled().finally(() => {
      this.drainTask = null;
      // A request that landed after the loop's last check but before this
      // callback ran would otherwise wait for the next trigger.
      if (this.drainPending) void this.requestDrain();
    });
    return this.drainTask;
  }

  start(): void {
    this.requestDrain();

    if (!this.watcher) {
      try {
        mkdirSync(this.spool.directory, { recursive: true });
        this.watcher = fsWatch(this.spool.directory, { persistent: false }, () => {
          this.requestDrain();
        });
        this.watcher.on('error', (error: Error) => {
          logger.warn('HOOK', 'Hook spool watch failed; relying on nudges and the safety sweep', {
            directory: this.spool.directory,
          }, error);
          this.watcher?.close();
          this.watcher = null;
        });
      } catch (error: unknown) {
        logger.warn('HOOK', 'Could not watch the hook spool; relying on nudges and the safety sweep', {
          directory: this.spool.directory,
        }, error instanceof Error ? error : new Error(String(error)));
        this.watcher = null;
      }
    }

    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.requestDrain(), SAFETY_SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private async drainUntilSettled(): Promise<void> {
    do {
      this.drainPending = false;
      try {
        await this.drain(this.spool);
      } catch (error: unknown) {
        logger.warn('HOOK', 'Hook spool drain pass failed; the next trigger retries', {
          directory: this.spool.directory,
        }, error instanceof Error ? error : new Error(String(error)));
      }
    } while (this.drainPending);
  }
}
