// Export main components
export {
  ClaudeMemDatabase,
  MigrationRunner
} from './Database.js';

// Export session store (CRUD operations for sessions, observations, summaries)
// @deprecated Use modular functions from Database.ts instead
export { SessionStore } from './SessionStore.js';

// Export session search (FTS5 and structured search)
export { SessionSearch } from './SessionSearch.js';

// Export types
export * from './types.js';

// Export transactions
export { storeObservations, storeObservationsAndMarkComplete } from './transactions.js';

// Re-export all modular functions for convenient access
export * from './sessions/types.js';
export * from './sessions/create.js';
export * from './sessions/get.js';
export * from './observations/types.js';
export * from './observations/store.js';
export * from './observations/get.js';
export * from './observations/recent.js';
export * from './observations/files.js';
export * from './summaries/types.js';
export * from './summaries/store.js';
export * from './summaries/get.js';
export * from './summaries/recent.js';
export * from './prompts/types.js';
export * from './prompts/store.js';
export * from './prompts/get.js';
export * from './timeline/queries.js';
export * from './import/bulk.js';
