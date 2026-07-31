// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import { reinforceObservation } from './persist.js';

/**
 * Phase 3 — semantic dedup judge (opt-in).
 *
 * Ported from the webdev memory vault's `mem add` pipeline. When a new
 * observation arrives, shortlist semantically-near existing observations, ask an
 * LLM for a verdict, and either keep it (ADD), fold it into the matching note by
 * reinforcing that note instead of writing a duplicate (INCREMENT), or mark the
 * contradicted note as superseded by the new one (FLAG_CONFLICT —
 * reconsolidation, see persist.ts `supersedeObservation`).
 *
 * The LLM call is injected as a `JudgeFn` so this module is provider-agnostic
 * and unit-testable; the exact content-hash short-circuit is handled upstream by
 * the storeObservation* ON CONFLICT path (the free, no-LLM dedup). This is the
 * semantic, near-duplicate tier on top of that.
 */

export interface DedupObservationInput {
  project: string;
  type: string;
  title: string | null;
  narrative: string | null;
}

export interface DedupCandidate {
  id: number;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
}

export type DedupAction = 'ADD' | 'INCREMENT' | 'FLAG_CONFLICT';

export interface Verdict {
  action: DedupAction;
  /** 1-based index into the shortlist, or null for ADD. */
  target: number | null;
  rationale: string;
}

/** Pluggable LLM call — takes a prompt, returns the raw model text. */
export type JudgeFn = (prompt: string) => Promise<string>;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'what',
  'which', 'observation', 'fixed', 'added', 'using', 'value', 'code',
  'это', 'как', 'что', 'для', 'при', 'над', 'под', 'после',
]);

/** Significant whole-word tokens (Latin+Cyrillic, ≥4 chars, stopwords dropped). */
export function significantTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(/[a-zа-яё0-9_-]{4,}/giu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of matches) {
    if (STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Build an FTS5 OR-query from the new observation's title+narrative tokens.
 * Returns '' when there's nothing meaningful to match on (caller skips dedup).
 */
export function buildFtsQuery(obs: DedupObservationInput, maxTerms = 12): string {
  const tokens = [
    ...significantTokens(obs.title),
    ...significantTokens(obs.narrative),
  ];
  const unique = Array.from(new Set(tokens)).slice(0, maxTerms);
  // Quote each term so hyphens/underscores don't trip the FTS query parser.
  return unique.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

/**
 * Shortlist near-duplicate candidates: same project + same type, ranked by FTS
 * relevance to the new observation's terms. Excludes a given id (the row itself,
 * once inserted). Capped.
 */
export function findDedupCandidates(
  db: Database,
  obs: DedupObservationInput,
  opts: { limit?: number; excludeId?: number } = {},
): DedupCandidate[] {
  const query = buildFtsQuery(obs);
  if (!query) return [];
  const limit = opts.limit ?? 8;

  try {
    return db.prepare(`
      SELECT o.id, o.type, o.title, o.subtitle, o.narrative
      FROM observations o
      JOIN observations_fts ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND o.project = ?
        AND o.type = ?
        AND o.superseded_by IS NULL
        ${opts.excludeId != null ? 'AND o.id != ?' : ''}
      ORDER BY bm25(observations_fts)
      LIMIT ?
    `).all(
      ...(opts.excludeId != null
        ? [query, obs.project, obs.type, opts.excludeId, limit]
        : [query, obs.project, obs.type, limit]),
    ) as DedupCandidate[];
  } catch {
    return []; // FTS unavailable / malformed query → no candidates, fail open to ADD
  }
}

export function buildJudgePrompt(obs: DedupObservationInput, shortlist: DedupCandidate[]): string {
  const candidates = shortlist
    .map((c, i) => `[${i + 1}] (${c.type}) ${c.title ?? ''}\n    ${(c.narrative ?? '').slice(0, 240)}`)
    .join('\n');
  return [
    'You are a memory deduplication judge. A new observation is being stored.',
    'Decide its relation to the existing candidates below.',
    '',
    'NEW OBSERVATION:',
    `(${obs.type}) ${obs.title ?? ''}`,
    `    ${(obs.narrative ?? '').slice(0, 400)}`,
    '',
    'EXISTING CANDIDATES:',
    candidates || '(none)',
    '',
    'Reply with ONLY a JSON object, no prose:',
    '{"action":"ADD|INCREMENT|FLAG_CONFLICT","target":<candidate number or null>,"rationale":"<short>"}',
    '- ADD: genuinely new information not covered by any candidate (target=null).',
    '- INCREMENT: semantically equivalent to candidate N — same fact restated (target=N).',
    '- FLAG_CONFLICT: directly contradicts candidate N (target=N).',
  ].join('\n');
}

/** Parse the judge's reply. Fail-open to ADD on anything unparseable/out-of-range. */
export function parseVerdict(raw: string, shortlistLength: number): Verdict {
  const fallback: Verdict = { action: 'ADD', target: null, rationale: 'unparseable verdict → ADD' };
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return fallback;
  }
  const action = obj.action;
  if (action !== 'ADD' && action !== 'INCREMENT' && action !== 'FLAG_CONFLICT') return fallback;
  if (action === 'ADD') return { action, target: null, rationale: String(obj.rationale ?? '') };

  const target = Number(obj.target);
  if (!Number.isInteger(target) || target < 1 || target > shortlistLength) {
    return fallback; // out-of-range target → ADD rather than touch the wrong row
  }
  return { action, target, rationale: String(obj.rationale ?? '') };
}

export interface DedupResult {
  action: DedupAction;
  /** Observation id that was reinforced (INCREMENT) or conflicts (FLAG_CONFLICT). */
  targetId: number | null;
  rationale: string;
}

/**
 * Run the full judge for one new observation against a shortlist and apply the
 * verdict. INCREMENT reinforces the target (the caller then skips inserting the
 * duplicate). ADD / FLAG_CONFLICT do not mutate here — the caller inserts the
 * row (FLAG_CONFLICT additionally surfaces the conflict).
 *
 * Returns ADD with no candidates without spending an LLM call.
 */
export async function judgeObservation(
  db: Database,
  obs: DedupObservationInput,
  shortlist: DedupCandidate[],
  judge: JudgeFn,
  today: Date = new Date(),
): Promise<DedupResult> {
  if (shortlist.length === 0) {
    return { action: 'ADD', targetId: null, rationale: 'no candidates' };
  }
  let verdict: Verdict;
  try {
    const raw = await judge(buildJudgePrompt(obs, shortlist));
    verdict = parseVerdict(raw, shortlist.length);
  } catch {
    return { action: 'ADD', targetId: null, rationale: 'judge error → ADD' };
  }

  if (verdict.action === 'INCREMENT' && verdict.target) {
    const targetId = shortlist[verdict.target - 1].id;
    reinforceObservation(db, targetId, today);
    return { action: 'INCREMENT', targetId, rationale: verdict.rationale };
  }
  if (verdict.action === 'FLAG_CONFLICT' && verdict.target) {
    return { action: 'FLAG_CONFLICT', targetId: shortlist[verdict.target - 1].id, rationale: verdict.rationale };
  }
  return { action: 'ADD', targetId: null, rationale: verdict.rationale };
}
