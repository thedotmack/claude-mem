// SPDX-License-Identifier: Apache-2.0

export type ExternalMemoryMode = 'mirror' | 'primary';

export type ExternalMemoryConfig =
  | { enabled: false }
  | {
      enabled: true;
      mode: ExternalMemoryMode;
      pgUrl: string;
      valkeyUrl: string;
      vectorDimensions: number;
      valkeyPrefix: string;
      cacheTtlSeconds: number;
    };

export interface ExternalMemoryEnv {
  [key: string]: string | undefined;
  CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED?: string;
  CLAUDE_MEM_PG_URL?: string;
  CLAUDE_MEM_PG_VECTOR_DIMENSIONS?: string;
  CLAUDE_MEM_SERVER_DATABASE_URL?: string;
  CLAUDE_MEM_VALKEY_URL?: string;
  CLAUDE_MEM_REDIS_URL?: string;
  CLAUDE_MEM_EXTERNAL_MEMORY_PREFIX?: string;
  CLAUDE_MEM_EXTERNAL_MEMORY_CACHE_TTL_SECONDS?: string;
  CLAUDE_MEM_EXTERNAL_MEMORY_MODE?: string;
  CLAUDE_MEM_WORKER_PORT?: string;
}

const DEFAULT_VECTOR_DIMENSIONS = 1536;
const DEFAULT_CACHE_TTL_SECONDS = 86_400;

export function parseExternalMemoryConfig(env: ExternalMemoryEnv = process.env): ExternalMemoryConfig {
  if (!isEnabled(env.CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED)) {
    return { enabled: false };
  }

  const pgUrl = firstNonEmpty(
    env.CLAUDE_MEM_PG_URL,
    env.CLAUDE_MEM_SERVER_DATABASE_URL
  );
  if (!pgUrl) {
    throw new Error('CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED=true requires CLAUDE_MEM_PG_URL or CLAUDE_MEM_SERVER_DATABASE_URL');
  }

  const valkeyUrl = firstNonEmpty(env.CLAUDE_MEM_VALKEY_URL, env.CLAUDE_MEM_REDIS_URL);
  if (!valkeyUrl) {
    throw new Error('CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED=true requires CLAUDE_MEM_VALKEY_URL or CLAUDE_MEM_REDIS_URL');
  }

  return {
    enabled: true,
    mode: parseMode(env.CLAUDE_MEM_EXTERNAL_MEMORY_MODE),
    pgUrl,
    valkeyUrl,
    vectorDimensions: parsePositiveInt(
      env.CLAUDE_MEM_PG_VECTOR_DIMENSIONS,
      DEFAULT_VECTOR_DIMENSIONS,
      'CLAUDE_MEM_PG_VECTOR_DIMENSIONS'
    ),
    valkeyPrefix: sanitizePrefix(env.CLAUDE_MEM_EXTERNAL_MEMORY_PREFIX || defaultPrefix(env)),
    cacheTtlSeconds: parsePositiveInt(env.CLAUDE_MEM_EXTERNAL_MEMORY_CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS, 'CLAUDE_MEM_EXTERNAL_MEMORY_CACHE_TTL_SECONDS'),
  };
}

function isEnabled(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseMode(value: string | undefined): ExternalMemoryMode {
  const normalized = (value ?? 'mirror').trim().toLowerCase();
  if (normalized === 'mirror' || normalized === 'primary') {
    return normalized;
  }
  throw new Error('CLAUDE_MEM_EXTERNAL_MEMORY_MODE must be mirror or primary');
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  return parsed;
}

function defaultPrefix(env: ExternalMemoryEnv): string {
  const port = env.CLAUDE_MEM_WORKER_PORT?.trim();
  return port ? `claude_mem_external_${port}` : 'claude_mem_external';
}

function sanitizePrefix(value: string): string {
  return (value.trim() || 'claude_mem_external').replace(/[^a-zA-Z0-9_-]/g, '_');
}
