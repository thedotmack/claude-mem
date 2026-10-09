/**
 * Orchestrates solving a set of instances and writing SWE-bench artifacts.
 *
 * Outputs (under the run directory):
 *   - predictions.jsonl : one Prediction per instance — the exact input the
 *     official grader consumes.
 *   - results.jsonl     : richer SolveResult per instance (turns, tool counts,
 *     mem-search usage, tokens/cost, timing) for analysis.
 *   - summary.json      : run-level rollup.
 *
 * Instances run sequentially by default (each needs an exclusive checkout of
 * its repo); concurrency>1 is safe only across distinct repos, so it is opt-in.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prediction, SolveResult, SweBenchInstance } from './types.ts';
import type { ChatProvider } from './types.ts';
import { MemSearchClient } from './mem-tools.ts';
import { prepareRepo, type PrepareOptions } from './repo.ts';
import { solveInstance, type SolveEvent } from './solver.ts';
import type { LearnOptions } from './learn.ts';
import { addUsage, emptyUsage } from './openrouter.ts';

export interface RunOptions {
  instances: SweBenchInstance[];
  provider: ChatProvider;
  modelNameForLeaderboard: string;
  runDir: string;
  memClient?: MemSearchClient;
  skipPriming?: boolean;
  learnOptions?: LearnOptions;
  maxTurns?: number;
  bashTimeoutMs?: number;
  prepare?: PrepareOptions;
  /** Overall wall-clock budget in ms; instances after it is hit are skipped. */
  wallClockBudgetMs?: number;
  onEvent?: (instanceId: string, event: SolveEvent) => void;
  onInstanceDone?: (result: SolveResult) => void;
  log?: (line: string) => void;
}

export interface RunSummary {
  model: string;
  total: number;
  attempted: number;
  withPatch: number;
  errored: number;
  totalMemSearchCalls: number;
  usage: ReturnType<typeof emptyUsage>;
  runDir: string;
  predictionsPath: string;
}

export async function runEvaluation(opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? (() => {});
  mkdirSync(opts.runDir, { recursive: true });
  const predictionsPath = join(opts.runDir, 'predictions.jsonl');
  const resultsPath = join(opts.runDir, 'results.jsonl');
  // Truncate any prior artifacts in this run dir.
  writeFileSync(predictionsPath, '');
  writeFileSync(resultsPath, '');

  const startedAt = Date.now();
  let usage = emptyUsage();
  let attempted = 0;
  let withPatch = 0;
  let errored = 0;
  let totalMemSearchCalls = 0;

  for (const instance of opts.instances) {
    if (opts.wallClockBudgetMs && Date.now() - startedAt > opts.wallClockBudgetMs) {
      log(`Wall-clock budget exhausted — skipping remaining ${opts.instances.length - attempted} instance(s).`);
      break;
    }
    attempted++;
    log(`[${attempted}/${opts.instances.length}] ${instance.instance_id} (${instance.repo})`);

    let result: SolveResult;
    try {
      const handle = await prepareRepo(instance, opts.prepare);
      result = await solveInstance({
        instance,
        repoDir: handle.dir,
        provider: opts.provider,
        memClient: opts.memClient,
        skipPriming: opts.skipPriming,
        learnOptions: opts.learnOptions,
        maxTurns: opts.maxTurns,
        bashTimeoutMs: opts.bashTimeoutMs,
        onEvent: (e) => opts.onEvent?.(instance.instance_id, e),
      });
    } catch (err) {
      result = {
        instance_id: instance.instance_id,
        patch: '',
        succeeded: false,
        turns: 0,
        toolCallCounts: {},
        memSearchCalls: 0,
        usage: emptyUsage(),
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    usage = addUsage(usage, result.usage);
    totalMemSearchCalls += result.memSearchCalls;
    if (result.patch.trim()) withPatch++;
    if (result.error) errored++;

    const prediction: Prediction = {
      instance_id: instance.instance_id,
      model_name_or_path: opts.modelNameForLeaderboard,
      model_patch: result.patch,
    };
    appendFileSync(predictionsPath, JSON.stringify(prediction) + '\n');
    appendFileSync(resultsPath, JSON.stringify(result) + '\n');
    opts.onInstanceDone?.(result);
    log(
      `    → patch: ${result.patch.trim() ? `${Buffer.byteLength(result.patch)}B` : 'EMPTY'}, ` +
        `turns: ${result.turns}, mem-search: ${result.memSearchCalls}` +
        (result.error ? `, error: ${result.error}` : ''),
    );
  }

  const summary: RunSummary = {
    model: opts.modelNameForLeaderboard,
    total: opts.instances.length,
    attempted,
    withPatch,
    errored,
    totalMemSearchCalls,
    usage,
    runDir: opts.runDir,
    predictionsPath,
  };
  writeFileSync(join(opts.runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
