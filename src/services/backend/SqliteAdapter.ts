/**
 * SQLite Storage Adapter
 *
 * Implements IStorageBackend wrapping the legacy SQLite-based storage.
 * Provides backwards compatibility during migration to memU.
 */

import type {
  IStorageBackend,
  SessionRef,
  SessionRecord,
  ExtractedMemory,
  StoredMemory,
  SessionSummary,
  StoredSummary,
  UserPrompt,
  StoredUserPrompt,
  MemoryQuery,
  SearchQuery,
} from '../../interfaces/IStorageBackend.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { logger } from '../../utils/logger.js';

export class SqliteAdapter implements IStorageBackend {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private ready: boolean = false;

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    try {
      this.sessionStore = new SessionStore();
      this.sessionSearch = new SessionSearch();
      this.ready = true;
      logger.info('SQLITE', 'SQLite adapter initialized');
    } catch (error) {
      logger.error('SQLITE', 'Failed to initialize SQLite adapter', {}, error as Error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
    if (this.sessionSearch) {
      this.sessionSearch.close();
      this.sessionSearch = null;
    }
    this.ready = false;
    logger.info('SQLITE', 'SQLite adapter closed');
  }

  isReady(): boolean {
    return this.ready;
  }

  private getStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('SQLite adapter not initialized');
    }
    return this.sessionStore;
  }

  private getSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('SQLite adapter not initialized');
    }
    return this.sessionSearch;
  }

  // ============================================================================
  // Session CRUD
  // ============================================================================

  async createSession(
    contentSessionId: string,
    project: string,
    userPrompt: string
  ): Promise<SessionRef> {
    const sessionDbId = this.getStore().createSDKSession(contentSessionId, project, userPrompt);

    return {
      sessionDbId,
      contentSessionId,
      memorySessionId: null,
      project,
      userPrompt,
    };
  }

  async getSessionById(sessionId: number): Promise<SessionRecord | null> {
    const session = this.getStore().getSessionById(sessionId);
    if (!session) return null;

    return {
      id: session.id,
      contentSessionId: session.content_session_id,
      memorySessionId: session.memory_session_id,
      project: session.project,
      userPrompt: session.user_prompt,
      createdAt: new Date().toISOString(), // Not stored in legacy format
    };
  }

  async getSessionByContentId(contentSessionId: string): Promise<SessionRecord | null> {
    // Use the search to find by content session ID
    const sessions = this.getStore().getSdkSessionsBySessionIds([]);
    // This is inefficient - legacy doesn't have a direct lookup
    // Would need to add a method to SessionStore
    return null;
  }

  async updateMemorySessionId(
    sessionDbId: number,
    memorySessionId: string
  ): Promise<void> {
    this.getStore().updateMemorySessionId(sessionDbId, memorySessionId);
  }

  // ============================================================================
  // Memory/Observation CRUD
  // ============================================================================

  async storeMemory(
    memorySessionId: string,
    project: string,
    memory: ExtractedMemory
  ): Promise<StoredMemory> {
    const result = this.getStore().storeObservation(
      memorySessionId,
      project,
      {
        type: memory.type,
        title: memory.title,
        subtitle: memory.subtitle,
        facts: memory.facts,
        narrative: memory.narrative,
        concepts: memory.concepts,
        files_read: memory.filesRead,
        files_modified: memory.filesModified,
      },
      memory.promptNumber
    );

    return {
      id: result.id,
      memorySessionId,
      project,
      type: memory.type,
      title: memory.title,
      subtitle: memory.subtitle,
      facts: memory.facts,
      narrative: memory.narrative,
      concepts: memory.concepts,
      filesRead: memory.filesRead,
      filesModified: memory.filesModified,
      promptNumber: memory.promptNumber,
      createdAt: new Date(result.createdAtEpoch).toISOString(),
      createdAtEpoch: result.createdAtEpoch,
    };
  }

  async getMemoryById(id: number | string): Promise<StoredMemory | null> {
    const obs = this.getStore().getObservationById(Number(id));
    if (!obs) return null;

    return this.observationRecordToStoredMemory(obs);
  }

  async getMemoriesBySessionId(
    memorySessionId: string,
    options?: MemoryQuery
  ): Promise<StoredMemory[]> {
    const observations = this.getStore().getObservationsForSession(memorySessionId);
    // This returns a limited set of fields, so we need full records
    // For now, return mapped data
    return observations.map((obs, index) => ({
      id: index,
      memorySessionId,
      project: '',
      type: obs.type as any,
      title: obs.title || null,
      subtitle: obs.subtitle || null,
      facts: [],
      narrative: null,
      concepts: [],
      filesRead: [],
      filesModified: [],
      promptNumber: obs.prompt_number || undefined,
      createdAt: new Date().toISOString(),
      createdAtEpoch: Date.now(),
    }));
  }

  async getRecentMemories(project: string, limit: number): Promise<StoredMemory[]> {
    const observations = this.getStore().getRecentObservations(project, limit);
    return observations.map((obs, index) => ({
      id: index,
      memorySessionId: '',
      project,
      type: obs.type as any,
      title: null,
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      filesRead: [],
      filesModified: [],
      text: obs.text,
      promptNumber: obs.prompt_number || undefined,
      createdAt: obs.created_at,
      createdAtEpoch: new Date(obs.created_at).getTime(),
    }));
  }

  // ============================================================================
  // Summary CRUD
  // ============================================================================

  async storeSummary(
    memorySessionId: string,
    project: string,
    summary: SessionSummary
  ): Promise<StoredSummary> {
    const result = this.getStore().storeSummary(
      memorySessionId,
      project,
      {
        request: summary.request || '',
        investigated: summary.investigated || '',
        learned: summary.learned || '',
        completed: summary.completed || '',
        next_steps: summary.nextSteps || '',
        notes: summary.notes || null,
      },
      summary.promptNumber
    );

    return {
      id: result.id,
      memorySessionId,
      project,
      ...summary,
      createdAt: new Date(result.createdAtEpoch).toISOString(),
      createdAtEpoch: result.createdAtEpoch,
    };
  }

  async getSummaryBySessionId(memorySessionId: string): Promise<StoredSummary | null> {
    const summary = this.getStore().getSummaryForSession(memorySessionId);
    if (!summary) return null;

    return {
      id: 0, // Not available from this query
      memorySessionId,
      project: '',
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      nextSteps: summary.next_steps,
      notes: summary.notes,
      promptNumber: summary.prompt_number || undefined,
      createdAt: summary.created_at,
      createdAtEpoch: summary.created_at_epoch,
    };
  }

  async getRecentSummaries(project: string, limit: number): Promise<StoredSummary[]> {
    const summaries = this.getStore().getRecentSummaries(project, limit);
    return summaries.map((s, index) => ({
      id: index,
      memorySessionId: '',
      project,
      request: s.request,
      investigated: s.investigated,
      learned: s.learned,
      completed: s.completed,
      nextSteps: s.next_steps,
      notes: s.notes,
      promptNumber: s.prompt_number || undefined,
      createdAt: s.created_at,
      createdAtEpoch: new Date(s.created_at).getTime(),
    }));
  }

  // ============================================================================
  // User Prompt CRUD
  // ============================================================================

  async storeUserPrompt(prompt: UserPrompt): Promise<StoredUserPrompt> {
    // Need to get the content_session_id from session
    const session = this.getStore().getSessionById(prompt.sessionDbId);
    if (!session) {
      throw new Error(`Session ${prompt.sessionDbId} not found`);
    }

    const id = this.getStore().saveUserPrompt(
      session.content_session_id,
      prompt.promptNumber,
      prompt.content
    );

    const now = new Date();
    return {
      id,
      sessionDbId: prompt.sessionDbId,
      project: prompt.project,
      content: prompt.content,
      promptNumber: prompt.promptNumber,
      createdAt: now.toISOString(),
      createdAtEpoch: now.getTime(),
    };
  }

  async getLatestPrompt(sessionDbId: number): Promise<StoredUserPrompt | null> {
    const session = this.getStore().getSessionById(sessionDbId);
    if (!session) return null;

    const result = this.getStore().getLatestUserPrompt(session.content_session_id);
    if (!result) return null;

    return {
      id: result.id,
      sessionDbId,
      project: result.project,
      content: result.prompt_text,
      promptNumber: result.prompt_number,
      createdAt: new Date(result.created_at_epoch).toISOString(),
      createdAtEpoch: result.created_at_epoch,
    };
  }

  // ============================================================================
  // Search/Query
  // ============================================================================

  async searchMemories(query: SearchQuery): Promise<StoredMemory[]> {
    // Use SessionSearch for filtering
    const results = this.getSearch().getObservationsByFilter(
      query.project || '',
      {
        type: query.types ? query.types[0] : undefined,
        concepts: query.concepts,
        files: query.files,
        limit: query.limit,
        offset: query.offset,
      }
    );

    return results.map(obs => this.observationRecordToStoredMemory(obs));
  }

  async searchSummaries(query: SearchQuery): Promise<StoredSummary[]> {
    const results = this.getSearch().getSummariesByFilter(
      query.project || '',
      {
        limit: query.limit,
        offset: query.offset,
      }
    );

    return results.map(s => ({
      id: s.id,
      memorySessionId: s.memory_session_id,
      project: s.project,
      request: s.request,
      investigated: s.investigated,
      learned: s.learned,
      completed: s.completed,
      nextSteps: s.next_steps,
      notes: s.notes,
      promptNumber: s.prompt_number || undefined,
      discoveryTokens: s.discovery_tokens,
      createdAt: s.created_at,
      createdAtEpoch: s.created_at_epoch,
    }));
  }

  // ============================================================================
  // Files
  // ============================================================================

  async getFilesForSession(memorySessionId: string): Promise<{
    filesRead: string[];
    filesModified: string[];
  }> {
    return this.getStore().getFilesForSession(memorySessionId);
  }

  // ============================================================================
  // Utility
  // ============================================================================

  async getStats(): Promise<{
    totalMemories: number;
    totalSummaries: number;
    totalSessions: number;
  }> {
    // These would need to be added to SessionStore
    return {
      totalMemories: 0,
      totalSummaries: 0,
      totalSessions: 0,
    };
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private observationRecordToStoredMemory(obs: any): StoredMemory {
    return {
      id: obs.id,
      memorySessionId: obs.memory_session_id,
      project: obs.project,
      type: obs.type,
      title: obs.title || null,
      subtitle: obs.subtitle || null,
      facts: obs.facts ? JSON.parse(obs.facts) : [],
      narrative: obs.narrative || null,
      concepts: obs.concepts ? JSON.parse(obs.concepts) : [],
      filesRead: obs.files_read ? JSON.parse(obs.files_read) : [],
      filesModified: obs.files_modified ? JSON.parse(obs.files_modified) : [],
      text: obs.text,
      promptNumber: obs.prompt_number || undefined,
      discoveryTokens: obs.discovery_tokens,
      createdAt: obs.created_at,
      createdAtEpoch: obs.created_at_epoch,
    };
  }
}
