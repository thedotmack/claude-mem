import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import * as autoUpdateCheck from '../../src/services/auto-update/auto-update-check.js';
import { autoUpdateStatePath, defaultAutoUpdateState, type AutoUpdateState } from '../../src/services/auto-update/auto-update-state.js';
import * as workerUtils from '../../src/shared/worker-utils.js';

// runDoctorCommand pushes the Auto-update row, and prints a detail of several
// lines with every later line under the first one's text. Run end to end with
// the isolation of tests/npx-cli/cli-worker-port-settings.test.ts: fetch
// answers 503 and process.exit and console.log are captured. On top of that
// the resolver is stubbed, Claude Code's config and managed settings point at
// scratch directories, and PATH holds only the system directories, so nothing
// reaches the real install, launcher or worker. The state file is the one the
// row reads, in the data dir tests/preload.ts points at a disposable directory.

const scratchRoot = path.join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });

/** The column where every row's detail starts: two spaces, the icon, a space, the name padded to 22, a space (doctor.ts CHECK_NAME_COLUMN_WIDTH). */
const DETAIL_COLUMN = 2 + 1 + 1 + 22 + 1;
const ANSI_STYLE = /\x1b\[[0-9;]*m/g;
const MINUTE_MS = 60_000;

const statePath = autoUpdateStatePath();
let claudeConfigDirectory: string;
let statePathBefore: string | null;
let savedEnvironment: Record<string, string | undefined>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  claudeConfigDirectory = mkdtempSync(path.join(scratchRoot, 'doctor-auto-update-wiring-'));
  statePathBefore = existsSync(statePath) ? readFileSync(statePath, 'utf-8') : null;
  savedEnvironment = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT };
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDirectory;
  process.env.PATH = '/usr/bin:/bin';
  delete process.env.CLAUDE_PLUGIN_ROOT;
  globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
  spyOn(workerUtils, 'resolvePluginRoot').mockReturnValue(null);
  spyOn(autoUpdateCheck, 'claudeCodeManagedSettingsDirectory').mockReturnValue(path.join(claudeConfigDirectory, 'no-managed-settings'));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (statePathBefore === null) rmSync(statePath, { force: true });
  else writeFileSync(statePath, statePathBefore);
  rmSync(claudeConfigDirectory, { recursive: true, force: true });
});

async function runDoctorOutputLines(): Promise<string[]> {
  const { runDoctorCommand } = await import('../../src/npx-cli/commands/doctor.js');
  // Run from source, there is no npm package root to read a version from.
  const pathsModule = await import('../../src/npx-cli/utils/paths.js');
  spyOn(pathsModule, 'readPluginVersion').mockReturnValue('0.0.0-test');
  spyOn(process, 'exit').mockImplementation((() => { throw new Error('doctor exited'); }) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  // Doctor may report through process.exitCode; keep it from becoming this
  // test process's exit status. Bun keeps a set code when assigned undefined.
  const previousExitCode = process.exitCode;
  try {
    await runDoctorCommand().catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'doctor exited') throw error;
    });
  } finally {
    process.exitCode = previousExitCode ?? 0;
  }
  return log.mock.calls.map((call) => call.map(String).join(' ')).join('\n').replace(ANSI_STYLE, '').split('\n');
}

describe('npx claude-mem doctor prints the Auto-update row', () => {
  it('as one row whose lines after the first start under its first line\'s text, ending with the fix the outcome recorded', async () => {
    const state: AutoUpdateState = {
      ...defaultAutoUpdateState(),
      lastNetworkCheckAt: Date.now() - 30 * MINUTE_MS,
      lastSeenPromotedVersion: '15.13.0',
      lastDecision: { decision: 'previously-failed', reason: '15.13.0 is promoted, but it failed here before, so it waits for the next promoted release', decidedAt: Date.now() - 10 * MINUTE_MS },
      lastAttemptOutcome: {
        result: 'restore_failed',
        targetVersion: '15.13.0',
        previousVersion: '15.12.0',
        finishedAt: Date.now() - 20 * MINUTE_MS,
        failureStage: 'installer-exit',
        message: 'what happened',
        fixCommand: 'npx claude-mem@15.13.0 update',
        fixCommandWhen: 'now',
      },
    };
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state));

    const output = await runDoctorOutputLines();

    const first = output.findIndex((line) => line.includes(' Auto-update '));
    expect(first).toBeGreaterThan(-1);
    expect(output[first]).toBe(`  ! ${'Auto-update'.padEnd(22)} claude-mem may not work: the automatic update to 15.13.0 failed`);
    const continuation = output.slice(first + 1, output.findIndex((line, index) => index > first && !line.startsWith(' '.repeat(DETAIL_COLUMN))));
    const continuationText = continuation.map((line) => line.slice(DETAIL_COLUMN));
    expect(continuationText[0]).toMatch(/^On: 15\.13\.0 is promoted, but it failed here before, so it waits for the next promoted release \(the worker's decision at .+\)$/);
    expect(continuationText).toContain('Installed: none found');
    expect(continuationText).toContain('Promoted: 15.13.0');
    expect(continuationText.some((line) => /^Last update: 15\.12\.0 → 15\.13\.0, restore_failed at installer-exit, .+$/.test(line))).toBe(true);
    expect(continuationText).toContain(`Claude Code's background update: off (the thedotmack marketplace is not registered in ${path.join(claudeConfigDirectory, 'plugins', 'known_marketplaces.json')}); claude-mem has not changed it`);
    expect(continuationText.at(-1)).toBe('Fix: run `npx claude-mem@15.13.0 update`, then restart Claude Code.');
    // Every continuation line is indented to the detail column and no further.
    for (const line of continuation) expect(line.charAt(DETAIL_COLUMN)).not.toBe(' ');
  }, 30_000);
});
