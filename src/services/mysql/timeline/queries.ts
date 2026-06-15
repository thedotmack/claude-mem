/**
 * Timeline queries (MySQL async)
 */

import { MySQLDatabase } from '../Database.js';
import type { ObservationRecord, SessionSummaryRecord, UserPromptRecord } from '../../../types/database.js';
import { logger } from '../../../utils/logger.js';

export interface TimelineResult {
  observations: ObservationRecord[];
  sessions: Array<{
    id: number; memory_session_id: string; project: string;
    request: string | null; completed: string | null; next_steps: string | null;
    created_at: string; created_at_epoch: number;
  }>;
  prompts: Array<{
    id: number; content_session_id: string; prompt_number: number;
    prompt_text: string; project: string | undefined;
    created_at: string; created_at_epoch: number;
  }>;
}

export async function getTimelineAroundTimestamp(
  db: MySQLDatabase, anchorEpoch: number,
  depthBefore: number = 10, depthAfter: number = 10, project?: string
): Promise<TimelineResult> {
  return getTimelineAroundObservation(db, null, anchorEpoch, depthBefore, depthAfter, project);
}

export async function getTimelineAroundObservation(
  db: MySQLDatabase, anchorObservationId: number | null, anchorEpoch: number,
  depthBefore: number = 10, depthAfter: number = 10, project?: string
): Promise<TimelineResult> {
  const projectFilter = project ? 'AND project = ?' : '';
  const projectParams = project ? [project] : [];
  let startEpoch: number, endEpoch: number;

  if (anchorObservationId !== null) {
    try {
      const beforeRecords = await db.prepare(`
        SELECT id, created_at_epoch FROM observations
        WHERE id <= ? ${projectFilter} ORDER BY id DESC LIMIT ?
      `).all(anchorObservationId, ...projectParams, depthBefore + 1) as Array<{id: number; created_at_epoch: number}>;
      const afterRecords = await db.prepare(`
        SELECT id, created_at_epoch FROM observations
        WHERE id >= ? ${projectFilter} ORDER BY id ASC LIMIT ?
      `).all(anchorObservationId, ...projectParams, depthAfter + 1) as Array<{id: number; created_at_epoch: number}>;
      if (beforeRecords.length === 0 && afterRecords.length === 0) return { observations: [], sessions: [], prompts: [] };
      startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
      endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
    } catch (err: any) {
      logger.error('DB', 'Error getting boundary observations', undefined, { error: err, project });
      return { observations: [], sessions: [], prompts: [] };
    }
  } else {
    try {
      const beforeRecords = await db.prepare(`
        SELECT created_at_epoch FROM observations
        WHERE created_at_epoch <= ? ${projectFilter} ORDER BY created_at_epoch DESC LIMIT ?
      `).all(anchorEpoch, ...projectParams, depthBefore) as Array<{created_at_epoch: number}>;
      const afterRecords = await db.prepare(`
        SELECT created_at_epoch FROM observations
        WHERE created_at_epoch >= ? ${projectFilter} ORDER BY created_at_epoch ASC LIMIT ?
      `).all(anchorEpoch, ...projectParams, depthAfter + 1) as Array<{created_at_epoch: number}>;
      if (beforeRecords.length === 0 && afterRecords.length === 0) return { observations: [], sessions: [], prompts: [] };
      startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
      endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
    } catch (err: any) {
      logger.error('DB', 'Error getting boundary timestamps', undefined, { error: err, project });
      return { observations: [], sessions: [], prompts: [] };
    }
  }

  const observations = await db.prepare(`
    SELECT * FROM observations
    WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
    ORDER BY created_at_epoch ASC
  `).all(startEpoch, endEpoch, ...projectParams) as ObservationRecord[];

  const sessions = await db.prepare(`
    SELECT * FROM session_summaries
    WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
    ORDER BY created_at_epoch ASC
  `).all(startEpoch, endEpoch, ...projectParams) as SessionSummaryRecord[];

  const promptProjectFilter = project ? 'AND s.project = ?' : '';
  const prompts = await db.prepare(`
    SELECT up.*, s.project, s.memory_session_id
    FROM user_prompts up JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${promptProjectFilter}
    ORDER BY up.created_at_epoch ASC
  `).all(startEpoch, endEpoch, ...projectParams) as UserPromptRecord[];

  return {
    observations: observations || [],
    sessions: (sessions || []).map(s => ({
      id: s.id, memory_session_id: s.memory_session_id, project: s.project,
      request: s.request, completed: s.completed, next_steps: s.next_steps,
      created_at: s.created_at, created_at_epoch: s.created_at_epoch
    })),
    prompts: (prompts || []).map(p => ({
      id: p.id, content_session_id: p.content_session_id,
      prompt_number: p.prompt_number, prompt_text: p.prompt_text,
      project: p.project, created_at: p.created_at, created_at_epoch: p.created_at_epoch
    }))
  };
}

export async function getAllProjects(db: MySQLDatabase): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT DISTINCT project FROM sdk_sessions
    WHERE project IS NOT NULL AND project != '' ORDER BY project ASC
  `).all() as Array<{ project: string }>;
  return rows.map(row => row.project);
}
