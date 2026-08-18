/**
 * RelevanceAnnotator — the critique stage for prompt-time semantic injection.
 *
 * The semantic channel (Chroma e5) ranks by similarity, but similar ≠
 * applicable: a stored observation was captured against a different world
 * state, and replaying it verbatim can act as noise. This service inserts one
 * batched, cheap-model LLM call between retrieval and injection: for each
 * candidate it produces either a short "why this helps now" hint (rendered as
 * `**Why now:** …` under the memory) or a `drop` verdict that removes the
 * memory from the injection entirely.
 *
 * Transport: a DIRECT Anthropic Messages API call (fetch), not an Agent SDK
 * subprocess. Measured live 2026-08-16 on a Kimi-backed endpoint: SDK spawn
 * cost 14–46s per call (blew every timeout), the raw HTTP round-trip is ~2.5s.
 * Credentials come from the same isolated env the observer uses
 * (buildIsolatedEnvWithFreshOAuth): ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY or
 * ANTHROPIC_AUTH_TOKEN.
 *
 * Hard constraints (the call sits on the BLOCKING hook path):
 *   - fail-open: any error/timeout/garbage output → inject unannotated;
 *   - hard timeout via AbortController (CLAUDE_MEM_SEMANTIC_ANNOTATE_TIMEOUT_MS);
 *   - single batched call per prompt — never one call per memory (quota cost
 *     is why this filter was deferred in the first place, see
 *     SettingsDefaultsManager CLAUDE_MEM_SEMANTIC_INJECT_MIN_SCORE comment).
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { buildIsolatedEnvWithFreshOAuth } from '../../shared/EnvManager.js';
import { logger } from '../../utils/logger.js';
import { resolveTierAlias } from './model-aliases.js';

export interface AnnotationCandidate {
  /** Stable caller-side key (e.g. SearchRoutes.observationKey) — verdicts map back to it. */
  key: string;
  title: string;
  narrative?: string;
  project?: string;
}

/** 'drop' = remove the memory from this injection; otherwise attach the hint. */
export type AnnotationVerdict = { hint: string } | 'drop';

/**
 * Why an annotate() call ended the way it did. 'ok' is the only outcome that
 * carries verdicts; everything else means "inject unannotated". Surfaced to
 * logs/telemetry so the mechanism stays inspectable.
 */
export type AnnotationOutcome = 'disabled' | 'provider_off' | 'timeout' | 'error' | 'unparseable' | 'ok';

export interface AnnotationResponse {
  outcome: AnnotationOutcome;
  verdicts: Map<string, AnnotationVerdict> | null;
  durationMs: number;
  model: string;
}

const HINT_MAX_CHARS = 140;
// Kept short on purpose: the critic prompt goes out on the blocking hook path,
// and per-prompt latency scales with candidate volume (measured live:
// 8 candidates × 500 chars blew the 20s budget on a Kimi backend).
const NARRATIVE_MAX_CHARS = 300;
const MAX_CANDIDATES = 20;

/**
 * Pure prompt builder (exported for tests). One numbered list so the model can
 * answer with compact per-index verdicts; narratives are truncated to bound
 * the input tokens of a per-prompt call.
 *
 * `currentProject` is named explicitly and foreign candidates are tagged
 * `[from project: X]` because without it the critic confabulated shared
 * context — observed live: a memory from project `dex` kept for a query in
 * `mllab` with the hint "in the same dex project" (there is no "same").
 */
export function buildAnnotationPrompt(
  userQuery: string,
  candidates: AnnotationCandidate[],
  currentProject?: string,
): string {
  const list = candidates
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => {
      const narrative = (c.narrative ?? '').slice(0, NARRATIVE_MAX_CHARS);
      const foreign = c.project && c.project !== currentProject;
      const project = foreign ? ` [from project: ${c.project}]` : '';
      return `${i + 1}. ${c.title}${project}\n${narrative}`;
    })
    .join('\n\n');

  return [
    'You are a memory relevance critic. Below is the user\'s current request and',
    'candidate memories retrieved by semantic similarity. Similar is NOT the same',
    'as applicable: a memory captured against a different state of the world can',
    'mislead if replayed verbatim.',
    '',
    'For EACH memory decide:',
    '- "keep" — it is applicable to the current request. Write a one-line hint',
    `  (max ${HINT_MAX_CHARS} chars) naming the factual CONNECTION between the memory`,
    '  and THIS request: why it surfaced now. Do NOT summarize the memory — the',
    '  reader can expand it. Do NOT tell the reader what to say, do, or report:',
    '  no directives ("say…", "use this to…", "report…"), the consuming agent',
    '  draws its own conclusions. Form: "relevant because <link to the request>".',
    '- "drop" — it is NOT applicable here. When in doubt, drop. Do not stretch.',
    '',
    'Candidates tagged [from project: X] come from a DIFFERENT project than the',
    'one being worked on. Keep such a memory only if it helps WITHOUT knowing',
    'that project\'s internals; a merely similarly-worded request is NOT',
    'applicability — drop it. Never claim the projects are the same.',
    '',
    'Good hint: "captured during the same Chroma EF failure you are debugging now".',
    'Bad hint:  "use this to explain the Chroma failure" (directive + restates content).',
    '',
    'Answer with ONLY a JSON array, no prose, no markdown fence:',
    '[{"i": 1, "verdict": "keep", "hint": "..."}, {"i": 2, "verdict": "drop"}]',
    '',
    `CURRENT PROJECT: ${currentProject ?? '(unknown)'}`,
    '',
    'CURRENT REQUEST:',
    userQuery.slice(0, 2000),
    '',
    'CANDIDATE MEMORIES:',
    list,
  ].join('\n');
}

