/**
 * Context Generator - DEPRECATED
 *
 * This file is maintained for backward compatibility.
 * New code should import from './Context.js' or './context/index.js'.
 *
 * The context generation logic has been restructured into:
 * - src/services/context/ContextBuilder.ts - Main orchestrator
 * - src/services/context/ContextConfigLoader.ts - Configuration loading
 * - src/services/context/TokenCalculator.ts - Token economics
 * - src/services/context/ObservationCompiler.ts - Data retrieval
 * - src/services/context/formatters/ - Output formatting
 * - src/services/context/sections/ - Section rendering
 */
import { logger } from '../utils/logger.js';

// Re-export everything from the new context module
export { generateContext } from './context/index.js';
export type { ContextInput, ContextConfig } from './context/types.js';
