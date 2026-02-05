/**
 * MemuStore
 *
 * Primary storage service for claude-memu using memU API.
 * Handles sessions, observations, summaries, and search.
 */

import type {
  MemuConfig,
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
  MemoryType,
  MemoryItem,
  RetrieveQuery,
} from './types.js';
import { MemuClient, createMemuClient } from './memu-client.js';
import { logger } from '../../utils/logger.js';

export class MemuStore {
  private client: MemuClient;
  private ready: boolean = false;

  // In-memory session tracking (sessions are transient per worker lifecycle)
  private sessions: Map<number, Session> = new Map();
  private sessionsByContentId: Map<string, number> = new Map();
  private nextSessionId: number = 1;

  // Project category cache
  private projectCategories: Map<string, string> = new Map();

  constructor(config?: Partial<MemuConfig>) {
    this.client = createMemuClient(config);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    try {
      const healthy = await this.client.healthCheck();
      if (!healthy) {
        logger.warn('MEMU', 'memU API not reachable, will retry on operations');
      } else {
        logger.info('MEMU', 'MemuStore initialized', { namespace: this.client.namespace });
      }
      this.ready = true;
    } catch (error) {
      logger.error('MEMU', 'Failed to initialize MemuStore', {}, error as Error);
      this.ready = true; // Allow operations to fail individually
    }
  }

  async close(): Promise<void> {
    this.ready = false;
    this.sessions.clear();
    this.sessionsByContentId.clear();
    this.projectCategories.clear();
    logger.info('MEMU', 'MemuStore closed');
  }

  isReady(): boolean {
    return this.ready;
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  async createSession(
    contentSessionId: string,
    project: string,
    userPrompt: string
  ): Promise<Session> {
    // Check if session already exists (idempotent)
    const existingId = this.sessionsByContentId.get(contentSessionId);
    if (existingId !== undefined) {
      return this.sessions.get(existingId)!;
    }

    const now = new Date();
    const session: Session = {
      id: this.nextSessionId++,
      contentSessionId,
      memorySessionId: null,
      project,
      userPrompt,
      promptCounter: 0,
      status: 'active',
      createdAt: now.toISOString(),
      createdAtEpoch: now.getTime(),
    };

    this.sessions.set(session.id, session);
    this.sessionsByContentId.set(contentSessionId, session.id);

    // Ensure project category exists
    await this.ensureProjectCategory(project);

    logger.info('MEMU', 'Session created', { sessionId: session.id, project });
    return session;
  }

  getSession(sessionId: number): Session | null {
    return this.sessions.get(sessionId) || null;
  }

  getSessionByContentId(contentSessionId: string): Session | null {
    const id = this.sessionsByContentId.get(contentSessionId);
    return id !== undefined ? this.sessions.get(id) || null : null;
  }

  updateMemorySessionId(sessionId: number, memorySessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.memorySessionId = memorySessionId;
    }
  }

