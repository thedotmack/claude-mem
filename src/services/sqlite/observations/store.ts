/**
 * Store observation function
 * Extracted from SessionStore.ts for modular organization
 */

import type { Database } from '../sqlite-compat.js';
import type { ObservationInput, StoreObservationResult } from './types.js';
import { estimateReadTokens } from '../../../shared/timeline-formatting.js';

/**
 * Store an observation (from SDK parsing)
 * Assumes session already exists (created by hook)
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

  // Estimate read tokens: sum token counts across all content fields.
  // facts and concepts are stored as JSON strings, so we estimate based on
  // their serialized length (consistent with what the migration backfill uses).
  const readTokens = estimateReadTokens({
    narrative: observation.narrative,
    title: observation.title,
    facts: JSON.stringify(observation.facts),
    concepts: JSON.stringify(observation.concepts),
    text: null,
  });

  // Empty-array-to-NULL coercion: ensures backfill's WHERE topics IS NULL works correctly
  const topicsJson = observation.topics?.length ? JSON.stringify(observation.topics) : null;
  const entitiesJson = observation.entities?.length ? JSON.stringify(observation.entities) : null;
  const eventDate = observation.event_date ?? null;

  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, read_tokens, priority,
     topics, entities, event_date, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    memorySessionId,
    project,
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
    readTokens,
    observation.priority ?? 'informational',
    topicsJson,
    entitiesJson,
    eventDate,
    timestampIso,
    timestampEpoch
  );

  return {
    id: Number(result.lastInsertRowid),
    createdAtEpoch: timestampEpoch
  };
}
