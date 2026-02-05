/**
 * memU Types
 *
 * Type definitions for claude-memu using NevaMind-AI/memU.
 * Simplified and optimized for direct memU integration.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface MemuConfig {
  apiKey: string;
  apiUrl: string;
  namespace: string;
}

// ============================================================================
// Core Memory Types
// ============================================================================

export type MemoryType =
  | 'decision'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'discovery'
  | 'change'
  | 'conversation'
  | 'document'
  | 'fact'
  | 'skill';

export interface MemoryCategory {
  id: string;
  name: string;
  description: string;
  summary?: string;
  itemCount?: number;
  createdAt?: string;
}

export interface MemoryItem {
  id: string;
  categoryId?: string;
  memoryType: MemoryType;
  content: string;
  summary?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ============================================================================
// Session Types
// ============================================================================

export interface Session {
  id: number;
  contentSessionId: string;
  memorySessionId: string | null;
  project: string;
  userPrompt: string;
  promptCounter: number;
  status: 'active' | 'completed' | 'failed';
  createdAt: string;
  createdAtEpoch: number;
}

// ============================================================================
// Observation Types
// ============================================================================

export interface Observation {
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

export interface StoredObservation extends Observation {
  id: string;
  memorySessionId: string;
  project: string;
  content?: string;
  createdAt: string;
  createdAtEpoch: number;
}

// ============================================================================
// Summary Types
// ============================================================================

export interface Summary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  nextSteps: string | null;
  notes?: string | null;
  promptNumber?: number;
}

export interface StoredSummary extends Summary {
  id: string;
  memorySessionId: string;
  project: string;
  createdAt: string;
  createdAtEpoch: number;
}

// ============================================================================
// User Prompt Types
// ============================================================================

export interface UserPrompt {
  sessionId: number;
  project: string;
  content: string;
  promptNumber: number;
}

export interface StoredUserPrompt extends UserPrompt {
  id: string;
  createdAt: string;
  createdAtEpoch: number;
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchQuery {
  text?: string;
  project?: string;
  types?: MemoryType[];
  concepts?: string[];
  files?: string[];
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  method?: 'rag' | 'llm';
}

export interface SearchResults {
  observations: StoredObservation[];
  summaries: StoredSummary[];
  prompts: StoredUserPrompt[];
  proactiveContext?: string;
}

// ============================================================================
// Context Injection Types
// ============================================================================

export interface ContextPayload {
  recentObservations: StoredObservation[];
  recentSummaries: StoredSummary[];
  proactiveContext?: string;
  project: string;
  sessionCount: number;
}

// ============================================================================
// API Types
// ============================================================================

export interface RetrieveQuery {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface RetrieveRequest {
  queries: RetrieveQuery[];
  method?: 'rag' | 'llm';
  limit?: number;
  where?: {
    namespace?: string;
    categoryId?: string;
    memoryTypes?: MemoryType[];
    tags?: string[];
    dateFrom?: string;
    dateTo?: string;
  };
}

export interface RetrieveResponse {
  items: Array<{
    id: string;
    summary: string;
    content?: string;
    memoryType: MemoryType;
    relevanceScore: number;
    category?: MemoryCategory;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }>;
  proactiveContext?: string;
}

export interface MemorizeRequest {
  content: string;
  modality: 'conversation' | 'document' | 'code';
  namespace?: string;
}

export interface MemorizeResponse {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  items?: MemoryItem[];
  categories?: MemoryCategory[];
}

export interface CreateItemRequest {
  memoryType: MemoryType;
  content: string;
  categoryId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateCategoryRequest {
  name: string;
  description: string;
}

export interface ListCategoriesResponse {
  categories: MemoryCategory[];
}
