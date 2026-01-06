/**
 * TypeFilter - Observation type filtering for search results
 *
 * Provides utilities for filtering observations by type.
 */
import { logger } from '../../../../utils/logger.js';

type ObservationType = 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';

/**
 * Valid observation types
 */
export const OBSERVATION_TYPES: ObservationType[] = [
  'decision',
  'bugfix',
  'feature',
  'refactor',
  'discovery',
  'change'
];

/**
 * Normalize type filter value(s)
 */
export function normalizeType(
  type?: string | string[]
): ObservationType[] | undefined {
  if (!type) {
    return undefined;
  }

  const types = Array.isArray(type) ? type : [type];
  const normalized = types
    .map(t => t.trim().toLowerCase())
    .filter(t => OBSERVATION_TYPES.includes(t as ObservationType)) as ObservationType[];

  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Check if a result matches the type filter
 */
export function matchesType(
  resultType: string,
  filterTypes?: ObservationType[]
): boolean {
  if (!filterTypes || filterTypes.length === 0) {
    return true;
  }

  return filterTypes.includes(resultType as ObservationType);
}

/**
 * Filter observations by type
 */
export function filterObservationsByType<T extends { type: string }>(
  observations: T[],
  types?: ObservationType[]
): T[] {
  if (!types || types.length === 0) {
    return observations;
  }

  return observations.filter(obs => matchesType(obs.type, types));
}

/**
 * Parse comma-separated type string
 */
export function parseTypeString(typeString: string): ObservationType[] {
  return typeString
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => OBSERVATION_TYPES.includes(t as ObservationType)) as ObservationType[];
}