/**
 * Pure response parser (exported for tests). Tolerates markdown fences and
 * surrounding prose; returns null when nothing parseable is found (caller
 * treats null as fail-open). Unknown indexes and malformed entries are
 * skipped; hints are truncated to HINT_MAX_CHARS. When allowDrop is false,
 * 'drop' verdicts are simply absent from the result map.
 */
export function parseAnnotationResponse(
  text: string,
  candidates: AnnotationCandidate[],
  allowDrop: boolean,
): Map<string, AnnotationVerdict> | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const verdicts = new Map<string, AnnotationVerdict>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const i = (entry as any).i;
    if (typeof i !== 'number' || i < 1 || i > candidates.length) continue;
    const candidate = candidates[i - 1];

    if ((entry as any).verdict === 'drop') {
      if (allowDrop) verdicts.set(candidate.key, 'drop');
      continue;
    }
    if ((entry as any).verdict === 'keep' && typeof (entry as any).hint === 'string' && (entry as any).hint.trim()) {
      verdicts.set(candidate.key, { hint: (entry as any).hint.trim().slice(0, HINT_MAX_CHARS) });
    }
  }
  return verdicts;
}

export class RelevanceAnnotator {
  /**
   * Annotate candidates against the current user query. Never throws; every
   * non-'ok' outcome means "inject unannotated" (fail-open).
   */
  async annotate(userQuery: string, candidates: AnnotationCandidate[], currentProject?: string): Promise<AnnotationResponse> {
    const none = (outcome: AnnotationOutcome, model = '', startedAt = Date.now()): AnnotationResponse =>
      ({ outcome, verdicts: null, durationMs: Date.now() - startedAt, model });

    if (!userQuery || candidates.length === 0) return none('disabled');

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_SEMANTIC_ANNOTATE !== 'true') return none('disabled');

    const model = resolveTierAlias(settings.CLAUDE_MEM_SEMANTIC_ANNOTATE_MODEL || '$TIER:simple', settings);

    // The direct Messages API call needs Anthropic-compatible credentials in
    // the isolated env (API key or OAuth token). Their absence — not the
    // configured provider name — is what turns the feature off.

    const allowDrop = settings.CLAUDE_MEM_SEMANTIC_ANNOTATE_ALLOW_DROP !== 'false';
    // Hard cap at 20s even if configured higher: the annotation sits inside
    // the /api/context/semantic request, which the hook fetches with a 30s
    // API timeout. An annotation budget that (with search latency) exceeds
    // the hook budget kills the ENTIRE injection, not just the hints —
    // observed live 2026-08-18: 30s annotation timeout + slow backend →
    // "Worker unavailable, skipping hook", prompts got no context at all.
    const timeoutMs = Math.min(
      Math.max(parseInt(settings.CLAUDE_MEM_SEMANTIC_ANNOTATE_TIMEOUT_MS, 10) || 4000, 500),
      20000,
    );

    const trimmed = candidates.slice(0, MAX_CANDIDATES);
    const startedAt = Date.now();
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const env = await buildIsolatedEnvWithFreshOAuth();
      const baseUrl = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
      const headers: Record<string, string> = {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      };
      if (env.ANTHROPIC_API_KEY) {
        headers['x-api-key'] = env.ANTHROPIC_API_KEY;
      } else if (env.ANTHROPIC_AUTH_TOKEN) {
        headers['authorization'] = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
        headers['anthropic-beta'] = 'oauth-2025-04-20';
      } else {
        return none('provider_off', model, startedAt);
      }

      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          // Roomy on purpose: thinking-enabled backends (Kimi) burn output
          // tokens on a thinking block before the JSON verdict array.
          max_tokens: 2048,
          temperature: 0,
          messages: [{ role: 'user', content: buildAnnotationPrompt(userQuery, trimmed, currentProject) }],
        }),
        signal: abortController.signal,
      });
      if (!response.ok) {
        logger.debug('HTTP', `Semantic annotation got HTTP ${response.status}, injecting unannotated`, {});
        return none('error', model, startedAt);
      }
      const payload = await response.json() as { content?: Array<{ type: string; text?: string }> };
      // Skip thinking blocks (Kimi-style endpoints emit them); join text only.
      const answer = (payload.content ?? [])
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text!)
        .join('');

      if (abortController.signal.aborted) return none('timeout', model, startedAt);

      const verdicts = answer ? parseAnnotationResponse(answer, trimmed, allowDrop) : null;
      if (!verdicts) return none('unparseable', model, startedAt);

      return { outcome: 'ok', verdicts, durationMs: Date.now() - startedAt, model };
    } catch (error) {
      const outcome: AnnotationOutcome = abortController.signal.aborted ? 'timeout' : 'error';
      if (outcome === 'error') {
        logger.debug('HTTP', 'Semantic annotation failed, injecting unannotated', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return none(outcome, model, startedAt);
    } finally {
      clearTimeout(timer);
    }
  }
}
