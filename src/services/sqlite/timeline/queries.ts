/**
 * Timeline query functions
 * Provides time-based context queries for observations, sessions, and prompts
 *
 * grep-friendly: getTimelineAroundTimestamp, getTimelineAroundObservation, getAllProjects
 */

import type { DbAdapter } from '../adapter.js';
import { queryAll } from '../adapter.js';
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
 */
export async function getTimelineAroundTimestamp(
  db: DbAdapter,
  anchorEpoch: number,
  depthBefore: number = 10,
  depthAfter: number = 10,
  project?: string
): Promise<TimelineResult> {
  return getTimelineAroundObservation(db, null, anchorEpoch, depthBefore, depthAfter, project);
}

/**
 * Get timeline around a specific observation ID
 * Uses observation ID offsets to determine time boundaries, then fetches all record types in that window
 */
export async function getTimelineAroundObservation(
  db: DbAdapter,
  anchorObservationId: number | null,
  anchorEpoch: number,
  depthBefore: number = 10,
  depthAfter: number = 10,
  project?: string
): Promise<TimelineResult> {
  const projectFilter = project ? 'AND project = ?' : '';
  const projectParams = project ? [project] : [];

  let startEpoch: number;
  let endEpoch: number;

  if (anchorObservationId !== null) {
    // Get boundary observations by ID offset
    try {
      const beforeRecords = await queryAll<{id: number; created_at_epoch: number}>(db, `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${projectFilter}
        ORDER BY id DESC
        LIMIT ?
      `, [anchorObservationId, ...projectParams, depthBefore + 1]);

      const afterRecords = await queryAll<{id: number; created_at_epoch: number}>(db, `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${projectFilter}
        ORDER BY id ASC
        LIMIT ?
      `, [anchorObservationId, ...projectParams, depthAfter + 1]);

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
    try {
      const beforeRecords = await queryAll<{created_at_epoch: number}>(db, `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${projectFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `, [anchorEpoch, ...projectParams, depthBefore]);

      const afterRecords = await queryAll<{created_at_epoch: number}>(db, `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${projectFilter}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `, [anchorEpoch, ...projectParams, depthAfter + 1]);

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
  const observations = await queryAll<ObservationRecord>(db, `
    SELECT *
    FROM observations
    WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
    ORDER BY created_at_epoch ASC
  `, [startEpoch, endEpoch, ...projectParams]);

  const sessions = await queryAll<SessionSummaryRecord>(db, `
    SELECT *
    FROM session_summaries
    WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
    ORDER BY created_at_epoch ASC
  `, [startEpoch, endEpoch, ...projectParams]);

  const prompts = await queryAll<UserPromptRecord>(db, `
    SELECT up.*, s.project, s.memory_session_id
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${projectFilter.replace('project', 's.project')}
    ORDER BY up.created_at_epoch ASC
  `, [startEpoch, endEpoch, ...projectParams]);

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
 */
export async function getAllProjects(db: DbAdapter): Promise<string[]> {
  const rows = await queryAll<{ project: string }>(db, `
    SELECT DISTINCT project
    FROM sdk_sessions
    WHERE project IS NOT NULL AND project != ''
    ORDER BY project ASC
  `);
  return rows.map(row => row.project);
}
