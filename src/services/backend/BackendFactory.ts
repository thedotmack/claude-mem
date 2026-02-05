/**
 * BackendFactory
 *
 * Factory for creating storage backend instances based on configuration.
 * Supports SQLite (legacy) and memU (new) backends.
 */

import type { IStorageBackend, StorageBackendType } from '../../interfaces/IStorageBackend.js';
import { MemuAdapter } from '../memu/memu-adapter.js';
import { logger } from '../../utils/logger.js';

/**
 * Get the configured backend type from settings/environment
 */
export function getBackendType(): StorageBackendType {
  const backend = process.env.CLAUDE_MEMU_BACKEND || 'memu';
  if (backend === 'sqlite' || backend === 'memu') {
    return backend;
  }
  logger.warn('BACKEND', `Unknown backend type: ${backend}, defaulting to memu`);
  return 'memu';
}

/**
 * Create a storage backend instance based on configuration
 */
export async function createBackend(type?: StorageBackendType): Promise<IStorageBackend> {
  const backendType = type || getBackendType();

  logger.info('BACKEND', `Creating ${backendType} backend`);

  switch (backendType) {
    case 'memu': {
      const adapter = new MemuAdapter({
        apiKey: process.env.CLAUDE_MEMU_API_KEY,
        apiUrl: process.env.CLAUDE_MEMU_API_URL,
        namespace: process.env.CLAUDE_MEMU_NAMESPACE,
      });
      await adapter.initialize();
      return adapter;
    }

    case 'sqlite': {
      // Lazy import to avoid loading SQLite when not needed
      const { SqliteAdapter } = await import('./SqliteAdapter.js');
      const adapter = new SqliteAdapter();
      await adapter.initialize();
      return adapter;
    }

    default:
      throw new Error(`Unknown backend type: ${backendType}`);
  }
}

/**
 * Check if memU backend is available (API key configured)
 */
export function isMemuConfigured(): boolean {
  const apiKey = process.env.CLAUDE_MEMU_API_KEY;
  return !!apiKey && apiKey.length > 0;
}

/**
 * Get backend configuration summary for logging
 */
export function getBackendConfig(): {
  type: StorageBackendType;
  memuConfigured: boolean;
  memuApiUrl: string;
  memuNamespace: string;
} {
  return {
    type: getBackendType(),
    memuConfigured: isMemuConfigured(),
    memuApiUrl: process.env.CLAUDE_MEMU_API_URL || 'https://api.memu.so',
    memuNamespace: process.env.CLAUDE_MEMU_NAMESPACE || 'default',
  };
}
