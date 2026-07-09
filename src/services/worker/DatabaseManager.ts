
import { Database } from 'bun:sqlite';
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { applySqliteBusyTimeout } from '../sqlite/connection.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { HelixManager } from '../sync/HelixManager.js';
import { HelixSync } from '../sync/HelixSync.js';
import type { VectorSync } from '../sync/VectorSync.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { resolveDbPath, resolveUserSettingsPath } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';
import type { HelixTransport } from '../../storage/helix/transport.js';

export class DatabaseManager {
  private db: Database | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: VectorSync | null = null;
  private helixManager: HelixManager | null = null;

  async initialize(): Promise<void> {
    this.db = applySqliteBusyTimeout(new Database(resolveDbPath()));
    
    this.sessionStore = new SessionStore(this.db);
    this.sessionSearch = new SessionSearch(this.db);

    const settings = SettingsDefaultsManager.loadFromFile(resolveUserSettingsPath());
    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    const helixEnabled = settings.CLAUDE_MEM_HELIX_ENABLED === 'true' || backend.includes('helix');
    if (helixEnabled) {
      this.helixManager = new HelixManager();
      this.chromaSync = new HelixSync('claude-mem', { manager: this.helixManager });
      logger.info('DB', 'Helix semantic search enabled', { backend })
    } else if (chromaEnabled) {
      this.chromaSync = new ChromaSync('claude-mem');
    } else {
      logger.info('DB', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using SQLite-only search');
    }

    logger.info('DB', 'Database initialized (shared connection)');
  }

  async close(): Promise<void> {
    this.chromaSync = null;
    await this.helixManager?.disconnect();
    this.helixManager = null;

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

  getChromaSync(): VectorSync | null {
    return this.chromaSync;
  }

  async getHelixTransport(): Promise<HelixTransport> {
    if (!this.helixManager) {
      this.helixManager = new HelixManager()
    }
    return await this.helixManager.getTransport()
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
