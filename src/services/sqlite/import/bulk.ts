/**
 * Bulk import functions for importing data with duplicate checking
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export interface ImportResult {
  imported: boolean;
  id: number;
}

/**
 * Import SDK session with duplicate checking
 * Duplicates are identified by content_session_id
 */
export function importSdkSession(
  db: Database,
  session: {
    content_session_id: string;
    memory_session_id: string;
    project: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }
): ImportResult {
  // Check if session already exists
  const existing = db
    .prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
    .get(session.content_session_id) as { id: number } | undefined;

  if (existing) {
    return { imported: false, id: existing.id };
  }

  const stmt = db.prepare(`
    INSERT INTO sdk_sessions (
      content_session_id, memory_session_id, project, user_prompt,
      started_at, started_at_epoch, completed_at, completed_at_epoch, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    session.content_session_id,
    session.memory_session_id,
    session.project,
    session.user_prompt,
    session.started_at,
    session.started_at_epoch,
    session.completed_at,
    session.completed_at_epoch,
    session.status
  );

  return { imported: true, id: result.lastInsertRowid as number };
}

/**
 * Import session summary with duplicate checking
 * Duplicates are identified by memory_session_id
 */
export function importSessionSummary(
  db: Database,
  summary: {
    memory_session_id: string;
    project: string;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }
): ImportResult {
  // Check if summary already exists for this session
  const existing = db
    .prepare('SELECT id FROM session_summaries WHERE memory_session_id = ?')
    .get(summary.memory_session_id) as { id: number } | undefined;

  if (existing) {
    return { imported: false, id: existing.id };
  }

  const stmt = db.prepare(`
    INSERT INTO session_summaries (
      memory_session_id, project, request, investigated, learned,
      completed, next_steps, files_read, files_edited, notes,
      prompt_number, discovery_tokens, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    summary.memory_session_id,
    summary.project,
    summary.request,
    summary.investigated,
    summary.learned,
    summary.completed,
    summary.next_steps,
    summary.files_read,
    summary.files_edited,
    summary.notes,
    summary.prompt_number,
    summary.discovery_tokens || 0,
    summary.created_at,
    summary.created_at_epoch
  );

  return { imported: true, id: result.lastInsertRowid as number };
}

/**
 * Import observation with duplicate checking
 * Duplicates are identified by memory_session_id + title + created_at_epoch
 */
export function importObservation(
  db: Database,
  obs: {
    memory_session_id: string;
    project: string;
    text: string | null;
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string | null;
    narrative: string | null;
    concepts: string | null;
    files_read: string | null;
    files_modified: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }
): ImportResult {
  // Check if observation already exists
  const existing = db
    .prepare(
      `
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `
    )
    .get(obs.memory_session_id, obs.title, obs.created_at_epoch) as
    | { id: number }
    | undefined;

  if (existing) {
    return { imported: false, id: existing.id };
  }

  const stmt = db.prepare(`
    INSERT INTO observations (
      memory_session_id, project, text, type, title, subtitle,
      facts, narrative, concepts, files_read, files_modified,
      prompt_number, discovery_tokens, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    obs.memory_session_id,
    obs.project,
    obs.text,
    obs.type,
    obs.title,
    obs.subtitle,
    obs.facts,
    obs.narrative,
    obs.concepts,
    obs.files_read,
    obs.files_modified,
    obs.prompt_number,
    obs.discovery_tokens || 0,
    obs.created_at,
    obs.created_at_epoch
  );

  return { imported: true, id: result.lastInsertRowid as number };
}

/**
 * Import user prompt with duplicate checking
 * Duplicates are identified by content_session_id + prompt_number
 */
export function importUserPrompt(
  db: Database,
  prompt: {
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }
): ImportResult {
  // Check if prompt already exists
  const existing = db
    .prepare(
      `
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `
    )
    .get(prompt.content_session_id, prompt.prompt_number) as
    | { id: number }
    | undefined;

  if (existing) {
    return { imported: false, id: existing.id };
  }

  const stmt = db.prepare(`
    INSERT INTO user_prompts (
      content_session_id, prompt_number, prompt_text,
      created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    prompt.content_session_id,
    prompt.prompt_number,
    prompt.prompt_text,
    prompt.created_at,
    prompt.created_at_epoch
  );

  return { imported: true, id: result.lastInsertRowid as number };
}
