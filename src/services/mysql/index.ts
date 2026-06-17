/**
 * MySQL Database Module
 *
 * Export all MySQL database components for dual backend support.
 */

// Export main database class and config
export { MySQLDatabase, getMySQLConfig, MySQLConfig } from './Database.js';
export type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

// Export session store
export { SessionStore } from './SessionStore.js';

// Export session search
export { SessionSearch } from './SessionSearch.js';

// Export pending message store
export { PendingMessageStore, PersistentPendingMessage } from './PendingMessageStore.js';

// Export migrations
export { migrations, runMigrations, Migration } from './migrations.js';

// Export types
export * from './types.js';