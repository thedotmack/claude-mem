/**
 * IMemoryClient — the abstraction layer for memory backends.
 *
 * Commands use this interface, never a concrete client directly.
 * Today: WorkerClient (HTTP to memory worker).
 * Future: SQLiteClient, Mem0MCPClient, AgentFSClient, etc.
 */

import type {
  SearchParams, TimelineParams, BatchParams, ListParams,
  SearchResponse, TimelineResponse, Observation,
  WorkerStats, ProjectsResponse, ProcessingStatus,
  QueueResponse, SettingsMap, LogsResponse,
  SaveMemoryResponse, ImportPayload, ImportResult,
  BranchInfo, PaginatedResponse, SessionSummary,
} from './types.js';

export interface IMemoryClient {
  // Health
  isHealthy(): Promise<boolean>;

  // Search (progressive disclosure)
  search(params: SearchParams): Promise<SearchResponse>;
  timeline(params: TimelineParams): Promise<TimelineResponse>;
  getObservations(params: BatchParams): Promise<Observation[]>;

  // Data browsing
  getObservationById(id: number): Promise<Observation>;
  listObservations(params: ListParams): Promise<PaginatedResponse<Observation>>;
  listSummaries(params: ListParams): Promise<PaginatedResponse<SessionSummary>>;
  getStats(): Promise<WorkerStats>;
  getProjects(): Promise<ProjectsResponse>;

  // Semantic shortcuts
  decisions(params: ListParams): Promise<SearchResponse>;
  changes(params: ListParams): Promise<SearchResponse>;
  howItWorks(params: ListParams): Promise<SearchResponse>;

  // Context
  getContext(project: string, options?: { full?: boolean; colors?: boolean }): Promise<string>;

  // Memory management
  saveMemory(text: string, title?: string, project?: string): Promise<SaveMemoryResponse>;
  importData(data: ImportPayload): Promise<ImportResult>;

  // Settings
  getSettings(): Promise<SettingsMap>;
  updateSettings(settings: Partial<SettingsMap>): Promise<{ success: boolean; message?: string }>;

  // Logs
  getLogs(lines?: number): Promise<LogsResponse>;
  clearLogs(): Promise<{ success: boolean; message: string }>;

  // Processing
  getProcessingStatus(): Promise<ProcessingStatus>;
  getPendingQueue(): Promise<QueueResponse>;
  processPendingQueue(sessionLimit?: number): Promise<{ success: boolean }>;
  clearFailedQueue(): Promise<{ success: boolean; clearedCount: number }>;
  clearAllQueue(): Promise<{ success: boolean; clearedCount: number }>;

  // Branch
  getBranchStatus(): Promise<BranchInfo>;

  // Discovery
  searchHelp(): Promise<Record<string, unknown>>;

  // Live stream
  connectStream(): Promise<Response>;
}
