#!/usr/bin/env bun
/**
 * cmem-swebench — CLI for the claude-mem SWE-bench harness.
 *
 * Subcommands:
 *   preflight            Check OpenRouter, the claude-mem worker, Docker/Python.
 *   fetch                Download a dataset split to a local .jsonl.
 *   learn <repoDir>      Run /learn-codebase priming over a repo, print/save it.
 *   run                  Solve instances → predictions.jsonl (primes + mem-search).
 *   grade                Grade predictions.jsonl with the official swebench harness.
 *
 * Run with no key/network for `learn` and `preflight`; `run` needs OpenRouter,
 * `grade` needs Docker + the swebench pip package.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveOpenRouterConfig, resolveWorkerConfig } from './config.ts';
import { OpenRouterProvider } from './openrouter.ts';
import { MemSearchClient } from './mem-tools.ts';
import { DATASETS, downloadDataset, loadInstancesFromFile, resolveDatasetId, selectInstances, writeInstancesJsonl } from './dataset.ts';
import { primeFromRepo } from './learn.ts';
import { runEvaluation } from './runner.ts';
import { grade, installEvalHarness, preflight } from './grade.ts';

type Args = { _: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function str(flags: Args['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}
function num(flags: Args['flags'], key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function bool(flags: Args['flags'], key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

const log = (s = '') => process.stdout.write(s + '\n');

async function main(): Promise<number> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];

  switch (cmd) {
    case 'preflight':
      return cmdPreflight();
    case 'fetch':
      return cmdFetch(flags);
    case 'learn':
      return cmdLearn(_[1], flags);
    case 'run':
      return cmdRun(flags);
    case 'grade':
      return cmdGrade(flags);
    case 'help':
    case undefined:
      printHelp();
      return 0;
    default:
      log(`Unknown command: ${cmd}\n`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  log(`cmem-swebench — SWE-bench harness for claude-mem (OpenRouter + /learn-codebase + mem-search)

Usage: bun run src/cli.ts <command> [options]

Commands:
  preflight                       Check OpenRouter key, claude-mem worker, Docker/Python/swebench.
  fetch --dataset verified        Download a split to data/<dataset>.jsonl (needs HF network).
       [--split test] [--out <path>]
  learn <repoDir> [--out <path>]  Build /learn-codebase priming for a repo; print or save it.
  run  --dataset verified         Solve instances → <run>/predictions.jsonl.
       [--data <file.jsonl>] [--ids a,b] [--count N] [--offset N]
       [--model openrouter/model] [--run-id ID] [--out <dir>]
       [--no-mem] [--no-prime] [--max-turns 40] [--local-repo <dir>]
  grade --predictions <file>      Grade with the official swebench harness (needs Docker).
       --dataset verified [--run-id ID] [--max-workers 4] [--install]

Datasets: ${Object.keys(DATASETS).join(', ')} (or a raw HF dataset id).
Env: CLAUDE_MEM_OPENROUTER_API_KEY / OPENROUTER_API_KEY, SWEBENCH_MODEL,
     CLAUDE_MEM_WORKER_PORT/HOST (mem-search target).`);
}

async function cmdPreflight(): Promise<number> {
  const or = resolveOpenRouterConfig();
  const worker = resolveWorkerConfig();
  log('OpenRouter:');
  log(`  model:   ${or.model}`);
  log(`  api url: ${or.apiUrl}`);
  log(`  api key: ${or.apiKey ? 'set' : 'MISSING (run needs it)'}`);
  log('claude-mem worker (mem-search):');
  log(`  base url: ${worker.baseUrl}`);
  const mem = new MemSearchClient(worker);
  const reachable = await mem.isReachable();
  log(`  reachable: ${reachable ? 'yes' : 'NO (mem-search calls will error; is the worker running?)'}`);
  log('Grading (official swebench harness):');
  const pf = await preflight();
  log(`  docker:   ${pf.dockerAvailable ? 'ok' : 'unavailable'}`);
  log(`  python:   ${pf.pythonAvailable ? 'ok' : 'unavailable'}`);
  log(`  swebench: ${pf.swebenchAvailable ? 'installed' : 'not installed'}`);
  for (const d of pf.details) log(`  - ${d}`);
  return 0;
}

async function cmdFetch(flags: Args['flags']): Promise<number> {
  const dataset = str(flags, 'dataset') ?? 'verified';
  const split = str(flags, 'split') ?? 'test';
  const id = resolveDatasetId(dataset);
  const out = str(flags, 'out') ?? join('data', `${dataset.replace(/[^a-z0-9]/gi, '_')}.jsonl`);
  mkdirSync(resolve(out, '..'), { recursive: true });
  log(`Downloading ${id} [${split}] via HF datasets-server…`);
  const instances = await downloadDataset({
    dataset: id,
    split,
    onProgress: (loaded, total) => process.stdout.write(`\r  ${loaded}${total ? `/${total}` : ''} rows`),
  });
  process.stdout.write('\n');
  writeInstancesJsonl(out, instances);
  log(`Wrote ${instances.length} instances → ${out}`);
  return 0;
}

async function cmdLearn(repoDir: string | undefined, flags: Args['flags']): Promise<number> {
  if (!repoDir) {
    log('Usage: cmem-swebench learn <repoDir> [--out <path>]');
    return 1;
  }
  const { map, block } = primeFromRepo(resolve(repoDir), {
    maxFiles: num(flags, 'max-files'),
    maxBytes: num(flags, 'max-bytes'),
  });
  log(`/learn-codebase: read ${map.totalFilesRead}/${map.totalFilesSeen} source files, ${(map.totalBytesRead / 1024).toFixed(0)} KiB` +
    (map.droppedForBudget > 0 ? ` (${map.droppedForBudget} dropped for budget)` : ''));
  const out = str(flags, 'out');
  if (out) {
    writeFileSync(out, block);
    log(`Priming block → ${out}`);
  } else {
    log('');
    log(block);
  }
  return 0;
}

async function cmdRun(flags: Args['flags']): Promise<number> {
  // Load instances from an explicit file, else download the named dataset.
  const dataFile = str(flags, 'data');
  const datasetName = str(flags, 'dataset') ?? 'verified';
  let instances = dataFile
    ? loadInstancesFromFile(resolve(dataFile))
    : await downloadDataset({ dataset: resolveDatasetId(datasetName) }).catch((e) => {
        log(`Could not download ${datasetName}: ${e instanceof Error ? e.message : String(e)}`);
        log('Provide a local dataset with --data <file.jsonl> (see `fetch`).');
        return [];
      });
  if (instances.length === 0) return 1;

  const ids = str(flags, 'ids')?.split(',').map((s) => s.trim()).filter(Boolean);
  instances = selectInstances(instances, { ids, count: num(flags, 'count'), offset: num(flags, 'offset') });
  if (instances.length === 0) {
    log('No instances selected after filtering.');
    return 1;
  }

  const orConfig = resolveOpenRouterConfig({ ...(str(flags, 'model') ? { model: str(flags, 'model')! } : {}) });
  if (!orConfig.apiKey) {
    log('OpenRouter API key missing. Set CLAUDE_MEM_OPENROUTER_API_KEY or OPENROUTER_API_KEY.');
    return 1;
  }
  const provider = new OpenRouterProvider(orConfig);

  const useMem = !bool(flags, 'no-mem');
  const memClient = useMem ? new MemSearchClient(resolveWorkerConfig({ ...(str(flags, 'project') ? { project: str(flags, 'project') } : {}) })) : undefined;
  if (memClient && !(await memClient.isReachable())) {
    log('WARNING: claude-mem worker is not reachable — mem-search calls will return errors.');
    log('         Start the worker or pass --no-mem. Continuing so priming-only runs still work.');
  }

  const runId = str(flags, 'run-id') ?? `cmem-${orConfig.model.replace(/[^a-z0-9]/gi, '_')}`;
  const runDir = resolve(str(flags, 'out') ?? join('runs', runId));

  log(`Model: ${orConfig.model}`);
  log(`Instances: ${instances.length}`);
  log(`mem-search: ${useMem ? 'ON' : 'off'} | /learn-codebase priming: ${bool(flags, 'no-prime') ? 'off' : 'ON'}`);
  log(`Run dir: ${runDir}\n`);

  const summary = await runEvaluation({
    instances,
    provider,
    modelNameForLeaderboard: runId,
    runDir,
    memClient,
    skipPriming: bool(flags, 'no-prime'),
    maxTurns: num(flags, 'max-turns'),
    ...(str(flags, 'local-repo') ? { prepare: { localRepoPath: resolve(str(flags, 'local-repo')!) } } : {}),
    log,
  });

  log('');
  log(`Done. ${summary.withPatch}/${summary.attempted} produced a non-empty patch; ${summary.errored} errored.`);
  log(`Total mem-search calls: ${summary.totalMemSearchCalls}`);
  log(`Tokens: ${summary.usage.totalTokens}${summary.usage.costUsd !== undefined ? ` (~$${summary.usage.costUsd.toFixed(4)})` : ''}`);
  log(`Predictions: ${summary.predictionsPath}`);
  log(`Next: cmem-swebench grade --predictions ${summary.predictionsPath} --dataset ${datasetName}`);
  return 0;
}

async function cmdGrade(flags: Args['flags']): Promise<number> {
  const predictions = str(flags, 'predictions');
  if (!predictions) {
    log('Usage: cmem-swebench grade --predictions <file.jsonl> --dataset verified [--run-id ID]');
    return 1;
  }
  const dataset = resolveDatasetId(str(flags, 'dataset') ?? 'verified');
  const runId = str(flags, 'run-id') ?? 'cmem-grade';

  const pf = await preflight();
  if (!pf.swebenchAvailable && bool(flags, 'install')) {
    const ok = await installEvalHarness((s) => process.stdout.write(s));
    if (!ok) { log('swebench install failed.'); return 1; }
  } else if (!pf.swebenchAvailable) {
    log('swebench is not installed. Re-run with --install, or `uv pip install swebench`.');
    return 1;
  }
  if (!pf.dockerAvailable) {
    log('Docker is not available/running. The official grader requires Docker.');
    return 1;
  }

  log(`Grading ${predictions} against ${dataset} (run_id=${runId})…`);
  const report = await grade({
    predictionsPath: resolve(predictions),
    datasetName: dataset,
    runId,
    maxWorkers: num(flags, 'max-workers') ?? 4,
    onOutput: (c) => process.stdout.write(c),
  });
  log('');
  log(`Resolved: ${report.resolvedIds.length}/${report.totalInstances} (${(report.resolvedRate * 100).toFixed(1)}%)`);
  log(`Report: ${report.reportPath}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
