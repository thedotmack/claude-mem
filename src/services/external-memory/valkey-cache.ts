// SPDX-License-Identifier: Apache-2.0

import type { ExternalMemoryCacheItem } from './types.js';

export interface ValkeyLikeClient {
  set(...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  zadd(...args: unknown[]): Promise<unknown>;
  zrevrange(...args: unknown[]): Promise<string[]>;
  expire(...args: unknown[]): Promise<unknown>;
}

export interface ExternalMemoryValkeyCacheOptions {
  prefix: string;
  ttlSeconds: number;
}

export class ExternalMemoryValkeyCache {
  private readonly prefix: string;

  constructor(
    private readonly client: ValkeyLikeClient,
    private readonly options: ExternalMemoryValkeyCacheOptions
  ) {
    this.prefix = sanitizePrefix(options.prefix);
  }

  async cacheItem(item: ExternalMemoryCacheItem): Promise<void> {
    const itemKey = this.itemKey(item.id);
    const recentKey = this.recentKey(item.project);

    await this.client.set(itemKey, JSON.stringify(item), 'EX', this.options.ttlSeconds);
    await this.client.zadd(recentKey, item.createdAtEpoch, String(item.id));
    await this.client.expire(recentKey, this.options.ttlSeconds);
  }

  async getItem(id: number): Promise<ExternalMemoryCacheItem | null> {
    const raw = await this.client.get(this.itemKey(id));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as ExternalMemoryCacheItem;
  }

  async getRecentIds(project: string, limit: number): Promise<number[]> {
    const ids = await this.client.zrevrange(this.recentKey(project), 0, Math.max(0, limit - 1));
    return ids.map(id => Number(id)).filter(id => Number.isFinite(id));
  }

  private itemKey(id: number): string {
    return `${this.prefix}:item:${id}`;
  }

  private recentKey(project: string): string {
    return `${this.prefix}:project:${sanitizeProject(project)}:recent`;
  }
}

function sanitizePrefix(value: string): string {
  return (value.trim() || 'claude_mem_external').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sanitizeProject(value: string): string {
  return (value.trim() || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}
