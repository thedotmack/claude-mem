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
  for (const path of new Glob('tests/**/*').scanSync({ onlyFiles: true })) {
    if (path.includes('/node_modules/')) continue;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (BUN_TEST_FILE_NAME.test(name) && BUN_TEST_FILE_EXTENSION.test(name)) files.push(path);
  }
  return files.sort();
}

function isIntegrationFile(path: string): boolean {
  return INTEGRATION_TIMER_HEAVY_FILES.has(path) || INTEGRATION_PATH_PATTERNS.some(pattern => pattern.test(path));
}

function filesForLane(lane: 'fast' | 'integration'): string[] {
  return listAllTestFiles().filter(path => isIntegrationFile(path) === (lane === 'integration'));
}

async function runLane(lane: 'fast' | 'integration', extraArgs: string[]): Promise<number> {
  // `./` makes bun treat each entry as an exact path, not a substring filter.
  const files = filesForLane(lane).map(path => `./${path}`);
  console.log(`[test-lanes] ${lane}: ${files.length} files`);
  const child = Bun.spawn([process.execPath, 'test', ...extraArgs, ...files], { stdio: ['inherit', 'inherit', 'inherit'] });
  return await child.exited;
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
