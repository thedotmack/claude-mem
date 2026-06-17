
import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import { getProjectContext } from '../../../utils/project-name.js';
import { seedReinforcement, reinforceObservation } from '../../reinforcement/persist.js';
import type { ObservationInput, StoreObservationResult } from './types.js';

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

export function storeObservation(
  db: Database,
  memorySessionId: string,
  project: string,
  observation: ObservationInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): StoreObservationResult {
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  const resolvedProject = project || getProjectContext(process.cwd()).primary;

  const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);

  // Phase 1c: seed ACT-R reinforcement history so a fresh observation starts at
  // baseline strength (ln(2) ≈ 0.69) rather than zero.
  const seed = seedReinforcement(timestampEpoch);

  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
     reinforcement_dates, last_reinforced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    timestampEpoch,
    seed.dates,
    seed.lastReinforced
  ) as { id: number; created_at_epoch: number } | null;

  if (inserted) {
    return { id: inserted.id, createdAtEpoch: inserted.created_at_epoch };
  }

  const existing = db.prepare(
    'SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND content_hash = ?'
  ).get(memorySessionId, contentHash) as { id: number; created_at_epoch: number } | null;

  if (!existing) {
    throw new Error(
      `storeObservation: ON CONFLICT fired but no row exists for (memory_session_id=${memorySessionId}, content_hash=${contentHash})`
    );
  }

  // Phase 1c: an exact content-hash collision is the world re-confirming this
  // observation — reinforce instead of silently dropping it. (Semantic, non-exact
  // dedup is the Phase 3 LLM judge; this is the free MD5-equivalent path.)
  const reinforced = reinforceObservation(db, existing.id, new Date(timestampEpoch));
  logger.debug(
    'DEDUP',
    `Duplicate observation ${reinforced ? 'reinforced' : 'skipped (same-day)'} | contentHash=${contentHash} | existingId=${existing.id}`
  );
  return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
}
