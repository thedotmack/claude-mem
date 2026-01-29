/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage single database connection for worker lifetime
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 * - Sync provider integration (ChromaSync for free users, CloudSync for Pro)
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { CloudSync, ALL_PROJECTS_SENTINEL } from '../sync/CloudSync.js';
import { SyncProvider } from '../sync/SyncProvider.js';
import { loadProConfig, ProUserConfig } from '../pro/ProConfig.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;
  private syncProvider: SyncProvider | null = null;
  private proConfig: ProUserConfig | null = null;

  /**
   * Initialize database connection (once, stays open)
   */
  async initialize(): Promise<void> {
    // Open database connection (ONCE)
    this.sessionStore = new SessionStore();
    this.sessionSearch = new SessionSearch();

    // Check if user is Pro
    this.proConfig = loadProConfig();

    if (this.proConfig) {
      // Pro user: use CloudSync
      logger.info('DB', 'Pro user detected, initializing CloudSync', {
        userId: this.proConfig.userId.substring(0, 8) + '...',
        planTier: this.proConfig.planTier
      });

      // CloudSync project handling:
      // - Storage operations (storeObservationsAndSummary, storePrompt) receive project per-call
      // - ensureBackfilled() iterates ALL projects from local DB (ignores config.project)
      // - Fetch/query methods use config.project as default filter, but accept options.project override
      // - The default project here is a fallback for methods that don't specify one
      this.syncProvider = new CloudSync({
        apiUrl: this.proConfig.apiUrl,
        setupToken: this.proConfig.setupToken,
        userId: this.proConfig.userId,
        project: ALL_PROJECTS_SENTINEL // Explicit sentinel value; methods should pass project explicitly
      });

      // Also keep ChromaSync for local fallback (optional)
      this.chromaSync = new ChromaSync('claude-mem');
    } else {
      // Free user: use ChromaSync (local only)
      logger.info('DB', 'Free user, initializing ChromaSync (local)');
      this.chromaSync = new ChromaSync('claude-mem');
      this.syncProvider = null;
    }

    logger.info('DB', 'Database initialized', {
      mode: this.proConfig ? 'pro' : 'free'
    });
  }

  /**
   * Check if user is Pro
   */
  isProUser(): boolean {
    return this.proConfig !== null;
  }

  /**
   * Get Pro config (null if not Pro)
   */
  getProConfig(): ProUserConfig | null {
    return this.proConfig;
  }

  /**
   * Close database connection and cleanup all resources
   */
  async close(): Promise<void> {
    // Close sync providers first
    if (this.syncProvider) {
      await this.syncProvider.close();
      this.syncProvider = null;
    }

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

    this.proConfig = null;
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
   * Get SyncProvider instance (CloudSync for Pro, ChromaSync for free)
   * Returns null if no sync provider is configured
   */
  getSyncProvider(): SyncProvider | null {
    return this.syncProvider;
  }

  /**
   * Get the active sync provider or fall back to ChromaSync
   * Use this for operations that should work in both modes
   */
  getActiveSyncProvider(): SyncProvider {
    if (this.syncProvider) {
      return this.syncProvider;
    }
    if (this.chromaSync) {
      // ChromaSync implements SyncProvider interface via duck typing
      // For explicit typing, we wrap it
      return this.chromaSync as unknown as SyncProvider;
    }
    throw new Error('No sync provider available');
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
