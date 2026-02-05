/**
 * memU API Types
 *
 * Type definitions for the NevaMind-AI/memU memory system.
 * Based on memU v3 API: https://github.com/NevaMind-AI/memU
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface MemuConfig {
  apiKey: string;
  apiUrl: string;
  namespace: string;
  llmProfile?: LLMProfile;
}

export interface LLMProfile {
  apiKey: string;
  chatModel: string;
  embedModel?: string;
  baseUrl?: string;
}

// ============================================================================
// Memory Category Types
// ============================================================================

export interface MemoryCategory {
  id: string;
  name: string;
  description: string;
  summary?: string;
  itemCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateCategoryRequest {
  name: string;
  description: string;
}

// ============================================================================
// Memory Item Types
// ============================================================================

export interface MemoryItem {
  id: string;
  categoryId?: string;
  memoryType: MemoryType;
  content: string;
  summary?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

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
  | 'skill'
  | 'preference';

export interface CreateMemoryItemRequest {
  memoryType: MemoryType;
  content: string;
  categoryId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Resource Types (for memorize)
// ============================================================================

export interface MemoryResource {
  id: string;
  url?: string;
  content?: string;
  modality: ResourceModality;
  items?: MemoryItem[];
  categories?: MemoryCategory[];
  createdAt: string;
}

export type ResourceModality =
  | 'conversation'
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'code';

// ============================================================================
// Memorize API Types
// ============================================================================

export interface MemorizeRequest {
  resourceUrl?: string;
  content?: string;
  modality: ResourceModality;
  userId?: string;
  namespace?: string;
  categories?: CreateCategoryRequest[];
}

export interface MemorizeResponse {
  taskId: string;
  status: MemorizeStatus;
  resource?: MemoryResource;
  items?: MemoryItem[];
  categories?: MemoryCategory[];
}

export type MemorizeStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export interface MemorizeStatusResponse {
  taskId: string;
  status: MemorizeStatus;
  progress?: number;
  error?: string;
  result?: MemorizeResponse;
}

// ============================================================================
// Retrieve API Types
// ============================================================================

export interface RetrieveRequest {
  queries: RetrieveQuery[];
  method?: RetrieveMethod;
  limit?: number;
  where?: RetrieveFilter;
}

export interface RetrieveQuery {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type RetrieveMethod = 'rag' | 'llm';

export interface RetrieveFilter {
  userId?: string;
  namespace?: string;
  categoryId?: string;
  memoryTypes?: MemoryType[];
  tags?: string[];
  dateFrom?: string;
  dateTo?: string;
}

export interface RetrieveResponse {
  items: RetrievedItem[];
  proactiveContext?: string;
  queryAnalysis?: QueryAnalysis;
}

export interface RetrievedItem {
  id: string;
  summary: string;
  content?: string;
  memoryType: MemoryType;
  relevanceScore: number;
  category?: MemoryCategory;
  metadata?: Record<string, unknown>;
}

export interface QueryAnalysis {
  intent: string;
  entities: string[];
  suggestedCategories?: string[];
}

// ============================================================================
// Categories API Types
// ============================================================================

export interface ListCategoriesRequest {
  namespace?: string;
  userId?: string;
}

export interface ListCategoriesResponse {
  categories: MemoryCategory[];
}

// ============================================================================
// Claude-memu Specific Mappings
// ============================================================================

/**
 * Mapped from claude-mem observation to memU item
 */
export interface ObservationToMemuMapping {
  type: MemoryType;
  title: string;
  subtitle?: string;
  facts: string[];
  narrative?: string;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
}

/**
 * Mapped from claude-mem session summary to memU category
 */
export interface SummaryToMemuMapping {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  nextSteps: string;
}

/**
 * Session reference for tracking memU resources
 */
export interface MemuSessionRef {
  sessionDbId: number;
  contentSessionId: string;
  memuResourceId?: string;
  memuTaskId?: string;
  project: string;
  namespace: string;
}
