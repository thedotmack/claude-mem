import type { DatabaseManager } from '../worker/DatabaseManager.js';
import '../sqlite/manual-session.js';
import { logger } from '../../utils/logger.js';
import { notifyGrokBotIndex } from '../integrations/GrokBotIndexWriter.js';

export interface SaveMemoryInput {
  text: string;
  title?: string;
  project?: string;
  metadata?: Record<string, unknown>;
}

/** Shared by explicit MCP notes and the opt-in file bridge; no LLM call. */
export function saveMemory(dbManager: DatabaseManager, defaultProject: string, input: SaveMemoryInput) {
  const persist = () => persistMemory(dbManager, defaultProject, input);
  // Take the write lock BEFORE the replay lookup, including across processes.
  return typeof input.metadata?.sourceFingerprint === 'string'
    ? dbManager.getConnection().transaction(persist).immediate()
    : persist();
}

function persistMemory(dbManager: DatabaseManager, defaultProject: string, input: SaveMemoryInput) {
  const text = input.text.trim();
  if (!text) throw new Error('Memory text must not be empty');
  const { title, metadata } = input;
  const metadataProject = typeof metadata?.project === 'string' ? metadata.project.trim() : '';
  const project = input.project?.trim() || metadataProject || defaultProject;
  const platformSource = typeof metadata?.platformSource === 'string' ? metadata.platformSource.trim() : undefined;
  const sourceFingerprint = typeof metadata?.sourceFingerprint === 'string' ? metadata.sourceFingerprint : undefined;
  if (sourceFingerprint) {
    // Exact replay dedupe includes the project. It survives process crashes
    // between committing a note and saving the watcher's local checkpoint.
    const existing = dbManager.getConnection().query(`SELECT id, title FROM observations
      WHERE project = ? AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.sourceFingerprint') END = ?
      ORDER BY id DESC LIMIT 1`).get(project, sourceFingerprint) as { id: number; title: string } | null;
    if (existing) return { success: true, id: existing.id, title: existing.title, project, duplicate: true, message: `Memory already saved as observation #${existing.id}` };
  }
  const store = dbManager.getSessionStore();
  const sessionId = store.getOrCreateManualSession(project, platformSource);
  const observation = {
    type: 'discovery', title: title?.trim() || text.substring(0, 60).trim() + (text.length > 60 ? '...' : ''),
    subtitle: 'Manual memory', facts: [] as string[], narrative: text, concepts: [] as string[],
    files_read: [] as string[], files_modified: [] as string[], metadata: metadata ? JSON.stringify(metadata) : null,
  };
  const result = store.storeObservation(sessionId, project, observation, 0, 0);
  logger.info('HTTP', 'Manual observation saved', { id: result.id, project, title: observation.title });
  dbManager.getCloudSync()?.notify();
  notifyGrokBotIndex();
  // A merged row keeps its original text and vector; never index the proposed
  // replacement content under the existing id.
  if (!result.mergedIntoExisting) dbManager.getChromaSync()?.syncObservation(result.id, sessionId, project, observation, 0, result.createdAtEpoch).catch(error => {
      logger.error('CHROMA', 'Manual memory sync failed', { id: result.id }, error as Error);
    });
  return { success: true, id: result.id, title: observation.title, project,
    message: result.mergedIntoExisting ? `Memory matches existing observation #${result.id} (counted as a repeat)` : `Memory saved as observation #${result.id}` };
}
