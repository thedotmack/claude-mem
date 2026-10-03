
import { Database } from 'bun:sqlite';
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { openConfiguredSqliteDatabase } from '../sqlite/connection.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { CloudSync, isCloudSyncConfigured } from '../sync/CloudSync.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DB_PATH, DATA_DIR } from '../../shared/paths.js';
import { MediaStore } from '../media/store.js';
import { MediaCloudClient, MediaCloudReplicaResolver, MediaCloudSync, mediaCloudUploadsEnabled } from '../media/cloud.js';
import { cmemProOrigin } from '../../shared/cmem-gateway.js';
import { MediaError } from '../../shared/media-contract.js';
import { logger } from '../../utils/logger.js';
import { clearSyncHealth, defaultSyncHealthFilePath } from '../../shared/sync-health.js';
import { purgeUndrainableSyncOutbox } from '../sync/outbox-purge.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private db: Database | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;
  private cloudSync: CloudSync | null = null;
  private mediaStore: MediaStore | null = null;
  private mediaCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private mediaCloudSync: MediaCloudSync | null = null;
  private mediaReplicaResolver: MediaCloudReplicaResolver | null = null;

  async initialize(): Promise<void> {
    this.db = openConfiguredSqliteDatabase(DB_PATH);

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // Cloud sync is active iff token, user id, and Hub URL are all non-empty
    // (CloudSync.isConfigured's exact predicate). Evaluated once here and
    // shared with SessionStore: sync_outbox rows are only ever deleted by
    // CloudSync's ack path, so an install without a CloudSync must not
    // produce mutation ops either — they would accumulate forever.
    const cloudSyncConfigured = isCloudSyncConfigured(settings);

    // The launch schema is SyncHub-native. SessionStore marks any pre-launch
    // local corpus as a nonqueued baseline once; only subsequent writes enter
    // the canonical v2 outbox.
    this.sessionStore = new SessionStore(this.db, { syncOpsEnabled: cloudSyncConfigured });
    this.sessionSearch = new SessionSearch(this.db);
    this.mediaStore = new MediaStore(this.db, DATA_DIR);
    const reconcileMedia = () => {
      // Cleanup rows stay durable on failure and are retried next interval.
      // Only the bounded code is logged: storage errors can contain paths.
      try { this.mediaStore?.reconcile(); }
      catch (error) {
        logger.warn('DB', 'Media cleanup remains pending', {
          code: error instanceof MediaError ? error.code : 'storage_unavailable',
        });
      }
    };
    reconcileMedia();
    this.mediaCleanupTimer = setInterval(reconcileMedia, 30_000);
    this.mediaCleanupTimer.unref?.();

    // Media upload/deletion runs beside, never inside, native text sync.
    // Queued cloud deletions drain whenever sync credentials exist; uploads
    // additionally require CLAUDE_MEM_MEDIA_CAPTURE_ENABLED.
    const mediaCloudClient = cloudSyncConfigured
      ? new MediaCloudClient({ baseUrl: cmemProOrigin(), token: settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN })
      : null;
    this.mediaReplicaResolver = new MediaCloudReplicaResolver(this.mediaStore, mediaCloudClient);
    if (mediaCloudClient) {
      this.mediaCloudSync = new MediaCloudSync(this.db, this.mediaStore, mediaCloudClient, {
        uploadsEnabled: mediaCloudUploadsEnabled(settings),
      });
      this.mediaCloudSync.start();
    }

    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    if (chromaEnabled) {
      this.chromaSync = new ChromaSync('claude-mem');
    } else {
      logger.info('DB', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using SQLite-only search');
    }

    // Inactive installs get null so the write-site `getCloudSync()?.notify()`
    // nudges are free no-ops.
    if (cloudSyncConfigured) {
      this.cloudSync = new CloudSync(this.db, settings, { healthFilePath: defaultSyncHealthFilePath() });
    } else {
      // Sync is off: no banner for a feature not in use, and no queue that
      // nothing will ever drain (#4228).
      clearSyncHealth();
      purgeUndrainableSyncOutbox(this.db);
    }

    logger.info('DB', 'Database initialized (shared connection)');
  }

  async close(): Promise<void> {
    if (this.mediaCleanupTimer) clearInterval(this.mediaCleanupTimer);
    this.mediaCleanupTimer = null;
    this.mediaCloudSync?.stop();
    this.mediaCloudSync = null;
    this.mediaReplicaResolver = null;
    this.mediaStore = null;
    this.chromaSync = null;

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

  getMediaStore(): MediaStore {
    if (!this.mediaStore) throw new Error('Database not initialized');
    return this.mediaStore;
  }

  /** Lazy second-device media resolution for viewer reads (no-op for native media). */
  getMediaReplicaResolver(): MediaCloudReplicaResolver {
    if (!this.mediaReplicaResolver) throw new Error('Database not initialized');
    return this.mediaReplicaResolver;
  }

  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  getChromaSync(): ChromaSync | null {
    return this.chromaSync;
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
    observed_model: string | null;
    observed_billing: string | null;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
