/**
 * Type definitions for cmem CLI.
 * Mirrors memory worker API response types.
 */

// --- Search Types ---

export interface SearchResult {
  id: number;
  type: string;
  title: string;
  subtitle?: string;
  timestamp: number;
  project?: string;
  discoveryTokens?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total?: number;
  query?: string;
}

// --- Timeline Types ---

export interface TimelineItem {
  id: number;
  type: 'observation' | 'session' | 'prompt';
  title: string;
  subtitle?: string;
  timestamp: number;
  project?: string;
  isAnchor?: boolean;
}

export interface TimelineResponse {
  items: TimelineItem[];
  anchor?: TimelineItem;
  query?: string;
}

// --- Observation Types ---

export interface Observation {
  id: number;
  session_id: number;
  content_session_id?: string;
  memory_session_id?: string;
  project?: string;
  type: string;
  title: string;
  subtitle?: string;
  narrative?: string;
  facts?: string[];
  concepts?: string[];
  files_read?: string[];
  files_modified?: string[];
  prompt_number?: number;
  discovery_tokens?: number;
  created_at_epoch: number;
}

// --- Session/Summary Types ---

export interface SessionSummary {
  id: number;
  content_session_id?: string;
  memory_session_id?: string;
  project?: string;
  summary_text?: string;
  key_decisions?: string;
  files_modified?: string;
  created_at_epoch: number;
}

// --- Paginated Response ---

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// --- Stats Types ---

export interface WorkerStats {
  worker: {
    version: string;
    uptime: number;
    activeSessions: number;
    sseClients: number;
    port: number;
  };
  database: {
    path: string;
    size: number;
    observations: number;
    sessions: number;
    summaries: number;
  };
}

// --- Projects ---

export interface ProjectsResponse {
  projects: string[];
}

/** A project name paired with its observation count, for richer listings. */
export interface ProjectWithCount {
  name: string;
  observationCount: number;
}

// --- Processing Status ---

export interface ProcessingStatus {
  isProcessing: boolean;
  queueDepth: number;
}

// --- Queue Types ---

export interface QueueMessage {
  id: number;
  session_id: number;
  status: 'pending' | 'processing' | 'failed';
  type: string;
  created_at: number;
  error?: string;
}

export interface QueueResponse {
  queue: {
    messages: QueueMessage[];
    totalPending: number;
    totalProcessing: number;
    totalFailed: number;
    stuckCount: number;
  };
  recentlyProcessed: QueueMessage[];
  sessionsWithPendingWork: number[];
}

// --- Settings ---

export type SettingsMap = Record<string, string>;

// --- Logs ---

export interface LogsResponse {
  logs: string;
  path: string;
  exists: boolean;
  totalLines?: number;
  returnedLines?: number;
}

// --- Memory Save ---

export interface SaveMemoryResponse {
  success: boolean;
  id: number;
  title: string;
  project: string;
  message: string;
}

// --- Import/Export ---

export interface ImportPayload {
  sessions?: unknown[];
  summaries?: unknown[];
  observations?: unknown[];
  prompts?: unknown[];
}

export interface ImportResult {
  success: boolean;
  stats: {
    sessionsImported: number;
    sessionsSkipped: number;
    summariesImported: number;
    summariesSkipped: number;
    observationsImported: number;
    observationsSkipped: number;
    promptsImported: number;
    promptsSkipped: number;
  };
}

// --- Branch ---

export interface BranchInfo {
  branch: string;
  isDefault: boolean;
}

// --- CLI Response Wrapper (for --json output) ---

export interface CLIResponse<T> {
  ok: boolean;
  data: T;
  error?: string;
  code?: number;
  meta?: {
    count?: number;
    hasMore?: boolean;
    offset?: number;
    limit?: number;
    query?: string;
    project?: string;
  };
}

// --- SSE Events ---

export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

// --- Search Params ---

export interface SearchParams {
  query: string;
  type?: string;
  limit?: number;
  offset?: number;
  project?: string;
  obsType?: string;
  dateStart?: string;
  dateEnd?: string;
  order?: string;
}

export interface TimelineParams {
  anchor?: string;
  query?: string;
  depthBefore?: number;
  depthAfter?: number;
  project?: string;
  mode?: string;
}

export interface BatchParams {
  ids: number[];
  orderBy?: string;
  limit?: number;
  project?: string;
}

export interface ListParams {
  limit?: number;
  offset?: number;
  project?: string;
}
