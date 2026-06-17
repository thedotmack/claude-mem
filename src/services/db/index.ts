/**
 * Database Backend Selector
 *
 * Provides dynamic selection between SQLite and MySQL backends
 * based on CLAUDE_MEM_DATABASE_TYPE environment variable.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

// Database type enum
export type DatabaseType = 'sqlite' | 'mysql';

/**
 * Get the configured database type from environment or settings.
 * Priority: CLAUDE_MEM_DATABASE_TYPE env var > settings.json > default (sqlite)
 */
export function getDatabaseType(): DatabaseType {
  // Check environment variable first
  const envType = process.env.CLAUDE_MEM_DATABASE_TYPE;
  if (envType === 'mysql' || envType === 'sqlite') {
    return envType;
  }

  // Check settings file
  try {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const settingsType = (settings as any).CLAUDE_MEM_DATABASE_TYPE;
    if (settingsType === 'mysql' || settingsType === 'sqlite') {
      return settingsType;
    }
  } catch (error) {
    logger.warn('DB', 'Failed to read database type from settings, using default', {}, error as Error);
  }

  // Default to SQLite
  return 'sqlite';
}

/**
 * Check if MySQL is configured
 */
export function isMySQLConfigured(): boolean {
  return getDatabaseType() === 'mysql';
}

/**
 * Database Backend Interface
 */
export interface DatabaseBackend {
  SessionStore: any;
  SessionSearch: any;
  PendingMessageStore?: any;
}

/**
 * Lazy-loaded backend modules
 */
let sqliteModule: any = null;
let mysqlModule: any = null;

async function getSQLiteModule(): Promise<any> {
  if (!sqliteModule) {
    sqliteModule = await import('../sqlite/index.js');
  }
  return sqliteModule;
}

async function getMySQLModule(): Promise<any> {
  if (!mysqlModule) {
    mysqlModule = await import('../mysql/index.js');
  }
  return mysqlModule;
}

/**
 * Create database backend based on configured type
 */
export async function createDatabaseBackend(): Promise<DatabaseBackend> {
  const dbType = getDatabaseType();
  logger.info('DB', `Creating database backend: ${dbType}`);

  if (dbType === 'mysql') {
    const module = await getMySQLModule();
    return {
      SessionStore: module.SessionStore,
      SessionSearch: module.SessionSearch,
      PendingMessageStore: module.PendingMessageStore,
    };
  } else {
    const module = await getSQLiteModule();
    return {
      SessionStore: module.SessionStore,
      SessionSearch: module.SessionSearch,
      PendingMessageStore: module.PendingMessageStore,
    };
  }
}

/**
 * Get the appropriate PendingMessageStore class
 */
export async function getPendingMessageStoreClass(): Promise<any> {
  const dbType = getDatabaseType();

  if (dbType === 'mysql') {
    const module = await getMySQLModule();
    return module.PendingMessageStore;
  } else {
    const module = await getSQLiteModule();
    return module.PendingMessageStore;
  }
}

export { getMySQLConfig } from '../mysql/Database.js';
