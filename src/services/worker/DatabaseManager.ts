
import { Database } from 'bun:sqlite';
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { openConfiguredSqliteDatabase } from '../sqlite/connection.js';
import { VectorIndex } from '../vector/VectorIndex.js';
import { VectorSync } from '../vector/VectorSync.js';
import { VectorBackfill } from '../vector/VectorBackfill.js';
import { LocalEmbedder } from '../vector/LocalEmbedder.js';
import { CloudSync } from '../sync/CloudSync.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DB_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

/** First wait after a failed pass; doubles per consecutive failure. */
export const BACKFILL_RETRY_BASE_MS = 5_000;
/**
 * Consecutive failures after which the chain stops and genuinely does wait for
 * the next boot. Five retries at 5/10/20/40/80s, so it keeps trying for about
 * 2.5 minutes before concluding the fault is not transient.
 */
export const BACKFILL_MAX_ATTEMPTS = 6;

/**
 * Cadence the chain settles into once fast retries stop helping. It never stops
 * entirely: the embedder or the database can recover long after the escalation
 * window, and a chain that has given up leaves that project on keyword search
 * for the rest of the worker's life.
 */
export const BACKFILL_RECOVERY_MS = 5 * 60_000;

export type BackfillOutcome =
  | { kind: 'complete' }
  | { kind: 'continue'; delayMs: number }
  | { kind: 'retry'; delayMs: number; failures: number; message: string }
  | { kind: 'exhausted'; delayMs: number; failures: number; message: string };

/**
 * One turn of the backfill chain: run a pass and say what happens next.
 *
 * Extracted from the timer so the recurrence is reachable without a
 * DatabaseManager, which needs DB_PATH, a settings file and a real
 * LocalEmbedder (208MB of ONNX the suite deliberately avoids). That
 * unreachability is why the retry path shipped untested: the only coverage
 * hand-mirrored the success branch and never modelled a throw.
 */
