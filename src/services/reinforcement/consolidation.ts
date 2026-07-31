// SPDX-License-Identifier: Apache-2.0

import { FACT_KINDS, isFactKind, type FactKind } from '../sqlite/facts/store.js';

/**
 * Semantic memory layer — consolidation prompt build + verdict parse.
 *
 * Pure, provider-agnostic, unit-testable: the LLM call is injected by the
 * caller (consolidation-judge.ts) as a `JudgeFn`, mirroring the dedup.ts /
 * dedup-judge.ts split. A consolidation run feeds the judge the active facts
 * for a project plus the new observations since the last run, and gets back
 * verdicts: ADD / UPDATE / DELETE / NOOP.
 *
 * Fact-gate (spec delta D3): the parser mechanically rejects any ADD/UPDATE
 * verdict carrying zero usable `source_ids` — a hallucinated fact with no
 * provenance fails parsing the same way malformed JSON does. Anything
 * unparseable degrades to NOOP-effect: the main pipeline is never disturbed.
 */

export interface ConsolidationFactInput {
  id: number;
  kind: string;
  fact: string;
}

export interface ConsolidationObservationInput {
  id: number;
  title: string | null;
  narrative: string | null;
  concepts: string | null;
}

export type ConsolidationVerdict =
  | { action: 'ADD'; kind: FactKind; fact: string; sourceIds: number[] }
  | { action: 'UPDATE'; targetFactId: number; fact: string; sourceIds: number[] }
  | { action: 'DELETE'; targetFactId: number }
  | { action: 'NOOP' };

export interface ParseVerdictsResult {
  verdicts: ConsolidationVerdict[];
  /** Human-readable reasons for every rejected verdict (logged upstream). */
  rejected: string[];
}

/** Hard cap on a fact's length — one self-contained sentence. */
const MAX_FACT_LENGTH = 500;

function parseConcepts(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export function buildConsolidationPrompt(
  facts: ConsolidationFactInput[],
  observations: ConsolidationObservationInput[],
): string {
  const factLines = facts
    .map(f => `[F${f.id}] (${f.kind}) ${f.fact}`)
    .join('\n');
  const observationLines = observations
    .map(o => {
      const concepts = parseConcepts(o.concepts).slice(0, 5);
      const conceptSuffix = concepts.length > 0 ? ` [${concepts.join(', ')}]` : '';
      return `[O${o.id}] ${o.title ?? ''}${conceptSuffix}\n    ${(o.narrative ?? '').slice(0, 300)}`;
    })
    .join('\n');

  return [
    'You are a memory consolidation judge. Episodic observations are being distilled',
    'into durable semantic facts about a project and its user.',
    '',
    'ACTIVE FACTS (what is already known):',
    factLines || '(none)',
    '',
    'NEW OBSERVATIONS (episodes since the last consolidation):',
    observationLines || '(none)',
    '',
    'Reply with ONLY a JSON object, no prose:',
    '{"verdicts":[',
    '  {"action":"ADD","kind":"<kind>","fact":"<one sentence>","source_ids":[<O-id, ...>]},',
    '  {"action":"UPDATE","target_fact_id":<F-id>,"fact":"<replacement sentence>","source_ids":[<O-id, ...>]},',
    '  {"action":"DELETE","target_fact_id":<F-id>},',
    '  {"action":"NOOP"}',
    ']}',
    `Kinds: ${FACT_KINDS.join(' | ')}.`,
    'Rules:',
    '- Facts must be session-agnostic, atomic, and phrased as standing truths',
    '  ("tests run via `bun test`", never "in session X we fixed...").',
    '- ADD only genuinely new, durable knowledge not covered by any active fact.',
    '- UPDATE only when the world changed and the new text replaces fact F-id.',
    '- DELETE only when fact F-id simply stopped being true, with no successor.',
    '- Every ADD and UPDATE MUST cite at least one source_ids entry — the [O-id]',
    '  observations the fact is distilled from. Uncited verdicts are discarded.',
    '- Prefer NOOP when the episodes added nothing durable.',
  ].join('\n');
}

/**
 * Tolerant id list parsing. The judge sees observations marked `[O<id>]` in
 * the prompt and — being a language model — often cites them back verbatim
 * (`"O7211"`, `"7211"`, `"#7211"`) instead of bare JSON numbers (observed
 * live with kimi-for-coding, 2026-07-28: every ADD verdict was fact-gated
 * because of this). Accept bare integers and such strings alike.
 */
function toIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const v of value) {
    const id = toVerdictId(v);
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** One id: a positive integer, or a string of digits with an optional O/F/# prefix. */
function toVerdictId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const m = value.trim().match(/^[oOfF#]?(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return null;
}

function toFactText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_FACT_LENGTH);
}

