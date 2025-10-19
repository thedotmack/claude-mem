import { 
  createStores, 
  SessionStore, 
  MemoryStore, 
  OverviewStore, 
  DiagnosticsStore,
  SessionInput,
  MemoryInput,
  OverviewInput,
  DiagnosticInput,
  SessionRow,
  MemoryRow,
  OverviewRow,
  DiagnosticRow,
  normalizeTimestamp
} from '../services/sqlite/index.js';

/**
 * Storage backend types
 */
export type StorageBackend = 'sqlite' | 'jsonl';

/**
 * Unified interface for storage operations
 */
export interface IStorageProvider {
  backend: StorageBackend;
  
  // Session operations
  createSession(session: SessionInput): Promise<SessionRow | void>;
  getSession(sessionId: string): Promise<SessionRow | null>;
  hasSession(sessionId: string): Promise<boolean>;
  getAllSessionIds(): Promise<Set<string>>;
  getRecentSessions(limit?: number): Promise<SessionRow[]>;
  getRecentSessionsForProject(project: string, limit?: number): Promise<SessionRow[]>;
  
  // Memory operations
  createMemory(memory: MemoryInput): Promise<MemoryRow | void>;
  createMemories(memories: MemoryInput[]): Promise<void>;
  getRecentMemories(limit?: number): Promise<MemoryRow[]>;
  getRecentMemoriesForProject(project: string, limit?: number): Promise<MemoryRow[]>;
  hasDocumentId(documentId: string): Promise<boolean>;
  
  // Overview operations
  createOverview(overview: OverviewInput): Promise<OverviewRow | void>;
  upsertOverview(overview: OverviewInput): Promise<OverviewRow | void>;
  getRecentOverviews(limit?: number): Promise<OverviewRow[]>;
  getRecentOverviewsForProject(project: string, limit?: number): Promise<OverviewRow[]>;
  
  // Diagnostic operations
  createDiagnostic(diagnostic: DiagnosticInput): Promise<DiagnosticRow | void>;
  
  // Health check
  isAvailable(): Promise<boolean>;
}

/**
 * SQLite-based storage provider
 */
export class SQLiteStorageProvider implements IStorageProvider {
  public readonly backend = 'sqlite';
  
  private stores?: {
    sessions: SessionStore;
    memories: MemoryStore;
    overviews: OverviewStore;
    diagnostics: DiagnosticsStore;
  };

  private async getStores() {
    if (!this.stores) {
      this.stores = await createStores();
    }
    return this.stores;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getStores();
      return true;
    } catch (error) {
      return false;
    }
  }

  async createSession(session: SessionInput): Promise<SessionRow> {
    const stores = await this.getStores();
    return stores.sessions.create(session);
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const stores = await this.getStores();
    return stores.sessions.getBySessionId(sessionId);
  }

  async hasSession(sessionId: string): Promise<boolean> {
    const stores = await this.getStores();
    return stores.sessions.has(sessionId);
  }

  async getAllSessionIds(): Promise<Set<string>> {
    const stores = await this.getStores();
    return stores.sessions.getAllSessionIds();
  }

  async getRecentSessions(limit = 5): Promise<SessionRow[]> {
    const stores = await this.getStores();
    return stores.sessions.getRecent(limit);
  }

  async getRecentSessionsForProject(project: string, limit = 5): Promise<SessionRow[]> {
    const stores = await this.getStores();
    return stores.sessions.getRecentForProject(project, limit);
  }

  async createMemory(memory: MemoryInput): Promise<MemoryRow> {
    const stores = await this.getStores();
    return stores.memories.create(memory);
  }

  async createMemories(memories: MemoryInput[]): Promise<void> {
    const stores = await this.getStores();
    stores.memories.createMany(memories);
  }

  async getRecentMemories(limit = 10): Promise<MemoryRow[]> {
    const stores = await this.getStores();
    return stores.memories.getRecent(limit);
  }

  async getRecentMemoriesForProject(project: string, limit = 10): Promise<MemoryRow[]> {
    const stores = await this.getStores();
    return stores.memories.getRecentForProject(project, limit);
  }

  async hasDocumentId(documentId: string): Promise<boolean> {
    const stores = await this.getStores();
    return stores.memories.hasDocumentId(documentId);
  }

  async createOverview(overview: OverviewInput): Promise<OverviewRow> {
    const stores = await this.getStores();
    return stores.overviews.create(overview);
  }

  async upsertOverview(overview: OverviewInput): Promise<OverviewRow> {
    const stores = await this.getStores();
    return stores.overviews.upsert(overview);
  }

  async getRecentOverviews(limit = 5): Promise<OverviewRow[]> {
    const stores = await this.getStores();
    return stores.overviews.getRecent(limit);
  }

  async getRecentOverviewsForProject(project: string, limit = 5): Promise<OverviewRow[]> {
    const stores = await this.getStores();
    return stores.overviews.getRecentForProject(project, limit);
  }

  async createDiagnostic(diagnostic: DiagnosticInput): Promise<DiagnosticRow> {
    const stores = await this.getStores();
    return stores.diagnostics.create(diagnostic);
  }
}


/**
 * Storage provider singleton
 */
let storageProvider: IStorageProvider | null = null;

/**
 * Get the configured storage provider (always SQLite)
 */
export async function getStorageProvider(): Promise<IStorageProvider> {
  if (storageProvider) {
    return storageProvider;
  }

  const sqliteProvider = new SQLiteStorageProvider();
  if (await sqliteProvider.isAvailable()) {
    storageProvider = sqliteProvider;
    return storageProvider;
  }

  throw new Error('SQLite storage backend unavailable');
}