/**
 * memU API Client
 *
 * HTTP client for the NevaMind-AI/memU memory system.
 * Supports both cloud API (api.memu.so) and self-hosted instances.
 */

import type {
  MemuConfig,
  MemorizeRequest,
  MemorizeResponse,
  RetrieveRequest,
  RetrieveResponse,
  ListCategoriesResponse,
  CreateItemRequest,
  MemoryItem,
  MemoryCategory,
  CreateCategoryRequest,
} from './types.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_API_URL = 'https://api.memu.so';
const API_VERSION = 'v3';

export class MemuClient {
  private config: MemuConfig;
  private baseUrl: string;

  constructor(config: MemuConfig) {
    this.config = config;
    this.baseUrl = `${config.apiUrl || DEFAULT_API_URL}/api/${API_VERSION}`;
  }

  /**
   * Get the current namespace
   */
  get namespace(): string {
    return this.config.namespace;
  }

  /**
   * Make authenticated HTTP request to memU API
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    if (this.config.namespace) {
      headers['X-Memu-Namespace'] = this.config.namespace;
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`memU API error (${response.status}): ${errorText}`);
      }

      return await response.json() as T;
    } catch (error) {
      logger.error('MEMU', `API request failed: ${method} ${endpoint}`, {}, error as Error);
      throw error;
    }
  }

  // ============================================================================
  // Memorize API
  // ============================================================================

  async memorize(request: MemorizeRequest): Promise<MemorizeResponse> {
    logger.info('MEMU', 'Starting memorize task', {
      modality: request.modality,
      hasContent: !!request.content,
    });

    return this.request<MemorizeResponse>('POST', '/memory/memorize', {
      content: request.content,
      modality: request.modality,
      namespace: request.namespace || this.config.namespace,
    });
  }

  async getMemorizeStatus(taskId: string): Promise<{
    taskId: string;
    status: string;
    progress?: number;
    error?: string;
    result?: MemorizeResponse;
  }> {
    return this.request('GET', `/memory/memorize/status/${taskId}`);
  }

  async waitForMemorize(
    taskId: string,
    timeoutMs: number = 60000,
    pollIntervalMs: number = 1000
  ): Promise<MemorizeResponse> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getMemorizeStatus(taskId);

      if (status.status === 'completed' && status.result) {
        return status.result;
      }

      if (status.status === 'failed') {
        throw new Error(`Memorize task failed: ${status.error || 'Unknown error'}`);
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Memorize task timed out after ${timeoutMs}ms`);
  }

  // ============================================================================
  // Retrieve API
  // ============================================================================

  async retrieve(request: RetrieveRequest): Promise<RetrieveResponse> {
    logger.debug('MEMU', 'Retrieving memories', {
      queryCount: request.queries.length,
      method: request.method || 'rag',
      limit: request.limit,
    });

    return this.request<RetrieveResponse>('POST', '/memory/retrieve', {
      queries: request.queries,
      method: request.method || 'rag',
      limit: request.limit,
      where: request.where ? {
        namespace: request.where.namespace || this.config.namespace,
        category_id: request.where.categoryId,
        memory_types: request.where.memoryTypes,
        tags: request.where.tags,
        date_from: request.where.dateFrom,
        date_to: request.where.dateTo,
      } : { namespace: this.config.namespace },
    });
  }

  // ============================================================================
  // Categories API
  // ============================================================================

  async listCategories(namespace?: string): Promise<ListCategoriesResponse> {
    return this.request<ListCategoriesResponse>('POST', '/memory/categories', {
      namespace: namespace || this.config.namespace,
    });
  }

  async createCategory(request: CreateCategoryRequest): Promise<MemoryCategory> {
    return this.request<MemoryCategory>('POST', '/memory/categories/create', {
      name: request.name,
      description: request.description,
      namespace: this.config.namespace,
    });
  }

  // ============================================================================
  // Memory Items API
  // ============================================================================

  async createItem(request: CreateItemRequest): Promise<MemoryItem> {
    logger.debug('MEMU', 'Creating memory item', {
      type: request.memoryType,
      hasCategory: !!request.categoryId,
      tagCount: request.tags?.length || 0,
    });

    return this.request<MemoryItem>('POST', '/memory/items', {
      memory_type: request.memoryType,
      content: request.content,
      category_id: request.categoryId,
      tags: request.tags,
      metadata: request.metadata,
      namespace: this.config.namespace,
    });
  }

  async getItem(itemId: string): Promise<MemoryItem> {
    return this.request<MemoryItem>('GET', `/memory/items/${itemId}`);
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.request<void>('DELETE', `/memory/items/${itemId}`);
  }

  // ============================================================================
  // Health Check
  // ============================================================================

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.apiUrl || DEFAULT_API_URL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Create a memU client from environment/settings
 */
export function createMemuClient(config?: Partial<MemuConfig>): MemuClient {
  const apiKey = config?.apiKey || process.env.CLAUDE_MEMU_API_KEY || '';
  const apiUrl = config?.apiUrl || process.env.CLAUDE_MEMU_API_URL || DEFAULT_API_URL;
  const namespace = config?.namespace || process.env.CLAUDE_MEMU_NAMESPACE || 'default';

  return new MemuClient({ apiKey, apiUrl, namespace });
}
