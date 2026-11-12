
import { createHash } from 'crypto';
import { logger } from '../../../utils/logger.js';

/**
 * Whether an observation has a title worth storing. Title-less observations are
 * malformed, low-signal rows that take up space in the recency-based recall
 * window without adding facts, so storage skips them. Callers that pair parsed
 * observations with stored ids by position must drop them first with this same
 * check, or every later id shifts onto the wrong observation.
 */
export function hasStorableTitle(title: string | null | undefined): title is string {
  return typeof title === 'string' && title.trim() !== '';
}

export function computeObservationContentHash(
  memorySessionId: string,
  title: string | null,
  narrative: string | null
): string {
  return createHash('sha256')
    .update([memorySessionId || '', title || '', narrative || ''].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

/** Structured fields absent from the legacy title/narrative fingerprint. */
export interface ObservationDetails {
  type: string;
  subtitle: string | null;
  facts: string[] | string | null;
  concepts: string[] | string | null;
}

function listValue(value: string[] | string | null): unknown {
  if (typeof value !== 'string') return value ?? [];
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * Disambiguate different details under a legacy hash without rewriting old
 * rows. Stored JSON lists and their input arrays have the same identity.
 * Tool-derived file evidence and agent/media metadata remain provenance, not
 * observation content, so their arrival can still reuse the existing row.
 */
export function computeObservationDetailsHash(legacyHash: string, details: ObservationDetails): string {
  return 'details-' + createHash('sha256').update(JSON.stringify([
    legacyHash, details.type, details.subtitle ?? null,
    listValue(details.facts), listValue(details.concepts),
  ])).digest('hex');
}
