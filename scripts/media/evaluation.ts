/** Offline-first benchmark seam; no credentials, fetches or implicit paid calls. */
import { MEDIA_LIMITS, MediaError, type MediaRecipe } from '../../src/shared/media-contract.js';
import { randomUUID } from 'node:crypto';

export interface EvaluationImage {
  file: string;
  sha256: string;
  width: number;
  height: number;
  label: string;
}

export interface EvaluationObservation {
  image_labels: string[];
  facts: string[];
}

export interface EvaluationFixture {
  id: string;
  kind: string;
  recipe: MediaRecipe;
  images: EvaluationImage[];
  expected_observations: EvaluationObservation[];
}

export interface EvaluationCorpus {
  version: 1;
  origin: 'public-generated-and-nasa';
  fixtures: EvaluationFixture[];
}

/** Already metered by the real caller's provenance-preserving accounting helper. */
export interface EvaluationResult {
  parsed: boolean;
  observations: EvaluationObservation[];
  actual_cost_usd: number | null;
  cost_source: 'provider' | 'computed' | 'missing';
  resolved_model: string;
  served_model?: string;
  provider?: string;
  generation_id?: string;
}

export interface EvaluationRequest {
  model: string;
  fixture_id: string;
  attempt_id: string;
  max_output_tokens: number;
  signal: AbortSignal;
  prompt: string;
  images: Array<{ label: string; mime_type: 'image/webp'; bytes: Uint8Array }>;
}

export interface EvaluationOptions {
  mode?: 'dry-run' | 'execute';
  executionKind?: 'mock' | 'live';
  model?: string;
  maxSpendUsd?: number;
  estimatedRequestCostUsd?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  runId?: string;
}

export interface EvaluationDependencies {
  caller?: (request: EvaluationRequest) => Promise<EvaluationResult>;
  /** Derivatives only; Phase 7 supplies the converter/full event flow. */
  readDerivative?: (fixture: EvaluationFixture, image: EvaluationImage) => Promise<Uint8Array>;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
  /** Required for live execution; record every attempt before another call. */
  recordAttempt?: (attempt: EvaluationAttempt) => Promise<void>;
}

export interface EvaluationAttempt {
  attempt_id: string;
  fixture_id: string;
  retry: number;
  requested_model: string;
  resolved_model: string | null;
  served_model: string | null;
  provider: string | null;
  generation_id: string | null;
  image_count: number;
  elapsed_ms: number;
  timed_out: boolean;
  actual_cost_usd: number | null;
  cost_source: EvaluationResult['cost_source'];
  parsed: boolean;
  labels_valid: boolean;
  critical_facts_present: boolean;
  observations: EvaluationObservation[];
}

export interface EvaluationReport {
  version: 1;
  execution_kind: 'dry-run' | 'mock' | 'live';
  qualification: 'not_qualified';
  outcome: 'dry_run' | 'complete' | 'spend_limit' | 'unknown_cost' | 'retry_limit' | 'recording_failed';
  fixture_count: number;
  request_count: number;
  known_spend_usd: number;
  unknown_charge: boolean;
  max_spend_usd: number | null;
  max_output_tokens: number | null;
  request_timeout_ms: number | null;
  fixtures: Array<{ id: string; hashes: string[]; recipe: MediaRecipe }>;
  attempts: EvaluationAttempt[];
}

const MAX_EVALUATION_RETRIES = 2;
const MAX_EVALUATION_OUTPUT_TOKENS = 4096;
let executionActive = false;

export function scoreEvaluationResult(fixture: EvaluationFixture, result: EvaluationResult): {
  labelsValid: boolean;
  criticalFactsPresent: boolean;
} {
  const expected = fixture.expected_observations;
  const supplied = new Set(fixture.images.map(image => image.label));
  const labelKey = (labels: string[]) => [...labels].sort().join('\u0000');
  const expectedKeys = expected.map(observation => labelKey(observation.image_labels)).sort();
  const actualKeys = result.observations.map(observation => labelKey(observation.image_labels)).sort();
  const labelsValid = result.parsed && result.observations.length === expected.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    result.observations.every(observation => {
      const labels = observation.image_labels;
      return new Set(labels).size === labels.length && labels.every(label => supplied.has(label));
    });
  const used = new Set<number>();
  const criticalFactsPresent = result.parsed && expected.every(observation => {
    const match = result.observations.findIndex((actual, index) => !used.has(index) &&
      labelKey(actual.image_labels) === labelKey(observation.image_labels) &&
      observation.facts.every(fact => actual.facts.includes(fact)));
    if (match < 0) return false;
    used.add(match);
    return true;
  });
  return { labelsValid, criticalFactsPresent };
}

