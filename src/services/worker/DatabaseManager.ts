
import { Database } from 'bun:sqlite';
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { openGuardedSqliteDatabase } from '../sqlite/connection.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { CloudSync } from '../sync/CloudSync.js';
import { BackupManager } from '../backup/BackupManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DB_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { clearSyncHealth, defaultSyncHealthFilePath } from '../../shared/sync-health.js';
import { purgeUndrainableSyncOutbox } from '../sync/outbox-purge.js';
import { purgeLinkedToolUses, resolveToolUsesRetentionDays } from '../sqlite/tool-uses.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private db: Database | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;
  private cloudSync: CloudSync | null = null;
  private backupManager: BackupManager | null = null;

  async initialize(): Promise<void> {
    // Guard before pragmas: journal_mode = WAL persistently rewrites the file,
    // so a database whose schema is newer than this binary's chain must be
    // refused before the shared open touches it (#3609 step 2).
    this.db = openGuardedSqliteDatabase(DB_PATH);

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // Cloud sync is active iff token, user id, and Hub URL are all non-empty
    // (CloudSync.isConfigured's exact predicate). Evaluated once here and
    // shared with SessionStore: sync_outbox rows are only ever deleted by
    // CloudSync's ack path, so an install without a CloudSync must not
    // produce mutation ops either — they would accumulate forever.
    const cloudSyncConfigured =
      settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN !== '' &&
      settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID !== '' &&
      settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL.trim() !== '';

    // The launch schema is SyncHub-native. SessionStore marks any pre-launch
    // local corpus as a nonqueued baseline once; only subsequent writes enter
    // the canonical v2 outbox.
    this.sessionStore = new SessionStore(this.db, { syncOpsEnabled: cloudSyncConfigured });
    this.sessionSearch = new SessionSearch(this.db);

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
    // Work-state reads fold native rows as this device's writes (the order
    // other devices and cmem.ai use), under the id CloudSync resolved.
    this.sessionStore.setLocalSyncDeviceId(this.cloudSync?.status().deviceId ?? settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID);

    purgeLinkedToolUses(this.db, resolveToolUsesRetentionDays(settings.CLAUDE_MEM_TOOL_USES_RETENTION_DAYS));

    // Automatic local snapshots are opt-in. Disabled installs get null so the
    // lifecycle `getBackupManager()?.start()` call is a free no-op.
    if (settings.CLAUDE_MEM_BACKUP_ENABLED === 'true') {
      this.backupManager = new BackupManager(settings);
    }

    logger.info('DB', 'Database initialized (shared connection)');
  }

  async close(): Promise<void> {
    this.chromaSync = null;

    this.cloudSync?.stop();
    this.cloudSync = null;

    this.backupManager?.stop();
    this.backupManager = null;

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

  getChromaSync(): ChromaSync | null {
    return this.chromaSync;
  }

  getCloudSync(): CloudSync | null {
    return this.cloudSync;
  }

  getBackupManager(): BackupManager | null {
    return this.backupManager;
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
