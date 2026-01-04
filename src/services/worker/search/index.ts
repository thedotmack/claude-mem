/**
 * Search Module - Named exports for search functionality
 *
 * This is the public API for the search module.
 */

// Main orchestrator
export { SearchOrchestrator } from './SearchOrchestrator.js';

// Formatters
export { ResultFormatter } from './ResultFormatter.js';
export { TimelineBuilder } from './TimelineBuilder.js';
export type { TimelineItem, TimelineData } from './TimelineBuilder.js';

// Strategies
export type { SearchStrategy } from './strategies/SearchStrategy.js';
export { BaseSearchStrategy } from './strategies/SearchStrategy.js';
export { ChromaSearchStrategy } from './strategies/ChromaSearchStrategy.js';
export { SQLiteSearchStrategy } from './strategies/SQLiteSearchStrategy.js';
export { HybridSearchStrategy } from './strategies/HybridSearchStrategy.js';

// Filters
export * from './filters/DateFilter.js';
export * from './filters/ProjectFilter.js';
export * from './filters/TypeFilter.js';

// Types
export * from './types.js';
