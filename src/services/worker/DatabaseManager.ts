
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

export class DatabaseManager {
  private db: Database | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private vectorSync: VectorSync | null = null;
  private vectorIndex: VectorIndex | null = null;
  private backfill: VectorBackfill | null = null;
  private backfillTimer: ReturnType<typeof setTimeout> | null = null;
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
   * An upgrading install has a full corpus to embed (~4 min for 141k docs),
   * and blocking startup on that would make the worker look hung. Batches are
   * spaced so indexing never competes with live capture; the pass simply
   * resumes next boot if the process exits partway.
   *
   * The re-arm is driven by the batch's own report rather than by a second
   * isComplete() probe, so the chain stops on the pass that finishes the scan
   * instead of one full COUNT(*) sweep of three tables later.
   */
  private scheduleBackfill(delayMs = 5_000): void {
    if (!this.backfill || !this.vectorIndex) return;
    this.backfillTimer = setTimeout(async () => {
      try {
        if (this.backfill!.isComplete(this.vectorIndex!.modelId)) {
          logger.info('DB', 'Vector backfill complete');
          return;
        }
        const progress = await this.backfill!.runBatch();
        if (progress.every((p) => p.remaining === 0)) {
          logger.info('DB', 'Vector backfill complete');
          return;
        }
        this.scheduleBackfill(1_000);
      } catch (error) {
        // A failed pass must never take the worker with it; search degrades
        // to whatever is already indexed and the next boot retries.
        logger.warn('DB', 'Vector backfill batch failed; will retry next boot', {
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
