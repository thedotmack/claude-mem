/**
 * Store observation function
 * Extracted from SessionStore.ts for modular organization
 */

import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import { getProjectContext } from '../../../utils/project-name.js';
import { truncateObservationPayload } from '../../../utils/claude-md-utils.js';
import type { ObservationInput, StoreObservationResult } from './types.js';

/** Deduplication window: observations with the same content hash within this window are skipped */
const DEDUP_WINDOW_MS = 30_000;

/**
 * Normalize content for dedup hashing: trim, collapse whitespace, lowercase.
 * Ensures near-identical observations with minor whitespace/case differences
 * produce the same hash and are properly deduped.
 */
function normalizeForDedup(value: string | null): string {
  if (!value) return '';
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Compute a short content hash for deduplication.
 * Uses (memory_session_id, title, narrative) as the semantic identity of an observation.
 * Content is normalized (trimmed, whitespace-collapsed, lowercased) before hashing
 * to prevent near-identical observations from bypassing dedup.
 */
export function computeObservationContentHash(
  memorySessionId: string,
  title: string | null,
  narrative: string | null
): string {
  return createHash('sha256')
    .update([
      memorySessionId || '',
      normalizeForDedup(title),
      normalizeForDedup(narrative)
    ].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Check if a duplicate observation exists within the dedup window.
 * Returns the existing observation's id and timestamp if found, null otherwise.
 */
export function findDuplicateObservation(
  db: Database,
  contentHash: string,
  timestampEpoch: number
): { id: number; created_at_epoch: number } | null {
  const windowStart = timestampEpoch - DEDUP_WINDOW_MS;
  const stmt = db.prepare(
    'SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?'
  );
  return (stmt.get(contentHash, windowStart) as { id: number; created_at_epoch: number } | null);
}

/**
 * Store an observation (from SDK parsing)
 * Assumes session already exists (created by hook)
 * Performs content-hash deduplication: skips INSERT if an identical observation exists within 30s
 */
export function storeObservation(
  db: Database,
  memorySessionId: string,
  project: string,
  observation: ObservationInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): StoreObservationResult {
  // Use override timestamp if provided (for processing backlog messages with original timestamps)
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  // Guard against empty project string (race condition where project isn't set yet).
  // Use 'unknown-project' instead of getProjectContext(process.cwd()) because the
  // worker process's cwd is not the user's project directory, which would cause a
  // project-key mismatch between writes and reads (#1918).
  const resolvedProject = project || 'unknown-project';

  // Truncate large observation payloads before storage (Bug #1935)
  if (observation.narrative) {
    observation.narrative = truncateObservationPayload(observation.narrative);
  }
  if (observation.facts && observation.facts.length > 0) {
    observation.facts = observation.facts.map(fact => truncateObservationPayload(fact));
  }

  // Content-hash deduplication
  const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
  const existing = findDuplicateObservation(db, contentHash, timestampEpoch);
  if (existing) {
    logger.debug('DEDUP', `Skipped duplicate observation | contentHash=${contentHash} | existingId=${existing.id}`);
    return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
  }

  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    memorySessionId,
    resolvedProject,
    observation.type,
    observation.title,
    observation.subtitle,
    JSON.stringify(observation.facts),
    observation.narrative,
    JSON.stringify(observation.concepts),
    JSON.stringify(observation.files_read),
    JSON.stringify(observation.files_modified),
    promptNumber || null,
    discoveryTokens,
    contentHash,
    timestampIso,
    timestampEpoch
  );

  return {
    id: Number(result.lastInsertRowid),
    createdAtEpoch: timestampEpoch
  };
}
