/**
 * HTTP client for the memory worker API.
 * Thin wrapper over fetch with timeout, error mapping, and typed responses.
 * Implements IMemoryClient for backend-agnostic command consumption.
 */

import type { CMEMConfig } from './config.js';
import { CLIError, ExitCode, workerNotRunning, workerError, notFoundError, maskPath } from './errors.js';
import type { IMemoryClient } from './memory-client.js';
import type {
  SearchParams, TimelineParams, BatchParams, ListParams,
  SearchResponse, TimelineResponse, Observation,
  WorkerStats, ProjectsResponse, ProcessingStatus,
  QueueResponse, SettingsMap, LogsResponse,
  SaveMemoryResponse, ImportPayload, ImportResult,
  BranchInfo, PaginatedResponse, SessionSummary,
} from './types.js';

export class WorkerClient implements IMemoryClient {
  private baseUrl: string;
  private readTimeout: number;
  private writeTimeout: number;

  constructor(config: CMEMConfig, readTimeout = 5000, writeTimeout = 30000) {
    this.baseUrl = config.baseUrl;
    this.readTimeout = readTimeout;
    this.writeTimeout = writeTimeout;
  }

  // --- Health ---

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.rawFetch('/health', { timeout: 2000 });
      return res.ok;
    } catch {
      return false;
    }
  }

  // --- Generic HTTP ---

  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await this.rawFetch(url.pathname + url.search, { timeout: this.readTimeout });
    return this.handleResponse<T>(res);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.rawFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      timeout: this.writeTimeout,
    });
    return this.handleResponse<T>(res);
  }

  async del<T>(path: string): Promise<T> {
    const res = await this.rawFetch(path, {
      method: 'DELETE',
      timeout: this.writeTimeout,
    });
    return this.handleResponse<T>(res);
  }

  // --- Typed API Methods ---

  async search(params: SearchParams): Promise<SearchResponse> {
    const qp: Record<string, string | number | undefined> = {
      query: params.query,
      type: params.type,
      limit: params.limit,
      offset: params.offset,
      project: params.project,
      obs_type: params.obsType,
      date_start: params.dateStart,
      date_end: params.dateEnd,
      order: params.order,
    };
    return this.get<SearchResponse>('/api/search', qp);
  }

  async timeline(params: TimelineParams): Promise<TimelineResponse> {
    if (params.query) {
      return this.get<TimelineResponse>('/api/timeline/by-query', {
        query: params.query,
        depth_before: params.depthBefore,
        depth_after: params.depthAfter,
        project: params.project,
        mode: params.mode,
      });
    }
    return this.get<TimelineResponse>('/api/timeline', {
      anchor: params.anchor,
      depth_before: params.depthBefore,
      depth_after: params.depthAfter,
      project: params.project,
    });
  }

  async getObservations(params: BatchParams): Promise<Observation[]> {
    return this.post<Observation[]>('/api/observations/batch', {
      ids: params.ids,
      orderBy: params.orderBy,
      limit: params.limit,
      project: params.project,
    });
  }

  async getObservationById(id: number): Promise<Observation> {
    return this.get<Observation>(`/api/observation/${id}`);
  }

  async listObservations(params: ListParams): Promise<PaginatedResponse<Observation>> {
    return this.get<PaginatedResponse<Observation>>('/api/observations', {
      offset: params.offset,
      limit: params.limit,
      project: params.project,
    });
  }

  async listSummaries(params: ListParams): Promise<PaginatedResponse<SessionSummary>> {
    return this.get<PaginatedResponse<SessionSummary>>('/api/summaries', {
      offset: params.offset,
      limit: params.limit,
      project: params.project,
    });
  }

  async getStats(): Promise<WorkerStats> {
    return this.get<WorkerStats>('/api/stats');
  }

  async getProjects(): Promise<ProjectsResponse> {
    return this.get<ProjectsResponse>('/api/projects');
  }

  async decisions(params: ListParams): Promise<SearchResponse> {
    return this.get<SearchResponse>('/api/decisions', {
      limit: params.limit,
      project: params.project,
    });
  }

  async changes(params: ListParams): Promise<SearchResponse> {
    return this.get<SearchResponse>('/api/changes', {
      limit: params.limit,
      project: params.project,
    });
  }

  async howItWorks(params: ListParams): Promise<SearchResponse> {
    return this.get<SearchResponse>('/api/how-it-works', {
      limit: params.limit,
      project: params.project,
    });
  }

  async getContext(project: string, options?: { full?: boolean; colors?: boolean }): Promise<string> {
    const url = new URL('/api/context/inject', this.baseUrl);
    url.searchParams.set('project', project);
    if (options?.full) url.searchParams.set('full', 'true');
    if (options?.colors) url.searchParams.set('colors', 'true');
    const res = await this.rawFetch(url.pathname + url.search, { timeout: this.readTimeout });
    if (!res.ok) {
      throw workerError(`Context inject failed: ${res.status}`);
    }
    return res.text();
  }

  async saveMemory(text: string, title?: string, project?: string): Promise<SaveMemoryResponse> {
    return this.post<SaveMemoryResponse>('/api/memory/save', { text, title, project });
  }

  async getSettings(): Promise<SettingsMap> {
    return this.get<SettingsMap>('/api/settings');
  }

  async updateSettings(settings: Partial<SettingsMap>): Promise<{ success: boolean; message?: string }> {
    return this.post('/api/settings', settings);
  }

  async getLogs(lines?: number): Promise<LogsResponse> {
    return this.get<LogsResponse>('/api/logs', { lines });
  }

  async clearLogs(): Promise<{ success: boolean; message: string }> {
    return this.post('/api/logs/clear');
  }

  async getProcessingStatus(): Promise<ProcessingStatus> {
    return this.get<ProcessingStatus>('/api/processing-status');
  }

  async getPendingQueue(): Promise<QueueResponse> {
    return this.get<QueueResponse>('/api/pending-queue');
  }

  async processPendingQueue(sessionLimit?: number): Promise<{ success: boolean }> {
    return this.post('/api/pending-queue/process', { sessionLimit });
  }

  async clearFailedQueue(): Promise<{ success: boolean; clearedCount: number }> {
    return this.del('/api/pending-queue/failed');
  }

  async clearAllQueue(): Promise<{ success: boolean; clearedCount: number }> {
    return this.del('/api/pending-queue/all');
  }

  async importData(data: ImportPayload): Promise<ImportResult> {
    return this.post<ImportResult>('/api/import', data);
  }

  async getBranchStatus(): Promise<BranchInfo> {
    return this.get<BranchInfo>('/api/branch/status');
  }

  async searchHelp(): Promise<Record<string, unknown>> {
    return this.get('/api/search/help');
  }

  // --- SSE Stream ---

  async connectStream(): Promise<Response> {
    const res = await this.rawFetch('/stream', {
      headers: { 'Accept': 'text/event-stream' },
      timeout: 0, // no timeout for SSE
    });
    if (!res.ok) {
      throw workerError(`Stream connection failed: ${res.status}`);
    }
    return res;
  }

  // --- Internal ---

  private async rawFetch(
    path: string,
    options: RequestInit & { timeout?: number } = {},
  ): Promise<Response> {
    const { timeout, ...fetchOptions } = options;
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeout);
    }

    try {
      const res = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      return res;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw workerNotRunning(this.baseUrl);
      }
      if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('connect'))) {
        throw workerNotRunning(this.baseUrl);
      }
      throw new CLIError(
        `Request failed: ${maskPath((err as Error).message)}`,
        ExitCode.CONNECTION_ERROR,
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    if (res.status === 404) {
      const body = await res.text();
      throw notFoundError(body || 'Not found');
    }
    if (!res.ok) {
      let body: string;
      try {
        body = await res.text();
      } catch {
        body = `HTTP ${res.status}`;
      }
      throw workerError(body);
    }
    return res.json() as Promise<T>;
  }
}