/**
 * Parse the judge's reply into validated verdicts. Defensive at every level:
 * malformed JSON, unknown actions, out-of-range targets, and fact-gate
 * violations (ADD/UPDATE without cited source observations) are rejected
 * individually; total garbage yields zero verdicts — the NOOP effect.
 *
 * `factIds` / `observationIds` are the id sets the judge was shown, so a
 * verdict can never target a row outside the prompt.
 */
export function parseConsolidationVerdicts(
  raw: string,
  opts: { factIds: Set<number>; observationIds: Set<number> },
): ParseVerdictsResult {
  const rejected: string[] = [];
  const empty: ParseVerdictsResult = { verdicts: [], rejected };

  const match = raw.match(/\{[\s\S]*\}/) ?? raw.match(/\[[\s\S]*\]/);
  if (!match) {
    rejected.push('no JSON found in judge reply');
    return empty;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    rejected.push('malformed JSON in judge reply');
    return empty;
  }

  let entries: unknown[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).verdicts)) {
    entries = (parsed as any).verdicts;
  } else if (parsed && typeof parsed === 'object' && typeof (parsed as any).action === 'string') {
    entries = [parsed]; // single bare verdict
  } else {
    rejected.push('judge reply has no verdicts array');
    return empty;
  }

  const verdicts: ConsolidationVerdict[] = [];
  let noopSeen = false;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      rejected.push('verdict is not an object');
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const action = obj.action;

    if (action === 'NOOP') {
      if (!noopSeen) {
        verdicts.push({ action: 'NOOP' });
        noopSeen = true;
      }
      continue;
    }

    if (action === 'ADD' || action === 'UPDATE') {
      const fact = toFactText(obj.fact);
      if (!fact) {
        rejected.push(`${action}: missing/empty fact text`);
        continue;
      }
      // Fact-gate: no cited source observation → the verdict fails parsing.
      const sourceIds = toIdArray(obj.source_ids).filter(id => opts.observationIds.has(id));
      if (sourceIds.length === 0) {
        rejected.push(`${action}: fact-gate — no valid source_ids, verdict discarded`);
        continue;
      }

      if (action === 'ADD') {
        if (!isFactKind(obj.kind)) {
          rejected.push(`ADD: unknown kind ${JSON.stringify(obj.kind)}`);
          continue;
        }
        verdicts.push({ action: 'ADD', kind: obj.kind, fact, sourceIds });
        continue;
      }

      const targetFactId = toVerdictId(obj.target_fact_id);
      if (targetFactId === null || !opts.factIds.has(targetFactId)) {
        rejected.push('UPDATE: target_fact_id not among the active facts shown');
        continue;
      }
      verdicts.push({ action: 'UPDATE', targetFactId, fact, sourceIds });
      continue;
    }

    if (action === 'DELETE') {
      const targetFactId = toVerdictId(obj.target_fact_id);
      if (targetFactId === null || !opts.factIds.has(targetFactId)) {
        rejected.push('DELETE: target_fact_id not among the active facts shown');
        continue;
      }
      verdicts.push({ action: 'DELETE', targetFactId });
      continue;
    }

    rejected.push(`unknown action ${JSON.stringify(action)}`);
  }

  return { verdicts, rejected };
}
