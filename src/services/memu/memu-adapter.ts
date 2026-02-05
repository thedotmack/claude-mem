/**
 * memU Storage Adapter
 *
 * Implements IStorageBackend using the memU API for memory storage.
 * Maps claude-memu concepts to memU's hierarchical memory model.
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
import type {
  MemuConfig,
  MemoryType,
  MemoryItem,
  RetrieveQuery,
} from './types.js';
import { MemuClient, createMemuClient } from './memu-client.js';
import { logger } from '../../utils/logger.js';

/**
 * Local session store for mapping content_session_id to memu resources
 * In production, this should be persisted (e.g., small SQLite or file)
 */
interface LocalSession {
  id: number;
  contentSessionId: string;
  memorySessionId: string | null;
  memuCategoryId?: string;
  project: string;
  userPrompt: string;
  createdAt: string;
}

export class MemuAdapter implements IStorageBackend {
  private client: MemuClient;
  private ready: boolean = false;
  private namespace: string;

  // Local caches for session management
  // Note: In production, consider persisting to a small local DB
  private sessions: Map<number, LocalSession> = new Map();
  private sessionsByContentId: Map<string, number> = new Map();
  private nextSessionId: number = 1;

  // Category cache for project -> categoryId mapping
  private projectCategories: Map<string, string> = new Map();

  constructor(config?: Partial<MemuConfig>) {
    this.client = createMemuClient(config);
    this.namespace = config?.namespace || process.env.CLAUDE_MEMU_NAMESPACE || 'default';
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    try {
      const healthy = await this.client.healthCheck();
      if (!healthy) {
        logger.warn('MEMU', 'memU API not available, will retry on operations');
      } else {
        logger.info('MEMU', 'memU adapter initialized', { namespace: this.namespace });
      }
      this.ready = true;
    } catch (error) {
      logger.error('MEMU', 'Failed to initialize memU adapter', {}, error as Error);
      // Still mark as ready - operations will fail individually
      this.ready = true;
    }
  }

  async close(): Promise<void> {
    this.ready = false;
    this.sessions.clear();
    this.sessionsByContentId.clear();
    this.projectCategories.clear();
    logger.info('MEMU', 'memU adapter closed');
  }

  isReady(): boolean {
    return this.ready;
  }

  // ============================================================================
  // Session CRUD
  // ============================================================================

  async createSession(
    contentSessionId: string,
    project: string,
    userPrompt: string
  ): Promise<SessionRef> {
    const sessionDbId = this.nextSessionId++;
    const now = new Date().toISOString();

    const session: LocalSession = {
      id: sessionDbId,
      contentSessionId,
      memorySessionId: null,
      project,
      userPrompt,
      createdAt: now,
    };

    this.sessions.set(sessionDbId, session);
    this.sessionsByContentId.set(contentSessionId, sessionDbId);

    // Ensure project category exists in memU
    await this.ensureProjectCategory(project);

    logger.info('MEMU', 'Session created', { sessionDbId, project });

    return {
      sessionDbId,
      contentSessionId,
      memorySessionId: null,
      project,
      userPrompt,
    };
  }

