import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

// Omit transport health, clock labels and generated summaries. Only recorded
// request content invalidates a review. Keep the old field list for adoption
// of device-local decisions saved before recorded products were versioned.
const priorFingerprintFields = ['id', 'original', 'explicitRequestText', 'scopeUpdates', 'title', 'projects', 'agentIds', 'items', 'lifecycle', 'afterShip', 'shipEstimate', 'stageSourceText', 'sourceContentHashes'];
const fingerprintFields = [...priorFingerprintFields, 'sourceProductHash'];

/**
 * The agents a review covers: the ones recorded work names. A request with no recorded work takes its agents from
 * its conversations' sessions (buildHumanRequests), which says who to show on the card, not what was reviewed. Such
 * a card had no agents until its session got an agent group (#6505); counting them now would drop every check made
 * while it read "Agent not recorded", on this device and in shared reviews.
 */
export function reviewedAgentIds(request: Record<string, unknown>): unknown {
  return Array.isArray(request.items) && request.items.length > 0 ? request.agentIds : [];
}

function fingerprintOf(request: Record<string, unknown>, fields: readonly string[]): string {
  const content = Object.fromEntries(fields.map(key => [key, key === 'agentIds' ? reviewedAgentIds(request) : request[key]]));
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}

export function contentFingerprint(request: Record<string, unknown>): string {
  return fingerprintOf(request, fingerprintFields);
}

export function priorContentFingerprint(request: Record<string, unknown>): string {
  return fingerprintOf(request, priorFingerprintFields);
}
