/**
 * WorkspaceDatabaseManager: Workspace-aware database connection manager
 *
 * Extends the original DatabaseManager pattern to support multiple isolated databases,
 * one per workspace. This enables complete data isolation between different clients
 * or organizational boundaries.
 *
 * Features:
 * - Lazy initialization of workspace databases (created on first access)
 * - Connection pooling per workspace
 * - Automatic routing based on cwd
 * - Graceful fallback to global database for unconfigured paths
 *
 * Usage:
 *   const dbManager = new WorkspaceDatabaseManager();
 *   await dbManager.initialize();
 *
 *   // Get database for a specific workspace
 *   const store = dbManager.getSessionStoreForWorkspace(cwd);
 *
 *   // Or use the default (global) database
 *   const globalStore = dbManager.getSessionStore();
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  getWorkspace,
  isWorkspaceIsolationEnabled,
  WorkspaceInfo
} from '../../utils/workspace.js';
import { WorkspacePaths } from '../../shared/paths-workspace.js';

/**
 * Workspace database connection bundle
 */
interface WorkspaceConnection {
  workspace: WorkspaceInfo;
  paths: WorkspacePaths;
  sessionStore: SessionStore;
  sessionSearch: SessionSearch;
  chromaSync: ChromaSync | null;
  lastAccessed: number;
}

export class WorkspaceDatabaseManager {
  /** Map of workspace name -> connection bundle */
  private connections: Map<string, WorkspaceConnection> = new Map();

  /** Global (default) connection for non-isolated workspaces */
  private globalConnection: WorkspaceConnection | null = null;

  /** Whether Chroma is enabled globally */
  private chromaEnabled: boolean = true;

  /**
   * Initialize the database manager
   * Sets up the global connection and prepares for workspace-specific connections
   */
  async initialize(): Promise<void> {
    // Load settings
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    this.chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';

    // Initialize global connection
    this.globalConnection = await this.createConnection(null);

    if (isWorkspaceIsolationEnabled()) {
      logger.info('DB', 'Workspace isolation ENABLED - databases will be isolated per workspace');
    } else {
      logger.info('DB', 'Workspace isolation disabled - using single global database');
    }
  }

  /**
   * Create a database connection for a workspace
   *
   * @param cwd - Current working directory (null for global)
   * @returns WorkspaceConnection bundle
   */
  private async createConnection(cwd: string | null): Promise<WorkspaceConnection> {
    const paths = new WorkspacePaths(cwd);
    const workspace = paths.workspace;

    // Ensure data directories exist
    paths.ensureAllDirs();

    logger.info('DB', `Creating database connection for workspace: ${workspace.name}`, {
      isolated: workspace.isolated,
      dbPath: paths.dbPath
    });

    // Create stores with workspace-specific paths
    const sessionStore = new SessionStore(paths.dbPath);
    const sessionSearch = new SessionSearch(paths.dbPath);

    // Initialize ChromaSync if enabled
    let chromaSync: ChromaSync | null = null;
    if (this.chromaEnabled) {
      // Use workspace-specific collection name to isolate vector data
      const collectionName = workspace.isolated
        ? `claude-mem-${workspace.name}`
        : 'claude-mem';
      chromaSync = new ChromaSync(collectionName);
    }

    return {
      workspace,
      paths,
      sessionStore,
      sessionSearch,
      chromaSync,
      lastAccessed: Date.now()
    };
  }

  /**
   * Get or create connection for a workspace based on cwd
   *
   * @param cwd - Current working directory
   * @returns WorkspaceConnection for the appropriate workspace
   */
  private async getOrCreateConnection(cwd: string | null | undefined): Promise<WorkspaceConnection> {
    // If no workspace isolation, always use global
    if (!isWorkspaceIsolationEnabled()) {
      if (!this.globalConnection) {
        throw new Error('Database not initialized');
      }
      return this.globalConnection;
    }

    const workspace = getWorkspace(cwd);

    // Non-isolated workspaces use global connection
    if (!workspace.isolated) {
      if (!this.globalConnection) {
        throw new Error('Database not initialized');
      }
      return this.globalConnection;
    }

    // Check if we already have a connection for this workspace
    const existing = this.connections.get(workspace.name);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing;
    }

