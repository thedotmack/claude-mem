
import { Database } from 'bun:sqlite';
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { openConfiguredSqliteDatabase } from '../sqlite/connection.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { CloudSync } from '../sync/CloudSync.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DB_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private db: Database | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;
  private cloudSync: CloudSync | null = null;

  async initialize(): Promise<void> {
    this.db = openConfiguredSqliteDatabase(DB_PATH);

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // cloudSyncHubUrl gates the one-shot v43 hub-cutover requeue inside the
    // migration chain (SessionStore.requeueAllForHubCutover) — it must run
    // BEFORE the first drain so the whole corpus is queued when the hub URL
    // first appears.
    this.sessionStore = new SessionStore(this.db, {
      cloudSyncHubUrl: settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL,
    });
    this.sessionSearch = new SessionSearch(this.db);

    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    if (chromaEnabled) {
      this.chromaSync = new ChromaSync('claude-mem');
    } else {
      logger.info('DB', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using SQLite-only search');
    }

    // Cloud sync is active ⇔ token AND user id AND hub URL are all non-empty
    // (no separate enabled flag; empty hub URL = sync OFF — the hard cutover,
    // plan Phase 3 task 5). Inactive installs get null so the write-site
    // `getCloudSync()?.notify()` nudges are free no-ops.
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
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
