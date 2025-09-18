import fs from 'fs';
import { PathDiscovery } from '../services/path-discovery.js';
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
 * JSONL-based storage provider (legacy fallback)
 */
export class JSONLStorageProvider implements IStorageProvider {
  public readonly backend = 'jsonl';

  private pathDiscovery = PathDiscovery.getInstance();

  async isAvailable(): Promise<boolean> {
    try {
      // Ensure data directory exists
      const dataDir = this.pathDiscovery.getDataDirectory();
      fs.mkdirSync(dataDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private appendToIndex(obj: any): void {
    const indexPath = this.pathDiscovery.getIndexPath();
    fs.appendFileSync(indexPath, JSON.stringify(obj) + '\\n', 'utf8');
  }

  async createSession(session: SessionInput): Promise<void> {
    const sessionRecord = {
      type: 'session',
      session_id: session.session_id,
      project: session.project,
      timestamp: session.created_at
    };
    this.appendToIndex(sessionRecord);
  }

  async getSession(): Promise<null> {
    // Not supported in JSONL mode
    return null;
  }

  async hasSession(sessionId: string): Promise<boolean> {
    const sessionIds = await this.getAllSessionIds();
    return sessionIds.has(sessionId);
  }

  async getAllSessionIds(): Promise<Set<string>> {
    const indexPath = this.pathDiscovery.getIndexPath();
    if (!fs.existsSync(indexPath)) {
      return new Set();
    }

    const content = fs.readFileSync(indexPath, 'utf-8');
    const lines = content.trim().split('\\n').filter(line => line.trim());
    const sessionIds = new Set<string>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.session_id) {
          sessionIds.add(obj.session_id);
        }
      } catch {
        // Skip malformed JSON
      }
    }

    return sessionIds;
  }

  async getRecentSessions(): Promise<SessionRow[]> {
    // Not fully supported in JSONL mode - return empty array
    return [];
  }

  async getRecentSessionsForProject(): Promise<SessionRow[]> {
    // Not fully supported in JSONL mode - return empty array
    return [];
  }

  async createMemory(memory: MemoryInput): Promise<void> {
    const memoryRecord = {
      type: 'memory',
      text: memory.text,
      document_id: memory.document_id,
      keywords: memory.keywords,
      session_id: memory.session_id,
      project: memory.project,
      timestamp: memory.created_at,
      archive: memory.archive_basename
    };
    this.appendToIndex(memoryRecord);
  }

  async createMemories(memories: MemoryInput[]): Promise<void> {
    for (const memory of memories) {
      await this.createMemory(memory);
    }
  }

  async getRecentMemories(): Promise<MemoryRow[]> {
    // Not fully supported in JSONL mode - return empty array
    return [];
  }

  async getRecentMemoriesForProject(): Promise<MemoryRow[]> {
    // Not fully supported in JSONL mode - return empty array
    return [];
  }

  async hasDocumentId(documentId: string): Promise<boolean> {
    const indexPath = this.pathDiscovery.getIndexPath();
    if (!fs.existsSync(indexPath)) {
      return false;
    }

    const content = fs.readFileSync(indexPath, 'utf-8');
    const lines = content.trim().split('\\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'memory' && obj.document_id === documentId) {
          return true;
        }
      } catch {
        // Skip malformed JSON
      }
    }

    return false;
  }

  async createOverview(overview: OverviewInput): Promise<void> {
    const overviewRecord = {
      type: 'overview',
      content: overview.content,
      session_id: overview.session_id,
      project: overview.project,
      timestamp: overview.created_at
    };
    this.appendToIndex(overviewRecord);
  }

  async upsertOverview(overview: OverviewInput): Promise<void> {
    // Just append in JSONL mode (no real upsert)
    await this.createOverview(overview);
  }

  async getRecentOverviews(): Promise<OverviewRow[]> {
    // Not fully supported in JSONL mode - return empty array
    return [];
  }

  async getRecentOverviewsForProject(): Promise<OverviewRow[]> {
    // Not fully supported in JSONL mode - return empty array
    return [];
  }

  async createDiagnostic(diagnostic: DiagnosticInput): Promise<void> {
    const diagnosticRecord = {
      type: 'diagnostic',
      message: diagnostic.message,
      session_id: diagnostic.session_id,
      project: diagnostic.project,
      timestamp: diagnostic.created_at
    };
    this.appendToIndex(diagnosticRecord);
  }
}

/**
 * Storage provider factory and singleton
 */
let storageProvider: IStorageProvider | null = null;

/**
 * Get the configured storage provider
 */
export async function getStorageProvider(): Promise<IStorageProvider> {
  if (storageProvider) {
    return storageProvider;
  }

  // Try SQLite first
  const sqliteProvider = new SQLiteStorageProvider();
  if (await sqliteProvider.isAvailable()) {
    storageProvider = sqliteProvider;
    return storageProvider;
  }

  // Fall back to JSONL
  const jsonlProvider = new JSONLStorageProvider();
  if (await jsonlProvider.isAvailable()) {
    storageProvider = jsonlProvider;
    return storageProvider;
  }

  throw new Error('No storage backend available');
}

/**
 * Force a specific storage provider (useful for testing)
 */
export function setStorageProvider(provider: IStorageProvider): void {
  storageProvider = provider;
}

/**
 * Check if SQLite migration is needed
 */
export async function needsMigration(): Promise<boolean> {
  const pathDiscovery = PathDiscovery.getInstance();
  const indexPath = pathDiscovery.getIndexPath();
  
  // If JSONL exists but SQLite is not available, migration is needed
  if (fs.existsSync(indexPath)) {
    const sqliteProvider = new SQLiteStorageProvider();
    const sqliteAvailable = await sqliteProvider.isAvailable();
    
    if (!sqliteAvailable) {
      return true;
    }
    
    // Check if SQLite has data
    try {
      const stores = await createStores();
      const sessionCount = stores.sessions.count();
      return sessionCount === 0; // Needs migration if SQLite is empty
    } catch {
      return true;
    }
  }
  
  return false;
}