/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage single database connection for worker lifetime
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 * - ChromaSync integration
 * 
 * ## ChromaSync Lifecycle (CRITICAL)
 * 
 * ChromaSync is instantiated ONCE per worker process:
 * - Created in initialize() 
 * - Lives until close() on worker shutdown
 * - NO new instances created between operations
 * 
 * MCP Connection Pattern:
 * - First Chroma operation spawns uvx chroma-mcp subprocess
 * - Subsequent operations reuse the same connection
 * - Connection closed only on worker shutdown
 * - See docs/architecture/mcp-connection-lifecycle.md for details
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;

  /**
   * Initialize database connection (once, stays open)
   * 
   * Creates singleton instances of:
   * - SessionStore (SQLite database)
   * - SessionSearch (SQLite FTS5)
   * - ChromaSync (MCP client for vector search)
   * 
   * ChromaSync note: The MCP connection to chroma-mcp is NOT established here.
   * The uvx subprocess is spawned lazily on first search/sync operation.
   * After that, the connection persists for all subsequent operations.
   */
  async initialize(): Promise<void> {
    // Open database connection (ONCE)
    this.sessionStore = new SessionStore();
    this.sessionSearch = new SessionSearch();

    // Initialize ChromaSync (lazy - connects on first search, not at startup)
    // This creates the ChromaSync instance but doesn't spawn uvx yet
    this.chromaSync = new ChromaSync('claude-mem');

    logger.info('DB', 'Database initialized');
  }

  /**
   * Close database connection and cleanup all resources
   * 
   * Called ONLY on worker shutdown. Terminates:
   * - ChromaSync MCP connection + uvx subprocess
   * - SQLite database connections
   * 
   * This is the ONLY place where chromaSync.close() should be called.
   */
  async close(): Promise<void> {
    // Close ChromaSync first (terminates uvx/python processes)
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

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // Worker restarts don't make sessions orphaned. Sessions are managed by hooks
  // and exist independently of worker state.

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
