// Export main components
export { DatabaseManager, getDatabase, initializeDatabase } from './Database.js';

// Export store classes
export { SessionStore } from './SessionStore.js';
export { MemoryStore } from './MemoryStore.js';
export { OverviewStore } from './OverviewStore.js';
export { DiagnosticsStore } from './DiagnosticsStore.js';
export { TranscriptEventStore } from './TranscriptEventStore.js';

// Export types
export * from './types.js';

// Export migrations
export { migrations } from './migrations.js';

// Convenience function to get all stores
export async function createStores() {
  const { DatabaseManager } = await import('./Database.js');
  const { migrations } = await import('./migrations.js');

  // Register migrations before initialization
  const manager = DatabaseManager.getInstance();
  for (const migration of migrations) {
    manager.registerMigration(migration);
  }

  const db = await manager.initialize();
  
  const { SessionStore } = await import('./SessionStore.js');
  const { MemoryStore } = await import('./MemoryStore.js');
  const { OverviewStore } = await import('./OverviewStore.js');
  const { DiagnosticsStore } = await import('./DiagnosticsStore.js');
  const { TranscriptEventStore } = await import('./TranscriptEventStore.js');

  return {
    sessions: new SessionStore(db),
    memories: new MemoryStore(db),
    overviews: new OverviewStore(db),
    diagnostics: new DiagnosticsStore(db),
    transcriptEvents: new TranscriptEventStore(db)
  };
}