export async function stepBackfill(
  backfill: VectorBackfill,
  modelId: string,
  failures: number,
): Promise<BackfillOutcome> {
  try {
    if (backfill.isComplete(modelId)) return { kind: 'complete' };
    const progress = await backfill.runBatch();
    if (progress.every((p) => p.remaining === 0)) return { kind: 'complete' };
    return { kind: 'continue', delayMs: 1_000 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempt = failures + 1;
    if (attempt >= BACKFILL_MAX_ATTEMPTS) {
      return { kind: 'exhausted', delayMs: BACKFILL_RECOVERY_MS, failures: attempt, message };
    }
    // Back off rather than re-arming at the success cadence: a permanently
    // failing embedder retried every second is the 1 Hz burn this backfill was
    // rewritten to remove. Doubling is long enough for a model download or a
    // busy database to come good, and short enough that a genuinely broken
    // install stops quickly instead of retrying all day.
    return { kind: 'retry', delayMs: BACKFILL_RETRY_BASE_MS * 2 ** (attempt - 1), failures: attempt, message };
  }
}

export class DatabaseManager {
  private db: Database | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private vectorSync: VectorSync | null = null;
  private vectorIndex: VectorIndex | null = null;
  private backfill: VectorBackfill | null = null;
  private backfillTimer: ReturnType<typeof setTimeout> | null = null;
  private backfillFailures = 0;
  private cloudSync: CloudSync | null = null;

  async initialize(): Promise<void> {
    this.db = openConfiguredSqliteDatabase(DB_PATH);

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // The launch schema is SyncHub-native. SessionStore marks any pre-launch
    // local corpus as a nonqueued baseline once; only subsequent writes enter
    // the canonical v2 outbox.
    this.sessionStore = new SessionStore(this.db);
    this.sessionSearch = new SessionSearch(this.db);

    // Setting name is unchanged on purpose: an install that opted out of
    // semantic search stays opted out across the upgrade. It now gates the
    // in-file index rather than the Chroma subprocess.
    const semanticEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    if (semanticEnabled) {
      this.vectorIndex = new VectorIndex(this.db, new LocalEmbedder());
      this.vectorSync = new VectorSync(this.vectorIndex);
      this.backfill = new VectorBackfill(this.db, this.vectorIndex);
      this.scheduleBackfill();
    } else {
      logger.info('DB', 'Semantic search disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using SQLite-only search');
    }

    // Cloud sync is active iff token, user id, and Hub URL are all non-empty.
    // Inactive installs get null so the write-site `getCloudSync()?.notify()`
    // nudges are free no-ops.
    if (
      settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN !== '' &&
      settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID !== '' &&
      settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL.trim() !== ''
    ) {
      this.cloudSync = new CloudSync(this.db, settings);
    }

    logger.info('DB', 'Database initialized (shared connection)');
  }

  async close(): Promise<void> {
    if (this.backfillTimer) {
      clearTimeout(this.backfillTimer);
      this.backfillTimer = null;
    }
    this.vectorSync = null;
    this.vectorIndex = null;
    this.backfill = null;

    this.cloudSync?.stop();
    this.cloudSync = null;

    this.sessionStore = null;
    this.sessionSearch = null;

    if (this.db) {
      this.db.close();
      this.db = null;
    }
    logger.info('DB', 'Database closed');
  }

  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  /**
   * Name retained so the six existing call sites keep their shape; this now
   * returns the in-file vector writer. Renaming it is a clean follow-up.
   */
  getChromaSync(): VectorSync | null {
    return this.vectorSync;
  }

  getVectorIndex(): VectorIndex | null {
    return this.vectorIndex;
  }

  /**
   * Drives the one-time re-embed on a timer instead of at boot.
   *
   * An upgrading install has its whole existing corpus to embed, and blocking
   * startup on that would make the worker look hung. Batches are spaced so
   * indexing never competes with live capture; the pass simply resumes next
   * boot if the process exits partway.
   *
   * The re-arm is driven by the batch's own report rather than by a second
   * isComplete() probe, so the chain stops on the pass that finishes the scan
   * instead of one full COUNT(*) sweep of three tables later.
   */
  private scheduleBackfill(delayMs = 5_000): void {
    if (!this.backfill || !this.vectorIndex) return;
    this.backfillTimer = setTimeout(async () => {
      // stepBackfill absorbs its own faults, but re-arming happens out here, so
      // the callback keeps a guard of its own: an unhandled rejection inside a
      // timer is how a failed pass would take the worker down with it.
      try {
        const modelId = this.vectorIndex!.modelId;
        const outcome = await stepBackfill(this.backfill!, modelId, this.backfillFailures);
        // 'exhausted' must carry its count forward too. Resetting it there
        // sends the next tick back to the front of the escalation, so the chain
        // cycles 5s..80s..slow..5s forever instead of settling into the slow
        // check. Only a pass that did not throw clears it.
        const stillFailing = outcome.kind === 'retry' || outcome.kind === 'exhausted';
        this.backfillFailures = stillFailing ? outcome.failures : 0;
        if (outcome.kind === 'complete') {
          logger.info('DB', 'Vector backfill complete');
          return;
        }
        if (outcome.kind === 'exhausted') {
          // Slow down, but never stop. The fault is no longer plausibly
          // transient, yet an embedder or database that is down for an hour
          // still comes back, and a chain that has stopped would leave this
          // project on keyword search until the process restarts.
          this.scheduleBackfill(outcome.delayMs);
          if (outcome.failures === BACKFILL_MAX_ATTEMPTS) {
            logger.warn('DB', 'Vector backfill still failing; checking occasionally from now on', {
              error: outcome.message,
              attempts: outcome.failures,
              nextCheckMs: outcome.delayMs,
            });
          }
          return;
        }
        if (outcome.kind === 'retry') {
          logger.warn('DB', 'Vector backfill batch failed; retrying', {
            error: outcome.message,
            attempt: outcome.failures,
            retryInMs: outcome.delayMs,
          });
        }
        this.scheduleBackfill(outcome.delayMs);
      } catch (error) {
        // Re-arm BEFORE logging: this handler exists so a fault here cannot
        // become an unhandled rejection, and returning without a timer would
        // strand indexing exactly as the failure path used to. A logger that
        // throws must not be what stops it.
        this.scheduleBackfill(BACKFILL_RECOVERY_MS);
        logger.warn('DB', 'Vector backfill scheduler failed; checking again later', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, delayMs);
    this.backfillTimer.unref?.();
  }

  getCloudSync(): CloudSync | null {
    return this.cloudSync;
  }

  getConnection(): Database {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    status: string;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
