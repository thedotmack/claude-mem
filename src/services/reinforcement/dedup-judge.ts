// SPDX-License-Identifier: Apache-2.0

import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import { buildIsolatedEnvWithFreshOAuth } from '../../shared/EnvManager.js';
import { findClaudeExecutable } from '../../shared/find-claude-executable.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { resolveTierAlias } from '../worker/model-aliases.js';
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildHardenedSdkOptions } from '../../sdk/hardened-options.js';
import { findDedupCandidates, judgeObservation, type JudgeFn } from './dedup.js';

/**
 * Phase 3 wiring — provider-backed semantic dedup judge (opt-in, default off).
 *
 * ⚠️ Each kept observation costs one extra LLM call. Gated behind
 * `CLAUDE_MEM_DEDUP_JUDGE_ENABLED=true`; off by default so it never spends
 * subscription quota unless explicitly turned on. The whole pass is defensive:
 * any failure falls back to storing the observations unchanged.
 */

export function dedupJudgeEnabled(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH) as unknown as Record<string, unknown>;
  const raw = settings.CLAUDE_MEM_DEDUP_JUDGE_ENABLED ?? process.env.CLAUDE_MEM_DEDUP_JUDGE_ENABLED;
  return String(raw ?? '') === 'true';
}

/** One-shot LLM call via the Agent SDK, mirroring KnowledgeAgent.executeQuery. */
export function createSdkJudge(): JudgeFn {
  return async (prompt: string): Promise<string> => {
    ensureDir(OBSERVER_SESSIONS_DIR);
    const claudePath = findClaudeExecutable('WORKER');
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const model = resolveTierAlias(settings.CLAUDE_MEM_MODEL, settings);

    const queryResult = query({
      prompt,
      options: buildHardenedSdkOptions({
        // Reuse the KnowledgeAgent spawn profile — an ad-hoc one-shot query,
        // not a streaming observer session.
        source: 'KnowledgeAgent',
        model,
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
      }),
    });

    let answer = '';
    for await (const msg of queryResult) {
      if (msg.type === 'assistant') {
        answer = msg.message.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
      }
    }
    return answer;
  };
}

interface JudgeableObservation {
  type: string;
  title: string | null;
  narrative: string | null;
  /** Echo marker (memory grounding, Layer 2) — set upstream by detectEcho. */
  echo_of?: number | null;
}

/**
 * Run the semantic judge over a batch about to be stored. Returns the subset to
 * actually insert: ADD + FLAG_CONFLICT are kept; INCREMENT folds into the
 * existing row (reinforced inside judgeObservation) and is dropped. Defensive —
 * a failing judge keeps the observation.
 *
 * FLAG_CONFLICT rows are reported via `onConflict` so the caller can mark the
 * contradicted row as superseded once the new row has been inserted and has an
 * id (reconsolidation — see persist.ts `supersedeObservation`).
 */
export async function applyDedupJudge<T extends JudgeableObservation>(
  db: Database,
  observations: T[],
  project: string,
  judge: JudgeFn = createSdkJudge(),
  onConflict?: (info: { observation: T; targetId: number; rationale: string }) => void,
): Promise<T[]> {
  const kept: T[] = [];
  for (const obs of observations) {
    // Echo rows (memory grounding, Layer 2) are stored but never judged: an
    // INCREMENT here would reinforce the very note the echo retells, letting
    // memory confirm itself. Skipping the judge is what breaks the loop.
    if (obs.echo_of != null) {
      kept.push(obs);
      continue;
    }
    const input = { project, type: obs.type, title: obs.title, narrative: obs.narrative };
    try {
      const shortlist = findDedupCandidates(db, input);
      const res = await judgeObservation(db, input, shortlist, judge);
      if (res.action === 'INCREMENT') {
        logger.info('DEDUP', `Semantic duplicate → reinforced #${res.targetId}, skipping insert | ${res.rationale}`);
        continue;
      }
      if (res.action === 'FLAG_CONFLICT' && res.targetId != null) {
        logger.warn('DEDUP', `Observation conflicts with #${res.targetId} — will supersede after insert | ${res.rationale}`);
        onConflict?.({ observation: obs, targetId: res.targetId, rationale: res.rationale });
      }
      kept.push(obs);
    } catch (error) {
      logger.warn('DEDUP', 'Judge failed for an observation — keeping it', {}, error instanceof Error ? error : new Error(String(error)));
      kept.push(obs);
    }
  }
  return kept;
}
