import { logger } from '../../../../utils/logger.js';

type ObservationType = 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change' | 'security_alert' | 'security_note';

export const OBSERVATION_TYPES: ObservationType[] = [
  'decision',
  'bugfix',
  'feature',
  'refactor',
  'discovery',
  'change',
  'security_alert',
  'security_note'
];

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

export function matchesType(
  resultType: string,
  filterTypes?: ObservationType[]
): boolean {
  if (!filterTypes || filterTypes.length === 0) {
    return true;
  }

  return filterTypes.includes(resultType as ObservationType);
}

export function filterObservationsByType<T extends { type: string }>(
  observations: T[],
  types?: ObservationType[]
): T[] {
  if (!types || types.length === 0) {
    return observations;
  }

  return observations.filter(obs => matchesType(obs.type, types));
}

export function parseTypeString(typeString: string): ObservationType[] {
  return typeString
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => OBSERVATION_TYPES.includes(t as ObservationType)) as ObservationType[];
}
