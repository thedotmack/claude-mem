/**
 * Timeline query functions
 * Provides time-based context queries for observations, sessions, and prompts
 *
 * grep-friendly: getTimelineAroundTimestamp, getTimelineAroundObservation, getAllProjects
 */

import type { Database } from 'bun:sqlite';
import type { ObservationRecord, SessionSummaryRecord, UserPromptRecord } from '../../../types/database.js';
import { logger } from '../../../utils/logger.js';

/**
 * Timeline result containing observations, sessions, and prompts within a time window
 */
export interface TimelineResult {
  observations: ObservationRecord[];
  sessions: Array<{
    id: number;
    memory_session_id: string;
    project: string;
    request: string | null;
    completed: string | null;
    next_steps: string | null;
    created_at: string;
    created_at_epoch: number;
  }>;
  prompts: Array<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string | undefined;
    created_at: string;
    created_at_epoch: number;
  }>;
}

/**
 * Get timeline around a specific timestamp
 * Convenience wrapper that delegates to getTimelineAroundObservation with null anchor
 *
 * @param db Database connection
 * @param anchorEpoch Epoch timestamp to anchor the query around
 * @param depthBefore Number of records to retrieve before anchor (any type)
 * @param depthAfter Number of records to retrieve after anchor (any type)
 * @param project Optional project filter
 * @returns Object containing observations, sessions, and prompts for the specified window
 */
export function getTimelineAroundTimestamp(
  db: Database,
  anchorEpoch: number,
  depthBefore: number = 10,
  depthAfter: number = 10,
  project?: string
): TimelineResult {
  return getTimelineAroundObservation(db, null, anchorEpoch, depthBefore, depthAfter, project);
}

/**
 * Get timeline around a specific observation ID
 * Uses observation ID offsets to determine time boundaries, then fetches all record types in that window
 *
 * @param db Database connection
 * @param anchorObservationId Observation ID to anchor around (null for timestamp-based)
 * @param anchorEpoch Epoch timestamp fallback or anchor for timestamp-based queries
 * @param depthBefore Number of records to retrieve before anchor
 * @param depthAfter Number of records to retrieve after anchor
 * @param project Optional project filter
 * @returns Object containing observations, sessions, and prompts for the specified window
 */
export function getTimelineAroundObservation(
  db: Database,
  anchorObservationId: number | null,
  anchorEpoch: number,
  depthBefore: number = 10,
  depthAfter: number = 10,
  project?: string
): TimelineResult {
  const projectFilter = project ? 'AND project = ?' : '';
  const projectParams = project ? [project] : [];

  let startEpoch: number;
  let endEpoch: number;

  if (anchorObservationId !== null) {
    // Get boundary observations by ID offset
    const beforeQuery = `
      SELECT id, created_at_epoch
      FROM observations
      WHERE id <= ? ${projectFilter}
      ORDER BY id DESC
      LIMIT ?
    `;
    const afterQuery = `
      SELECT id, created_at_epoch
      FROM observations
      WHERE id >= ? ${projectFilter}
      ORDER BY id ASC
      LIMIT ?
    `;

    try {
      const beforeRecords = db.prepare(beforeQuery).all(anchorObservationId, ...projectParams, depthBefore + 1) as Array<{id: number; created_at_epoch: number}>;
      const afterRecords = db.prepare(afterQuery).all(anchorObservationId, ...projectParams, depthAfter + 1) as Array<{id: number; created_at_epoch: number}>;

      // Get the earliest and latest timestamps from boundary observations
      if (beforeRecords.length === 0 && afterRecords.length === 0) {
        return { observations: [], sessions: [], prompts: [] };
      }

      startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
      endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
    } catch (err: any) {
      logger.error('DB', 'Error getting boundary observations', undefined, { error: err, project });
      return { observations: [], sessions: [], prompts: [] };
    }
  } else {
    // For timestamp-based anchors, use time-based boundaries
    // Get observations to find the time window
    const beforeQuery = `
      SELECT created_at_epoch
      FROM observations
      WHERE created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `;
    const afterQuery = `
      SELECT created_at_epoch
      FROM observations
      WHERE created_at_epoch >= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `;

    try {
      const beforeRecords = db.prepare(beforeQuery).all(anchorEpoch, ...projectParams, depthBefore) as Array<{created_at_epoch: number}>;
      const afterRecords = db.prepare(afterQuery).all(anchorEpoch, ...projectParams, depthAfter + 1) as Array<{created_at_epoch: number}>;

      if (beforeRecords.length === 0 && afterRecords.length === 0) {
        return { observations: [], sessions: [], prompts: [] };
      }

      startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
      endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
    } catch (err: any) {
      logger.error('DB', 'Error getting boundary timestamps', undefined, { error: err, project });
      return { observations: [], sessions: [], prompts: [] };
    }
  }

  // Now query ALL record types within the time window
  const obsQuery = `
    SELECT *
    FROM observations
    WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
    ORDER BY created_at_epoch ASC
  `;

  const sessQuery = `
    SELECT *
    FROM session_summaries
    WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
    ORDER BY created_at_epoch ASC
  `;

  const promptQuery = `
    SELECT up.*, s.project, s.memory_session_id
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${projectFilter.replace('project', 's.project')}
    ORDER BY up.created_at_epoch ASC
  `;

  const observations = db.prepare(obsQuery).all(startEpoch, endEpoch, ...projectParams) as ObservationRecord[];
  const sessions = db.prepare(sessQuery).all(startEpoch, endEpoch, ...projectParams) as SessionSummaryRecord[];
  const prompts = db.prepare(promptQuery).all(startEpoch, endEpoch, ...projectParams) as UserPromptRecord[];

  return {
    observations,
    sessions: sessions.map(s => ({
      id: s.id,
      memory_session_id: s.memory_session_id,
      project: s.project,
      request: s.request,
      completed: s.completed,
      next_steps: s.next_steps,
      created_at: s.created_at,
      created_at_epoch: s.created_at_epoch
    })),
    prompts: prompts.map(p => ({
      id: p.id,
      content_session_id: p.content_session_id,
      prompt_number: p.prompt_number,
      prompt_text: p.prompt_text,
      project: p.project,
      created_at: p.created_at,
      created_at_epoch: p.created_at_epoch
    }))
  };
}

/**
 * Get all unique projects from the database (for web UI project filter)
 *
 * @param db Database connection
 * @returns Array of unique project names
 */
export function getAllProjects(db: Database): string[] {
  const stmt = db.prepare(`
    SELECT DISTINCT project
    FROM sdk_sessions
    WHERE project IS NOT NULL AND project != ''
    ORDER BY project ASC
  `);

  const rows = stmt.all() as Array<{ project: string }>;
  return rows.map(row => row.project);
}
