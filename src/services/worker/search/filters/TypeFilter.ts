/**
 * TypeFilter - Observation type filtering for search results
 *
 * Provides utilities for filtering observations by type.
 */
import { ModeManager } from '../../../domain/ModeManager.js';

/**
 * Get valid observation types dynamically from ModeManager
 */
export function getObservationTypes(): string[] {
  return ModeManager.getInstance().getObservationTypes().map(t => t.id);
}

/**
 * Normalize type filter value(s)
 */
export function normalizeType(
  type?: string | string[]
): string[] | undefined {
  if (!type) {
    return undefined;
  }

  const validTypes = getObservationTypes();
  const types = Array.isArray(type) ? type : [type];
  const normalized = types
    .map(t => t.trim().toLowerCase())
    .filter(t => validTypes.includes(t));

  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Check if a result matches the type filter
 */
export function matchesType(
  resultType: string,
  filterTypes?: string[]
): boolean {
  if (!filterTypes || filterTypes.length === 0) {
    return true;
  }

  return filterTypes.includes(resultType);
}

/**
 * Filter observations by type
 */
export function filterObservationsByType<T extends { type: string }>(
  observations: T[],
  types?: string[]
): T[] {
  if (!types || types.length === 0) {
    return observations;
  }

  return observations.filter(obs => matchesType(obs.type, types));
}

/**
 * Parse comma-separated type string
 */
export function parseTypeString(typeString: string): string[] {
  const validTypes = getObservationTypes();
  return typeString
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => validTypes.includes(t));
}
