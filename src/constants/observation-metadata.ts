/**
 * Observation metadata constants
 * Shared across hooks, worker service, and UI components
 */

/**
 * Valid observation types
 */
export const OBSERVATION_TYPES = [
  'bugfix',
  'feature',
  'refactor',
  'discovery',
  'decision',
  'change'
] as const;

export type ObservationType = typeof OBSERVATION_TYPES[number];

/**
 * Valid observation concepts
 */
export const OBSERVATION_CONCEPTS = [
  'how-it-works',
  'why-it-exists',
  'what-changed',
  'problem-solution',
  'gotcha',
  'pattern',
  'trade-off'
] as const;

export type ObservationConcept = typeof OBSERVATION_CONCEPTS[number];

/**
 * Map observation types to emoji icons
 */
export const TYPE_ICON_MAP: Record<ObservationType | 'session-request', string> = {
  'bugfix': '🔴',
  'feature': '🟣',
  'refactor': '🔄',
  'change': '✅',
  'discovery': '🔵',
  'decision': '⚖️',
  'session-request': '🎯'
};

/**
 * Map observation types to work emoji (for token display)
 */
export const TYPE_WORK_EMOJI_MAP: Record<ObservationType, string> = {
  'discovery': '🔍',  // research/exploration
  'change': '🛠️',    // building/modifying
  'feature': '🛠️',   // building/modifying
  'bugfix': '🛠️',    // building/modifying
  'refactor': '🛠️',  // building/modifying
  'decision': '⚖️'   // decision-making
};

/**
 * Default observation types (comma-separated string for settings)
 */
export const DEFAULT_OBSERVATION_TYPES_STRING = OBSERVATION_TYPES.join(',');

/**
 * Default observation concepts (comma-separated string for settings)
 */
export const DEFAULT_OBSERVATION_CONCEPTS_STRING = OBSERVATION_CONCEPTS.join(',');
