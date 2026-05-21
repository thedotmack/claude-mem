import { describe, expect, test } from 'bun:test';
import { parseExternalMemoryConfig } from '../../../src/services/external-memory/config.js';

describe('external memory config', () => {
  test('is disabled by default so local SQLite remains the safe default', () => {
    const config = parseExternalMemoryConfig({});

    expect(config.enabled).toBe(false);
  });

  test('requires Postgres and Valkey URLs when external memory is enabled', () => {
    expect(() => parseExternalMemoryConfig({
      CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
      CLAUDE_MEM_PG_URL: 'postgres://user:pass@localhost:5432/claude_mem',
    })).toThrow('CLAUDE_MEM_VALKEY_URL');

    expect(() => parseExternalMemoryConfig({
      CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
      CLAUDE_MEM_VALKEY_URL: 'redis://localhost:6379/0',
    })).toThrow('CLAUDE_MEM_PG_URL');
  });

  test('parses Postgres and Valkey settings with safe defaults', () => {
    const config = parseExternalMemoryConfig({
      CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
      CLAUDE_MEM_PG_URL: 'postgres://user:pass@localhost:5432/claude_mem',
      CLAUDE_MEM_VALKEY_URL: 'redis://localhost:6379/3',
      CLAUDE_MEM_PG_VECTOR_DIMENSIONS: '768',
      CLAUDE_MEM_EXTERNAL_MEMORY_PREFIX: 'team-memory',
    });

    expect(config).toEqual({
      enabled: true,
      mode: 'mirror',
      pgUrl: 'postgres://user:pass@localhost:5432/claude_mem',
      valkeyUrl: 'redis://localhost:6379/3',
      vectorDimensions: 768,
      valkeyPrefix: 'team-memory',
      cacheTtlSeconds: 86_400,
    });
  });

  test('accepts legacy pgvector, server-beta database, and Redis/Valkey env names as compatibility fallbacks', () => {
    const config = parseExternalMemoryConfig({
      CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
      CLAUDE_MEM_PGVECTOR_URL: 'postgres://legacy-pgvector/db',
      CLAUDE_MEM_REDIS_URL: 'redis://valkey:6379/0',
    });

    expect(config.enabled).toBe(true);
    if (config.enabled) expect(config.mode).toBe('mirror');
    expect(config.pgUrl).toBe('postgres://legacy-pgvector/db');
    expect(config.valkeyUrl).toBe('redis://valkey:6379/0');

    const serverBetaFallback = parseExternalMemoryConfig({
      CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
      CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://server-beta/db',
      CLAUDE_MEM_REDIS_URL: 'redis://valkey:6379/0',
    });

    expect(serverBetaFallback.enabled).toBe(true);
    if (serverBetaFallback.enabled) expect(serverBetaFallback.pgUrl).toBe('postgres://server-beta/db');
  });


  test('can switch external memory from mirror to primary mode', () => {
    const config = parseExternalMemoryConfig({
      CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
      CLAUDE_MEM_EXTERNAL_MEMORY_MODE: 'primary',
      CLAUDE_MEM_PG_URL: 'postgres://user:pass@localhost:5432/claude_mem',
      CLAUDE_MEM_VALKEY_URL: 'redis://localhost:6379/3',
    });

    expect(config.enabled).toBe(true);
    if (config.enabled) expect(config.mode).toBe('primary');
  });

  test('rejects unknown external memory modes', () => {
    expect(() => parseExternalMemoryConfig({
      CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
      CLAUDE_MEM_EXTERNAL_MEMORY_MODE: 'sqlite-free-ish',
      CLAUDE_MEM_PG_URL: 'postgres://user:pass@localhost:5432/claude_mem',
      CLAUDE_MEM_VALKEY_URL: 'redis://localhost:6379/3',
    })).toThrow('CLAUDE_MEM_EXTERNAL_MEMORY_MODE');
  });

  test('rejects malformed numeric settings instead of truncating them', () => {
    expect(() => parseExternalMemoryConfig({
      CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
      CLAUDE_MEM_PG_URL: 'postgres://user:pass@localhost:5432/claude_mem',
      CLAUDE_MEM_VALKEY_URL: 'redis://localhost:6379/3',
      CLAUDE_MEM_PG_VECTOR_DIMENSIONS: '768px',
    })).toThrow('CLAUDE_MEM_PG_VECTOR_DIMENSIONS must be a positive integer');

    expect(() => parseExternalMemoryConfig({
      CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
      CLAUDE_MEM_PG_URL: 'postgres://user:pass@localhost:5432/claude_mem',
      CLAUDE_MEM_VALKEY_URL: 'redis://localhost:6379/3',
      CLAUDE_MEM_EXTERNAL_MEMORY_CACHE_TTL_SECONDS: '0',
    })).toThrow('CLAUDE_MEM_EXTERNAL_MEMORY_CACHE_TTL_SECONDS must be a positive integer');
  });
});
