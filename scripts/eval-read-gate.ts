#!/usr/bin/env bun
/**
 * File Read Gate eval: gate ON against gate OFF, through real claude-mem
 * workers and real Claude Code. What it proves and how to read the results:
 * evals/read-gate/README.md.
 *
 *   npm run eval:read-gate [-- --runs 3 --model claude-sonnet-5-5 -j 3 --max-cost-usd 10 --case <glob> --preflight-only]
 *
 * 1. Requires plugin/scripts/worker-service.cjs built with the gate, and
 *    provisions the plugin's tree-sitter CLI the way a real install does: the
 *    gate only denies where smart_outline can parse (D9).
 * 2. Starts one worker per arm, each with its own data dir under
 *    .scratch/read-gate-eval/<timestamp>/<arm>/data and its own free port, both
 *    seeded with the same observations of the fixture file.
 * 3. Pre-flight, no model: checks the tree-sitter CLI the built hook resolves,
 *    then pipes PreToolUse Read payloads into the real file-context hook
 *    against each worker.
 * 4. Runs evals/read-gate with `claude plugin eval`, analyzes every
 *    run's trace, writes reports/read-gate/<timestamp>/summary.{md,json} and
 *    exits non-zero when a verdict fails or a requested run did not complete.
 * Both workers are always stopped, and the sandboxes --keep-temp kept are
 * removed once their traces are copied into the report.
 */
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import net from 'net';
import path from 'path';
import { isTreeSitterCliAvailable } from '../src/services/smart-file-read/tree-sitter-bin-path.js';
import { treeSitterBinaryName } from '../src/services/smart-file-read/tree-sitter-bin-name.js';
import { ensureTreeSitterCliBinary, treeSitterCliBinaryPath } from '../src/services/smart-file-read/tree-sitter-cli-provision.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const pluginDirectory = path.join(repoRoot, 'plugin');
/**
 * The suite is tracked outside plugin/ because a marketplace install copies
 * plugin/ from git and no install needs the eval. `claude plugin eval
 * --eval-dir` only reads a directory below the plugin, so each run stages a
 * copy at plugin/evals-read-gate (gitignored) and removes it afterwards.
 */
const suiteSourceDirectory = path.join(repoRoot, 'evals', 'read-gate');
const SUITE_DIRECTORY_NAME = 'evals-read-gate';
const stagedSuiteDirectory = path.join(pluginDirectory, SUITE_DIRECTORY_NAME);
const fixtureDirectory = path.join(suiteSourceDirectory, 'fixture');
/** The large-file cases' project, apart so the other cases never see its file. */
const largeFixtureDirectory = path.join(suiteSourceDirectory, 'fixture-large');
const seedObservationsPath = path.join(suiteSourceDirectory, 'seed-observations.json');
const workerScriptPath = path.join(pluginDirectory, 'scripts', 'worker-service.cjs');
const bunRunnerPath = path.join(pluginDirectory, 'scripts', 'bun-runner.js');
const scratchDirectory = path.join(repoRoot, '.scratch', 'read-gate-eval');

export const FIXTURE_RELATIVE_PATH = 'src/shipping/rate-calculator.ts';
export const LARGE_FIXTURE_RELATIVE_PATH = 'src/shipping/carrier-tariffs.ts';
/** The gate's deny reason starts with this line; the suite's trace graders match it too. */
export const READ_GATE_DENY_MARKER = 'Full-file Read blocked by claude-mem';
const EVAL_PROJECT_NAME = 'read-gate-eval';

const MCP_SEARCH_TOOL_PREFIX = 'mcp__plugin_claude-mem_mcp-search__';
export const SMART_OUTLINE_TOOL = `${MCP_SEARCH_TOOL_PREFIX}smart_outline`;
export const SMART_UNFOLD_TOOL = `${MCP_SEARCH_TOOL_PREFIX}smart_unfold`;
export const GET_OBSERVATIONS_TOOL = `${MCP_SEARCH_TOOL_PREFIX}get_observations`;

export const CASE_GATE_ON_LARGE_FILE = 'gate-on-large-file';
export const CASE_GATE_OFF_LARGE_FILE = 'gate-off-large-file';
export const CASE_GATE_ON_EDITS = 'gate-on-edits-file';
export const CASE_GATE_ON_SMALL_FILE = 'gate-on-small-file';
export const CASE_GATE_OFF_SMALL_FILE = 'gate-off-small-file';
/** Every case in evals/read-gate. */
export const EVAL_CASE_NAMES: readonly string[] = [
  CASE_GATE_ON_LARGE_FILE, CASE_GATE_OFF_LARGE_FILE, CASE_GATE_ON_EDITS, CASE_GATE_ON_SMALL_FILE, CASE_GATE_OFF_SMALL_FILE,
];
/** Cases on the large fixture, which is over the gate's deny size; the small one is under it. */
const LARGE_FIXTURE_CASE_NAMES: readonly string[] = [CASE_GATE_ON_LARGE_FILE, CASE_GATE_OFF_LARGE_FILE, CASE_GATE_ON_EDITS];
const ANSWER_GRADERS = ['answer-rate', 'answer-minimum'];
const EDIT_GRADERS = ['edited', 'old-value-gone'];

// Every tool claude-mem's MCP server registers (src/servers/mcp-server.ts).
const CLAUDE_MEM_MCP_TOOL_NAMES = [
  'important_workflow', 'search', 'timeline', 'get_observations', 'get_tool_uses',
  'work_state_write', 'work_state_read', 'session_start_context',
  'observation_add', 'observation_record_event', 'observation_search', 'observation_context',
  'observation_generation_status', 'smart_search', 'smart_unfold', 'smart_outline',
  'build_corpus', 'list_corpora', 'prime_corpus', 'query_corpus', 'rebuild_corpus', 'reprime_corpus',
];
// CLAUDE_MEM_SKIP_TOOLS matches exact tool names. It lists claude-mem's defaults
// plus every tool an eval session can call, so no run queues observer work.
const SKIPPED_TOOL_NAMES = [
  'ListMcpResourcesTool', 'SlashCommand', 'Skill', 'TodoWrite', 'AskUserQuestion',
  'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'ToolSearch', 'Task', 'Agent', 'TaskStop',
  ...CLAUDE_MEM_MCP_TOOL_NAMES.map(name => `${MCP_SEARCH_TOOL_PREFIX}${name}`),
];

const SEED_SUBCOMMAND = '--seed-observation-database';
const SEEDED_OBSERVATIONS_FILE = 'seeded-observations.json';
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
/** Local midnight, 2026-01-01: the mtime the scaffold's `touch -t 202601010000` gives the fixture. */
const FIXTURE_MTIME = new Date(2026, 0, 1, 0, 0, 0);

type ArmName = 'on' | 'off';
const ARM_NAMES: readonly ArmName[] = ['on', 'off'];

interface EvalArm {
  name: ArmName;
  gateEnabled: boolean;
  /** .scratch/read-gate-eval/<timestamp>/<arm>: the data dir and the pre-flight home. */
  directory: string;
  /** The data dir the arm's worker, hooks and MCP server share. */
  dataDirectory: string;
  port: number;
}

export interface RunnerOptions {
  runs: number;
  model: string;
  concurrency: number;
  maxCostUsd: number;
  caseGlob: string | null;
  preflightOnly: boolean;
}

const VALUE_FLAGS = new Set(['--runs', '--model', '-j', '--max-cost-usd', '--case']);

export function parseRunnerArguments(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    runs: 3, model: 'claude-sonnet-5-5', concurrency: 3, maxCostUsd: 10, caseGlob: null, preflightOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--preflight-only') {
      options.preflightOnly = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === '--runs') options.runs = Number(value);
    else if (flag === '--model') options.model = value;
    else if (flag === '-j') options.concurrency = Number(value);
    else if (flag === '--max-cost-usd') options.maxCostUsd = Number(value);
    else options.caseGlob = value;
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 50) {
    throw new Error('--runs must be an integer from 1 to 50');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error('-j must be an integer from 1 to 8');
  }
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
    throw new Error('--max-cost-usd must be a positive number');
  }
  if (!/^claude-/.test(options.model)) {
    throw new Error('--model must be an explicit Claude model ID, such as claude-sonnet-5-5');
  }
  return options;
}

// ---------------------------------------------------------------------------
// Trace analysis (pure)
// ---------------------------------------------------------------------------

export interface TraceAnalysisOptions {
  fixtureRelativePath: string;
  fixtureTotalLines: number;
}

/** What the run's `result` event reports it used; null where it reports no number. */
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export interface ReadGateTraceAnalysis {
  /** Reads of the fixture whose window covers the whole file. */
  wholeFileReadAttempts: number;
  /** Whole-file Reads answered with the gate's deny: an error result carrying the marker. */
  wholeFileReadsDenied: number;
  /** Whole-file Reads that returned the file. */
  wholeFileReadsSucceeded: number;
  /** Reads of the fixture with a partial window. */
  targetedReads: number;
  targetedReadsSucceeded: number;
  /** Partial Reads the gate denied anyway; Edit needs them to pass. */
  targetedReadsDenied: number;
  smartOutlineCalls: number;
  smartUnfoldCalls: number;
  getObservationsCalls: number;
  /** The marker appears anywhere in the trace, which is what the suite's trace graders check. */
  denyMarkerAppeared: boolean;
  /** Lines that are not JSON, such as the cut-off last line of a killed run. */
  unparsableLines: number;
  /** Null when the trace has no `result` event, as with a killed run. */
  usage: TokenUsage | null;
}

