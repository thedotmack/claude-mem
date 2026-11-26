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

function fingerprintOf(request: Record<string, unknown>, fields: readonly string[]): string {
  const content = Object.fromEntries(fields.map(key => [key, request[key]]));
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}

export function contentFingerprint(request: Record<string, unknown>): string {
  return fingerprintOf(request, fingerprintFields);
}

export function priorContentFingerprint(request: Record<string, unknown>): string {
  return fingerprintOf(request, priorFingerprintFields);
}
