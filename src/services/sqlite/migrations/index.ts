import { DatabaseManager } from '../Database.js';
import { migration001 } from './001_initial.js';

/**
 * Register all migrations with the database manager
 */
export function registerMigrations(): void {
  const manager = DatabaseManager.getInstance();
  
  // Register migrations in order
  manager.registerMigration(migration001);
}

// Auto-register migrations when this module is imported
registerMigrations();