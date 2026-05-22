// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { parseExternalMemoryConfig, type ExternalMemoryConfig } from './config.js';
import { bootstrapExternalMemorySchema } from './schema.js';
import { PgvectorMemoryStore } from './pgvector-store.js';
import type { StorageResult } from '../worker/agents/types.js';
import { ExternalMemoryValkeyCache, type ValkeyLikeClient } from './valkey-cache.js';
import type { ExternalMemoryCacheItem, ExternalMemoryWriteResult } from './types.js';

export interface ExternalMemoryWritableStore {
  upsertObservation(input: {
    sqliteId?: number | null;
    memorySessionId: string;
    project: string;
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string[];
    narrative: string | null;
    concepts: string[];
    filesRead: string[];
    filesModified: string[];
    promptNumber?: number | null;
    discoveryTokens?: number;
    createdAtEpoch: number;
    embedding?: number[] | null;
    metadata?: Record<string, unknown>;
  }): Promise<ExternalMemoryWriteResult>;

  upsertSummary(input: {
    sqliteId?: number | null;
    memorySessionId: string;
    project: string;
    request: string;
    investigated: string;
    learned: string;
    completed: string;
    nextSteps: string;
    notes: string | null;
    promptNumber?: number | null;
    discoveryTokens?: number;
    createdAtEpoch: number;
    embedding?: number[] | null;
    metadata?: Record<string, unknown>;
  }): Promise<ExternalMemoryWriteResult>;
}

export interface ExternalMemoryCache {
  cacheItem(item: ExternalMemoryCacheItem): Promise<void>;
}

export interface ExternalMemoryBatchObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  agent_type?: string | null;
  agent_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ExternalMemoryBatchSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

export interface ExternalMemoryBatchInput {
  memorySessionId: string;
  project: string;
  promptNumber?: number | null;
  discoveryTokens?: number;
  createdAtEpoch: number;
  observationIds: number[];
  observations: ExternalMemoryBatchObservation[];
  summaryId: number | null;
  summary: ExternalMemoryBatchSummary | null;
}

export interface ExternalMemoryPrimaryBatchInput {
  memorySessionId: string;
  project: string;
  promptNumber?: number | null;
  discoveryTokens?: number;
  createdAtEpoch: number;
  observations: ExternalMemoryBatchObservation[];
  summary: ExternalMemoryBatchSummary | null;
}

export interface ExternalMemorySyncResult {
  observationsWritten: number;
  summariesWritten: number;
  cacheWrites: number;
}

export class ExternalMemorySyncService {
  constructor(
    private readonly store: ExternalMemoryWritableStore,
    private readonly cache: ExternalMemoryCache
  ) {}

  async storePrimaryBatch(input: ExternalMemoryPrimaryBatchInput): Promise<StorageResult> {
    const observationIds: number[] = [];

    for (const observation of input.observations) {
      const stored = await this.store.upsertObservation({
        sqliteId: null,
        memorySessionId: input.memorySessionId,
        project: input.project,
        type: observation.type,
        title: observation.title,
        subtitle: observation.subtitle,
        facts: observation.facts,
        narrative: observation.narrative,
        concepts: observation.concepts,
        filesRead: observation.files_read,
        filesModified: observation.files_modified,
        promptNumber: input.promptNumber ?? null,
        discoveryTokens: input.discoveryTokens ?? 0,
        createdAtEpoch: input.createdAtEpoch,
        metadata: {
          ...(observation.metadata ?? {}),
          agent_type: observation.agent_type ?? null,
          agent_id: observation.agent_id ?? null,
          primary: true,
        },
      });
      observationIds.push(stored.id);
      await this.cache.cacheItem({
        id: stored.id,
        project: input.project,
        kind: 'observation',
        content: observation.narrative || observation.title || '',
        createdAtEpoch: stored.createdAtEpoch,
      });
    }

    let summaryId: number | null = null;
    if (input.summary) {
      const stored = await this.store.upsertSummary({
        sqliteId: null,
        memorySessionId: input.memorySessionId,
        project: input.project,
        request: input.summary.request,
        investigated: input.summary.investigated,
        learned: input.summary.learned,
        completed: input.summary.completed,
        nextSteps: input.summary.next_steps,
        notes: input.summary.notes,
        promptNumber: input.promptNumber ?? null,
        discoveryTokens: input.discoveryTokens ?? 0,
        createdAtEpoch: input.createdAtEpoch,
        metadata: { primary: true },
      });
      summaryId = stored.id;
      await this.cache.cacheItem({
        id: stored.id,
        project: input.project,
        kind: 'summary',
        content: input.summary.learned || input.summary.completed || input.summary.request,
        createdAtEpoch: stored.createdAtEpoch,
      });
    }

    return { observationIds, summaryId, createdAtEpoch: input.createdAtEpoch };
  }

