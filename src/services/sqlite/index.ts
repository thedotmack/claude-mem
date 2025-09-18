// Import migrations to register them
import './migrations/index.js';

// Export main components
export { DatabaseManager, getDatabase, initializeDatabase } from './Database.js';

// Export store classes
export { SessionStore } from './SessionStore.js';
export { MemoryStore } from './MemoryStore.js';
export { OverviewStore } from './OverviewStore.js';
export { DiagnosticsStore } from './DiagnosticsStore.js';

// Export types
export * from './types.js';

// Convenience function to get all stores
export async function createStores() {
  const { DatabaseManager } = await import('./Database.js');
  const db = await DatabaseManager.getInstance().initialize();
  
  const { SessionStore } = await import('./SessionStore.js');
  const { MemoryStore } = await import('./MemoryStore.js');
  const { OverviewStore } = await import('./OverviewStore.js');
  const { DiagnosticsStore } = await import('./DiagnosticsStore.js');
  
  return {
    sessions: new SessionStore(db),
    memories: new MemoryStore(db),
    overviews: new OverviewStore(db),
    diagnostics: new DiagnosticsStore(db)
  };
}
