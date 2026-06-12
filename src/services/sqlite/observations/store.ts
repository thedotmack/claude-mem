
import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import { getProjectContext } from '../../../utils/project-name.js';
import type { ObservationInput, StoreObservationResult } from './types.js';

interface ObservationHashFields {
  title: string | null;
  subtitle?: string | null;
  facts?: string[];
  narrative: string | null;
  concepts?: string[];
  files_read?: string[];
  files_modified?: string[];
}

function hashParts(parts: string[]): string {
  return createHash('sha256')
    .update(parts.join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

function arrayHashPart(value: string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

function hasAdditionalHashFields(observation: ObservationHashFields): boolean {
  return Boolean(
    observation.subtitle ||
    (observation.facts?.length ?? 0) > 0 ||
    (observation.concepts?.length ?? 0) > 0 ||
    (observation.files_read?.length ?? 0) > 0 ||
    (observation.files_modified?.length ?? 0) > 0
  );
}

export function computeObservationContentHash(
  memorySessionId: string,
  observation: ObservationHashFields
): string;
export function computeObservationContentHash(
  memorySessionId: string,
  title: string | null,
  narrative: string | null
): string;
export function computeObservationContentHash(
  memorySessionId: string,
  observationOrTitle: ObservationHashFields | string | null,
  narrative?: string | null
): string {
  const observation = typeof observationOrTitle === 'object' && observationOrTitle !== null
    ? observationOrTitle
    : { title: observationOrTitle, narrative: narrative ?? null };

  const legacyParts = [memorySessionId || '', observation.title || '', observation.narrative || ''];

  if (!hasAdditionalHashFields(observation)) {
    return hashParts(legacyParts);
  }

  return hashParts([
    ...legacyParts,
    observation.subtitle || '',
    arrayHashPart(observation.facts),
    arrayHashPart(observation.concepts),
    arrayHashPart(observation.files_read),
    arrayHashPart(observation.files_modified),
  ]);
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

  const contentHash = computeObservationContentHash(memorySessionId, observation);

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

  const existing = db.prepare(
    'SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND content_hash = ?'
  ).get(memorySessionId, contentHash) as { id: number; created_at_epoch: number } | null;

  if (!existing) {
    throw new Error(
      `storeObservation: ON CONFLICT fired but no row exists for (memory_session_id=${memorySessionId}, content_hash=${contentHash})`
    );
  }

  logger.debug('DEDUP', `Skipped duplicate observation | contentHash=${contentHash} | existingId=${existing.id}`);
  return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
}
