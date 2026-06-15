/**
 * Database Factory
 *
 * Provides a unified entry point for database operations based on
 * CLAUDE_MEM_DATABASE_TYPE setting ('sqlite' or 'mysql').
 *
 * The factory returns either a SQLite or MySQL database instance,
 * abstracting away the differences between the two backends.
 */

import { getDatabaseType } from '../shared/paths.js';
import { logger } from '../utils/logger.js';

export type DatabaseBackend = 'sqlite' | 'mysql';

/**
 * Get the current database backend type
 */
export function getDatabaseBackend(): DatabaseBackend {
  const type = getDatabaseType().toLowerCase();
  if (type === 'mysql') return 'mysql';
  return 'sqlite';
}

/**
 * Check if MySQL backend is being used
 */
export function isMySQL(): boolean {
  return getDatabaseBackend() === 'mysql';
}

/**
 * Check if SQLite backend is being used
 */
export function isSQLite(): boolean {
  return getDatabaseBackend() === 'sqlite';
}

/**
 * Create and initialize the appropriate database
 *
 * For SQLite: Returns a synchronous ClaudeMemDatabase instance
 * For MySQL: Returns an async ClaudeMemMySQLDatabase instance (must call initialize())
 *
 * Usage:
 *   if (isMySQL()) {
 *     const mysqlDb = new ClaudeMemMySQLDatabase();
 *     await mysqlDb.initialize();
 *   } else {
 *     const sqliteDb = new ClaudeMemDatabase();
 *   }
 */
export async function createDatabase(): Promise<any> {
  const backend = getDatabaseBackend();
  logger.info('DB', `Creating database with backend: ${backend}`);

  if (backend === 'mysql') {
    const { MySQLDatabase, getMySQLConfig } = await import('./mysql/Database.js');
    const config = getMySQLConfig();
    const db = new MySQLDatabase(config);
    return db;
  } else {
    const { ClaudeMemDatabase } = await import('./sqlite/Database.js');
    const db = new ClaudeMemDatabase();
    return db;
  }
}
