
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
