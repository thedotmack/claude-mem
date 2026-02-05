/**
 * IStorageBackend Interface
 *
 * Abstract interface for memory storage backends.
 * Implementations: SQLite (legacy), memU (new)
 */

import type { MemoryType } from '../services/memu/types.js';

// ============================================================================
// Session Types
// ============================================================================

export interface SessionRef {
  sessionDbId: number;
  contentSessionId: string;
  memorySessionId: string | null;
  project: string;
  userPrompt: string;
}

export interface SessionRecord {
  id: number;
  contentSessionId: string;
  memorySessionId: string | null;
  project: string;
  userPrompt: string;
  createdAt: string;
}

// ============================================================================
// Memory/Observation Types
// ============================================================================

export interface ExtractedMemory {
  type: MemoryType;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  promptNumber?: number;
}

export interface StoredMemory extends ExtractedMemory {
  id: number | string;
  memorySessionId: string;
  project: string;
  text?: string;
  discoveryTokens?: number;
  createdAt: string;
  createdAtEpoch: number;
}

// ============================================================================
// Summary Types
// ============================================================================

export interface SessionSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  nextSteps: string | null;
  notes?: string | null;
  promptNumber?: number;
}

export interface StoredSummary extends SessionSummary {
  id: number | string;
  memorySessionId: string;
  project: string;
  discoveryTokens?: number;
  createdAt: string;
  createdAtEpoch: number;
}

// ============================================================================
// User Prompt Types
// ============================================================================

export interface UserPrompt {
  sessionDbId: number;
  project: string;
  content: string;
  promptNumber: number;
}

export interface StoredUserPrompt extends UserPrompt {
  id: number | string;
  createdAt: string;
  createdAtEpoch: number;
}

// ============================================================================
// Query/Filter Types
// ============================================================================

export interface MemoryQuery {
  project?: string;
  types?: MemoryType[];
  concepts?: string[];
  files?: string[];
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export interface SearchQuery extends MemoryQuery {
  text?: string;
  method?: 'semantic' | 'keyword' | 'hybrid';
}

// ============================================================================
// Storage Backend Interface
// ============================================================================

export interface IStorageBackend {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;

  // Session CRUD
  createSession(
    contentSessionId: string,
    project: string,
    userPrompt: string
  ): Promise<SessionRef>;

  getSessionById(sessionId: number): Promise<SessionRecord | null>;

  getSessionByContentId(contentSessionId: string): Promise<SessionRecord | null>;

  updateMemorySessionId(
    sessionDbId: number,
    memorySessionId: string
  ): Promise<void>;

  // Memory/Observation CRUD
  storeMemory(
    memorySessionId: string,
    project: string,
    memory: ExtractedMemory
  ): Promise<StoredMemory>;

  getMemoryById(id: number | string): Promise<StoredMemory | null>;

  getMemoriesBySessionId(
    memorySessionId: string,
    options?: MemoryQuery
  ): Promise<StoredMemory[]>;

  getRecentMemories(
    project: string,
    limit: number
  ): Promise<StoredMemory[]>;

  // Summary CRUD
  storeSummary(
    memorySessionId: string,
    project: string,
    summary: SessionSummary
  ): Promise<StoredSummary>;

  getSummaryBySessionId(memorySessionId: string): Promise<StoredSummary | null>;

  getRecentSummaries(
    project: string,
    limit: number
  ): Promise<StoredSummary[]>;

  // User Prompt CRUD
  storeUserPrompt(prompt: UserPrompt): Promise<StoredUserPrompt>;

  getLatestPrompt(sessionDbId: number): Promise<StoredUserPrompt | null>;

  // Search/Query
  searchMemories(query: SearchQuery): Promise<StoredMemory[]>;

  searchSummaries(query: SearchQuery): Promise<StoredSummary[]>;

  // Files
  getFilesForSession(memorySessionId: string): Promise<{
    filesRead: string[];
    filesModified: string[];
  }>;

  // Utility
  getStats(): Promise<{
    totalMemories: number;
    totalSummaries: number;
    totalSessions: number;
  }>;
}

// ============================================================================
// Backend Type Enum
// ============================================================================

export type StorageBackendType = 'sqlite' | 'memu';
