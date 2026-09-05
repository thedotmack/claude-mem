/**
 * Grading via the official SWE-bench harness.
 *
 * This shells out to `python -m swebench.harness.run_evaluation`, the canonical
 * containerized grader that applies each prediction's patch plus the gold test
 * patch inside the instance's Docker image and runs FAIL_TO_PASS/PASS_TO_PASS.
 * We do NOT reimplement grading — reusing the official harness is what makes a
 * score comparable to the leaderboard.
 *
 * Requirements at grade time: Docker running, Python, and the `swebench` pip
 * package (installEvalHarness can provision it with uv/pip).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run, type ExecResult } from './exec.ts';

export interface GradeOptions {
  predictionsPath: string;
  /** HF dataset name (e.g. princeton-nlp/SWE-bench_Verified) or a local file. */
  datasetName: string;
  runId: string;
  maxWorkers?: number;
  /** Directory to run the grader in (report JSON lands here). Default cwd. */
  cwd?: string;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export interface GradeReport {
  resolvedIds: string[];
  unresolvedIds: string[];
  erroredIds: string[];
  totalInstances: number;
  resolvedRate: number;
  reportPath: string;
  raw: unknown;
}

export interface PreflightResult {
  dockerAvailable: boolean;
  pythonAvailable: boolean;
  swebenchAvailable: boolean;
  details: string[];
}

export async function preflight(): Promise<PreflightResult> {
  const details: string[] = [];
  const docker = await run('docker', ['info'], { timeoutMs: 20_000 });
  const dockerAvailable = docker.code === 0;
  if (!dockerAvailable) details.push('docker: not running or unavailable (grading needs Docker).');

  const py = await pythonProbe(['--version']);
  const pythonAvailable = py.code === 0;
  if (!pythonAvailable) details.push('python: not found.');

  const swe = await pythonProbe(['-c', 'import swebench, sys; print(swebench.__version__ if hasattr(swebench, "__version__") else "installed")']);
  const swebenchAvailable = swe.code === 0;
  if (!swebenchAvailable) details.push('swebench: pip package not installed (run installEvalHarness or `uv pip install swebench`).');

  return { dockerAvailable, pythonAvailable, swebenchAvailable, details };
}

/** Install the official harness with uv (preferred) or pip. */
export async function installEvalHarness(onOutput?: (s: string) => void): Promise<boolean> {
  const uv = await run('uv', ['--version'], { timeoutMs: 10_000 });
  const cmd = uv.code === 0
    ? { file: 'uv', args: ['pip', 'install', '--system', 'swebench'] }
    : { file: 'python3', args: ['-m', 'pip', 'install', 'swebench'] };
  onOutput?.(`Installing swebench via ${cmd.file} ${cmd.args.join(' ')}…\n`);
  const res = await run(cmd.file, cmd.args, { timeoutMs: 600_000, maxBuffer: 256 * 1024 });
  onOutput?.(res.stdout + res.stderr);
  return res.code === 0;
}

/** Run the official grader and parse its report. */
export async function grade(opts: GradeOptions): Promise<GradeReport> {
  const cwd = opts.cwd ?? process.cwd();
  const args = [
    '-m', 'swebench.harness.run_evaluation',
    '--dataset_name', opts.datasetName,
    '--predictions_path', opts.predictionsPath,
    '--run_id', opts.runId,
    '--max_workers', String(opts.maxWorkers ?? 4),
  ];
  const python = await resolvePython();
  const res = await run(python, args, {
    cwd,
    timeoutMs: opts.timeoutMs ?? 3 * 60 * 60 * 1000,
    maxBuffer: 256 * 1024,
  });
  opts.onOutput?.(res.stdout + res.stderr);
  if (res.code !== 0 && res.timedOut) {
    throw new Error('swebench grading timed out.');
  }

  const report = locateReport(cwd, opts.runId);
  if (!report) {
    throw new Error(
      `Grading finished (exit ${res.code}) but no report JSON was found in ${cwd}. ` +
        `Last output:\n${(res.stdout + res.stderr).slice(-1000)}`,
    );
  }
  return report;
}

/**
 * The harness writes a report named like `<model>.<run_id>.json` in cwd. Field
 * names have shifted slightly across releases, so we read defensively.
 */
export function locateReport(cwd: string, runId: string): GradeReport | null {
  const candidates = readdirSync(cwd)
    .filter((f) => f.endsWith('.json') && f.includes(runId))
    .map((f) => join(cwd, f));
  const path = candidates.find((p) => existsSync(p));
  if (!path) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  return parseReport(raw, path);
}

export function parseReport(raw: Record<string, unknown>, reportPath: string): GradeReport {
  const resolvedIds = idList(raw, ['resolved_ids', 'resolved_instances', 'resolved']);
  const unresolvedIds = idList(raw, ['unresolved_ids', 'unresolved_instances', 'unresolved']);
  const erroredIds = idList(raw, ['error_ids', 'errored_ids', 'errors']);
  const totalFromField = numberField(raw, ['total_instances', 'submitted_instances', 'total']);
  const totalInstances = totalFromField ?? resolvedIds.length + unresolvedIds.length + erroredIds.length;
  return {
    resolvedIds,
    unresolvedIds,
    erroredIds,
    totalInstances,
    resolvedRate: totalInstances > 0 ? resolvedIds.length / totalInstances : 0,
    reportPath,
    raw,
  };
}

function idList(raw: Record<string, unknown>, keys: string[]): string[] {
  for (const k of keys) {
    const v = raw[k];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'number') return []; // count-only field; ids live elsewhere
  }
  return [];
}

function numberField(raw: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

async function resolvePython(): Promise<string> {
  const py3 = await run('python3', ['--version'], { timeoutMs: 10_000 });
  return py3.code === 0 ? 'python3' : 'python';
}

async function pythonProbe(args: string[]): Promise<ExecResult> {
  const py3 = await run('python3', args, { timeoutMs: 20_000 });
  if (py3.code === 0) return py3;
  return run('python', args, { timeoutMs: 20_000 });
}