  async syncBatch(input: ExternalMemoryBatchInput): Promise<ExternalMemorySyncResult> {
    let observationsWritten = 0;
    let summariesWritten = 0;
    let cacheWrites = 0;

    if (input.observationIds.length !== input.observations.length) {
      logger.warn('EXTERNAL_MEMORY', 'Observation ID count did not match observation count; unmatched observations will be skipped', {
        project: input.project,
        observationCount: input.observations.length,
        observationIdCount: input.observationIds.length,
      });
    }

    for (let index = 0; index < input.observations.length; index++) {
      const observation = input.observations[index];
      const sqliteId = input.observationIds[index];
      if (!observation || sqliteId === undefined) {
        continue;
      }
      try {
        const stored = await this.store.upsertObservation({
          sqliteId,
          memorySessionId: input.memorySessionId,
          project: input.project,
          type: observation.type,
          title: observation.title,
          subtitle: observation.subtitle,
          facts: observation.facts,
          narrative: observation.narrative,
          concepts: observation.concepts,
          filesRead: observation.files_read,
          filesModified: observation.files_modified,
          promptNumber: input.promptNumber ?? null,
          discoveryTokens: input.discoveryTokens ?? 0,
          createdAtEpoch: input.createdAtEpoch,
          metadata: {
            ...(observation.metadata ?? {}),
            agent_type: observation.agent_type ?? null,
            agent_id: observation.agent_id ?? null,
          },
        });
        observationsWritten++;
        await this.cache.cacheItem({
          id: stored.id,
          project: input.project,
          kind: 'observation',
          content: observation.narrative || observation.title || '',
          createdAtEpoch: stored.createdAtEpoch,
        });
        cacheWrites++;
      } catch (error) {
        logger.warn('EXTERNAL_MEMORY', 'Failed to mirror observation to Postgres/Valkey; continuing', {
          sqliteId,
          project: input.project,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (input.summary && input.summaryId !== null) {
      try {
        const stored = await this.store.upsertSummary({
          sqliteId: input.summaryId,
          memorySessionId: input.memorySessionId,
          project: input.project,
          request: input.summary.request,
          investigated: input.summary.investigated,
          learned: input.summary.learned,
          completed: input.summary.completed,
          nextSteps: input.summary.next_steps,
          notes: input.summary.notes,
          promptNumber: input.promptNumber ?? null,
          discoveryTokens: input.discoveryTokens ?? 0,
          createdAtEpoch: input.createdAtEpoch,
        });
        summariesWritten++;
        await this.cache.cacheItem({
          id: stored.id,
          project: input.project,
          kind: 'summary',
          content: input.summary.learned || input.summary.completed || input.summary.request,
          createdAtEpoch: stored.createdAtEpoch,
        });
        cacheWrites++;
      } catch (error) {
        logger.warn('EXTERNAL_MEMORY', 'Failed to mirror summary to Postgres/Valkey; continuing', {
          sqliteId: input.summaryId,
          project: input.project,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { observationsWritten, summariesWritten, cacheWrites };
  }
}

interface ExternalMemoryRuntime {
  key: string;
  pool: PgPoolLike;
  valkey: RedisRuntimeClient;
  service: ExternalMemorySyncService;
  store: PgvectorMemoryStore;
  cache: ExternalMemoryValkeyCache;
  config: Extract<ExternalMemoryConfig, { enabled: true }>;
}

interface PgPoolLike extends PostgresQueryable {
  end(): Promise<void>;
}

interface RedisRuntimeClient extends ValkeyLikeClient {
  quit(): Promise<unknown>;
  disconnect(): void;
}

type PgPoolConstructor = new (options: {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}) => PgPoolLike;

type RedisConstructor = new (
  url: string,
  options: {
    lazyConnect: boolean;
    maxRetriesPerRequest: number;
    connectTimeout: number;
  }
) => RedisRuntimeClient;

type ExternalMemoryDriverLoader = typeof loadExternalMemoryDrivers;

let runtime: ExternalMemoryRuntime | null = null;
let initPromise: Promise<ExternalMemoryRuntime> | null = null;
let externalMemoryDriverLoader: ExternalMemoryDriverLoader = loadExternalMemoryDrivers;

export async function syncExternalMemoryBatchIfEnabled(input: ExternalMemoryBatchInput): Promise<ExternalMemorySyncResult | null> {
  const service = await getExternalMemorySyncService();
  if (!service) {
    return null;
  }
  return service.syncBatch(input);
}

export async function getExternalMemorySyncService(env: NodeJS.ProcessEnv = loadExternalMemoryEnv()): Promise<ExternalMemorySyncService | null> {
  const runtime = await getExternalMemoryRuntime(env);
  return runtime?.service ?? null;
}

export async function storeExternalMemoryBatchAsPrimaryIfEnabled(
  input: ExternalMemoryPrimaryBatchInput,
  env: NodeJS.ProcessEnv = loadExternalMemoryEnv()
): Promise<StorageResult | null> {
  const runtime = await getExternalMemoryRuntime(env);
  if (!runtime || runtime.config.mode !== 'primary') {
    return null;
  }
  return runtime.service.storePrimaryBatch(input);
}

export async function getExternalMemoryPrimaryStore(env: NodeJS.ProcessEnv = loadExternalMemoryEnv()): Promise<PgvectorMemoryStore | null> {
  const runtime = await getExternalMemoryRuntime(env);
  if (!runtime || runtime.config.mode !== 'primary') {
    return null;
  }
  return runtime.store;
}

async function getExternalMemoryRuntime(env: NodeJS.ProcessEnv = loadExternalMemoryEnv()): Promise<ExternalMemoryRuntime | null> {
  const config = parseExternalMemoryConfig(env);
  if (!config.enabled) {
    return null;
  }

  const key = runtimeKey(config);
  if (runtime?.key === key) {
    return runtime;
  }

  if (initPromise) {
    const initialized = await initPromise;
    if (initialized.key === key) {
      return initialized;
    }
  }

  const initializing = initializeExternalMemoryRuntime(config, key);
  initPromise = initializing;
  try {
    return await initializing;
  } finally {
    if (initPromise === initializing) {
      initPromise = null;
    }
  }
}


function loadExternalMemoryEnv(): NodeJS.ProcessEnv {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH) as unknown as NodeJS.ProcessEnv;
  return { ...settings, ...process.env };
}

async function initializeExternalMemoryRuntime(
  config: Extract<ExternalMemoryConfig, { enabled: true }>,
  key: string
): Promise<ExternalMemoryRuntime> {
  if (runtime?.key === key) {
    return runtime;
  }

  await closeExternalMemorySyncService();
  const { Pool, Redis } = await externalMemoryDriverLoader();
  const pool = new Pool({
    connectionString: config.pgUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const valkey = new Redis(config.valkeyUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
  });

  try {
    await bootstrapExternalMemorySchema(pool, { vectorDimensions: config.vectorDimensions });
  } catch (error) {
    await Promise.allSettled([
      pool.end(),
      valkey.quit().catch(() => valkey.disconnect()),
    ]);
    throw error;
  }

  const store = new PgvectorMemoryStore(pool);
  const cache = new ExternalMemoryValkeyCache(valkey as ValkeyLikeClient, {
    prefix: config.valkeyPrefix,
    ttlSeconds: config.cacheTtlSeconds,
  });

  const initialized: ExternalMemoryRuntime = {
    key,
    pool,
    valkey,
    service: new ExternalMemorySyncService(store, cache),
    store,
    cache,
    config,
  };
  runtime = initialized;
  return initialized;
}

async function loadExternalMemoryDrivers(): Promise<{
  Pool: PgPoolConstructor;
  Redis: RedisConstructor;
}> {
  const [pgModuleRaw, redisModuleRaw] = await Promise.all([
    import('pg'),
    import('ioredis'),
  ]);

  const pgModule = pgModuleRaw as unknown as {
    default?: { Pool?: PgPoolConstructor };
    Pool?: PgPoolConstructor;
  };
  const redisModule = redisModuleRaw as unknown as {
    default?: RedisConstructor;
    Redis?: RedisConstructor;
  };

  const Pool = pgModule.Pool ?? pgModule.default?.Pool;
  const Redis = redisModule.Redis ?? redisModule.default;
  if (!Pool) {
    throw new Error('pg driver did not expose Pool');
  }
  if (!Redis) {
    throw new Error('ioredis driver did not expose Redis constructor');
  }
  return { Pool, Redis };
}

export async function closeExternalMemorySyncService(): Promise<void> {
  const current = runtime;
  runtime = null;
  if (!current) {
    return;
  }
  await Promise.allSettled([
    current.pool.end(),
    current.valkey.quit().catch(() => current.valkey.disconnect()),
  ]);
}

export function __setExternalMemoryDriverLoaderForTesting(loader: ExternalMemoryDriverLoader): () => void {
  const previous = externalMemoryDriverLoader;
  externalMemoryDriverLoader = loader;
  return () => {
    externalMemoryDriverLoader = previous;
  };
}

function runtimeKey(config: Extract<ExternalMemoryConfig, { enabled: true }>): string {
  return [
    config.pgUrl,
    config.valkeyUrl,
    config.vectorDimensions,
    config.valkeyPrefix,
    config.cacheTtlSeconds,
    config.mode,
  ].join('\x00');
}
