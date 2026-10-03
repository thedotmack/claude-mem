import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { convertMedia } from '../../src/services/media/converter.js';
import { MEDIA_LIMITS } from '../../src/shared/media-contract.js';
import { loadEvaluationCorpus, CORPUS_DIRECTORY } from './corpus.js';
import { runMediaEvaluation, scoreEvaluationResult, type EvaluationCorpus, type EvaluationFixture, type EvaluationImage, type EvaluationOptions, type EvaluationRequest, type EvaluationResult } from './evaluation.js';

export async function runEvaluationChecks(): Promise<{ checks: number; images: number; sourceBytes: number; derivativeBytes: number }> {
  const corpus = await loadEvaluationCorpus();
  let checks = 0;
  let calls = 0;
  let sourceBytes = 0;
  let derivativeBytes = 0;
  const derivatives = new Map<string, Uint8Array>();
  const derivativeReader = async (_fixture: EvaluationFixture, image: EvaluationImage) => derivatives.get(image.file)!;
  const successful = (request: EvaluationRequest, cost = 0.001): EvaluationResult => {
    calls++;
    assert.equal(request.max_output_tokens, 512);
    assert.equal(request.model, 'fixture/model-concrete');
    assert.equal(request.signal.aborted, false);
    assert.ok(!request.prompt.includes('checksum mismatch') && !request.prompt.includes('HTTP 500'));
    for (const image of request.images) {
      assert.equal(Buffer.from(image.bytes).toString('ascii', 0, 4), 'RIFF');
      assert.equal(Buffer.from(image.bytes).toString('ascii', 8, 12), 'WEBP');
    }
    return { parsed: true, observations: structuredClone(corpus.fixtures.find(fixture => fixture.id === request.fixture_id)!.expected_observations), actual_cost_usd: cost, cost_source: 'provider', resolved_model: 'fixture/model-concrete', served_model: 'fixture/served-model' };
  };
  const options: EvaluationOptions = { mode: 'execute', executionKind: 'mock', model: 'fixture/model-concrete', maxSpendUsd: 0.1, estimatedRequestCostUsd: 0.001, maxRetries: 0, maxOutputTokens: 512, requestTimeoutMs: 1000, runId: 'public-fixture-run' };
  const single: EvaluationCorpus = { ...corpus, fixtures: corpus.fixtures.slice(0, 1) };
  const dry = await runMediaEvaluation(corpus, {}, {
    caller: async () => { throw new Error('dry run must never call'); },
    readDerivative: async () => { throw new Error('dry run must never resolve pixels'); },
    recordAttempt: async () => { throw new Error('dry run has no attempts'); },
  });
  assert.equal(dry.outcome, 'dry_run'); assert.equal(dry.request_count, 0); assert.equal(dry.fixture_count, 8); assert.equal(dry.qualification, 'not_qualified'); checks++;

  for (const fixture of corpus.fixtures) for (const image of fixture.images) {
    const source = await readFile(new URL(image.file, CORPUS_DIRECTORY));
    const converted = await convertMedia(source, image.file.endsWith('.jpg') ? 'image/jpeg' : 'image/png', fixture.recipe);
    sourceBytes += source.length;
    derivativeBytes += converted.llm.byteLength;
    assert.ok(converted.llm.byteLength <= MEDIA_LIMITS.maxDerivativeBytes);
    assert.ok(Math.max(converted.llm.width, converted.llm.height) <= MEDIA_LIMITS.maxDerivativeDimension);
    assert.equal(converted.source.sha256, image.sha256);
    derivatives.set(image.file, converted.llm.bytes);
  }
  assert.equal(derivatives.size, 9); checks++;

  calls = 0;
  const complete = await runMediaEvaluation(corpus, options, { caller: successful, readDerivative: derivativeReader });
  assert.equal(complete.outcome, 'complete'); assert.equal(calls, 8); assert.equal(complete.request_count, 8); assert.ok(Math.abs(complete.known_spend_usd - 0.008) < Number.EPSILON); assert.equal(complete.qualification, 'not_qualified'); checks++;

  calls = 0;
  const capped = await runMediaEvaluation(corpus, { ...options, maxSpendUsd: 0.001 }, { caller: successful, readDerivative: derivativeReader });
  assert.equal(capped.outcome, 'spend_limit'); assert.equal(calls, 1); checks++;

  calls = 0;
  const noCall = await runMediaEvaluation(single, { ...options, maxSpendUsd: 0.0001 }, { caller: successful, readDerivative: derivativeReader });
  assert.equal(noCall.request_count, 0); assert.equal(calls, 0); checks++;

  calls = 0;
  const free = await runMediaEvaluation(single, options, { caller: async request => successful(request, 0), readDerivative: derivativeReader });
  assert.equal(free.known_spend_usd, 0); assert.equal(free.attempts[0].cost_source, 'provider'); assert.equal(free.outcome, 'complete'); checks++;

  const unknown = await runMediaEvaluation(corpus, { ...options, maxRetries: 2 }, { caller: async () => ({ parsed: false, observations: [], actual_cost_usd: null, cost_source: 'missing', resolved_model: '' }), readDerivative: derivativeReader });
  assert.equal(unknown.outcome, 'unknown_cost'); assert.equal(unknown.request_count, 1); assert.equal(unknown.unknown_charge, true); assert.equal(unknown.attempts[0].resolved_model, null); checks++;

  const lost = await runMediaEvaluation(corpus, { ...options, maxRetries: 2 }, { caller: async () => { throw new Error('upstream response lost'); }, readDerivative: derivativeReader });
  assert.equal(lost.outcome, 'unknown_cost'); assert.equal(lost.request_count, 1); checks++;

  const malformed = await runMediaEvaluation(corpus, options, { caller: async () => ({ parsed: true, observations: null, actual_cost_usd: 0.003, cost_source: 'provider', resolved_model: 'fixture/model-concrete' } as unknown as EvaluationResult), readDerivative: derivativeReader });
  assert.equal(malformed.outcome, 'retry_limit'); assert.equal(malformed.known_spend_usd, 0.003); assert.equal(malformed.attempts[0].parsed, false); assert.deepEqual(malformed.attempts[0].observations, []); checks++;

  const invalidResponse = await runMediaEvaluation(corpus, options, { caller: async () => null as unknown as EvaluationResult, readDerivative: derivativeReader });
  assert.equal(invalidResponse.outcome, 'unknown_cost'); assert.equal(invalidResponse.request_count, 1); checks++;

  calls = 0;
  let failedOnce = false;
  const retried = await runMediaEvaluation(single, { ...options, maxRetries: 1 }, { caller: async request => {
    if (!failedOnce) { failedOnce = true; return { ...successful(request), parsed: false, observations: [] }; }
    return successful(request);
  }, readDerivative: derivativeReader });
  assert.equal(retried.outcome, 'complete'); assert.equal(retried.request_count, 2); assert.equal(retried.known_spend_usd, 0.002); assert.equal(retried.attempts[1].retry, 1); checks++;

  const failed = await runMediaEvaluation(single, { ...options, maxRetries: 1 }, { caller: async request => ({ ...successful(request), parsed: false, observations: [] }), readDerivative: derivativeReader });
  assert.equal(failed.outcome, 'retry_limit'); assert.equal(failed.request_count, 2); assert.equal(failed.known_spend_usd, 0.002); checks++;

  // Injected structural acceptance: a quality miss is not retried into best-of-N.
  const paraphrased = await runMediaEvaluation(single, { ...options, maxRetries: 1 }, {
    caller: async request => ({ ...successful(request), observations: [{ image_labels: ['event1_image1'], facts: ['paraphrase only'] }] }),
    readDerivative: derivativeReader,
    score: (_fixture, result) => ({ labelsValid: result.parsed && result.observations.length > 0, criticalFactsPresent: true }),
  });
  assert.equal(paraphrased.outcome, 'complete'); assert.equal(paraphrased.request_count, 1); assert.equal(paraphrased.attempts[0].critical_facts_present, true); checks++;

  const overrun = await runMediaEvaluation(corpus, { ...options, maxSpendUsd: 0.01 }, { caller: async request => successful(request, 0.02), readDerivative: derivativeReader });
  assert.equal(overrun.outcome, 'spend_limit'); assert.equal(overrun.request_count, 1); assert.equal(overrun.known_spend_usd, 0.02); checks++;

  const two = corpus.fixtures.find(fixture => fixture.id === 'two-image-event')!;
  const result: EvaluationResult = { parsed: true, observations: structuredClone(two.expected_observations).reverse(), actual_cost_usd: 0.001, cost_source: 'provider', resolved_model: 'fixture/model-concrete' };
  assert.deepEqual(scoreEvaluationResult(two, result), { labelsValid: true, criticalFactsPresent: true }); checks++;
  result.observations[0].image_labels = ['event1_image1']; result.observations[1].image_labels = ['event1_image2'];
  assert.equal(scoreEvaluationResult(two, result).criticalFactsPresent, false); checks++;
  result.observations[0].image_labels = ['event999_image1'];
  assert.equal(scoreEvaluationResult(two, result).labelsValid, false); checks++;

  for (const bad of [
    { maxSpendUsd: undefined }, { estimatedRequestCostUsd: 0 }, { maxRetries: 3 },
    { maxRetries: -1 }, { maxOutputTokens: 0 }, { maxOutputTokens: 4097 },
    { requestTimeoutMs: 0 }, { model: '~fixture/latest' },
    { runId: '/private/run-path' },
    { executionKind: 'live' as const },
  ]) {
    await assert.rejects(runMediaEvaluation(single, { ...options, ...bad }, { caller: successful, readDerivative: derivativeReader })); checks++;
  }

  let recorded = 0;
  const durable = await runMediaEvaluation(corpus, { ...options, executionKind: 'live' }, {
    caller: async request => { assert.equal(recorded, request.fixture_id === corpus.fixtures[0].id ? 0 : corpus.fixtures.findIndex(fixture => fixture.id === request.fixture_id)); return successful(request); },
    readDerivative: derivativeReader, recordAttempt: async () => { recorded++; },
  });
  assert.equal(durable.request_count, recorded); assert.equal(recorded, 8); checks++;

  const failedRecord = await runMediaEvaluation(corpus, { ...options, maxRetries: 2 }, { caller: successful, readDerivative: derivativeReader, recordAttempt: async () => { throw new Error('ledger unavailable'); } });
  assert.equal(failedRecord.outcome, 'recording_failed'); assert.equal(failedRecord.request_count, 1); assert.equal(failedRecord.known_spend_usd, 0.001); checks++;

  const uniqueFirst = await runMediaEvaluation(single, { ...options, runId: undefined }, { caller: successful, readDerivative: derivativeReader });
  const uniqueSecond = await runMediaEvaluation(single, { ...options, runId: undefined }, { caller: successful, readDerivative: derivativeReader });
  assert.notEqual(uniqueFirst.attempts[0].attempt_id, uniqueSecond.attempts[0].attempt_id); checks++;

  await assert.rejects(runMediaEvaluation(single, options, { caller: successful, readDerivative: async () => new Uint8Array(MEDIA_LIMITS.maxDerivativeBytes + 1) })); checks++;

  let settle!: (value: EvaluationResult) => void;
  const pending = new Promise<EvaluationResult>(resolve => { settle = resolve; });
  let timeoutRequest: EvaluationRequest | undefined;
  const timed = await runMediaEvaluation(single, { ...options, requestTimeoutMs: 1, maxRetries: 2 }, {
    caller: async request => { timeoutRequest = request; return pending; }, readDerivative: derivativeReader,
  });
  assert.equal(timed.outcome, 'unknown_cost'); assert.equal(timed.request_count, 1); assert.equal(timed.attempts[0].timed_out, true); assert.equal(timeoutRequest!.signal.aborted, true); checks++;
  await assert.rejects(runMediaEvaluation(single, options, { caller: successful, readDerivative: derivativeReader }), /already active/); checks++;
  settle({ parsed: false, observations: [], actual_cost_usd: 0.001, cost_source: 'provider', resolved_model: 'fixture/model-concrete' });
  await new Promise<void>(resolve => setImmediate(resolve));
  const resumed = await runMediaEvaluation(single, options, { caller: successful, readDerivative: derivativeReader });
  assert.equal(resumed.outcome, 'complete'); checks++;

  return { checks, images: derivatives.size, sourceBytes, derivativeBytes };
}
