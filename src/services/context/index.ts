/**
 * Context Module - Public API
 *
 * Re-exports the main context generation functionality.
 */

export { generateContext, generateContextWithMeta } from './ContextBuilder.js';
export type { ContextResult } from './ContextBuilder.js';
export type { ContextInput, ContextConfig } from './types.js';

// Component exports for advanced usage
export { loadContextConfig } from './ContextConfigLoader.js';
export { calculateTokenEconomics, calculateObservationTokens } from './TokenCalculator.js';
export {
  queryObservations,
  querySummaries,
  buildTimeline,
  getPriorSessionMessages,
} from './ObservationCompiler.js';