/** Lines as the gate counts them: newline characters, plus a last line that has none. */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const newlines = content.split('\n').length - 1;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

/** A Read offset/limit as the gate reads it (readWindowValue in file-context.ts): anything but a finite, non-negative number counts as absent. */
function readWindowValue(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

/** The gate's whole-file test: the Read starts at line 1 and its window reaches the last line. */
export function isWholeFileRead(toolInput: Record<string, unknown>, totalLines: number): boolean {
  const offset = readWindowValue(toolInput.offset) ?? 0;
  const limit = readWindowValue(toolInput.limit);
  return offset <= 1 && (limit === undefined || limit >= totalLines);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFixturePath(filePath: unknown, fixtureRelativePath: string): boolean {
  if (typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  return normalized === fixtureRelativePath || normalized.endsWith(`/${fixtureRelativePath}`);
}

function tokenCount(usage: Record<string, unknown>, key: string): number | null {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('\n');
}

/**
 * Counts what one `claude plugin eval` run did with the fixture. Tool calls are
 * `tool_use` blocks in assistant messages; each is paired with the
 * `tool_result` block of the same id in a later user message.
 */
export function analyzeReadGateTrace(traceLines: string[], options: TraceAnalysisOptions): ReadGateTraceAnalysis {
  const analysis: ReadGateTraceAnalysis = {
    wholeFileReadAttempts: 0, wholeFileReadsDenied: 0, wholeFileReadsSucceeded: 0,
    targetedReads: 0, targetedReadsSucceeded: 0, targetedReadsDenied: 0,
    smartOutlineCalls: 0, smartUnfoldCalls: 0, getObservationsCalls: 0,
    denyMarkerAppeared: false, unparsableLines: 0, usage: null,
  };
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const toolResults = new Map<string, { isError: boolean; text: string }>();

  for (const line of traceLines) {
    if (!line.trim()) continue;
    if (line.includes(READ_GATE_DENY_MARKER)) analysis.denyMarkerAppeared = true;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      analysis.unparsableLines += 1;
      continue;
    }
    if (isRecord(event) && event.type === 'result' && isRecord(event.usage)) {
      const usage = event.usage;
      analysis.usage = {
        inputTokens: tokenCount(usage, 'input_tokens'),
        outputTokens: tokenCount(usage, 'output_tokens'),
        cacheCreationInputTokens: tokenCount(usage, 'cache_creation_input_tokens'),
        cacheReadInputTokens: tokenCount(usage, 'cache_read_input_tokens'),
      };
    }
    if (!isRecord(event) || !isRecord(event.message) || !Array.isArray(event.message.content)) continue;
    for (const block of event.message.content) {
      if (!isRecord(block)) continue;
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        toolUses.push({ id: block.id, name: String(block.name), input: isRecord(block.input) ? block.input : {} });
      }
      if (event.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolResults.set(block.tool_use_id, { isError: block.is_error === true, text: toolResultText(block.content) });
      }
    }
  }

  for (const toolUse of toolUses) {
    if (toolUse.name === SMART_OUTLINE_TOOL) analysis.smartOutlineCalls += 1;
    else if (toolUse.name === SMART_UNFOLD_TOOL) analysis.smartUnfoldCalls += 1;
    else if (toolUse.name === GET_OBSERVATIONS_TOOL) analysis.getObservationsCalls += 1;
    if (toolUse.name !== 'Read' || !isFixturePath(toolUse.input.file_path, options.fixtureRelativePath)) continue;

    const result = toolResults.get(toolUse.id);
    const succeeded = result !== undefined && !result.isError;
    const denied = result !== undefined && result.isError && result.text.includes(READ_GATE_DENY_MARKER);
    if (isWholeFileRead(toolUse.input, options.fixtureTotalLines)) {
      analysis.wholeFileReadAttempts += 1;
      if (denied) analysis.wholeFileReadsDenied += 1;
      if (succeeded) analysis.wholeFileReadsSucceeded += 1;
    } else {
      analysis.targetedReads += 1;
      if (denied) analysis.targetedReadsDenied += 1;
      if (succeeded) analysis.targetedReadsSucceeded += 1;
    }
  }
  return analysis;
}

// ---------------------------------------------------------------------------
// Verdicts (pure)
// ---------------------------------------------------------------------------

/** A run a mock ended early: `aborted` on a run in claude plugin eval's aggregate-result.json. */
export interface RunAbort {
  server: string;
  tool: string;
  reason: string;
}

export interface RunEvidence {
  caseName: string;
  runNumber: number;
  score: number | null;
  turns: number | null;
  costUsd: number | null;
  error: string | null;
  aborted: RunAbort | null;
  /** Grader name to passed. */
  graders: Record<string, boolean>;
  analysis: ReadGateTraceAnalysis;
  /** The run's trace, copied into the report directory (repo-relative). */
  tracePath: string | null;
}

export type VerdictStatus = 'pass' | 'fail' | 'not-run';

export interface Verdict {
  id: string;
  description: string;
  status: VerdictStatus;
  detail: string;
}

function runLabel(run: RunEvidence): string {
  return `${run.caseName} #${run.runNumber}`;
}

function passesAtLeastTwoThirds(runs: RunEvidence[], graderNames: string[]): { passed: boolean; detail: string } {
  const passing = runs.filter(run => graderNames.every(name => run.graders[name] === true)).length;
  return { passed: passing * 3 >= runs.length * 2, detail: `${passing} of ${runs.length} runs pass ${graderNames.join(' + ')}` };
}

function verdict(
  id: string,
  description: string,
  runs: RunEvidence[],
  decide: () => { passed: boolean; detail: string },
): Verdict {
  if (runs.length === 0) return { id, description, status: 'not-run', detail: 'no runs' };
  const { passed, detail } = decide();
  return { id, description, status: passed ? 'pass' : 'fail', detail };
}

/** The plan's verdicts (plans/2026-10-05-file-read-gate-restore.md, 5.2 step 7), with the deny size split. */
export function decideVerdicts(runs: RunEvidence[]): Verdict[] {
  const gateOnLargeFileRuns = runs.filter(run => run.caseName === CASE_GATE_ON_LARGE_FILE);
  const gateOnEditRuns = runs.filter(run => run.caseName === CASE_GATE_ON_EDITS);
  // The gate-ON runs on a file over the deny size, which the gate must deny.
  const gateOnRuns = [...gateOnLargeFileRuns, ...gateOnEditRuns];
  const gateOnSmallFileRuns = runs.filter(run => run.caseName === CASE_GATE_ON_SMALL_FILE);
  const gateOffSmallFileRuns = runs.filter(run => run.caseName === CASE_GATE_OFF_SMALL_FILE);
  const gateOffLargeFileRuns = runs.filter(run => run.caseName === CASE_GATE_OFF_LARGE_FILE);
  const gateOffRuns = [...gateOffSmallFileRuns, ...gateOffLargeFileRuns];
  // The cost comparison needs both arms; with one of them filtered out by --case it did not run.
  const largeFileComparisonRuns = gateOnLargeFileRuns.length > 0 && gateOffLargeFileRuns.length > 0
    ? [...gateOnLargeFileRuns, ...gateOffLargeFileRuns]
    : [];

  return [
    // Without this, gate-ON runs that never try a whole-file Read pass every
    // other gate-ON verdict vacuously, and so would a dormant gate.
    verdict('gate-on-deny-exercised', 'Gate ON: Claude tried a whole-file Read and got the deny in at least 2/3 of runs', gateOnRuns, () => {
      const denied = gateOnRuns.filter(run => run.analysis.wholeFileReadsDenied > 0).length;
      return { passed: denied * 3 >= gateOnRuns.length * 2, detail: `${denied} of ${gateOnRuns.length} runs` };
    }),
    verdict('gate-on-no-whole-file-read', 'Gate ON: no run read the whole fixture', gateOnRuns, () => {
      const offenders = gateOnRuns.filter(run => run.analysis.wholeFileReadsSucceeded > 0);
      return {
        passed: offenders.length === 0,
        detail: offenders.length === 0
          ? `0 of ${gateOnRuns.length} runs`
          : `read the whole file: ${offenders.map(runLabel).join(', ')}`,
      };
    }),
    verdict('gate-on-attempts-denied', 'Gate ON: every run that tried a whole-file Read saw the deny', gateOnRuns, () => {
      const attempting = gateOnRuns.filter(run => run.analysis.wholeFileReadAttempts > 0);
      const missed = attempting.filter(run => run.analysis.wholeFileReadsDenied === 0);
      const neverTried = gateOnRuns.length - attempting.length;
      return {
        passed: missed.length === 0,
        detail: `${attempting.length - missed.length} of ${attempting.length} attempting runs denied, ${neverTried} never tried`
          + (missed.length > 0 ? `; not denied: ${missed.map(runLabel).join(', ')}` : ''),
      };
    }),
    verdict('gate-on-edits', 'Gate ON: the edit leaves 24.75 and no 22.40 in at least 2/3 of runs', gateOnEditRuns,
      () => passesAtLeastTwoThirds(gateOnEditRuns, EDIT_GRADERS)),
    verdict('gate-on-small-file-not-denied', 'Gate ON, file under the deny size: no deny marker and a successful Read in every run', gateOnSmallFileRuns, () => {
      const offenders = gateOnSmallFileRuns.filter(
        run => run.analysis.denyMarkerAppeared || run.analysis.wholeFileReadsSucceeded + run.analysis.targetedReadsSucceeded === 0,
      );
      return {
        passed: offenders.length === 0,
        detail: offenders.length === 0
          ? `${gateOnSmallFileRuns.length} of ${gateOnSmallFileRuns.length} runs`
          : `denied or no successful Read: ${offenders.map(runLabel).join(', ')}`,
      };
    }),
    verdict('gate-on-small-file-answers', 'Gate ON, file under the deny size: answer graders pass in at least 2/3 of runs', gateOnSmallFileRuns,
      () => passesAtLeastTwoThirds(gateOnSmallFileRuns, ANSWER_GRADERS)),
    verdict('gate-off-never-denied', 'Gate OFF: no deny marker in any run', gateOffRuns, () => {
      const denied = gateOffRuns.filter(run => run.analysis.denyMarkerAppeared);
      return {
        passed: denied.length === 0,
        detail: denied.length === 0 ? `0 of ${gateOffRuns.length} runs` : `deny marker in: ${denied.map(runLabel).join(', ')}`,
      };
    }),
    verdict('gate-off-reads-succeed', 'Gate OFF: at least one successful Read of the fixture per run', gateOffRuns, () => {
      const withoutRead = gateOffRuns.filter(
        run => run.analysis.wholeFileReadsSucceeded + run.analysis.targetedReadsSucceeded === 0,
      );
      return {
        passed: withoutRead.length === 0,
        detail: withoutRead.length === 0
          ? `${gateOffRuns.length} of ${gateOffRuns.length} runs`
          : `no successful Read in: ${withoutRead.map(runLabel).join(', ')}`,
      };
    }),
    verdict('gate-off-answers', 'Gate OFF, small file: answer graders pass in at least 2/3 of runs', gateOffSmallFileRuns,
      () => passesAtLeastTwoThirds(gateOffSmallFileRuns, ANSWER_GRADERS)),
    verdict('large-file-gate-on-answers', 'Large file, gate ON: answer graders pass in at least 2/3 of runs', gateOnLargeFileRuns,
      () => passesAtLeastTwoThirds(gateOnLargeFileRuns, ANSWER_GRADERS)),
    verdict('large-file-gate-off-answers', 'Large file, gate OFF: answer graders pass in at least 2/3 of runs', gateOffLargeFileRuns,
      () => passesAtLeastTwoThirds(gateOffLargeFileRuns, ANSWER_GRADERS)),
    // The two verdicts below are what make the cost comparison measure the gate:
    // a gate-ON run that never met the deny, or a gate-OFF run that only greps
    // and reads a window, never differs by the whole file the gate keeps out.
    // The gate-ON deny verdict above can pass on the other gate-ON cases alone.
    verdict('large-file-gate-on-denied', 'Large file, gate ON: Claude tried a whole-file Read and got the deny in at least 2/3 of runs', gateOnLargeFileRuns, () => {
      const denied = gateOnLargeFileRuns.filter(run => run.analysis.wholeFileReadsDenied > 0).length;
      return { passed: denied * 3 >= gateOnLargeFileRuns.length * 2, detail: `${denied} of ${gateOnLargeFileRuns.length} runs` };
    }),
    verdict('large-file-gate-off-reads-whole-file', 'Large file, gate OFF: Claude read the whole file in at least 2/3 of runs', gateOffLargeFileRuns, () => {
      const reading = gateOffLargeFileRuns.filter(run => run.analysis.wholeFileReadsSucceeded > 0).length;
      return { passed: reading * 3 >= gateOffLargeFileRuns.length * 2, detail: `${reading} of ${gateOffLargeFileRuns.length} runs` };
    }),
    verdict('large-file-gate-on-cheaper', 'Large file: gate ON costs less per run than gate OFF', largeFileComparisonRuns, () => {
      // A mean over only the priced runs would compare different runs per arm.
      const unpriced = largeFileComparisonRuns.filter(run => run.costUsd === null);
      if (unpriced.length > 0) return { passed: false, detail: `no cost for ${unpriced.map(runLabel).join(', ')}` };
      const gateOnCost = mean(gateOnLargeFileRuns.map(run => run.costUsd))!;
      const gateOffCost = mean(gateOffLargeFileRuns.map(run => run.costUsd))!;
      return {
        passed: gateOnCost < gateOffCost,
        detail: `mean $${gateOnCost.toFixed(3)} gate ON vs $${gateOffCost.toFixed(3)} gate OFF (${formatChange(gateOnCost, gateOffCost)})`,
      };
    }),
  ];
}

/** `value` against `baseline` as a signed percentage, e.g. "-23%". */
function formatChange(value: number, baseline: number): string {
  if (baseline === 0) return 'n/a';
  const percent = Math.round(((value - baseline) / baseline) * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/** `claude plugin eval --case <glob>` as the CLI matches it: the whole name, `*` for any characters, `?` for one. */
export function caseNameMatchesGlob(caseGlob: string, caseName: string): boolean {
  const pattern = caseGlob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`).test(caseName);
}

/** The cases a run asked for: all of them, or the ones --case selects. */
export function requestedCaseNames(caseGlob: string | null): string[] {
  return EVAL_CASE_NAMES.filter(caseName => caseGlob === null || caseNameMatchesGlob(caseGlob, caseName));
}

/**
 * One problem per requested case whose runs did not all complete: fewer (or
 * more) runs in the results than --runs asked for, as when the eval stopped
 * before starting some, or a run that ended with an error or that a mock
 * aborted. Its verdicts then rest on runs that never did the task, which can
 * pass them vacuously, so any problem here fails the eval.
 */
export function findIncompleteCaseRuns(
  runs: RunEvidence[],
  caseNames: readonly string[],
  runsRequestedPerCase: number,
): string[] {
  const problems: string[] = [];
  for (const caseName of caseNames) {
    const caseRuns = runs.filter(run => run.caseName === caseName);
    const reasons: string[] = [];
    if (caseRuns.length !== runsRequestedPerCase) {
      reasons.push(`${caseRuns.length} of ${runsRequestedPerCase} requested runs in the results`);
    }
    for (const run of caseRuns) {
      if (run.error !== null) reasons.push(`run ${run.runNumber} ended with an error: ${run.error}`);
      if (run.aborted !== null) {
        reasons.push(`run ${run.runNumber} was aborted by mock ${run.aborted.server}/${run.aborted.tool}: ${run.aborted.reason}`);
      }
    }
    if (reasons.length > 0) problems.push(`${caseName} did not complete its runs: ${reasons.join('; ')}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('The OS assigned no free port'))));
    });
  });
}

