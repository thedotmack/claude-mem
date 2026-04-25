/**
 * Store observation function
 * Extracted from SessionStore.ts for modular organization
 */

import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import { getProjectContext } from '../../../utils/project-name.js';
import type { ObservationInput, StoreObservationResult } from './types.js';

/**
 * Compute a short content hash for deduplication.
 * Uses (memory_session_id, title, narrative) as the semantic identity of an observation.
 * Subagent fields (agent_type, agent_id) are intentionally excluded so the same work
 * described once by a subagent and once by its parent deduplicates across contexts.
 */
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

/**
 * Store an observation (from SDK parsing).
 *
 * Assumes session already exists (created by hook). Deduplication is enforced
 * by the database via UNIQUE(memory_session_id, content_hash) (Plan 01 Phase 4):
 * INSERT … ON CONFLICT DO NOTHING absorbs duplicates silently. The returned id
 * is the existing row's id when a conflict occurred, otherwise the freshly
 * inserted row.
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

  // Guard against empty project string (race condition where project isn't set yet)
  const resolvedProject = project || getProjectContext(process.cwd()).primary;

  const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);

  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_session_id, content_hash) DO NOTHING
    RETURNING id, created_at_epoch
  `);

  const inserted = stmt.get(
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
    observation.agent_type ?? null,
    observation.agent_id ?? null,
    contentHash,
    timestampIso,
    timestampEpoch
  ) as { id: number; created_at_epoch: number } | null;

  if (inserted) {
    return { id: inserted.id, createdAtEpoch: inserted.created_at_epoch };
  }

  // Conflict — fetch the existing row's id for the (memory_session_id, content_hash) pair.
  const existing = db.prepare(
    'SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND content_hash = ?'
  ).get(memorySessionId, contentHash) as { id: number; created_at_epoch: number } | null;

  if (!existing) {
    // Unreachable in practice (UNIQUE conflict implies existing row), but be explicit.
    throw new Error(
      `storeObservation: ON CONFLICT fired but no row exists for (memory_session_id=${memorySessionId}, content_hash=${contentHash})`
    );
  }

  logger.debug('DEDUP', `Skipped duplicate observation | contentHash=${contentHash} | existingId=${existing.id}`);
  return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
}