  incrementPromptCounter(sessionId: number): number {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.promptCounter++;
      return session.promptCounter;
    }
    return 0;
  }

  // ============================================================================
  // Observation Storage
  // ============================================================================

  async storeObservation(
    memorySessionId: string,
    project: string,
    observation: Observation
  ): Promise<StoredObservation> {
    const categoryId = await this.ensureProjectCategory(project);

    // Build markdown content
    const content = this.buildObservationContent(observation);

    try {
      const item = await this.client.createItem({
        memoryType: observation.type,
        content,
        categoryId,
        tags: [
          ...observation.concepts,
          `session:${memorySessionId}`,
          `project:${project}`,
          `type:${observation.type}`,
        ],
        metadata: {
          title: observation.title,
          subtitle: observation.subtitle,
          facts: observation.facts,
          narrative: observation.narrative,
          filesRead: observation.filesRead,
          filesModified: observation.filesModified,
          promptNumber: observation.promptNumber,
          project,
          memorySessionId,
        },
      });

      logger.info('MEMU', 'Observation stored', {
        itemId: item.id,
        type: observation.type,
        project,
      });

      return this.itemToObservation(item, memorySessionId, project);
    } catch (error) {
      logger.error('MEMU', 'Failed to store observation', { project }, error as Error);
      throw error;
    }
  }

  async getObservation(id: string): Promise<StoredObservation | null> {
    try {
      const item = await this.client.getItem(id);
      const meta = (item.metadata || {}) as Record<string, unknown>;
      return this.itemToObservation(
        item,
        String(meta.memorySessionId || ''),
        String(meta.project || '')
      );
    } catch {
      return null;
    }
  }

  async getRecentObservations(project: string, limit: number = 20): Promise<StoredObservation[]> {
    try {
      const response = await this.client.retrieve({
        queries: [{ role: 'system', content: `project:${project}` }],
        method: 'rag',
        limit,
        where: {
          namespace: this.client.namespace,
          tags: [`project:${project}`],
        },
      });

      return response.items
        .filter(item => !item.metadata?.isSummary)
        .map(item => this.retrievedToObservation(item));
    } catch (error) {
      logger.error('MEMU', 'Failed to get recent observations', { project }, error as Error);
      return [];
    }
  }

  // ============================================================================
  // Summary Storage
  // ============================================================================

  async storeSummary(
    memorySessionId: string,
    project: string,
    summary: Summary
  ): Promise<StoredSummary> {
    const categoryId = await this.ensureProjectCategory(project);
    const content = this.buildSummaryContent(summary);

    try {
      const item = await this.client.createItem({
        memoryType: 'document',
        content,
        categoryId,
        tags: [
          `session:${memorySessionId}`,
          `project:${project}`,
          'summary',
        ],
        metadata: {
          ...summary,
          project,
          memorySessionId,
          isSummary: true,
        },
      });

      logger.info('MEMU', 'Summary stored', { itemId: item.id, project });

      return {
        id: item.id,
        memorySessionId,
        project,
        ...summary,
        createdAt: item.createdAt,
        createdAtEpoch: new Date(item.createdAt).getTime(),
      };
    } catch (error) {
      logger.error('MEMU', 'Failed to store summary', { project }, error as Error);
      throw error;
    }
  }

  async getSummary(memorySessionId: string): Promise<StoredSummary | null> {
    try {
      const response = await this.client.retrieve({
        queries: [{ role: 'system', content: `session:${memorySessionId}` }],
        method: 'rag',
        limit: 1,
        where: {
          namespace: this.client.namespace,
          tags: [`session:${memorySessionId}`, 'summary'],
        },
      });

      if (response.items.length === 0) return null;

      const item = response.items[0];
      const meta = (item.metadata || {}) as Record<string, unknown>;

      return {
        id: item.id,
        memorySessionId,
        project: String(meta.project || ''),
        request: meta.request ? String(meta.request) : null,
        investigated: meta.investigated ? String(meta.investigated) : null,
        learned: meta.learned ? String(meta.learned) : null,
        completed: meta.completed ? String(meta.completed) : null,
        nextSteps: meta.nextSteps ? String(meta.nextSteps) : null,
        notes: meta.notes ? String(meta.notes) : null,
        promptNumber: meta.promptNumber ? Number(meta.promptNumber) : undefined,
        createdAt: item.createdAt || new Date().toISOString(),
        createdAtEpoch: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getRecentSummaries(project: string, limit: number = 10): Promise<StoredSummary[]> {
    try {
      const response = await this.client.retrieve({
        queries: [{ role: 'system', content: `project:${project}` }],
        method: 'rag',
        limit,
        where: {
          namespace: this.client.namespace,
          tags: [`project:${project}`, 'summary'],
        },
      });

      return response.items.map(item => {
        const meta = (item.metadata || {}) as Record<string, unknown>;
        return {
          id: item.id,
          memorySessionId: String(meta.memorySessionId || ''),
          project,
          request: meta.request ? String(meta.request) : null,
          investigated: meta.investigated ? String(meta.investigated) : null,
          learned: meta.learned ? String(meta.learned) : null,
          completed: meta.completed ? String(meta.completed) : null,
          nextSteps: meta.nextSteps ? String(meta.nextSteps) : null,
          notes: meta.notes ? String(meta.notes) : null,
          createdAt: item.createdAt || new Date().toISOString(),
          createdAtEpoch: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
        };
      });
    } catch (error) {
      logger.error('MEMU', 'Failed to get recent summaries', { project }, error as Error);
      return [];
    }
  }

  // ============================================================================
  // User Prompt Storage
  // ============================================================================

  async storeUserPrompt(prompt: UserPrompt): Promise<StoredUserPrompt> {
    const now = new Date();

    try {
      const item = await this.client.createItem({
        memoryType: 'conversation',
        content: prompt.content,
        tags: [
          'user-prompt',
          `session:${prompt.sessionId}`,
          `project:${prompt.project}`,
          `prompt:${prompt.promptNumber}`,
        ],
        metadata: {
          sessionId: prompt.sessionId,
          project: prompt.project,
          promptNumber: prompt.promptNumber,
        },
      });

      return {
        id: item.id,
        sessionId: prompt.sessionId,
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

  // ============================================================================
  // Search
  // ============================================================================

  async search(query: SearchQuery): Promise<SearchResults> {
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
        method: query.method || 'rag',
        limit: query.limit || 50,
        where: {
          namespace: this.client.namespace,
          memoryTypes: query.types,
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
        },
      });

      const observations: StoredObservation[] = [];
      const summaries: StoredSummary[] = [];
      const prompts: StoredUserPrompt[] = [];

      for (const item of response.items) {
        const meta = (item.metadata || {}) as Record<string, unknown>;

        if (meta.isSummary) {
          summaries.push({
            id: item.id,
            memorySessionId: String(meta.memorySessionId || ''),
            project: String(meta.project || ''),
            request: meta.request ? String(meta.request) : null,
            investigated: meta.investigated ? String(meta.investigated) : null,
            learned: meta.learned ? String(meta.learned) : null,
            completed: meta.completed ? String(meta.completed) : null,
            nextSteps: meta.nextSteps ? String(meta.nextSteps) : null,
            notes: meta.notes ? String(meta.notes) : null,
            createdAt: item.createdAt || new Date().toISOString(),
            createdAtEpoch: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
          });
        } else if (item.memoryType === 'conversation' && meta.promptNumber !== undefined) {
          prompts.push({
            id: item.id,
            sessionId: Number(meta.sessionId || 0),
            project: String(meta.project || ''),
            content: item.content || item.summary,
            promptNumber: Number(meta.promptNumber),
            createdAt: item.createdAt || new Date().toISOString(),
            createdAtEpoch: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
          });
        } else {
          observations.push(this.retrievedToObservation(item));
        }
      }

      return {
        observations,
        summaries,
        prompts,
        proactiveContext: response.proactiveContext,
      };
    } catch (error) {
      logger.error('MEMU', 'Search failed', {}, error as Error);
      return { observations: [], summaries: [], prompts: [] };
    }
  }

  // ============================================================================
  // Context Injection
  // ============================================================================

  async getContextForProject(project: string, limit: number = 10): Promise<ContextPayload> {
    try {
      // Use memU's proactive context feature
      const response = await this.client.retrieve({
        queries: [
          { role: 'system', content: `project:${project}` },
          { role: 'system', content: 'recent work context' },
        ],
        method: 'llm', // Use LLM method for proactive context
        limit,
        where: {
          namespace: this.client.namespace,
          tags: [`project:${project}`],
        },
      });

      const observations: StoredObservation[] = [];
      const summaries: StoredSummary[] = [];

      for (const item of response.items) {
        const meta = (item.metadata || {}) as Record<string, unknown>;
        if (meta.isSummary) {
          summaries.push({
            id: item.id,
            memorySessionId: String(meta.memorySessionId || ''),
            project,
            request: meta.request ? String(meta.request) : null,
            investigated: meta.investigated ? String(meta.investigated) : null,
            learned: meta.learned ? String(meta.learned) : null,
            completed: meta.completed ? String(meta.completed) : null,
            nextSteps: meta.nextSteps ? String(meta.nextSteps) : null,
            notes: meta.notes ? String(meta.notes) : null,
            createdAt: item.createdAt || new Date().toISOString(),
            createdAtEpoch: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
          });
        } else {
          observations.push(this.retrievedToObservation(item));
        }
      }

      return {
        recentObservations: observations,
        recentSummaries: summaries,
        proactiveContext: response.proactiveContext,
        project,
        sessionCount: this.sessions.size,
      };
    } catch (error) {
      logger.error('MEMU', 'Failed to get context', { project }, error as Error);
      return {
        recentObservations: [],
        recentSummaries: [],
        project,
        sessionCount: 0,
      };
    }
  }

  // ============================================================================
  // Project Categories
  // ============================================================================

  async getAllProjects(): Promise<string[]> {
    try {
      const categories = await this.client.listCategories();
      return categories.categories.map(c => c.name);
    } catch {
      return Array.from(this.projectCategories.keys());
    }
  }

  private async ensureProjectCategory(project: string): Promise<string | undefined> {
    if (this.projectCategories.has(project)) {
      return this.projectCategories.get(project);
    }

    try {
      const categories = await this.client.listCategories();
      const existing = categories.categories.find(c => c.name === project);

      if (existing) {
        this.projectCategories.set(project, existing.id);
        return existing.id;
      }

      const category = await this.client.createCategory({
        name: project,
        description: `Development memories for ${project}`,
      });

      this.projectCategories.set(project, category.id);
      return category.id;
    } catch (error) {
      logger.warn('MEMU', 'Failed to ensure project category', { project });
      return undefined;
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private buildObservationContent(obs: Observation): string {
    const parts: string[] = [];
    if (obs.title) parts.push(`## ${obs.title}`);
    if (obs.subtitle) parts.push(obs.subtitle);
    if (obs.narrative) parts.push(obs.narrative);
    if (obs.facts.length > 0) {
      parts.push('### Facts');
      obs.facts.forEach(f => parts.push(`- ${f}`));
    }
    if (obs.filesRead.length > 0) {
      parts.push(`**Files Read:** ${obs.filesRead.join(', ')}`);
    }
    if (obs.filesModified.length > 0) {
      parts.push(`**Files Modified:** ${obs.filesModified.join(', ')}`);
    }
    return parts.join('\n\n');
  }

  private buildSummaryContent(summary: Summary): string {
    const parts: string[] = ['# Session Summary'];
    if (summary.request) parts.push(`## Request\n${summary.request}`);
    if (summary.investigated) parts.push(`## Investigated\n${summary.investigated}`);
    if (summary.learned) parts.push(`## Learned\n${summary.learned}`);
    if (summary.completed) parts.push(`## Completed\n${summary.completed}`);
    if (summary.nextSteps) parts.push(`## Next Steps\n${summary.nextSteps}`);
    if (summary.notes) parts.push(`## Notes\n${summary.notes}`);
    return parts.join('\n\n');
  }

  private itemToObservation(item: MemoryItem, memorySessionId: string, project: string): StoredObservation {
    const meta = (item.metadata || {}) as Record<string, unknown>;
    return {
      id: item.id,
      memorySessionId,
      project,
      type: item.memoryType as MemoryType,
      title: meta.title ? String(meta.title) : null,
      subtitle: meta.subtitle ? String(meta.subtitle) : null,
      facts: Array.isArray(meta.facts) ? meta.facts as string[] : [],
      narrative: meta.narrative ? String(meta.narrative) : null,
      concepts: item.tags?.filter(t => !t.startsWith('session:') && !t.startsWith('project:') && !t.startsWith('type:')) || [],
      filesRead: Array.isArray(meta.filesRead) ? meta.filesRead as string[] : [],
      filesModified: Array.isArray(meta.filesModified) ? meta.filesModified as string[] : [],
      promptNumber: meta.promptNumber ? Number(meta.promptNumber) : undefined,
      content: item.content,
      createdAt: item.createdAt,
      createdAtEpoch: new Date(item.createdAt).getTime(),
    };
  }

  private retrievedToObservation(item: {
    id: string;
    summary: string;
    content?: string;
    memoryType: MemoryType;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): StoredObservation {
    const meta = item.metadata || {};
    return {
      id: item.id,
      memorySessionId: String(meta.memorySessionId || ''),
      project: String(meta.project || ''),
      type: item.memoryType,
      title: meta.title ? String(meta.title) : null,
      subtitle: meta.subtitle ? String(meta.subtitle) : null,
      facts: Array.isArray(meta.facts) ? meta.facts as string[] : [],
      narrative: meta.narrative ? String(meta.narrative) : null,
      concepts: Array.isArray(meta.concepts) ? meta.concepts as string[] : [],
      filesRead: Array.isArray(meta.filesRead) ? meta.filesRead as string[] : [],
      filesModified: Array.isArray(meta.filesModified) ? meta.filesModified as string[] : [],
      promptNumber: meta.promptNumber ? Number(meta.promptNumber) : undefined,
      content: item.content || item.summary,
      createdAt: item.createdAt || new Date().toISOString(),
      createdAtEpoch: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
    };
  }
}

// Singleton instance
let storeInstance: MemuStore | null = null;

export function getMemuStore(config?: Partial<MemuConfig>): MemuStore {
  if (!storeInstance) {
    storeInstance = new MemuStore(config);
  }
  return storeInstance;
}

export async function initializeMemuStore(config?: Partial<MemuConfig>): Promise<MemuStore> {
  const store = getMemuStore(config);
  await store.initialize();
  return store;
}
