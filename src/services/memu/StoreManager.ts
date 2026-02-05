/**
 * StoreManager
 *
 * Compatibility layer providing legacy SessionStore/SessionSearch interfaces
 * backed by the new UnifiedStore. This allows the existing codebase to work
 * with minimal changes during the migration to memU.
 */

import type {
  Session,
  StoredObservation,
  StoredSummary,
  StoredUserPrompt,
  SearchQuery,
  SearchResults,
  Observation,
  Summary,
  UserPrompt,
} from './types.js';
import { UnifiedStore, getStore, initializeStore } from './UnifiedStore.js';
import { logger } from '../../utils/logger.js';

/**
 * Legacy-compatible SessionStore interface
 * Wraps UnifiedStore to provide the old interface expected by existing code
 */
export class SessionStore {
  private store: UnifiedStore;

  constructor() {
    this.store = getStore();
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  close(): void {
    // No-op for compatibility - UnifiedStore manages lifecycle
  }

  // Session operations (return legacy format)
  async createSession(contentSessionId: string, project: string, userPrompt: string): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  }> {
    const session = await this.store.createSession(contentSessionId, project, userPrompt);
    return {
      id: session.id,
      content_session_id: session.contentSessionId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
    };
  }

  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  } | null {
    const session = this.store.getSession(sessionDbId);
    if (!session) return null;
    return {
      id: session.id,
      content_session_id: session.contentSessionId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
    };
  }

  getSessionByContentId(contentSessionId: string): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  } | null {
    const session = this.store.getSessionByContentId(contentSessionId);
    if (!session) return null;
    return {
      id: session.id,
      content_session_id: session.contentSessionId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
    };
  }

  updateMemorySessionId(sessionId: number, memorySessionId: string): void {
    this.store.updateMemorySessionId(sessionId, memorySessionId);
  }

  incrementPromptCounter(sessionId: number): number {
    return this.store.incrementPromptCounter(sessionId);
  }

  // Observation operations
  async storeObservation(
    memorySessionId: string,
    project: string,
    observation: Observation
  ): Promise<StoredObservation> {
    return this.store.storeObservation(memorySessionId, project, observation);
  }

  async getObservationById(id: string): Promise<StoredObservation | null> {
    return this.store.getObservation(id);
  }

  async getRecentObservations(project: string, limit?: number): Promise<StoredObservation[]> {
    return this.store.getRecentObservations(project, limit);
  }

  // Summary operations
  async storeSummary(
    memorySessionId: string,
    project: string,
    summary: Summary
  ): Promise<StoredSummary> {
    return this.store.storeSummary(memorySessionId, project, summary);
  }

  async getSummaryForSession(memorySessionId: string): Promise<StoredSummary | null> {
    return this.store.getSummary(memorySessionId);
  }

  async getRecentSummaries(project: string, limit?: number): Promise<StoredSummary[]> {
    return this.store.getRecentSummaries(project, limit);
  }

  // User prompt operations
  async storeUserPrompt(prompt: UserPrompt): Promise<StoredUserPrompt> {
    return this.store.storeUserPrompt(prompt);
  }

  // Project operations
  async getAllProjects(): Promise<string[]> {
    return this.store.getAllProjects();
  }

  // Stats (simplified)
  getStats(): { observations: number; summaries: number; prompts: number; sessions: number } {
    // Return placeholder stats - actual implementation would need to track counts
    return { observations: 0, summaries: 0, prompts: 0, sessions: 0 };
  }

  // Compatibility getter for db (returns null - not applicable for memU)
  get db(): null {
    return null;
  }
}

/**
 * Legacy-compatible SessionSearch interface
 * Wraps UnifiedStore search capabilities
 */
export class SessionSearch {
  private store: UnifiedStore;

  constructor() {
    this.store = getStore();
  }

  close(): void {
    // No-op for compatibility
  }

  async search(query: SearchQuery): Promise<SearchResults> {
    return this.store.search(query);
  }

  async searchObservations(text: string, project?: string, limit?: number): Promise<StoredObservation[]> {
    const results = await this.store.search({ text, project, limit });
    return results.observations;
  }

  async searchSummaries(text: string, project?: string, limit?: number): Promise<StoredSummary[]> {
    const results = await this.store.search({ text, project, limit });
    return results.summaries;
  }
}

/**
 * PendingMessageStore stub
 * Provides minimal interface for pending message queue (simplified for memU)
 */
export class PendingMessageStore {
  private pendingMessages: Map<number, Array<{ id: string; content: string; status: string }>> = new Map();

  constructor(_db?: unknown, _maxRetries?: number) {
    // Ignore db parameter - we use in-memory storage
  }

  getSessionsWithPendingMessages(): number[] {
    const sessions: number[] = [];
    for (const [sessionId, messages] of this.pendingMessages) {
      if (messages.some(m => m.status === 'pending')) {
        sessions.push(sessionId);
      }
    }
    return sessions;
  }

  getPendingCount(sessionId: number): number {
    const messages = this.pendingMessages.get(sessionId) || [];
    return messages.filter(m => m.status === 'pending').length;
  }

  resetStuckMessages(_thresholdMs: number): number {
    // No-op - simplified implementation
    return 0;
  }

  addMessage(sessionId: number, content: string): string {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (!this.pendingMessages.has(sessionId)) {
      this.pendingMessages.set(sessionId, []);
    }
    this.pendingMessages.get(sessionId)!.push({ id, content, status: 'pending' });
    return id;
  }

  markProcessed(sessionId: number, messageId: string): void {
    const messages = this.pendingMessages.get(sessionId);
    if (messages) {
      const msg = messages.find(m => m.id === messageId);
      if (msg) msg.status = 'processed';
    }
  }

  clearAll(sessionId: number): void {
    this.pendingMessages.delete(sessionId);
  }
}

/**
 * ChromaSync stub
 * No-op implementation since memU handles vector search internally
 */
export class ChromaSync {
  constructor(_collectionName?: string) {}

  async close(): Promise<void> {
    // No-op
  }

  async search(_query: string, _limit?: number): Promise<unknown[]> {
    return [];
  }

  async add(_content: string, _metadata?: Record<string, unknown>): Promise<void> {
    // No-op - memU handles embeddings
  }
}

// Singleton instances
let sessionStoreInstance: SessionStore | null = null;
let sessionSearchInstance: SessionSearch | null = null;

export function getSessionStore(): SessionStore {
  if (!sessionStoreInstance) {
    sessionStoreInstance = new SessionStore();
  }
  return sessionStoreInstance;
}

export function getSessionSearch(): SessionSearch {
  if (!sessionSearchInstance) {
    sessionSearchInstance = new SessionSearch();
  }
  return sessionSearchInstance;
}

export async function initializeStores(): Promise<{ store: SessionStore; search: SessionSearch }> {
  const store = getSessionStore();
  await store.initialize();
  return { store, search: getSessionSearch() };
}
