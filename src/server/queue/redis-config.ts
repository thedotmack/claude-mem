// SPDX-License-Identifier: Apache-2.0

import type { RedisOptions } from 'ioredis';
import { existsSync } from 'fs';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import type { SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export type ObservationQueueEngineName = 'sqlite' | 'bullmq';
export type RedisMode = 'external' | 'managed' | 'docker';

export interface RedisQueueConfig {
  engine: ObservationQueueEngineName;
  mode: RedisMode;
  url: string | null;
  host: string;
  port: number;
  prefix: string;
  connection: RedisOptions;
}

export function getObservationQueueEngineName(): ObservationQueueEngineName {
  const raw = getQueueSetting('CLAUDE_MEM_QUEUE_ENGINE').trim().toLowerCase();
  if (raw === 'sqlite' || raw === 'bullmq') {
    return raw;
  }
  throw new Error(`Invalid CLAUDE_MEM_QUEUE_ENGINE=${raw}; expected sqlite or bullmq`);
}

export function getRedisQueueConfig(): RedisQueueConfig {
  const engine = getObservationQueueEngineName();
  const mode = normalizeRedisMode(getQueueSetting('CLAUDE_MEM_REDIS_MODE'));
  const url = getQueueSetting('CLAUDE_MEM_REDIS_URL').trim() || null;
  const host = getQueueSetting('CLAUDE_MEM_REDIS_HOST').trim() || '127.0.0.1';
  const port = parseRedisPort(getQueueSetting('CLAUDE_MEM_REDIS_PORT'));
  const prefix = sanitizePrefix(getQueueSetting('CLAUDE_MEM_QUEUE_REDIS_PREFIX'));
  const connection = url ? connectionFromUrl(url) : connectionFromHost(host, port);

  return {
    engine,
    mode,
    url,
    host: url ? describeUrlHost(url).host : host,
    port: url ? describeUrlHost(url).port : port,
    prefix,
    connection,
  };
}

function getQueueSetting(key: keyof SettingsDefaults): string {
  if (process.env[key] !== undefined) {
    return process.env[key]!;
  }
  if (existsSync(USER_SETTINGS_PATH)) {
    return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)[key];
  }
  return SettingsDefaultsManager.get(key);
}

function normalizeRedisMode(value: string): RedisMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'external' || normalized === 'managed' || normalized === 'docker') {
    return normalized;
  }
  throw new Error(`Invalid CLAUDE_MEM_REDIS_MODE=${value}; expected external, managed, or docker`);
}

function parseRedisPort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid CLAUDE_MEM_REDIS_PORT=${value}; expected a TCP port`);
  }
  return port;
}

function sanitizePrefix(value: string): string {
  return (value.trim() || 'claude_mem').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function connectionFromHost(host: string, port: number): RedisOptions {
  return {
    host,
    port,
    maxRetriesPerRequest: null,
    // 1s connectTimeout is too aggressive for cold-start Docker
    // stacks where Valkey may take 5–10s to accept connections. 10s gives
    // the queue engine room to come up gracefully without spamming errors.
    connectTimeout: 10000,
    // reconnect with exponential-ish backoff capped at 5s so a
    // restarted Valkey container is reconnected within seconds instead of
    // failing fast on first transient error.
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    // wait for Redis to send a READY response before sending
    // commands. Prevents BullMQ from racing the boot sequence and getting
    // 'LOADING' replies on a fresh Valkey.
    enableReadyCheck: true,
    lazyConnect: true,
  };
}

function connectionFromUrl(rawUrl: string): RedisOptions {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('CLAUDE_MEM_REDIS_URL must use redis:// or rediss://');
  }
  const db = parsed.pathname.length > 1
    ? Number.parseInt(parsed.pathname.slice(1), 10)
    : undefined;
  if (db !== undefined && (!Number.isInteger(db) || db < 0)) {
    throw new Error(`Invalid Redis database in CLAUDE_MEM_REDIS_URL: ${parsed.pathname}`);
  }
  return {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
    // see connectionFromHost() above. 10s connectTimeout +
    // exponential retryStrategy + enableReadyCheck make BullMQ resilient to
    // Valkey cold start and transient connection loss.
    connectTimeout: 10000,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    enableReadyCheck: true,
    lazyConnect: true,
  };
}

function describeUrlHost(rawUrl: string): { host: string; port: number } {
  const parsed = new URL(rawUrl);
  return {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
  };
}