/** claude-mem's default worker port (SettingsDefaultsManager): the eval never uses it. */
function defaultWorkerPort(): number {
  return 37700 + ((process.getuid?.() ?? 77) % 100);
}

function armSettings(arm: EvalArm): Record<string, unknown> {
  return {
    CLAUDE_MEM_WORKER_PORT: String(arm.port),
    // This script starts the arm's worker; hooks and the MCP server must never launch another.
    CLAUDE_MEM_WORKER_AUTOSTART: 'false',
    // Eval runs work in <sandbox>/home/cwd and the pre-flight in <arm>/preflight/home/cwd;
    // these patterns make every one of them the project the observations were seeded into.
    CLAUDE_MEM_PROJECT_ENVIRONMENTS: [{ name: EVAL_PROJECT_NAME, patterns: ['**/home/cwd', '**/home/cwd/**'] }],
    CLAUDE_MEM_FILE_READ_GATE_ENABLED: arm.gateEnabled ? 'true' : 'false',
    CLAUDE_MEM_SKIP_TOOLS: SKIPPED_TOOL_NAMES.join(','),
    CLAUDE_MEM_SEMANTIC_INJECT: 'false',
    // Search falls back to SQLite, and no chroma-mcp process starts per arm.
    CLAUDE_MEM_CHROMA_ENABLED: 'false',
    CLAUDE_MEM_LOG_LEVEL: 'DEBUG',
    // The default lives under the real HOME; a missing file keeps the arm's
    // worker from ingesting transcripts you watch day to day.
    CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: path.join(arm.dataDirectory, 'transcript-watch.json'),
  };
}

