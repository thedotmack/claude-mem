/**
 * Observation metadata constants
 * Shared across hooks, worker service, and UI components
 *
 * Note: These are fallback defaults for the code mode.
 * Actual observation types and concepts are defined per-mode in the modes/ directory.
 */

/**
 * Default observation types (comma-separated string for settings)
 * Uses code mode defaults as fallback
 */
export const DEFAULT_OBSERVATION_TYPES_STRING = 'bugfix,feature,refactor,discovery,decision,change';

/**
 * Default observation concepts (comma-separated string for settings)
 * Uses code mode defaults as fallback
 */
export const DEFAULT_OBSERVATION_CONCEPTS_STRING = 'how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off';
