#!/usr/bin/env bun
/**
 * Splits the root bun suite (everything `bun test tests` finds) into two lanes:
 *
 *   fast         unit tests: the default `npm test`, run on every save
 *   integration  real Chrome, tree-sitter grammar builds, end-to-end installs
 *                and other files that need real wall-clock time
 *
 * Usage: bun scripts/test-lanes.ts <fast|integration|all|check> [bun test args]
 *
 * `all` runs both lanes (each in its own `bun test` process, as CI does).
 * `check` proves the lanes are disjoint and together cover every test file.
 */
import { Glob } from 'bun';

const INTEGRATION_PATH_PATTERNS: RegExp[] = [
  /\.browser\.test\.ts$/,
  /^tests\/integration\//,
  /^tests\/services\/smart-file-read\//,
];

// Unit-test locations whose files still spend real seconds waiting on timers.
const INTEGRATION_TIMER_HEAVY_FILES = new Set<string>([
]);

// The same names `bun test` treats as test files.
const BUN_TEST_FILE_NAME = /\.test|_test_|\.spec|_spec_/;
const BUN_TEST_FILE_EXTENSION = /\.(c|m)?[jt]sx?$/;

function listAllTestFiles(): string[] {
  const files: string[] = [];
  for (const root of ['tests', 'src/ui/my-work/src/live', 'src/ui/my-work/src/setup', 'src/ui/my-work/src/store']) {
  for (const path of new Glob(`${root}/**/*`).scanSync({ onlyFiles: true })) {
    if (path.includes('/node_modules/')) continue;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (BUN_TEST_FILE_NAME.test(name) && BUN_TEST_FILE_EXTENSION.test(name)) files.push(path);
  }
  }
  return files.sort();
}

function isIntegrationFile(path: string): boolean {
  return INTEGRATION_TIMER_HEAVY_FILES.has(path) || INTEGRATION_PATH_PATTERNS.some(pattern => pattern.test(path));
}

export function filesForLane(lane: 'fast' | 'integration'): string[] {
  return listAllTestFiles().filter(path => isIntegrationFile(path) === (lane === 'integration'));
}

/**
 * Windows' CreateProcess caps lpCommandLine at 32,767 characters including the
 * terminating null, so 32,766 are usable. The fast lane's ~900 paths come to
 * ~44k characters, so one `bun test` call per lane cannot start on Windows.
 */
export const WINDOWS_COMMAND_LINE_CHARACTER_LIMIT = 32_766;

/**
 * Upper bound on the Windows command line for these arguments: each one may be
 * wrapped in two quotes and is followed by one space. Test paths and bun flags
 * contain no quote characters, so escaping adds nothing more.
 */
export function commandLineLength(args: string[]): number {
  return args.reduce((total, arg) => total + arg.length + 3, 0);
}

/** Splits `files` into ordered batches whose full command line stays within the Windows limit. */
export function splitTestFilesIntoCommandLineBatches(commandPrefix: string[], files: string[]): string[][] {
  // `bun test` with no paths runs every test file, so an empty lane must never reach it.
  if (files.length === 0) throw new Error('[test-lanes] no test files to run');
  const prefixLength = commandLineLength(commandPrefix);
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentLength = prefixLength;
  for (const file of files) {
    const fileLength = commandLineLength([file]);
    if (prefixLength + fileLength > WINDOWS_COMMAND_LINE_CHARACTER_LIMIT) {
      throw new Error(`[test-lanes] ${file} does not fit on one command line (limit ${WINDOWS_COMMAND_LINE_CHARACTER_LIMIT} characters)`);
    }
    if (currentLength + fileLength > WINDOWS_COMMAND_LINE_CHARACTER_LIMIT) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLength = prefixLength;
    }
    currentBatch.push(file);
    currentLength += fileLength;
  }
  batches.push(currentBatch);
  return batches;
}

/** Runs every batch (one failure doesn't hide the rest) and returns the first non-zero exit code. */
export async function runTestFilesInBatches(batches: string[][], runBatch: (batch: string[]) => Promise<number>): Promise<number> {
  let firstFailingExitCode = 0;
  for (const batch of batches) {
    const exitCode = await runBatch(batch);
    if (exitCode !== 0 && firstFailingExitCode === 0) firstFailingExitCode = exitCode;
  }
  return firstFailingExitCode;
}

async function runLane(lane: 'fast' | 'integration', extraArgs: string[]): Promise<number> {
  // `./` makes bun treat each entry as an exact path, not a substring filter.
  const files = filesForLane(lane).map(path => `./${path}`);
  const commandPrefix = [process.execPath, 'test', ...extraArgs];
  const batches = splitTestFilesIntoCommandLineBatches(commandPrefix, files);
  console.log(`[test-lanes] ${lane}: ${files.length} files in ${batches.length} bun test run(s)`);
  const exitCode = await runTestFilesInBatches(batches, async batch => {
    const child = Bun.spawn([...commandPrefix, ...batch], { stdio: ['inherit', 'inherit', 'inherit'] });
    return await child.exited;
  });
  if (exitCode !== 0) console.error(`[test-lanes] ${lane}: a bun test run failed (exit ${exitCode})`);
  return exitCode;
}

function checkLanes(): number {
  const all = listAllTestFiles();
  const fast = filesForLane('fast');
  const integration = filesForLane('integration');
  const overlap = fast.filter(path => integration.includes(path));
  const covered = new Set([...fast, ...integration]);
  const missing = all.filter(path => !covered.has(path));
  const staleTimerHeavy = [...INTEGRATION_TIMER_HEAVY_FILES].filter(path => !all.includes(path));
  console.log(`all test files: ${all.length}`);
  console.log(`fast lane: ${fast.length}`);
  console.log(`integration lane: ${integration.length}`);
  console.log(`in both lanes: ${overlap.length}`);
  console.log(`in neither lane: ${missing.length}`);
  console.log(`timer-heavy entries that match no file: ${staleTimerHeavy.length}`);
  for (const path of [...overlap, ...missing, ...staleTimerHeavy]) console.log(`  ${path}`);
  return overlap.length + missing.length + staleTimerHeavy.length === 0 && fast.length + integration.length === all.length ? 0 : 1;
}

if (import.meta.main) {
  const [command, ...extraArgs] = process.argv.slice(2);
  if (command === 'fast' || command === 'integration') {
    process.exit(await runLane(command, extraArgs));
  } else if (command === 'all') {
    const fastExit = await runLane('fast', extraArgs);
    const integrationExit = await runLane('integration', extraArgs);
    process.exit(fastExit || integrationExit);
  } else if (command === 'check') {
    process.exit(checkLanes());
  } else {
    console.error('usage: bun scripts/test-lanes.ts <fast|integration|all|check> [bun test args]');
    process.exit(2);
  }
}
