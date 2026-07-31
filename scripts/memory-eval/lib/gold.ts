// SPDX-License-Identifier: Apache-2.0

/**
 * Gold-set builder (rule 3 — declared scoring target).
 *
 * Queries are real user_prompts joined to their sdk_session. Candidates are
 * observations from the SAME memory session plus same-project observations in
 * a ±1 day window (superseded rows excluded). Without the judge, gold =
 * session linkage only; with the judge, gold = judge-confirmed ids (cached).
 *
 * Pure functions take a `Database` so tests can run on :memory: stores.
 */

import type { Database } from 'bun:sqlite';
import { DAY_MS, type GoldItem, type GoldSet } from './common.js';
import type { CachedJudge } from './judge.js';

export const MIN_PROMPT_LENGTH = 40;
export const MAX_CANDIDATES = 30;

export interface PromptRow {
  prompt_id: number;
  prompt_text: string;
  prompt_epoch: number;
  project: string;
  memory_session_id: string;
}

/** Recent prompts that have at least one non-superseded observation in their session. */
export function findPromptSessions(db: Database, limit: number): PromptRow[] {
  return db.prepare(`
    SELECT up.id AS prompt_id, up.prompt_text, up.created_at_epoch AS prompt_epoch,
           s.project, s.memory_session_id
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE length(up.prompt_text) >= ?
      AND up.prompt_text NOT LIKE '/%'
      AND EXISTS (
        SELECT 1 FROM observations o
        WHERE o.memory_session_id = s.memory_session_id AND o.superseded_by IS NULL
      )
    ORDER BY up.created_at_epoch DESC
    LIMIT ?
  `).all(MIN_PROMPT_LENGTH, limit) as PromptRow[];
}

interface ObsRow {
  id: number;
  title: string | null;
  narrative: string | null;
}

/** Session-linked observations (the linkage gold). */
export function sessionLinkedIds(db: Database, memorySessionId: string): number[] {
  const rows = db.prepare(`
    SELECT id FROM observations
    WHERE memory_session_id = ? AND superseded_by IS NULL
    ORDER BY created_at_epoch DESC
  `).all(memorySessionId) as Array<{ id: number }>;
  return rows.map(r => r.id);
}

/**
 * Candidate pool: same-session observations + same-project observations within
 * ±1 day of the prompt, capped at MAX_CANDIDATES (most recent first).
 */
export function buildCandidates(db: Database, prompt: PromptRow): ObsRow[] {
  return db.prepare(`
    SELECT id, title, narrative FROM observations
    WHERE superseded_by IS NULL
      AND (
        memory_session_id = ?
        OR ((project = ? OR merged_into_project = ?)
            AND abs(created_at_epoch - ?) <= ?)
      )
    ORDER BY (memory_session_id = ?) DESC, created_at_epoch DESC
    LIMIT ?
  `).all(
    prompt.memory_session_id,
    prompt.project, prompt.project, prompt.prompt_epoch, DAY_MS,
    prompt.memory_session_id,
    MAX_CANDIDATES,
  ) as ObsRow[];
}

export interface BuildGoldOptions {
  limit: number;
  judge?: CachedJudge | null;
  dbPath?: string;
}

export async function buildGold(db: Database, options: BuildGoldOptions): Promise<GoldSet> {
  const prompts = findPromptSessions(db, options.limit);
  const items: GoldItem[] = [];
  for (const p of prompts) {
    const linked = sessionLinkedIds(db, p.memory_session_id);
    if (linked.length === 0) continue;
    const candidates = buildCandidates(db, p);
    let relevantIds = linked;
    if (options.judge) {
      relevantIds = await options.judge.confirmRelevant(p.prompt_text, candidates);
    }
    items.push({
      promptId: p.prompt_id,
      promptText: p.prompt_text,
      promptEpoch: p.prompt_epoch,
      project: p.project,
      memorySessionId: p.memory_session_id,
      sessionLinkedIds: linked,
      candidateIds: candidates.map(c => c.id),
      relevantIds,
    });
  }
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    dbPath: options.dbPath ?? 'unknown',
    judgeUsed: Boolean(options.judge),
    itemCount: items.length,
    items,
  };
}