    // Create new connection for this workspace
    const connection = await this.createConnection(cwd || null);
    this.connections.set(workspace.name, connection);

    logger.info('DB', `New workspace database initialized: ${workspace.name}`, {
      totalConnections: this.connections.size + 1 // +1 for global
    });

    return connection;
  }

  /**
   * Get SessionStore for a specific workspace
   *
   * @param cwd - Current working directory to determine workspace
   * @returns SessionStore for the appropriate workspace
   */
  async getSessionStoreForWorkspace(cwd: string | null | undefined): Promise<SessionStore> {
    const connection = await this.getOrCreateConnection(cwd);
    return connection.sessionStore;
  }

  /**
   * Get SessionSearch for a specific workspace
   *
   * @param cwd - Current working directory to determine workspace
   * @returns SessionSearch for the appropriate workspace
   */
  async getSessionSearchForWorkspace(cwd: string | null | undefined): Promise<SessionSearch> {
    const connection = await this.getOrCreateConnection(cwd);
    return connection.sessionSearch;
  }

  /**
   * Get ChromaSync for a specific workspace
   *
   * @param cwd - Current working directory to determine workspace
   * @returns ChromaSync for the appropriate workspace (or null if disabled)
   */
  async getChromaSyncForWorkspace(cwd: string | null | undefined): Promise<ChromaSync | null> {
    const connection = await this.getOrCreateConnection(cwd);
    return connection.chromaSync;
  }

  /**
   * Get the global SessionStore (backwards compatibility)
   *
   * @deprecated Use getSessionStoreForWorkspace(cwd) instead
   */
  getSessionStore(): SessionStore {
    if (!this.globalConnection) {
      throw new Error('Database not initialized');
    }
    return this.globalConnection.sessionStore;
  }

  /**
   * Get the global SessionSearch (backwards compatibility)
   *
   * @deprecated Use getSessionSearchForWorkspace(cwd) instead
   */
  getSessionSearch(): SessionSearch {
    if (!this.globalConnection) {
      throw new Error('Database not initialized');
    }
    return this.globalConnection.sessionSearch;
  }

  /**
   * Get the global ChromaSync (backwards compatibility)
   *
   * @deprecated Use getChromaSyncForWorkspace(cwd) instead
   */
  getChromaSync(): ChromaSync | null {
    return this.globalConnection?.chromaSync || null;
  }

  /**
   * Get workspace info for a cwd
   */
  getWorkspaceInfo(cwd: string | null | undefined): WorkspaceInfo {
    return getWorkspace(cwd);
  }

  /**
   * Check if workspace isolation is enabled
   */
  isIsolationEnabled(): boolean {
    return isWorkspaceIsolationEnabled();
  }

  /**
   * Get all active workspace connections (for monitoring/debugging)
   */
  getActiveWorkspaces(): string[] {
    const workspaces = ['global'];
    for (const name of this.connections.keys()) {
      workspaces.push(name);
    }
    return workspaces;
  }

  /**
   * Close all database connections
   */
  async close(): Promise<void> {
    // Close all workspace connections
    for (const [name, connection] of this.connections) {
      logger.debug('DB', `Closing workspace connection: ${name}`);
      if (connection.chromaSync) {
        await connection.chromaSync.close();
      }
      connection.sessionStore.close();
      connection.sessionSearch.close();
    }
    this.connections.clear();

    // Close global connection
    if (this.globalConnection) {
      logger.debug('DB', 'Closing global connection');
      if (this.globalConnection.chromaSync) {
        await this.globalConnection.chromaSync.close();
      }
      this.globalConnection.sessionStore.close();
      this.globalConnection.sessionSearch.close();
      this.globalConnection = null;
    }

    logger.info('DB', 'All database connections closed');
  }

  /**
   * Get session by ID from the appropriate workspace
   * Note: This requires knowing which workspace the session belongs to
   */
  async getSessionById(sessionDbId: number, cwd?: string): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  }> {
    const store = await this.getSessionStoreForWorkspace(cwd);
    const session = store.getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }
}
