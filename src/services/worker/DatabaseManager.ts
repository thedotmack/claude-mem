/**
 * DatabaseManager: Unified storage management
 *
 * Responsibility:
 * - Manage storage connection for worker lifetime
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 *
 * Now uses memU/UnifiedStore via StoreManager compatibility layer.
 */

import { SessionStore, SessionSearch, ChromaSync, getSessionStore, getSessionSearch } from '../memu/StoreManager.js';
import { logger } from '../../utils/logger.js';

export class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;

  /**
   * Initialize storage connection (once, stays open)
   */
  async initialize(): Promise<void> {
    // Get singleton instances
    this.sessionStore = getSessionStore();
    this.sessionSearch = getSessionSearch();

    // Initialize the store (connects to memU API or local storage)
    await this.sessionStore.initialize();

    // ChromaSync is a no-op stub - memU handles vector search
    this.chromaSync = new ChromaSync('claude-memu');

    logger.info('DB', 'Database initialized (using memU storage)');
  }

  /**
   * Close storage connection and cleanup all resources
   */
  async close(): Promise<void> {
    // ChromaSync close is no-op
    if (this.chromaSync) {
      await this.chromaSync.close();
      this.chromaSync = null;
    }

    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
    if (this.sessionSearch) {
      this.sessionSearch.close();
      this.sessionSearch = null;
    }
    logger.info('DB', 'Database closed');
  }

  /**
   * Get SessionStore instance (throws if not initialized)
   */
  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  /**
   * Get SessionSearch instance (throws if not initialized)
   */
  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  /**
   * Get ChromaSync instance (throws if not initialized)
   */
  getChromaSync(): ChromaSync {
    if (!this.chromaSync) {
      throw new Error('ChromaSync not initialized');
    }
    return this.chromaSync;
  }

  /**
   * Get session by ID (throws if not found)
   */
  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }
}