function normalizeResult(value: unknown): EvaluationResult {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const costSource = record.cost_source === 'provider' || record.cost_source === 'computed' ? record.cost_source : 'missing';
  const cost = typeof record.actual_cost_usd === 'number' && Number.isFinite(record.actual_cost_usd) && record.actual_cost_usd >= 0 ? record.actual_cost_usd : null;
  const validObservations = Array.isArray(record.observations) && record.observations.length <= 32 && record.observations.every(value => {
    if (value === null || typeof value !== 'object') return false;
    const observation = value as Record<string, unknown>;
    return Array.isArray(observation.image_labels) && observation.image_labels.length <= MEDIA_LIMITS.maxImagesPerEvent &&
      observation.image_labels.every(label => typeof label === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(label)) &&
      Array.isArray(observation.facts) && observation.facts.length <= 64 &&
      observation.facts.every(fact => typeof fact === 'string' && fact.length <= 4096);
  });
  const result: EvaluationResult = {
    parsed: record.parsed === true && validObservations,
    observations: validObservations ? (record.observations as EvaluationObservation[]).map(observation => ({ image_labels: [...observation.image_labels], facts: [...observation.facts] })) : [],
    actual_cost_usd: costSource === 'missing' ? null : cost,
    cost_source: cost === null ? 'missing' : costSource,
    resolved_model: typeof record.resolved_model === 'string' && record.resolved_model.length <= 256 ? record.resolved_model : '',
  };
  for (const key of ['served_model', 'provider', 'generation_id'] as const) {
    if (typeof record[key] === 'string' && (record[key] as string).length <= 256) result[key] = record[key];
  }
  return result;
}

/**
 * One process-wide execution; sequential calls and explicit conservative spend
 * reservation. Estimates aren't a total-charge guarantee. Unknown charges and
 * an overrun on the final in-flight request stop all further requests.
 */
