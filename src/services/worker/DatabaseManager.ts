/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage single database connection for worker lifetime
 * - Support both SQLite and MySQL backends (dynamic selection)
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 * - ChromaSync integration
 */

import { getDatabaseType, createDatabaseBackend, isMySQLConfigured } from '../db/index.js';
import { getMySQLConfig } from '../mysql/Database.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

// Use any for dynamic backend dispatch - actual methods depend on backend

export class DatabaseManager {
  private sessionStore: any = null;
  private sessionSearch: any = null;
  private chromaSync: ChromaSync | null = null;
  private pendingMessageStore: any = null;
  private databaseType: 'sqlite' | 'mysql' = 'sqlite';
  private db: any = null;

  async initialize(): Promise<void> {
    this.databaseType = getDatabaseType();
    logger.info('DB', `Initializing database with backend: ${this.databaseType}`);

    const backend = await createDatabaseBackend();

    if (this.databaseType === 'mysql') {
      const MySQLSessionStore = backend.SessionStore;
      const MySQLSessionSearch = backend.SessionSearch;

      const config = getMySQLConfig();
      const { MySQLDatabase } = await import('../mysql/Database.js');
      this.db = new MySQLDatabase(config);

      this.sessionStore = new MySQLSessionStore(this.db);
      if (typeof (this.sessionStore as any).initialize === 'function') {
        await (this.sessionStore as any).initialize();
      }

      this.sessionSearch = new MySQLSessionSearch(this.db);

      logger.info('DB', `MySQL database initialized: ${config.host}:${config.port}/${config.database}`);
    } else {
      const { ClaudeMemDatabase } = await import('../sqlite/Database.js');
      this.db = new ClaudeMemDatabase();

      this.sessionStore = new backend.SessionStore(this.db);
      this.sessionSearch = new backend.SessionSearch(this.db);

      logger.info('DB', 'SQLite database initialized');
    }

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    if (chromaEnabled) {
      this.chromaSync = new ChromaSync('claude-mem');
    } else {
      logger.info('DB', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using SQLite-only search');
    }

    logger.info('DB', 'Database initialized');
  }

  async close(): Promise<void> {
    if (this.chromaSync) {
      await this.chromaSync.close();
      this.chromaSync = null;
    }

    if (this.sessionStore) {
      await this.sessionStore.close();
      this.sessionStore = null;
    }

    if (this.sessionSearch) {
      await this.sessionSearch.close();
      this.sessionSearch = null;
    }

    if (this.db && typeof this.db.close === 'function') {
      this.db.close();
      this.db = null;
    }

    logger.info('DB', 'Database closed');
  }

  getSessionStore(): any {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  getSessionSearch(): any {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  getDb(): any {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  getConnection(): any {
    return this.getDb();
  }

  getChromaSync(): ChromaSync | null {
    return this.chromaSync;
  }

  getDatabaseType(): 'sqlite' | 'mysql' {
    return this.databaseType;
  }

  isMySQL(): boolean {
    return this.databaseType === 'mysql';
  }

  async getSessionByIdAsync(sessionDbId: number): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    status: string;
  }> {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }

    let session: any;
    if (this.databaseType === 'mysql') {
      session = await this.sessionStore.getSessionById(sessionDbId);
    } else {
      session = this.sessionStore.getSessionById(sessionDbId);
    }

    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
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
    if (this.databaseType === 'mysql') {
      throw new Error('getSessionById is not supported for MySQL - use getSessionByIdAsync');
    }

    const session = this.sessionStore!.getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }
}