  async getSessionById(sessionId: number): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      id: session.id,
      contentSessionId: session.contentSessionId,
      memorySessionId: session.memorySessionId,
      project: session.project,
      userPrompt: session.userPrompt,
      createdAt: session.createdAt,
    };
  }

  async getSessionByContentId(contentSessionId: string): Promise<SessionRecord | null> {
    const sessionId = this.sessionsByContentId.get(contentSessionId);
    if (sessionId === undefined) return null;
    return this.getSessionById(sessionId);
  }

  async updateMemorySessionId(
    sessionDbId: number,
    memorySessionId: string
  ): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (session) {
      session.memorySessionId = memorySessionId;
    }
  }

  // ============================================================================
  // Memory/Observation CRUD
  // ============================================================================

  async storeMemory(
    memorySessionId: string,
    project: string,
    memory: ExtractedMemory
  ): Promise<StoredMemory> {
    const now = new Date();
    const categoryId = await this.ensureProjectCategory(project);

    // Build content from memory fields
    const contentParts: string[] = [];
    if (memory.title) contentParts.push(`## ${memory.title}`);
    if (memory.subtitle) contentParts.push(memory.subtitle);
    if (memory.narrative) contentParts.push(memory.narrative);
    if (memory.facts.length > 0) {
      contentParts.push('### Facts');
      memory.facts.forEach(fact => contentParts.push(`- ${fact}`));
    }
    if (memory.filesRead.length > 0) {
      contentParts.push(`### Files Read: ${memory.filesRead.join(', ')}`);
    }
    if (memory.filesModified.length > 0) {
      contentParts.push(`### Files Modified: ${memory.filesModified.join(', ')}`);
    }

    const content = contentParts.join('\n\n');

    try {
      const item = await this.client.createMemoryItem({
        memoryType: memory.type,
        content,
        categoryId,
        tags: [...memory.concepts, `session:${memorySessionId}`],
        metadata: {
          title: memory.title,
          subtitle: memory.subtitle,
          facts: memory.facts,
          narrative: memory.narrative,
          filesRead: memory.filesRead,
          filesModified: memory.filesModified,
          promptNumber: memory.promptNumber,
          project,
          memorySessionId,
        },
      });

      logger.info('MEMU', 'Memory stored', {
        itemId: item.id,
        type: memory.type,
        project,
      });

      return this.memuItemToStoredMemory(item, memorySessionId, project);
    } catch (error) {
      logger.error('MEMU', 'Failed to store memory', { project, type: memory.type }, error as Error);
      throw error;
    }
  }

  async getMemoryById(id: number | string): Promise<StoredMemory | null> {
    try {
      const item = await this.client.getMemoryItem(String(id));
      const metadata = item.metadata || {};
      return this.memuItemToStoredMemory(
        item,
        String(metadata.memorySessionId || ''),
        String(metadata.project || '')
      );
    } catch {
      return null;
    }
  }

  async getMemoriesBySessionId(
    memorySessionId: string,
    options?: MemoryQuery
  ): Promise<StoredMemory[]> {
    try {
      const response = await this.client.retrieve({
        queries: [{ role: 'system', content: `session:${memorySessionId}` }],
        method: 'rag',
        limit: options?.limit || 100,
        where: {
          namespace: this.namespace,
          tags: [`session:${memorySessionId}`],
          memoryTypes: options?.types,
        },
      });

      return response.items.map(item => this.retrievedItemToStoredMemory(item, memorySessionId));
    } catch (error) {
      logger.error('MEMU', 'Failed to get memories by session', { memorySessionId }, error as Error);
      return [];
    }
  }

  async getRecentMemories(project: string, limit: number): Promise<StoredMemory[]> {
    try {
      const categoryId = this.projectCategories.get(project);

      const response = await this.client.retrieve({
        queries: [{ role: 'system', content: `project:${project} recent memories` }],
        method: 'rag',
        limit,
        where: {
          namespace: this.namespace,
          categoryId,
        },
      });

      return response.items.map(item => this.retrievedItemToStoredMemory(item, ''));
    } catch (error) {
      logger.error('MEMU', 'Failed to get recent memories', { project }, error as Error);
      return [];
    }
  }

  // ============================================================================
  // Summary CRUD
  // ============================================================================

  async storeSummary(
    memorySessionId: string,
    project: string,
    summary: SessionSummary
  ): Promise<StoredSummary> {
    const now = new Date();
    const categoryId = await this.ensureProjectCategory(project);

    // Build summary content
    const contentParts: string[] = ['# Session Summary'];
    if (summary.request) contentParts.push(`## Request\n${summary.request}`);
    if (summary.investigated) contentParts.push(`## Investigated\n${summary.investigated}`);
    if (summary.learned) contentParts.push(`## Learned\n${summary.learned}`);
    if (summary.completed) contentParts.push(`## Completed\n${summary.completed}`);
    if (summary.nextSteps) contentParts.push(`## Next Steps\n${summary.nextSteps}`);
    if (summary.notes) contentParts.push(`## Notes\n${summary.notes}`);

    const content = contentParts.join('\n\n');

    try {
      const item = await this.client.createMemoryItem({
        memoryType: 'document',
        content,
        categoryId,
        tags: [`session:${memorySessionId}`, 'summary', `project:${project}`],
        metadata: {
          ...summary,
          project,
          memorySessionId,
          isSummary: true,
        },
      });

      logger.info('MEMU', 'Summary stored', {
        itemId: item.id,
        project,
        memorySessionId,
      });

      return this.memuItemToStoredSummary(item, memorySessionId, project, summary);
    } catch (error) {
      logger.error('MEMU', 'Failed to store summary', { project }, error as Error);
      throw error;
    }
  }

  async getSummaryBySessionId(memorySessionId: string): Promise<StoredSummary | null> {
    try {
      const response = await this.client.retrieve({
        queries: [{ role: 'system', content: `session:${memorySessionId} summary` }],
        method: 'rag',
        limit: 1,
        where: {
          namespace: this.namespace,
          tags: [`session:${memorySessionId}`, 'summary'],
        },
      });

      if (response.items.length === 0) return null;

      const item = response.items[0];
      const metadata = (item.metadata || {}) as Record<string, unknown>;

      return {
        id: item.id,
        memorySessionId,
        project: String(metadata.project || ''),
        request: String(metadata.request || '') || null,
        investigated: String(metadata.investigated || '') || null,
        learned: String(metadata.learned || '') || null,
        completed: String(metadata.completed || '') || null,
        nextSteps: String(metadata.nextSteps || '') || null,
        notes: metadata.notes ? String(metadata.notes) : null,
        createdAt: new Date().toISOString(),
        createdAtEpoch: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getRecentSummaries(project: string, limit: number): Promise<StoredSummary[]> {
    try {
      const response = await this.client.retrieve({
        queries: [{ role: 'system', content: `project:${project} summaries` }],
        method: 'rag',
        limit,
        where: {
          namespace: this.namespace,
          tags: ['summary', `project:${project}`],
        },
      });

      return response.items.map(item => {
        const metadata = (item.metadata || {}) as Record<string, unknown>;
        return {
          id: item.id,
          memorySessionId: String(metadata.memorySessionId || ''),
          project,
          request: String(metadata.request || '') || null,
          investigated: String(metadata.investigated || '') || null,
          learned: String(metadata.learned || '') || null,
          completed: String(metadata.completed || '') || null,
          nextSteps: String(metadata.nextSteps || '') || null,
          notes: metadata.notes ? String(metadata.notes) : null,
          createdAt: item.createdAt,
          createdAtEpoch: new Date(item.createdAt).getTime(),
        };
      });
    } catch (error) {
      logger.error('MEMU', 'Failed to get recent summaries', { project }, error as Error);
      return [];
    }
  }

  // ============================================================================
  // User Prompt CRUD
  // ============================================================================

  async storeUserPrompt(prompt: UserPrompt): Promise<StoredUserPrompt> {
    const now = new Date();

    // Store as a memory item tagged as user prompt
    try {
      const item = await this.client.createMemoryItem({
        memoryType: 'conversation',
        content: prompt.content,
        tags: [
          'user-prompt',
          `session-db:${prompt.sessionDbId}`,
          `project:${prompt.project}`,
          `prompt-num:${prompt.promptNumber}`,
        ],
        metadata: {
          sessionDbId: prompt.sessionDbId,
          project: prompt.project,
          promptNumber: prompt.promptNumber,
        },
      });

      return {
        id: item.id,
        sessionDbId: prompt.sessionDbId,
        project: prompt.project,
        content: prompt.content,
        promptNumber: prompt.promptNumber,
        createdAt: now.toISOString(),
        createdAtEpoch: now.getTime(),
      };
    } catch (error) {
      logger.error('MEMU', 'Failed to store user prompt', {}, error as Error);
      throw error;
    }
  }

  async getLatestPrompt(sessionDbId: number): Promise<StoredUserPrompt | null> {
    try {
      const response = await this.client.retrieve({
        queries: [{ role: 'system', content: `session-db:${sessionDbId} user-prompt` }],
        method: 'rag',
        limit: 1,
        where: {
          namespace: this.namespace,
          tags: ['user-prompt', `session-db:${sessionDbId}`],
        },
      });

      if (response.items.length === 0) return null;

      const item = response.items[0];
      const metadata = (item.metadata || {}) as Record<string, unknown>;

      return {
        id: item.id,
        sessionDbId,
        project: String(metadata.project || ''),
        content: item.content || item.summary,
        promptNumber: Number(metadata.promptNumber || 0),
        createdAt: new Date().toISOString(),
        createdAtEpoch: Date.now(),
      };
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Search/Query
  // ============================================================================

  async searchMemories(query: SearchQuery): Promise<StoredMemory[]> {
    try {
      const queries: RetrieveQuery[] = [];

      if (query.text) {
        queries.push({ role: 'user', content: query.text });
      }

      if (query.project) {
        queries.push({ role: 'system', content: `project:${query.project}` });
      }

      if (queries.length === 0) {
        queries.push({ role: 'system', content: 'recent memories' });
      }

      const response = await this.client.retrieve({
        queries,
        method: query.method === 'semantic' ? 'llm' : 'rag',
        limit: query.limit || 50,
        where: {
          namespace: this.namespace,
          memoryTypes: query.types,
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
        },
      });

      return response.items.map(item => this.retrievedItemToStoredMemory(item, ''));
    } catch (error) {
      logger.error('MEMU', 'Failed to search memories', {}, error as Error);
      return [];
    }
  }

  async searchSummaries(query: SearchQuery): Promise<StoredSummary[]> {
    try {
      const queries: RetrieveQuery[] = [];

      if (query.text) {
        queries.push({ role: 'user', content: query.text });
      }

      queries.push({ role: 'system', content: 'summaries' });

      const response = await this.client.retrieve({
        queries,
        method: query.method === 'semantic' ? 'llm' : 'rag',
        limit: query.limit || 20,
        where: {
          namespace: this.namespace,
          tags: ['summary'],
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
        },
      });

      return response.items.map(item => {
        const metadata = (item.metadata || {}) as Record<string, unknown>;
        return {
          id: item.id,
          memorySessionId: String(metadata.memorySessionId || ''),
          project: String(metadata.project || ''),
          request: String(metadata.request || '') || null,
          investigated: String(metadata.investigated || '') || null,
          learned: String(metadata.learned || '') || null,
          completed: String(metadata.completed || '') || null,
          nextSteps: String(metadata.nextSteps || '') || null,
          notes: metadata.notes ? String(metadata.notes) : null,
          createdAt: item.createdAt || new Date().toISOString(),
          createdAtEpoch: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
        };
      });
    } catch (error) {
      logger.error('MEMU', 'Failed to search summaries', {}, error as Error);
      return [];
    }
  }

  // ============================================================================
  // Files
  // ============================================================================

  async getFilesForSession(memorySessionId: string): Promise<{
    filesRead: string[];
    filesModified: string[];
  }> {
    try {
      const memories = await this.getMemoriesBySessionId(memorySessionId);

      const filesRead = new Set<string>();
      const filesModified = new Set<string>();

      for (const memory of memories) {
        memory.filesRead.forEach(f => filesRead.add(f));
        memory.filesModified.forEach(f => filesModified.add(f));
      }

      return {
        filesRead: Array.from(filesRead),
        filesModified: Array.from(filesModified),
      };
    } catch {
      return { filesRead: [], filesModified: [] };
    }
  }

  // ============================================================================
  // Utility
  // ============================================================================

  async getStats(): Promise<{
    totalMemories: number;
    totalSummaries: number;
    totalSessions: number;
  }> {
    // memU doesn't have a direct stats endpoint, so we estimate
    return {
      totalMemories: 0, // Would need count endpoint
      totalSummaries: 0,
      totalSessions: this.sessions.size,
    };
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Ensure a category exists for the project
   */
  private async ensureProjectCategory(project: string): Promise<string | undefined> {
    if (this.projectCategories.has(project)) {
      return this.projectCategories.get(project);
    }

    try {
      // Check if category already exists
      const categories = await this.client.listCategories({ namespace: this.namespace });
      const existing = categories.categories.find(c => c.name === project);

      if (existing) {
        this.projectCategories.set(project, existing.id);
        return existing.id;
      }

      // Create new category
      const category = await this.client.createCategory({
        name: project,
        description: `Development memories for ${project}`,
      });

      this.projectCategories.set(project, category.id);
      return category.id;
    } catch (error) {
      logger.warn('MEMU', 'Failed to ensure project category', { project }, error as Error);
      return undefined;
    }
  }

  /**
   * Convert memU item to StoredMemory
   */
  private memuItemToStoredMemory(
    item: MemoryItem,
    memorySessionId: string,
    project: string
  ): StoredMemory {
    const metadata = (item.metadata || {}) as Record<string, unknown>;

    return {
      id: item.id,
      memorySessionId,
      project,
      type: item.memoryType as MemoryType,
      title: String(metadata.title || '') || null,
      subtitle: String(metadata.subtitle || '') || null,
      facts: Array.isArray(metadata.facts) ? metadata.facts as string[] : [],
      narrative: String(metadata.narrative || '') || null,
      concepts: item.tags?.filter(t => !t.startsWith('session:') && !t.startsWith('project:')) || [],
      filesRead: Array.isArray(metadata.filesRead) ? metadata.filesRead as string[] : [],
      filesModified: Array.isArray(metadata.filesModified) ? metadata.filesModified as string[] : [],
      promptNumber: Number(metadata.promptNumber || 0),
      text: item.content,
      createdAt: item.createdAt,
      createdAtEpoch: new Date(item.createdAt).getTime(),
    };
  }

  /**
   * Convert retrieved item to StoredMemory
   */
  private retrievedItemToStoredMemory(
    item: { id: string; summary: string; content?: string; memoryType: MemoryType; metadata?: Record<string, unknown> },
    memorySessionId: string
  ): StoredMemory {
    const metadata = item.metadata || {};

    return {
      id: item.id,
      memorySessionId: String(metadata.memorySessionId || memorySessionId),
      project: String(metadata.project || ''),
      type: item.memoryType,
      title: String(metadata.title || '') || null,
      subtitle: String(metadata.subtitle || '') || null,
      facts: Array.isArray(metadata.facts) ? metadata.facts as string[] : [],
      narrative: String(metadata.narrative || '') || null,
      concepts: Array.isArray(metadata.concepts) ? metadata.concepts as string[] : [],
      filesRead: Array.isArray(metadata.filesRead) ? metadata.filesRead as string[] : [],
      filesModified: Array.isArray(metadata.filesModified) ? metadata.filesModified as string[] : [],
      promptNumber: Number(metadata.promptNumber || 0),
      text: item.content || item.summary,
      createdAt: new Date().toISOString(),
      createdAtEpoch: Date.now(),
    };
  }

  /**
   * Convert memU item to StoredSummary
   */
  private memuItemToStoredSummary(
    item: MemoryItem,
    memorySessionId: string,
    project: string,
    summary: SessionSummary
  ): StoredSummary {
    return {
      id: item.id,
      memorySessionId,
      project,
      ...summary,
      createdAt: item.createdAt,
      createdAtEpoch: new Date(item.createdAt).getTime(),
    };
  }
}
