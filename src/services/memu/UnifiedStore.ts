/**
 * UnifiedStore
 *
 * Unified storage interface that automatically chooses between:
 * - MemuStore (API mode) when CLAUDE_MEMU_API_KEY is configured
 * - LocalStore (local mode) when no API key is provided
 *
 * This allows claude-memu to run fully locally without requiring a memU API key.
 */

import type {
  Session,
  Observation,
  StoredObservation,
  Summary,
  StoredSummary,
  UserPrompt,
  StoredUserPrompt,
  SearchQuery,
  SearchResults,
  ContextPayload,
  MemuConfig,
} from './types.js';
import { MemuStore } from './MemuStore.js';
import { LocalStore } from './LocalStore.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

export type StoreMode = 'api' | 'local';

/**
 * IStore interface - common interface for both MemuStore and LocalStore
 */
export interface IStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;

  // Session management
  createSession(contentSessionId: string, project: string, userPrompt: string): Promise<Session>;
  getSession(sessionId: number): Session | null;
  getSessionByContentId(contentSessionId: string): Session | null;
  updateMemorySessionId(sessionId: number, memorySessionId: string): void;
  incrementPromptCounter(sessionId: number): number;

  // Observation storage
  storeObservation(memorySessionId: string, project: string, observation: Observation): Promise<StoredObservation>;
  getObservation(id: string): Promise<StoredObservation | null>;
  getRecentObservations(project: string, limit?: number): Promise<StoredObservation[]>;

  // Summary storage
  storeSummary(memorySessionId: string, project: string, summary: Summary): Promise<StoredSummary>;
  getSummary(memorySessionId: string): Promise<StoredSummary | null>;
  getRecentSummaries(project: string, limit?: number): Promise<StoredSummary[]>;

  // User prompt storage
  storeUserPrompt(prompt: UserPrompt): Promise<StoredUserPrompt>;

  // Search
  search(query: SearchQuery): Promise<SearchResults>;

  // Context injection
  getContextForProject(project: string, limit?: number): Promise<ContextPayload>;

  // Project management
  getAllProjects(): Promise<string[]>;
}

/**
 * UnifiedStore - Auto-selecting storage wrapper
 */
export class UnifiedStore implements IStore {
  private store: IStore;
  private mode: StoreMode;

  constructor(config?: Partial<MemuConfig>) {
    // Determine mode based on API key availability
    const apiKey = config?.apiKey || SettingsDefaultsManager.getWithEnv('CLAUDE_MEMU_API_KEY');

    if (apiKey && apiKey.trim() !== '') {
      this.mode = 'api';
      this.store = new MemuStore(config);
      logger.info('STORE', 'Using API mode (memU cloud/self-hosted)');
    } else {
      this.mode = 'local';
      this.store = new LocalStore();
      logger.info('STORE', 'Using local mode (file-based storage)');
    }
  }

  /**
   * Get the current storage mode
   */
  getMode(): StoreMode {
    return this.mode;
  }

  /**
   * Check if using local storage
   */
  isLocalMode(): boolean {
    return this.mode === 'local';
  }

  /**
   * Check if using API storage
   */
  isApiMode(): boolean {
    return this.mode === 'api';
  }

  // ============================================================================
  // Delegate all methods to underlying store
  // ============================================================================

  async initialize(): Promise<void> {
    return this.store.initialize();
  }

  async close(): Promise<void> {
    return this.store.close();
  }

  isReady(): boolean {
    return this.store.isReady();
  }

  async createSession(contentSessionId: string, project: string, userPrompt: string): Promise<Session> {
    return this.store.createSession(contentSessionId, project, userPrompt);
  }

  getSession(sessionId: number): Session | null {
    return this.store.getSession(sessionId);
  }

  getSessionByContentId(contentSessionId: string): Session | null {
    return this.store.getSessionByContentId(contentSessionId);
  }

  updateMemorySessionId(sessionId: number, memorySessionId: string): void {
    return this.store.updateMemorySessionId(sessionId, memorySessionId);
  }

  incrementPromptCounter(sessionId: number): number {
    return this.store.incrementPromptCounter(sessionId);
  }

  async storeObservation(memorySessionId: string, project: string, observation: Observation): Promise<StoredObservation> {
    return this.store.storeObservation(memorySessionId, project, observation);
  }

  async getObservation(id: string): Promise<StoredObservation | null> {
    return this.store.getObservation(id);
  }

  async getRecentObservations(project: string, limit?: number): Promise<StoredObservation[]> {
    return this.store.getRecentObservations(project, limit);
  }

  async storeSummary(memorySessionId: string, project: string, summary: Summary): Promise<StoredSummary> {
    return this.store.storeSummary(memorySessionId, project, summary);
  }

  async getSummary(memorySessionId: string): Promise<StoredSummary | null> {
    return this.store.getSummary(memorySessionId);
  }

  async getRecentSummaries(project: string, limit?: number): Promise<StoredSummary[]> {
    return this.store.getRecentSummaries(project, limit);
  }

  async storeUserPrompt(prompt: UserPrompt): Promise<StoredUserPrompt> {
    return this.store.storeUserPrompt(prompt);
  }

  async search(query: SearchQuery): Promise<SearchResults> {
    return this.store.search(query);
  }

  async getContextForProject(project: string, limit?: number): Promise<ContextPayload> {
    return this.store.getContextForProject(project, limit);
  }

  async getAllProjects(): Promise<string[]> {
    return this.store.getAllProjects();
  }
}

// Singleton instance
let unifiedStoreInstance: UnifiedStore | null = null;

/**
 * Get or create the unified store instance
 */
export function getStore(config?: Partial<MemuConfig>): UnifiedStore {
  if (!unifiedStoreInstance) {
    unifiedStoreInstance = new UnifiedStore(config);
  }
  return unifiedStoreInstance;
}

/**
 * Initialize and return the unified store
 */
export async function initializeStore(config?: Partial<MemuConfig>): Promise<UnifiedStore> {
  const store = getStore(config);
  await store.initialize();
  return store;
}

/**
 * Reset the store instance (useful for testing)
 */
export function resetStore(): void {
  if (unifiedStoreInstance) {
    unifiedStoreInstance.close();
    unifiedStoreInstance = null;
  }
}