async function createEvalArm(name: ArmName, runDirectory: string, portsTaken: number[]): Promise<EvalArm> {
  const directory = path.join(runDirectory, name);
  const dataDirectory = path.join(directory, 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  let port = await findFreePort();
  while (port === defaultWorkerPort() || portsTaken.includes(port)) port = await findFreePort();
  const arm: EvalArm = { name, gateEnabled: name === 'on', directory, dataDirectory, port };
  fs.writeFileSync(path.join(dataDirectory, 'settings.json'), `${JSON.stringify(armSettings(arm), null, 2)}\n`);
  // An eval is not an install; keep it out of claude-mem's usage analytics.
  fs.writeFileSync(path.join(dataDirectory, 'telemetry.json'), `${JSON.stringify({
    enabled: false,
    installId: 'read-gate-eval',
    decidedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return arm;
}

/** The parent environment without CLAUDE_MEM_*: env overrides settings.json, so none of your own configuration may reach an eval worker. */
function environmentWithoutClaudeMemSettings(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('CLAUDE_MEM_')) environment[key] = value;
  }
  return environment;
}

/**
 * The real HOME stays, as in the other eval workers: every path claude-mem
 * keeps state in comes from CLAUDE_MEM_DATA_DIR and the arm's settings.json.
 */
function workerEnvironment(arm: EvalArm): Record<string, string> {
  return { ...environmentWithoutClaudeMemSettings(), CLAUDE_MEM_DATA_DIR: arm.dataDirectory };
}

function runWorkerCommand(arm: EvalArm, command: 'start' | 'stop', extraEnvironment: Record<string, string> = {}): string {
  const result = spawnSync(process.execPath, [workerScriptPath, command], {
    env: { ...workerEnvironment(arm), ...extraEnvironment },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw new Error(`worker ${command} (gate ${arm.name}) could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`worker ${command} (gate ${arm.name}) exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function startWorker(arm: EvalArm): void {
  // settings.json says AUTOSTART=false so the eval's hooks never launch a worker;
  // this one launch is the script's own.
  const output = runWorkerCommand(arm, 'start', { CLAUDE_MEM_WORKER_AUTOSTART: 'true' });
  if (!output.includes('"status":"ready"')) {
    throw new Error(`worker start (gate ${arm.name}) did not report ready: ${output.trim()}`);
  }
}

/** `start` reports ready while the worker may still be warming up; the pre-flight needs it initialized. */
async function waitForWorkerReadiness(arm: EvalArm, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastProblem = 'no answer';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${arm.port}/api/readiness`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastProblem = `HTTP ${response.status}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`gate-${arm.name} worker on port ${arm.port} not ready after ${timeoutMs / 1000}s: ${lastProblem}`);
}

function pidsFrom(output: string): number[] {
  return output.split('\n').map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 0);
}

/** A spawnSync run, as processesStillUsingArm reads it. Bun sets `error` and leaves stdout null when the tool cannot run. */
type ProcessQuery = (
  command: string,
  args: string[],
) => Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'signal' | 'stdout' | 'stderr'>;

/** `text` as a POSIX extended regex that matches only itself: `pgrep -f` takes a regex, and a checkout path may hold `.`, `(` or `+`. */
function extendedRegexLiteral(text: string): string {
  return text.replace(/[.[\\()*+?{|^$]/g, '\\$&');
}

/**
 * Processes still tied to an arm: `pgrep -f` finds helpers that carry the data
 * dir on their command line; the worker daemon carries only `--daemon` and gets
 * its data dir from the environment, so it shows up as the listener on the
 * arm's own port. Both tools exit 1 when nothing matches, and lsof exits 1 on
 * errors too, which it explains on stderr. Any other answer throws: read as
 * "nothing left", it would skip the sweep and leave a leaked worker unreported.
 */
export function processesStillUsingArm(
  arm: Pick<EvalArm, 'name' | 'dataDirectory' | 'port'>,
  query: ProcessQuery = (command, args) => spawnSync(command, args, { encoding: 'utf8' }),
): number[] {
  const pidsFoundBy = (command: string, args: string[]): number[] => {
    const result = query(command, args);
    const nothingMatched = result.status === 1 && !result.stderr?.trim();
    if (result.error || (result.status !== 0 && !nothingMatched)) {
      const failure = result.error
        ? `could not run (${result.error.message})`
        : `exited ${result.status ?? result.signal}: ${result.stderr?.trim() || 'no error output'}`;
      throw new Error(`${command} ${failure}; cannot tell whether the gate-${arm.name} worker (port ${arm.port}) left processes running`);
    }
    return pidsFrom(result.stdout ?? '');
  };
  const byDataDirectory = pidsFoundBy('pgrep', ['-f', '--', extendedRegexLiteral(arm.dataDirectory)]);
  const byPort = pidsFoundBy('lsof', ['-nP', `-iTCP:${arm.port}`, '-sTCP:LISTEN', '-t']);
  return [...new Set([...byDataDirectory, ...byPort])].filter(pid => pid !== process.pid);
}

/** `stop`, then SIGTERM whatever still uses the arm, even when `stop` itself failed. */
function stopWorker(arm: EvalArm): void {
  let stopError: unknown = null;
  try {
    runWorkerCommand(arm, 'stop');
  } catch (error) {
    stopError = error;
  }
  try {
    const deadline = Date.now() + 30_000;
    while (processesStillUsingArm(arm).length > 0 && Date.now() < deadline) Bun.sleepSync(500);
    for (const pid of processesStillUsingArm(arm)) {
      console.warn(`Stopping leftover process ${pid} of the gate-${arm.name} worker (port ${arm.port})`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        console.warn(`Process ${pid} could not be signalled: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (sweepError) {
    // The sweep cannot see what is left; keep a failed `stop` in the report too.
    if (stopError === null) throw sweepError;
    throw new Error([stopError, sweepError].map(error => (error instanceof Error ? error.message : String(error))).join('; then '));
  }
  if (stopError) throw stopError;
}

const startedArms = new Set<EvalArm>();

function stopStartedWorkers(): void {
  for (const arm of [...startedArms]) {
    startedArms.delete(arm);
    try {
      stopWorker(arm);
    } catch (error) {
      console.error(`Could not stop the gate-${arm.name} worker on port ${arm.port}: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  }
}

function activeDataDirectoryFile(armName: ArmName): string {
  return path.join(scratchDirectory, `active-data-dir-${armName}`);
}

let activeDataDirectoryFilesWritten = false;

function writeActiveDataDirectoryFiles(arms: EvalArm[]): void {
  activeDataDirectoryFilesWritten = true;
  for (const arm of arms) fs.writeFileSync(activeDataDirectoryFile(arm.name), arm.dataDirectory);
}

function removeActiveDataDirectoryFiles(): void {
  if (!activeDataDirectoryFilesWritten) return;
  for (const name of ARM_NAMES) fs.rmSync(activeDataDirectoryFile(name), { force: true });
  activeDataDirectoryFilesWritten = false;
}

let suiteStagedByThisRun = false;

// Symlinks stay verbatim: the cases' scaffolds link to the shared ones beside them.
function stageSuite(): void {
  fs.rmSync(stagedSuiteDirectory, { recursive: true, force: true });
  fs.cpSync(suiteSourceDirectory, stagedSuiteDirectory, { recursive: true, verbatimSymlinks: true });
  suiteStagedByThisRun = true;
}

/** Only a suite this run staged: a --preflight-only run must not remove a full run's. */
function removeStagedSuite(): void {
  if (!suiteStagedByThisRun) return;
  fs.rmSync(stagedSuiteDirectory, { recursive: true, force: true });
  suiteStagedByThisRun = false;
}

// ---------------------------------------------------------------------------
// tree-sitter CLI (D9: the gate only denies where smart_outline can parse)
// ---------------------------------------------------------------------------

export interface TreeSitterProvisioning {
  /** The executable inside plugin/node_modules/tree-sitter-cli (repo-relative). */
  binaryPath: string;
  /** What it prints for --version, e.g. "tree-sitter 0.26.5 (...)". */
  version: string;
}

export interface PluginTreeSitterCheck {
  /** What the built hook's resolveTreeSitterBinPath() answers: an absolute path, or the bare name it looks up on PATH. */
  resolvedPath: string;
  /** isTreeSitterCliAvailable() for that answer and the hook's PATH. */
  available: boolean;
  version: string | null;
  failure: string | null;
}

const TREE_SITTER_CLI_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** The output of `<binary> --version` when it answers like the tree-sitter CLI, else null. */
function treeSitterVersion(binary: string, searchPath: string = process.env.PATH ?? ''): string | null {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, PATH: searchPath },
  });
  const output = (result.stdout ?? '').trim();
  return result.status === 0 && /^tree-sitter \d+\.\d+\.\d+(?:\s|$)/.test(output) ? output : null;
}

/**
 * npm run build installs the plugin's dependencies with lifecycle scripts off,
 * so tree-sitter-cli's install.js, which downloads the executable, never runs
 * and plugin/node_modules/tree-sitter-cli has no binary. A real install then
 * runs ensureTreeSitterCliBinary; this does the same for the plugin the eval
 * loads. Without it the gate stays dormant and smart_outline cannot parse.
 */
async function provisionPluginTreeSitterCli(): Promise<TreeSitterProvisioning> {
  const binaryPath = treeSitterCliBinaryPath(pluginDirectory);
  const relativeBinaryPath = path.relative(repoRoot, binaryPath);
  try {
    await ensureTreeSitterCliBinary(pluginDirectory, TREE_SITTER_CLI_INSTALL_TIMEOUT_MS);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const output = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`.trim();
    throw new Error(
      `Could not provision the tree-sitter CLI the plugin uses (${relativeBinaryPath}): ${failure.message}`
        + (output ? `\n${output.slice(-2000)}` : '')
        + '\nWithout it the gate stays dormant (D9). A missing tree-sitter-cli package means npm run build has not'
        + ' installed the plugin\'s dependencies; a failed download needs network access to the tree-sitter releases.',
    );
  }
  const version = treeSitterVersion(binaryPath);
  if (!version) throw new Error(`${relativeBinaryPath} was provisioned but does not answer --version`);
  return { binaryPath: relativeBinaryPath, version };
}

function isSameFile(left: string, right: string): boolean {
  return fs.existsSync(left) && fs.existsSync(right) && fs.realpathSync(left) === fs.realpathSync(right);
}

/**
 * D9's precondition as the built hook evaluates it: resolveTreeSitterBinPath()
 * from plugin/scripts (tree-sitter-cli beside the plugin first, else the bare
 * name on PATH), then isTreeSitterCliAvailable() on that answer. Stricter than
 * the hook in two ways: the answer must be the plugin's own provisioned copy,
 * not a tree-sitter this machine happens to have on PATH (`npm run` puts the
 * repo's node_modules/.bin there), and it must answer --version.
 */
export function checkPluginTreeSitterCli(searchPath: string, provisionedBinaryPath: string): PluginTreeSitterCheck {
  const binaryName = treeSitterBinaryName();
  let resolvedPath = binaryName;
  try {
    const packageJsonPath = createRequire(workerScriptPath).resolve('tree-sitter-cli/package.json');
    const candidate = path.join(path.dirname(packageJsonPath), binaryName);
    if (fs.existsSync(candidate)) resolvedPath = candidate;
  } catch {
    // tree-sitter-cli is not installed beside the plugin; the hook falls back to PATH too.
  }
  const shownPath = path.isAbsolute(resolvedPath) ? path.relative(repoRoot, resolvedPath) : resolvedPath;
  const available = isTreeSitterCliAvailable(resolvedPath, searchPath);
  const version = available ? treeSitterVersion(resolvedPath, searchPath) : null;
  let failure: string | null = null;
  if (!available) {
    failure = `tree-sitter CLI not provisioned for the plugin: the built hook resolves "${shownPath}", which `
      + `${path.isAbsolute(resolvedPath) ? 'does not exist' : 'is not on PATH'}, so the gate stays dormant (D9) and smart_outline cannot parse`;
  } else if (!path.isAbsolute(resolvedPath) || !isSameFile(resolvedPath, provisionedBinaryPath)) {
    failure = `the built hook resolves the tree-sitter CLI as "${shownPath}", not the plugin's provisioned `
      + `${path.relative(repoRoot, provisionedBinaryPath)}, so the gate (D9) would depend on this machine's PATH instead of the plugin's own copy`;
  } else if (!version) {
    failure = `tree-sitter CLI not usable by the plugin: "${shownPath}" does not answer --version, so smart_outline cannot parse (D9)`;
  }
  return { resolvedPath: shownPath, available, version, failure };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeededObservation {
  id: number;
  title: string;
  createdAtEpoch: number;
}

interface SeedObservation {
  type: string;
  title: string;
  subtitle: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

/**
 * Seeds once, in a child process: SessionStore's module resolves claude-mem's
 * data dir from CLAUDE_MEM_DATA_DIR when it loads, so this process never
 * imports it, and the child's environment names the seed directory. Both arms
 * get a copy of the one database, so their observation IDs match.
 */
function seedObservationDatabases(runDirectory: string, arms: EvalArm[]): SeededObservation[] {
  const seedDirectory = path.join(runDirectory, 'seed');
  fs.mkdirSync(seedDirectory, { recursive: true });
  const result = spawnSync(process.execPath, [import.meta.path, SEED_SUBCOMMAND, seedDirectory], {
    env: { ...environmentWithoutClaudeMemSettings(), CLAUDE_MEM_DATA_DIR: seedDirectory },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`Seeding observations failed (exit ${result.status}): ${result.stderr || result.stdout || result.error?.message}`);
  }
  const seedDatabasePath = path.join(seedDirectory, 'claude-mem.db');
  const walPath = `${seedDatabasePath}-wal`;
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error(`The seed database left unflushed writes in ${walPath}`);
  }
  for (const arm of arms) fs.copyFileSync(seedDatabasePath, path.join(arm.dataDirectory, 'claude-mem.db'));
  return JSON.parse(fs.readFileSync(path.join(seedDirectory, SEEDED_OBSERVATIONS_FILE), 'utf8')) as SeededObservation[];
}

/** Runs in the child process started by seedObservationDatabases. */
async function seedObservationDatabase(seedDirectory: string | undefined): Promise<void> {
  if (!seedDirectory) throw new Error(`${SEED_SUBCOMMAND} needs the seed directory`);
  const resolvedSeedDirectory = path.resolve(seedDirectory);
  if (process.env.CLAUDE_MEM_DATA_DIR !== resolvedSeedDirectory) {
    throw new Error(`Refusing to seed: CLAUDE_MEM_DATA_DIR is ${process.env.CLAUDE_MEM_DATA_DIR ?? 'unset'}, not ${resolvedSeedDirectory}`);
  }
  const { DB_PATH } = await import('../src/shared/paths.js');
  const expectedDatabasePath = path.join(resolvedSeedDirectory, 'claude-mem.db');
  if (DB_PATH !== expectedDatabasePath) {
    throw new Error(`Refusing to seed: claude-mem resolved its database to ${DB_PATH}, not ${expectedDatabasePath}`);
  }
  const { SessionStore } = await import('../src/services/sqlite/SessionStore.js');
  const observations = JSON.parse(fs.readFileSync(seedObservationsPath, 'utf8')) as SeedObservation[];
  const newestCreatedAtEpoch = Date.now() - ONE_DAY_MS;
  const seeded: SeededObservation[] = [];
  const store = new SessionStore(DB_PATH);
  try {
    observations.forEach((observation, index) => {
      // One session per observation: the gate's timeline keeps one observation per session.
      const sessionNumber = index + 1;
      const memorySessionId = `read-gate-eval-memory-${sessionNumber}`;
      const sessionDbId = store.createSDKSession(
        `read-gate-eval-session-${sessionNumber}`,
        EVAL_PROJECT_NAME,
        `Work on ${FIXTURE_RELATIVE_PATH}`,
      );
      store.updateMemorySessionId(sessionDbId, memorySessionId);
      // Oldest first, an hour apart; the newest is a day old, newer than the fixture's mtime.
      const createdAtEpoch = newestCreatedAtEpoch - (observations.length - sessionNumber) * ONE_HOUR_MS;
      const stored = store.storeObservations(memorySessionId, EVAL_PROJECT_NAME, [observation], null, 0, 0, createdAtEpoch);
      seeded.push({ id: stored.observationIds[0], title: observation.title, createdAtEpoch });
    });
    store.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    store.close();
  }
  fs.writeFileSync(path.join(resolvedSeedDirectory, SEEDED_OBSERVATIONS_FILE), JSON.stringify(seeded, null, 2));
}

// ---------------------------------------------------------------------------
// Pre-flight: the real hook against each arm's worker, no model
// ---------------------------------------------------------------------------

interface HookWorkspace {
  home: string;
  cwd: string;
  /** Over the gate's deny size. */
  largeFixturePath: string;
  /** Under the gate's deny size. */
  smallFixturePath: string;
}

interface HookSpecificOutput {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  additionalContext?: string;
}

export interface PreflightCheck {
  arm: ArmName;
  name: string;
  toolInput: Record<string, unknown>;
  wallTimeMs: number;
  permissionDecision: string | null;
  seededObservationIdsShown: number[];
  failures: string[];
}

function listFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

/** The eval sandbox's layout: HOME with ~/.claude-mem linked to the arm's data dir, and both fixtures in HOME/cwd dated 2026-01-01. */
function prepareHookWorkspace(arm: EvalArm): HookWorkspace {
  const home = path.join(arm.directory, 'preflight', 'home');
  const cwd = path.join(home, 'cwd');
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(fixtureDirectory, cwd, { recursive: true });
  fs.cpSync(largeFixtureDirectory, cwd, { recursive: true });
  for (const file of listFiles(cwd)) fs.utimesSync(file, FIXTURE_MTIME, FIXTURE_MTIME);
  fs.symlinkSync(arm.dataDirectory, path.join(home, '.claude-mem'));
  return {
    home,
    cwd,
    largeFixturePath: path.join(cwd, LARGE_FIXTURE_RELATIVE_PATH),
    smallFixturePath: path.join(cwd, FIXTURE_RELATIVE_PATH),
  };
}

/**
 * The pre-flight hooks' PATH: the bun running this script first, since
 * bun-runner.js looks bun up on PATH and its ~/.bun fallback would look under
 * the pre-flight HOME.
 */
function hookSearchPath(): string {
  return [path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter);
}

/** What Claude Code gives a plugin hook, reduced to what this one needs. */
function hookEnvironment(workspace: HookWorkspace): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: hookSearchPath(),
    HOME: workspace.home,
    CLAUDE_PROJECT_DIR: workspace.cwd,
    CLAUDE_PLUGIN_ROOT: path.join(repoRoot, 'plugin'),
  };
  for (const key of ['TMPDIR', 'LANG']) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

function parseHookStdout(stdout: string, stderr: string): HookSpecificOutput {
  const lines = stdout.trim().split('\n').filter(Boolean);
  for (const candidate of [stdout.trim(), lines.at(-1) ?? '']) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!isRecord(parsed)) break;
      return isRecord(parsed.hookSpecificOutput) ? (parsed.hookSpecificOutput as HookSpecificOutput) : {};
    } catch {
      // Try the last line on its own.
    }
  }
  throw new Error(`file-context hook printed no JSON object. stdout: ${stdout.trim() || '(empty)'} stderr: ${stderr.trim() || '(empty)'}`);
}

function runFileContextHook(
  workspace: HookWorkspace,
  sessionId: string,
  toolInput: Record<string, unknown>,
): { output: HookSpecificOutput; wallTimeMs: number } {
  const payload = {
    session_id: sessionId,
    cwd: workspace.cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: toolInput,
    tool_use_id: `toolu_${sessionId.replace(/-/g, '_')}`,
  };
  const startedAt = performance.now();
  const result = spawnSync('node', [bunRunnerPath, workerScriptPath, 'hook', 'claude-code', 'file-context'], {
    cwd: workspace.cwd,
    input: JSON.stringify(payload),
    env: hookEnvironment(workspace),
    encoding: 'utf8',
    timeout: 60_000,
  });
  const wallTimeMs = Math.round(performance.now() - startedAt);
  if (result.error) throw new Error(`file-context hook could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`file-context hook exited ${result.status}: ${result.stderr}`);
  return { output: parseHookStdout(result.stdout, result.stderr), wallTimeMs };
}

/** Seeded observations that appear as timeline rows (`<id> <time> <icon> <title>`). */
function seededIdsShown(text: string, seeded: SeededObservation[]): number[] {
  return seeded.filter(observation => new RegExp(`^${observation.id} `, 'm').test(text)).map(observation => observation.id);
}

function expectDeny(output: HookSpecificOutput, seeded: SeededObservation[]): { failures: string[]; shown: number[] } {
  const reason = output.permissionDecisionReason ?? '';
  const shown = seededIdsShown(reason, seeded);
  const failures: string[] = [];
  if (output.permissionDecision !== 'deny') {
    failures.push(`expected permissionDecision "deny", got ${JSON.stringify(output.permissionDecision ?? null)}`);
  }
  if (!reason.includes(READ_GATE_DENY_MARKER)) failures.push(`the deny reason lacks "${READ_GATE_DENY_MARKER}"`);
  if (shown.length === 0) failures.push('the deny reason lists none of the seeded observations');
  return { failures, shown };
}

function expectContext(output: HookSpecificOutput, seeded: SeededObservation[]): { failures: string[]; shown: number[] } {
  const shown = seededIdsShown(output.additionalContext ?? '', seeded);
  const failures: string[] = [];
  if (output.permissionDecision !== undefined) {
    failures.push(`expected no permissionDecision on the context path, got ${JSON.stringify(output.permissionDecision)}`);
  }
  if (shown.length === 0) failures.push('additionalContext has no timeline row for the seeded observations');
  return { failures, shown };
}

function runPreflight(arms: EvalArm[], seeded: SeededObservation[]): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  for (const arm of arms) {
    const workspace = prepareHookWorkspace(arm);
    const cases = arm.gateEnabled
      ? [
        { name: 'whole-file Read of the large file is denied', toolInput: { file_path: workspace.largeFixturePath }, expect: expectDeny },
        {
          name: 'targeted Read (offset 40, limit 20) gets context',
          toolInput: { file_path: workspace.largeFixturePath, offset: 40, limit: 20 },
          expect: expectContext,
        },
        {
          name: 'whole-file Read under the deny size gets context',
          toolInput: { file_path: workspace.smallFixturePath },
          expect: expectContext,
        },
      ]
      : [{ name: 'whole-file Read gets context', toolInput: { file_path: workspace.largeFixturePath }, expect: expectContext }];
    cases.forEach((check, index) => {
      // A session per check: the dedupe claim is per (session, file).
      const { output, wallTimeMs } = runFileContextHook(workspace, `read-gate-preflight-${arm.name}-${index + 1}`, check.toolInput);
      const { failures, shown } = check.expect(output, seeded);
      checks.push({
        arm: arm.name,
        name: check.name,
        toolInput: { ...check.toolInput, file_path: path.relative(workspace.cwd, check.toolInput.file_path) },
        wallTimeMs,
        permissionDecision: output.permissionDecision ?? null,
        seededObservationIdsShown: shown,
        failures,
      });
    });
  }
  return checks;
}

function formatPreflight(treeSitter: PluginTreeSitterCheck, checks: PreflightCheck[], seededCount: number): string {
  const treeSitterLine = [
    '  plugin'.padEnd(11),
    'tree-sitter CLI the built hook resolves (D9)'.padEnd(50),
    (treeSitter.failure ? 'FAIL' : 'PASS').padEnd(5),
    ''.padStart(8),
    `  ${treeSitter.resolvedPath}${treeSitter.version ? `, ${treeSitter.version}` : ''}`,
  ].join(' ');
  return [treeSitterLine, ...checks.map(check => [
    `  gate-${check.arm}`.padEnd(11),
    check.name.padEnd(50),
    (check.failures.length === 0 ? 'PASS' : 'FAIL').padEnd(5),
    `${check.wallTimeMs} ms`.padStart(8),
    `  ${check.seededObservationIdsShown.length}/${seededCount} observations listed`,
  ].join(' '))].join('\n');
}

// ---------------------------------------------------------------------------
// claude plugin eval and its results
// ---------------------------------------------------------------------------

interface AggregateGraderResult {
  name: string;
  passed: boolean;
}

interface AggregateRun {
  score?: number | null;
  turns?: number | null;
  costUsd?: number | null;
  error?: string | null;
  aborted?: RunAbort;
  tracePath?: string;
  graders?: AggregateGraderResult[];
}

interface AggregateResult {
  claudeVersion?: string;
  costUsd?: number | null;
  partial?: boolean;
  partialReason?: string;
  cases?: Array<{ name: string; arms?: { with?: AggregateRun[] } }>;
}

function runPluginEval(options: RunnerOptions, outputDirectory: string): number {
  const evalArguments = [
    'plugin', 'eval', './plugin',
    '--eval-dir', SUITE_DIRECTORY_NAME,
    '--scaffold',
    '--trust-plugin',
    '--mocks', 'off',
    '--ablation', 'none',
    '--no-publish',
    '--keep-temp',
    '--runs', String(options.runs),
    '-j', String(options.concurrency),
    '--model', options.model,
    '--max-cost-usd', String(options.maxCostUsd),
    '--threshold', '0',
    '--output-dir', outputDirectory,
    ...(options.caseGlob ? ['--case', options.caseGlob] : []),
    // Last: --allow-tools takes a list. Edit is a gated tool the edit case needs;
    // ToolSearch loads the deferred MCP tools. Grants apply to every case.
    '--allow-tools', `${MCP_SEARCH_TOOL_PREFIX}*`, 'Edit', 'ToolSearch',
  ];
  console.log(`\n> claude ${evalArguments.join(' ')}\n`);
  const result = spawnSync('claude', evalArguments, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: environmentWithoutClaudeMemSettings(),
  });
  if (result.error) throw new Error(`Could not run claude: ${result.error.message}`);
  return result.status ?? 1;
}

/** The sandbox --keep-temp kept for a run: `<sandbox>/out/trace.jsonl`, sandbox named `e-*`. */
function keptSandboxOfTrace(tracePath: string): string {
  const sandbox = path.dirname(path.dirname(tracePath));
  if (!path.basename(sandbox).startsWith('e-') || path.basename(path.dirname(tracePath)) !== 'out') {
    throw new Error(`Refusing to touch unexpected sandbox path ${sandbox}`);
  }
  return sandbox;
}

/** Copies a run's trace (and the edit case's edited file) into the report, then removes the kept sandbox. */
function keepRunArtifacts(caseName: string, runNumber: number, tracePath: string | undefined, tracesDirectory: string): string | null {
  if (!tracePath) return null;
  const sandbox = keptSandboxOfTrace(tracePath);
  spawnSync('chmod', ['-R', 'u+rwx', sandbox]);
  let copiedTracePath: string | null = null;
  if (fs.existsSync(tracePath)) {
    copiedTracePath = path.join(tracesDirectory, `${caseName}-run-${runNumber}.trace.jsonl`);
    fs.copyFileSync(tracePath, copiedTracePath);
  }
  // --keep-temp seals the run's home/ (and the workspace in it) under sealed/.
  const workspaceFixturePath = [path.join(sandbox, 'sealed', 'home'), path.join(sandbox, 'home')]
    .map(home => path.join(home, 'cwd', LARGE_FIXTURE_RELATIVE_PATH))
    .find(candidate => fs.existsSync(candidate));
  if (caseName === CASE_GATE_ON_EDITS) {
    if (workspaceFixturePath) {
      fs.copyFileSync(workspaceFixturePath, path.join(tracesDirectory, `${caseName}-run-${runNumber}.${path.basename(LARGE_FIXTURE_RELATIVE_PATH)}`));
    } else {
      console.warn(`No edited ${LARGE_FIXTURE_RELATIVE_PATH} found in ${sandbox} for ${caseName} run ${runNumber}`);
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  return copiedTracePath;
}

export interface FixtureInfo {
  relativePath: string;
  totalLines: number;
  bytes: number;
}

interface EvalFixtures {
  /** Over the gate's deny size. */
  large: FixtureInfo;
  /** Under it. */
  small: FixtureInfo;
}

function readFixtureInfo(directory: string, relativePath: string): FixtureInfo {
  const content = fs.readFileSync(path.join(directory, relativePath), 'utf8');
  return { relativePath, totalLines: countLines(content), bytes: Buffer.byteLength(content) };
}

/** The file a case's Reads are counted against. */
function fixtureOfCase(fixtures: EvalFixtures, caseName: string): FixtureInfo {
  return LARGE_FIXTURE_CASE_NAMES.includes(caseName) ? fixtures.large : fixtures.small;
}

function collectRunEvidence(aggregate: AggregateResult, reportDirectory: string, fixtures: EvalFixtures): RunEvidence[] {
  const tracesDirectory = path.join(reportDirectory, 'traces');
  fs.mkdirSync(tracesDirectory, { recursive: true });
  const evidence: RunEvidence[] = [];
  for (const evalCase of aggregate.cases ?? []) {
    (evalCase.arms?.with ?? []).forEach((run, index) => {
      const runNumber = index + 1;
      const copiedTracePath = keepRunArtifacts(evalCase.name, runNumber, run.tracePath, tracesDirectory);
      const traceLines = copiedTracePath ? fs.readFileSync(copiedTracePath, 'utf8').split('\n') : [];
      const fixture = fixtureOfCase(fixtures, evalCase.name);
      evidence.push({
        caseName: evalCase.name,
        runNumber,
        score: run.score ?? null,
        turns: run.turns ?? null,
        costUsd: run.costUsd ?? null,
        error: run.error ?? null,
        aborted: run.aborted ?? null,
        graders: Object.fromEntries((run.graders ?? []).map(grader => [grader.name, grader.passed === true])),
        analysis: analyzeReadGateTrace(traceLines, { fixtureRelativePath: fixture.relativePath, fixtureTotalLines: fixture.totalLines }),
        tracePath: copiedTracePath ? path.relative(repoRoot, copiedTracePath) : null,
      });
    });
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

interface ArmStatistics {
  runs: number;
  meanTurns: number | null;
  meanCostUsd: number | null;
  meanCacheCreationTokens: number | null;
  meanCacheReadTokens: number | null;
  meanOutputTokens: number | null;
}

/** One question asked with the gate ON and with it OFF. */
interface QuestionComparison {
  fixture: FixtureInfo;
  gateOnCase: string;
  gateOffCase: string;
  on: ArmStatistics;
  off: ArmStatistics;
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function armStatistics(runs: RunEvidence[]): ArmStatistics {
  return {
    runs: runs.length,
    meanTurns: mean(runs.map(run => run.turns)),
    meanCostUsd: mean(runs.map(run => run.costUsd)),
    meanCacheCreationTokens: mean(runs.map(run => run.analysis.usage?.cacheCreationInputTokens ?? null)),
    meanCacheReadTokens: mean(runs.map(run => run.analysis.usage?.cacheReadInputTokens ?? null)),
    meanOutputTokens: mean(runs.map(run => run.analysis.usage?.outputTokens ?? null)),
  };
}

function formatUsd(value: number | null | undefined): string {
  return typeof value === 'number' ? `$${value.toFixed(2)}` : 'n/a';
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatTokens(value: number | null | undefined): string {
  return typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : 'n/a';
}

function formatFixture(fixture: FixtureInfo): string {
  return `${fixture.relativePath} (${fixture.totalLines} lines, ${(fixture.bytes / 1024).toFixed(1)} KB)`;
}

interface Summary {
  createdAt: string;
  passed: boolean;
  problems: string[];
  claudeVersion: string | null;
  model: string;
  runsPerCase: number;
  caseFilter: string | null;
  evalExitCode: number;
  evalCostUsd: number | null;
  fixtures: FixtureInfo[];
  /** The CLI provisioned for the plugin, and what the built hook resolved in the pre-flight (D9). */
  treeSitter: TreeSitterProvisioning & { resolvedByPlugin: PluginTreeSitterCheck };
  seededObservations: SeededObservation[];
  preflight: PreflightCheck[];
  verdicts: Verdict[];
  comparisons: QuestionComparison[];
  runs: RunEvidence[];
}

function buildSummary(input: {
  options: RunnerOptions;
  aggregate: AggregateResult;
  evalExitCode: number;
  fixtures: EvalFixtures;
  treeSitter: Summary['treeSitter'];
  seeded: SeededObservation[];
  preflight: PreflightCheck[];
  runs: RunEvidence[];
}): Summary {
  const verdicts = decideVerdicts(input.runs);
  const problems = verdicts.filter(item => item.status === 'fail').map(item => `${item.description}: ${item.detail}`);
  // Covers a requested case with no runs at all, so its not-run verdicts fail the eval too.
  problems.push(...findIncompleteCaseRuns(input.runs, requestedCaseNames(input.options.caseGlob), input.options.runs));
  if (input.evalExitCode !== 0) problems.push(`claude plugin eval exited ${input.evalExitCode}`);
  if (input.aggregate.partial) problems.push(`the eval stopped early (${input.aggregate.partialReason ?? 'partial'})`);
  const caseRuns = (caseName: string) => input.runs.filter(run => run.caseName === caseName);
  const comparison = (fixture: FixtureInfo, gateOnCase: string, gateOffCase: string): QuestionComparison => ({
    fixture, gateOnCase, gateOffCase, on: armStatistics(caseRuns(gateOnCase)), off: armStatistics(caseRuns(gateOffCase)),
  });
  return {
    createdAt: new Date().toISOString(),
    passed: problems.length === 0,
    problems,
    claudeVersion: input.aggregate.claudeVersion ?? null,
    model: input.options.model,
    runsPerCase: input.options.runs,
    caseFilter: input.options.caseGlob,
    evalExitCode: input.evalExitCode,
    evalCostUsd: input.aggregate.costUsd ?? null,
    fixtures: [input.fixtures.large, input.fixtures.small],
    treeSitter: input.treeSitter,
    seededObservations: input.seeded,
    preflight: input.preflight,
    verdicts,
    comparisons: [
      comparison(input.fixtures.large, CASE_GATE_ON_LARGE_FILE, CASE_GATE_OFF_LARGE_FILE),
      comparison(input.fixtures.small, CASE_GATE_ON_SMALL_FILE, CASE_GATE_OFF_SMALL_FILE),
    ],
    runs: input.runs,
  };
}

function renderSummaryMarkdown(summary: Summary, reportDirectory: string): string {
  const relativeReportDirectory = path.relative(repoRoot, reportDirectory);
  const lines = [
    `# File Read Gate eval: ${summary.passed ? 'PASS' : 'FAIL'}`,
    '',
    `${summary.createdAt} · Claude Code ${summary.claudeVersion ?? 'unknown'} · model ${summary.model} · `
      + `${summary.runsPerCase} run(s) per case${summary.caseFilter ? ` · cases ${summary.caseFilter}` : ''} · `
      + `eval cost ${formatUsd(summary.evalCostUsd)} · ${summary.treeSitter.version} (${summary.treeSitter.binaryPath})`,
    '',
    '| Verdict | Result | Detail |',
    '| --- | --- | --- |',
    ...summary.verdicts.map(item => `| ${item.description} | ${item.status.toUpperCase()} | ${item.detail} |`),
  ];
  if (summary.problems.length > 0) {
    lines.push('', '**Problems**', '', ...summary.problems.map(problem => `- ${problem}`));
  }
  lines.push(
    '',
    '## Runs',
    '',
    `Whole-file Reads of each case's fixture are counted as tried / denied by the gate / returned the file: ${summary.fixtures.map(formatFixture).join('; ')}. `
      + 'Tokens are the run\'s cache writes / cache reads / output.',
    '',
    '| Case | Run | Whole-file Reads | Targeted Reads (ok / denied) | smart_outline | smart_unfold | get_observations | Deny marker | Failed graders | Turns | Tokens | Cost |',
    '| --- | ---: | --- | --- | ---: | ---: | ---: | --- | --- | ---: | --- | ---: |',
    ...summary.runs.map(run => {
      const analysis = run.analysis;
      const failedGraders = Object.entries(run.graders).filter(([, passed]) => !passed).map(([name]) => name);
      return [
        '',
        run.caseName,
        run.runNumber,
        `${analysis.wholeFileReadAttempts} / ${analysis.wholeFileReadsDenied} / ${analysis.wholeFileReadsSucceeded}`,
        `${analysis.targetedReads} (${analysis.targetedReadsSucceeded} / ${analysis.targetedReadsDenied})`,
        analysis.smartOutlineCalls,
        analysis.smartUnfoldCalls,
        analysis.getObservationsCalls,
        analysis.denyMarkerAppeared ? 'yes' : 'no',
        (failedGraders.join(', ') || 'none') + (run.error ? ` (error: ${run.error})` : '')
          + (run.aborted ? ` (aborted by mock ${run.aborted.server}/${run.aborted.tool}: ${run.aborted.reason})` : ''),
        formatNumber(run.turns),
        analysis.usage
          ? `${formatTokens(analysis.usage.cacheCreationInputTokens)} / ${formatTokens(analysis.usage.cacheReadInputTokens)} / ${formatTokens(analysis.usage.outputTokens)}`
          : 'n/a',
        formatUsd(run.costUsd),
        '',
      ].join(' | ').trim();
    }),
    '',
    '## Same question, gate ON vs OFF (informational)',
    '',
    'Means per run. The gate saves the cache writes of the file it keeps out of context, and costs a turn for the deny plus one per smart-tool call, each re-reading the whole context.',
    '',
    '| Fixture | Arm | Runs | Turns | Cache write | Cache read | Output | Cost |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summary.comparisons.flatMap(item => [
      [item.on, 'Gate ON'] as const,
      [item.off, 'Gate OFF'] as const,
    ].map(([arm, label]) => `| ${formatFixture(item.fixture)} | ${label} | ${arm.runs} | ${formatNumber(arm.meanTurns)} | `
      + `${formatTokens(arm.meanCacheCreationTokens)} | ${formatTokens(arm.meanCacheReadTokens)} | ${formatTokens(arm.meanOutputTokens)} | `
      + `${formatUsd(arm.meanCostUsd)}${label === 'Gate ON' && item.on.meanCostUsd !== null && item.off.meanCostUsd !== null
        ? ` (${formatChange(item.on.meanCostUsd, item.off.meanCostUsd)})` : ''} |`)),
    '',
    '## Pre-flight and hook latency (informational)',
    '',
    'Wall time of one `node bun-runner.js worker-service.cjs hook claude-code file-context` call, process start included.',
    '',
    '| Arm | Check | Result | Wall time |',
    '| --- | --- | --- | ---: |',
    `| plugin | tree-sitter CLI the built hook resolves (D9): ${summary.treeSitter.resolvedByPlugin.resolvedPath} | `
      + `${summary.treeSitter.resolvedByPlugin.failure ? 'FAIL' : 'PASS'} | |`,
    ...summary.preflight.map(check =>
      `| gate ${check.arm.toUpperCase()} | ${check.name} | ${check.failures.length === 0 ? 'PASS' : 'FAIL'} | ${check.wallTimeMs} ms |`),
    '',
    `Traces: \`${relativeReportDirectory}/traces/\`. Eval report: \`${relativeReportDirectory}/eval/report.html\`.`,
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function requireBuiltGate(): void {
  const relativeWorkerPath = path.relative(repoRoot, workerScriptPath);
  if (!fs.existsSync(workerScriptPath)) throw new Error(`${relativeWorkerPath} is missing. Run npm run build`);
  if (!fs.readFileSync(workerScriptPath, 'utf8').includes(READ_GATE_DENY_MARKER)) {
    throw new Error(`${relativeWorkerPath} does not contain "${READ_GATE_DENY_MARKER}": it was built without the File Read Gate. Run npm run build`);
  }
}

/** Claude Code ignores an async hook's permissionDecision, so a paid run against one could never show a deny. */
function requireSynchronousReadHook(): void {
  const hooksPath = path.join(repoRoot, 'plugin', 'hooks', 'hooks.json');
  const hooksFile = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ async?: boolean }> }> };
  };
  const readEntries = (hooksFile.hooks?.PreToolUse ?? []).filter(entry => entry.matcher === 'Read');
  if (readEntries.length === 0) throw new Error('plugin/hooks/hooks.json has no PreToolUse hook for Read');
  if (readEntries.some(entry => (entry.hooks ?? []).some(hook => hook.async === true))) {
    throw new Error('plugin/hooks/hooks.json runs the PreToolUse Read hook with "async": true, and an async hook cannot deny. Make it synchronous, then run npm run build');
  }
}