export async function runMediaEvaluation(
  corpus: EvaluationCorpus,
  options: EvaluationOptions = {},
  dependencies: EvaluationDependencies = {},
): Promise<EvaluationReport> {
  const report: EvaluationReport = {
    version: 1,
    execution_kind: options.mode === 'execute' ? options.executionKind ?? 'mock' : 'dry-run',
    qualification: 'not_qualified',
    outcome: options.mode === 'execute' ? 'complete' : 'dry_run',
    fixture_count: corpus.fixtures.length,
    request_count: 0,
    known_spend_usd: 0,
    unknown_charge: false,
    max_spend_usd: null,
    max_output_tokens: null,
    request_timeout_ms: null,
    fixtures: corpus.fixtures.map(fixture => ({ id: fixture.id, hashes: fixture.images.map(image => image.sha256), recipe: fixture.recipe })),
    attempts: [],
  };
  // Never even resolve bytes or call an injected model in the default mode.
  if (options.mode !== 'execute') return report;
  const budget = options.maxSpendUsd;
  const estimate = options.estimatedRequestCostUsd;
  const retries = options.maxRetries;
  const maxOutput = options.maxOutputTokens;
  const requestTimeout = options.requestTimeoutMs;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 ||
      typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate <= 0) throw new MediaError('spend_limit');
  if (!Number.isSafeInteger(retries) || (retries as number) < 0 || (retries as number) > MAX_EVALUATION_RETRIES) throw new MediaError('retry_limit');
  if (!Number.isSafeInteger(maxOutput) || (maxOutput as number) <= 0 || (maxOutput as number) > MAX_EVALUATION_OUTPUT_TOKENS) throw new Error('invalid evaluation output-token cap');
  if (!Number.isSafeInteger(requestTimeout) || (requestTimeout as number) <= 0 || (requestTimeout as number) > 180_000) throw new Error('invalid evaluation request timeout');
  if (!options.model?.trim() || !dependencies.caller || !dependencies.readDerivative) throw new Error('explicit evaluation caller, derivative reader and concrete model are required');
  if (options.model.trim().startsWith('~')) throw new Error('resolve the evaluation model to a fixed concrete catalog target first');
  if (options.executionKind === 'live' && !dependencies.recordAttempt) throw new Error('live evaluation requires a durable attempt recorder');
  if (executionActive) throw new Error('an evaluation execution is already active');
  const caller = dependencies.caller;
  const readDerivative = dependencies.readDerivative;
  const model = options.model.trim();
  const now = dependencies.now ?? Date.now;
  const scheduleTimeout = dependencies.scheduleTimeout ?? ((callback, milliseconds) => {
    const timeout = setTimeout(callback, milliseconds);
    return () => clearTimeout(timeout);
  });
  const runId = options.runId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) throw new Error('invalid evaluation run ID');
  report.max_spend_usd = budget;
  report.max_output_tokens = maxOutput as number;
  report.request_timeout_ms = requestTimeout as number;
  executionActive = true;
  let pendingCaller: Promise<EvaluationResult> | null = null;
  try {
    for (const fixture of corpus.fixtures) {
      if (fixture.images.length === 0 || fixture.images.length > MEDIA_LIMITS.maxImagesPerEvent) throw new Error('invalid fixture image count');
      const images: EvaluationRequest['images'] = [];
      let derivativeBytes = 0;
      for (const image of fixture.images) {
        const bytes = await readDerivative(fixture, image);
        if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_LIMITS.maxDerivativeBytes) throw new MediaError('derivative_too_large');
        derivativeBytes += bytes.byteLength;
        images.push({ label: image.label, mime_type: 'image/webp', bytes });
      }
      if (derivativeBytes > MEDIA_LIMITS.maxGatewayImageBytes) throw new MediaError('derivative_too_large');
      for (let retry = 0; retry <= (retries as number); retry++) {
        if (report.known_spend_usd + estimate > budget + Number.EPSILON) {
          report.outcome = 'spend_limit';
          return report;
        }
        const attemptId = `${runId}:${fixture.id}:${retry}`;
        const started = now();
        let result: EvaluationResult;
        let timedOut = false;
        let settled = false;
        let cancelTimeout = () => {};
        const controller = new AbortController();
        report.request_count++;
        try {
          const invocation = Promise.resolve().then(() => caller({
            model, fixture_id: fixture.id, attempt_id: attemptId,
            max_output_tokens: maxOutput as number,
            signal: controller.signal,
            // Expected facts are grading data and deliberately aren't included.
            prompt: 'Record useful visual facts as observations. Associate each observation with only its supplied image labels.',
            images,
          }));
          pendingCaller = invocation.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
          const deadline = new Promise<never>((_, reject) => {
            cancelTimeout = scheduleTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error('evaluation request timeout'));
            }, requestTimeout as number);
          });
          result = normalizeResult(await Promise.race([pendingCaller, deadline]));
        } catch {
          // A lost response is a potentially billed request, never a free retry.
          result = { parsed: false, observations: [], actual_cost_usd: null, cost_source: 'missing', resolved_model: '' };
        } finally {
          cancelTimeout();
          if (settled) pendingCaller = null;
        }
        const score = scoreEvaluationResult(fixture, result);
        const knownCharge = (result.cost_source === 'provider' || result.cost_source === 'computed') &&
          typeof result.actual_cost_usd === 'number' && Number.isFinite(result.actual_cost_usd) && result.actual_cost_usd >= 0;
        const attempt: EvaluationAttempt = {
          attempt_id: attemptId, fixture_id: fixture.id, retry, requested_model: model,
          resolved_model: result.resolved_model || null, served_model: result.served_model ?? null,
          provider: result.provider ?? null, generation_id: result.generation_id ?? null,
          image_count: images.length, elapsed_ms: Math.max(0, now() - started), timed_out: timedOut,
          actual_cost_usd: knownCharge ? result.actual_cost_usd : null,
          cost_source: knownCharge ? result.cost_source : 'missing',
          parsed: result.parsed, labels_valid: score.labelsValid,
          critical_facts_present: score.criticalFactsPresent, observations: result.observations,
        };
        report.attempts.push(attempt);
        if (knownCharge) report.known_spend_usd += result.actual_cost_usd as number;
        if (!knownCharge) report.unknown_charge = true;
        if (dependencies.recordAttempt) {
          try { await dependencies.recordAttempt(attempt); }
          catch { report.outcome = 'recording_failed'; return report; }
        }
        if (!knownCharge) {
          report.outcome = 'unknown_cost';
          report.unknown_charge = true;
          return report;
        }
        if (report.known_spend_usd > budget + Number.EPSILON) {
          report.outcome = 'spend_limit';
          return report;
        }
        if (score.labelsValid && score.criticalFactsPresent) break;
        if (retry === retries) {
          report.outcome = 'retry_limit';
          return report;
        }
      }
    }
    return report;
  } finally {
    if (pendingCaller) {
      // A caller timeout does not prove upstream work ended. Prevent another
      // run from overlapping it until that exact request has settled.
      pendingCaller.then(() => { executionActive = false; }, () => { executionActive = false; });
    } else executionActive = false;
  }
}
