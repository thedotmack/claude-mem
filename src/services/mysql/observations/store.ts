/**
 * Store observation function (MySQL async)
 * 
 * Adapted from v13.4.0 sqlite/observations/store.ts
 */

import { createHash } from 'crypto';
import { MySQLDatabase } from '../Database.js';
import { logger } from '../../../utils/logger.js';
import { getProjectContext } from '../../../utils/project-name.js';
import type { ObservationInput, StoreObservationResult } from '../../sqlite/observations/types.js';

const DEDUP_WINDOW_MS = 30_000;

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

async function findDuplicateObservation(
  db: MySQLDatabase,
  contentHash: string,
  timestampEpoch: number
): Promise<{ id: number; created_at_epoch: number } | null> {
  const windowStart = timestampEpoch - DEDUP_WINDOW_MS;
  return await db.prepare(
    'SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?'
  ).get(contentHash, windowStart) as { id: number; created_at_epoch: number } | null;
}

/**
 * Check if an observation with the same title exists for the same memory_session_id.
 * This prevents duplicate initialization observations when SDK agent restarts after crash recovery.
 * Returns the existing observation's id and timestamp if found, null otherwise.
 */
async function findDuplicateByTitle(
  db: MySQLDatabase,
  memorySessionId: string,
  title: string | null
): Promise<{ id: number; created_at_epoch: number } | null> {
  if (!title) return null;
  return await db.prepare(
    'SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND title = ? ORDER BY id DESC LIMIT 1'
  ).get(memorySessionId, title) as { id: number; created_at_epoch: number } | null;
}

export async function storeObservation(
  db: MySQLDatabase,
  memorySessionId: string,
  project: string,
  observation: ObservationInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): Promise<StoreObservationResult> {
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  const resolvedProject = project || getProjectContext(process.cwd()).primary;

  // Level 1: Content-hash deduplication within 30-second window
  const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
  const existingByHash = await findDuplicateObservation(db, contentHash, timestampEpoch);
  if (existingByHash) {
    logger.debug('DB', `Skipped duplicate observation | contentHash=${contentHash} | existingId=${existingByHash.id}`);
    return { id: existingByHash.id, createdAtEpoch: existingByHash.created_at_epoch };
  }

  // Level 2: Title-based deduplication within same session
  // This prevents duplicate initialization observations when SDK agent restarts after crash recovery
  const existingByTitle = await findDuplicateByTitle(db, memorySessionId, observation.title);
  if (existingByTitle) {
    logger.debug('DB', `Skipped duplicate observation by title | title=${observation.title?.substring(0, 50)} | existingId=${existingByTitle.id}`);
    return { id: existingByTitle.id, createdAtEpoch: existingByTitle.created_at_epoch };
  }

  const result = await db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memorySessionId, resolvedProject, observation.type,
    observation.title, observation.subtitle,
    JSON.stringify(observation.facts), observation.narrative,
    JSON.stringify(observation.concepts),
    JSON.stringify(observation.files_read), JSON.stringify(observation.files_modified),
    promptNumber || null, discoveryTokens,
    observation.agent_type ?? null, observation.agent_id ?? null,
    contentHash,
    timestampIso, timestampEpoch
  );

  logger.debug('DB', `Stored observation | type=${observation.type} | id=${result.insertId}`);
  return { id: result.insertId, createdAtEpoch: timestampEpoch };
}

export { findDuplicateObservation, findDuplicateByTitle };