function requireNoActiveRun(): void {
  for (const name of ARM_NAMES) {
    const file = activeDataDirectoryFile(name);
    if (fs.existsSync(file)) {
      throw new Error(`${path.relative(repoRoot, file)} exists: another read-gate eval is running, or a crashed one left it behind (delete it if so)`);
    }
  }
}

async function main(): Promise<number> {
  const options = parseRunnerArguments(process.argv.slice(2));
  requireBuiltGate();
  if (!options.preflightOnly) requireSynchronousReadHook();
  requireNoActiveRun();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDirectory = path.join(scratchDirectory, timestamp);
  const reportDirectory = path.join(repoRoot, 'reports', 'read-gate', timestamp);
  fs.mkdirSync(reportDirectory, { recursive: true });
  const fixtures: EvalFixtures = {
    large: readFixtureInfo(largeFixtureDirectory, LARGE_FIXTURE_RELATIVE_PATH),
    small: readFixtureInfo(fixtureDirectory, FIXTURE_RELATIVE_PATH),
  };
  const provisionedTreeSitter = await provisionPluginTreeSitterCli();
  console.log(`tree-sitter CLI for the plugin: ${provisionedTreeSitter.binaryPath} (${provisionedTreeSitter.version})`);

  const arms: EvalArm[] = [];
  for (const name of ARM_NAMES) arms.push(await createEvalArm(name, runDirectory, arms.map(arm => arm.port)));
  const seeded = seedObservationDatabases(runDirectory, arms);
  console.log(`Seeded observations ${seeded.map(observation => `#${observation.id}`).join(', ')} into both arms (${path.relative(repoRoot, runDirectory)})`);

  try {
    for (const arm of arms) {
      console.log(`Starting the gate-${arm.name} worker on port ${arm.port}`);
      startedArms.add(arm);
      startWorker(arm);
      await waitForWorkerReadiness(arm);
    }

    // D9 first: a gate that cannot reach the tree-sitter CLI stays dormant, and
    // that cause must read as such rather than as a deny that never came.
    const treeSitter = {
      ...provisionedTreeSitter,
      resolvedByPlugin: checkPluginTreeSitterCli(hookSearchPath(), path.join(repoRoot, provisionedTreeSitter.binaryPath)),
    };
    const preflight = runPreflight(arms, seeded);
    fs.writeFileSync(path.join(reportDirectory, 'preflight.json'), `${JSON.stringify({
      fixtures: [fixtures.large, fixtures.small],
      treeSitter,
      seededObservations: seeded,
      checks: preflight,
    }, null, 2)}\n`);
    console.log(`\nPre-flight (real hook and worker, no model):\n${formatPreflight(treeSitter.resolvedByPlugin, preflight, seeded.length)}\n`);
    const preflightFailures = [
      ...(treeSitter.resolvedByPlugin.failure ? [treeSitter.resolvedByPlugin.failure] : []),
      ...preflight.flatMap(check => check.failures.map(failure => `gate-${check.arm}, ${check.name}: ${failure}`)),
    ];
    if (preflightFailures.length > 0) {
      throw new Error(`Pre-flight failed, so no model was called:\n- ${preflightFailures.join('\n- ')}`);
    }
    if (options.preflightOnly) {
      console.log(`Pre-flight passed. Written to ${path.relative(repoRoot, reportDirectory)}/preflight.json`);
      return 0;
    }

    writeActiveDataDirectoryFiles(arms);
    stageSuite();
    const evalOutputDirectory = path.join(reportDirectory, 'eval');
    const evalExitCode = runPluginEval(options, evalOutputDirectory);
    removeActiveDataDirectoryFiles();
    removeStagedSuite();
    const aggregatePath = path.join(evalOutputDirectory, 'aggregate-result.json');
    if (!fs.existsSync(aggregatePath)) {
      throw new Error(`claude plugin eval exited ${evalExitCode} without writing ${path.relative(repoRoot, aggregatePath)}`);
    }
    const aggregate = JSON.parse(fs.readFileSync(aggregatePath, 'utf8')) as AggregateResult;
    const runs = collectRunEvidence(aggregate, reportDirectory, fixtures);
    const summary = buildSummary({ options, aggregate, evalExitCode, fixtures, treeSitter, seeded, preflight, runs });
    const markdown = renderSummaryMarkdown(summary, reportDirectory);
    fs.writeFileSync(path.join(reportDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(reportDirectory, 'summary.md'), markdown);
    console.log(`\n${markdown}\nWritten to ${path.relative(repoRoot, reportDirectory)}/summary.md`);
    return summary.passed ? 0 : 1;
  } finally {
    removeActiveDataDirectoryFiles();
    removeStagedSuite();
    stopStartedWorkers();
  }
}

if (import.meta.main) {
  if (process.argv[2] === SEED_SUBCOMMAND) {
    await seedObservationDatabase(process.argv[3]);
  } else {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        removeActiveDataDirectoryFiles();
        removeStagedSuite();
        stopStartedWorkers();
        process.exit(130);
      });
    }
    main().then(
      exitCode => {
        if (exitCode !== 0) process.exitCode = exitCode;
      },
      error => {
        console.error(`eval:read-gate failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      },
    );
  }
}
