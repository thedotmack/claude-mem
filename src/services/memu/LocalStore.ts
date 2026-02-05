/**
 * LocalStore
 *
 * File-based storage for claude-memu when no memU API key is configured.
 * Stores all data in JSON files in ~/.claude-memu/data/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
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
  MemoryType,
} from './types.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

interface LocalData {
  observations: StoredObservation[];
  summaries: StoredSummary[];
  prompts: StoredUserPrompt[];
  categories: Array<{ id: string; name: string; description: string }>;
  version: number;
}

export class LocalStore {
  private dataDir: string;
  private ready: boolean = false;

  // In-memory session tracking (sessions are transient per worker lifecycle)
  private sessions: Map<number, Session> = new Map();
  private sessionsByContentId: Map<string, number> = new Map();
  private nextSessionId: number = 1;

  // Project data cache
  private projectData: Map<string, LocalData> = new Map();

  constructor() {
    this.dataDir = join(SettingsDefaultsManager.getDataDir(), 'data');
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      // Load existing project data
      this.loadAllProjects();

      this.ready = true;
      logger.info('LOCAL', 'LocalStore initialized', { dataDir: this.dataDir });
    } catch (error) {
      logger.error('LOCAL', 'Failed to initialize LocalStore', {}, error as Error);
      this.ready = true; // Allow operations to fail individually
    }
  }

  async close(): Promise<void> {
    // Save all project data before closing
    for (const [project, data] of this.projectData) {
      this.saveProjectData(project, data);
    }

    this.ready = false;
    this.sessions.clear();
    this.sessionsByContentId.clear();
    this.projectData.clear();
    logger.info('LOCAL', 'LocalStore closed');
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
      memorySessionId: `local-${randomUUID()}`,
      project,
      userPrompt,
      promptCounter: 0,
      status: 'active',
      createdAt: now.toISOString(),
      createdAtEpoch: now.getTime(),
    };

    this.sessions.set(session.id, session);
    this.sessionsByContentId.set(contentSessionId, session.id);

    // Ensure project data exists
    this.ensureProjectData(project);

    logger.info('LOCAL', 'Session created', { sessionId: session.id, project });
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
    const now = new Date();
    const data = this.ensureProjectData(project);

    const stored: StoredObservation = {
      ...observation,
      id: randomUUID(),
      memorySessionId,
      project,
      content: this.buildObservationContent(observation),
      createdAt: now.toISOString(),
      createdAtEpoch: now.getTime(),
    };

    data.observations.push(stored);
    this.saveProjectData(project, data);

    logger.info('LOCAL', 'Observation stored', {
      id: stored.id,
      type: observation.type,
      project,
    });

    return stored;
  }

  async getObservation(id: string): Promise<StoredObservation | null> {
    for (const data of this.projectData.values()) {
      const obs = data.observations.find(o => o.id === id);
      if (obs) return obs;
    }
    return null;
  }

  async getRecentObservations(project: string, limit: number = 20): Promise<StoredObservation[]> {
    const data = this.getProjectData(project);
    if (!data) return [];

    return data.observations
      .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
      .slice(0, limit);
  }

  // ============================================================================
  // Summary Storage
  // ============================================================================

  async storeSummary(
    memorySessionId: string,
    project: string,
    summary: Summary
  ): Promise<StoredSummary> {
    const now = new Date();
    const data = this.ensureProjectData(project);

    const stored: StoredSummary = {
      ...summary,
      id: randomUUID(),
      memorySessionId,
      project,
      createdAt: now.toISOString(),
      createdAtEpoch: now.getTime(),
    };

    data.summaries.push(stored);
    this.saveProjectData(project, data);

    logger.info('LOCAL', 'Summary stored', { id: stored.id, project });

    return stored;
  }

  async getSummary(memorySessionId: string): Promise<StoredSummary | null> {
    for (const data of this.projectData.values()) {
      const summary = data.summaries.find(s => s.memorySessionId === memorySessionId);
      if (summary) return summary;
    }
    return null;
  }

  async getRecentSummaries(project: string, limit: number = 10): Promise<StoredSummary[]> {
    const data = this.getProjectData(project);
    if (!data) return [];

    return data.summaries
      .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
      .slice(0, limit);
  }

  // ============================================================================
  // User Prompt Storage
  // ============================================================================

  async storeUserPrompt(prompt: UserPrompt): Promise<StoredUserPrompt> {
    const now = new Date();
    const data = this.ensureProjectData(prompt.project);

    const stored: StoredUserPrompt = {
      ...prompt,
      id: randomUUID(),
      createdAt: now.toISOString(),
      createdAtEpoch: now.getTime(),
    };

    data.prompts.push(stored);
    this.saveProjectData(prompt.project, data);

    return stored;
  }

  // ============================================================================
  // Search
  // ============================================================================

  async search(query: SearchQuery): Promise<SearchResults> {
    const observations: StoredObservation[] = [];
    const summaries: StoredSummary[] = [];
    const prompts: StoredUserPrompt[] = [];

    // Determine which projects to search
    const projects = query.project
      ? [query.project]
      : Array.from(this.projectData.keys());

    for (const project of projects) {
      const data = this.getProjectData(project);
      if (!data) continue;

      // Filter observations
      let filteredObs = data.observations;

      if (query.types && query.types.length > 0) {
        filteredObs = filteredObs.filter(o => query.types!.includes(o.type));
      }

      if (query.concepts && query.concepts.length > 0) {
        filteredObs = filteredObs.filter(o =>
          query.concepts!.some(c => o.concepts.includes(c))
        );
      }

      if (query.files && query.files.length > 0) {
        filteredObs = filteredObs.filter(o =>
          query.files!.some(
            f => o.filesRead.includes(f) || o.filesModified.includes(f)
          )
        );
      }

      if (query.dateFrom) {
        const from = new Date(query.dateFrom).getTime();
        filteredObs = filteredObs.filter(o => o.createdAtEpoch >= from);
      }

      if (query.dateTo) {
        const to = new Date(query.dateTo).getTime();
        filteredObs = filteredObs.filter(o => o.createdAtEpoch <= to);
      }

      // Text search (simple substring match)
      if (query.text) {
        const searchText = query.text.toLowerCase();
        filteredObs = filteredObs.filter(
          o =>
            (o.title?.toLowerCase().includes(searchText)) ||
            (o.narrative?.toLowerCase().includes(searchText)) ||
            (o.content?.toLowerCase().includes(searchText)) ||
            o.facts.some(f => f.toLowerCase().includes(searchText))
        );
      }

      observations.push(...filteredObs);

      // Filter summaries
      let filteredSummaries = data.summaries;

      if (query.dateFrom) {
        const from = new Date(query.dateFrom).getTime();
        filteredSummaries = filteredSummaries.filter(s => s.createdAtEpoch >= from);
      }

      if (query.dateTo) {
        const to = new Date(query.dateTo).getTime();
        filteredSummaries = filteredSummaries.filter(s => s.createdAtEpoch <= to);
      }

      if (query.text) {
        const searchText = query.text.toLowerCase();
        filteredSummaries = filteredSummaries.filter(
          s =>
            (s.request?.toLowerCase().includes(searchText)) ||
            (s.completed?.toLowerCase().includes(searchText)) ||
            (s.learned?.toLowerCase().includes(searchText))
        );
      }

      summaries.push(...filteredSummaries);

      // Filter prompts
      let filteredPrompts = data.prompts;

      if (query.text) {
        const searchText = query.text.toLowerCase();
        filteredPrompts = filteredPrompts.filter(p =>
          p.content.toLowerCase().includes(searchText)
        );
      }

      prompts.push(...filteredPrompts);
    }

    // Sort by date and apply limit
    const limit = query.limit || 50;

    return {
      observations: observations
        .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
        .slice(0, limit),
      summaries: summaries
        .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
        .slice(0, limit),
      prompts: prompts
        .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
        .slice(0, limit),
    };
  }

  // ============================================================================
  // Context Injection
  // ============================================================================

  async getContextForProject(project: string, limit: number = 10): Promise<ContextPayload> {
    const observations = await this.getRecentObservations(project, limit);
    const summaries = await this.getRecentSummaries(project, Math.ceil(limit / 2));

    return {
      recentObservations: observations,
      recentSummaries: summaries,
      project,
      sessionCount: this.sessions.size,
    };
  }

  // ============================================================================
  // Project Categories
  // ============================================================================

  async getAllProjects(): Promise<string[]> {
    return Array.from(this.projectData.keys());
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  private getProjectFilePath(project: string): string {
    // Sanitize project name for filesystem
    const safeName = project.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dataDir, `${safeName}.json`);
  }

  private loadAllProjects(): void {
    try {
      const files = readdirSync(this.dataDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const project = file.replace('.json', '');
          const data = this.loadProjectData(project);
          if (data) {
            this.projectData.set(project, data);
          }
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  private loadProjectData(project: string): LocalData | null {
    try {
      const filePath = this.getProjectFilePath(project);
      if (!existsSync(filePath)) return null;

      const content = readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as LocalData;
    } catch (error) {
      logger.warn('LOCAL', 'Failed to load project data', { project });
      return null;
    }
  }

  private saveProjectData(project: string, data: LocalData): void {
    try {
      const filePath = this.getProjectFilePath(project);
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      logger.error('LOCAL', 'Failed to save project data', { project }, error as Error);
    }
  }

  private getProjectData(project: string): LocalData | null {
    let data = this.projectData.get(project);
    if (!data) {
      data = this.loadProjectData(project) || undefined;
      if (data) {
        this.projectData.set(project, data);
      }
    }
    return data || null;
  }

  private ensureProjectData(project: string): LocalData {
    let data = this.projectData.get(project);
    if (!data) {
      data = this.loadProjectData(project) || this.createEmptyData();
      this.projectData.set(project, data);
    }
    return data;
  }

  private createEmptyData(): LocalData {
    return {
      observations: [],
      summaries: [],
      prompts: [],
      categories: [],
      version: 1,
    };
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
}

// Singleton instance
let localStoreInstance: LocalStore | null = null;

export function getLocalStore(): LocalStore {
  if (!localStoreInstance) {
    localStoreInstance = new LocalStore();
  }
  return localStoreInstance;
}

export async function initializeLocalStore(): Promise<LocalStore> {
  const store = getLocalStore();
  await store.initialize();
  return store;
}
