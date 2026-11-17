/**
 * Runs claude-mem's hooks module through Claude Code's own engine with
 * `claude plugin test`: the bundle of src/mods/hooks-module.ts is loaded the
 * way a session loads it, events go through its hooks, and stubs stand in for
 * Claude Code beneath them. The checks themselves are Claude Code test-kit
 * files (not bun's) under tests/fixtures/, copied into a scratch plugin's
 * tests/ folder.
 *
 * Skipped when no Claude Code with mods (2.1.287+) is on PATH. On a Claude
 * Code older than a mod's checks need, that mod's older-engine checks run in
 * place of its own (what it must leave alone there), when it has any.
 *
 * CI sets CLAUDE_MEM_TEST_HOOKS_MODULE_ENGINE=1, and the Claude Code on PATH
 * must then run every mod's own checks. It also names an older Claude Code in
 * CLAUDE_MEM_TEST_HOOKS_MODULE_OLDER_CLAUDE for a second run: one bundle ships
 * to every Claude Code, so it has to load on the oldest with mods too.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { SESSION_START_CARD_MINIMUM_VERSION } from '../../src/mods/session-start-card/card.js';

type Version = readonly [number, number, number];

const MODS_MINIMUM: Version = [2, 1, 287];

/**
 * Each mod's folder under tests/fixtures/ and the first Claude Code that runs
 * its `engine-checks.ts`. On an older one its `older-engine-checks.ts` runs,
 * or nothing when it has none.
 */
const ENGINE_CHECKS: ReadonlyArray<{ fixture: string; minimumVersion: Version; hasOlderEngineChecks: boolean }> = [
  // Its checks call the test kit's `mock.session`: 2.1.287's kit has none, 2.1.312's has it (no build between them was tried).
  { fixture: 'auto-clear-mod', minimumVersion: [2, 1, 312], hasOlderEngineChecks: false },
  // Its checks answer `ui.place` and `process.hookEnv`, and a stub for a call the build lacks is refused.
  { fixture: 'session-start-card-mod', minimumVersion: SESSION_START_CARD_MINIMUM_VERSION, hasOlderEngineChecks: true },
];

function isAtLeast(version: Version, minimum: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

/**
 * Both timeouts only end a Claude Code that hangs, so the lane goes on:
 * measured here, `--version` answers in 0.2 s and a run of the checks in 2 s.
 */
const VERSION_TIMEOUT_MS = 30_000;
const ENGINE_CHECKS_TIMEOUT_MS = 180_000;

function claudeVersion(claudeBinary: string): Version | null {
  const result = spawnSync(claudeBinary, ['--version'], { encoding: 'utf-8', timeout: VERSION_TIMEOUT_MS });
  if (result.status !== 0) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const repoRoot = join(import.meta.dir, '..', '..');

/** The engine's verdict on the bundle, or null when `claudeBinary` is no Claude Code with mods. */
async function runEngineChecks(claudeBinary: string) {
  const version = claudeVersion(claudeBinary);
  if (!version || !isAtLeast(version, MODS_MINIMUM)) return null;

  const plugin = mkdtempSync(join(tmpdir(), 'hooks-module-engine-'));
  try {
    mkdirSync(join(plugin, '.claude-plugin'));
    mkdirSync(join(plugin, 'hooks'));
    mkdirSync(join(plugin, 'tests'));
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'hooks-module-engine-test', version: '0.0.0', description: 'claude-mem hooks module engine checks', author: { name: 'claude-mem' }, license: 'Apache-2.0',
    }));
    writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./hooks-module.js'] }));
    await build({
      entryPoints: [join(repoRoot, 'src', 'mods', 'hooks-module.ts')],
      bundle: true,
      platform: 'neutral',
      target: 'es2022',
      format: 'esm',
      outfile: join(plugin, 'hooks', 'hooks-module.js'),
      logLevel: 'error',
    });
    /** The mods this Claude Code is too old for: their older-engine checks ran. */
    const modsOnOlderEngineChecks: string[] = [];
    for (const { fixture, minimumVersion, hasOlderEngineChecks } of ENGINE_CHECKS) {
      const runsItsOwnChecks = isAtLeast(version, minimumVersion);
      if (!runsItsOwnChecks && !hasOlderEngineChecks) continue;
      if (!runsItsOwnChecks) modsOnOlderEngineChecks.push(fixture);
      copyFileSync(
        join(repoRoot, 'tests', 'fixtures', fixture, runsItsOwnChecks ? 'engine-checks.ts' : 'older-engine-checks.ts'),
        join(plugin, 'tests', `${fixture}.test.ts`),
      );
    }

    const run = spawnSync(claudeBinary, ['plugin', 'test'], { cwd: plugin, encoding: 'utf-8', timeout: ENGINE_CHECKS_TIMEOUT_MS });
    return { status: run.status, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}`, modsOnOlderEngineChecks };
  } finally {
    rmSync(plugin, { recursive: true, force: true });
  }
}

const requireEngine = process.env.CLAUDE_MEM_TEST_HOOKS_MODULE_ENGINE === '1';
const olderClaudeBinary = process.env.CLAUDE_MEM_TEST_HOOKS_MODULE_OLDER_CLAUDE;
const run = await runEngineChecks('claude');
const olderRun = olderClaudeBinary ? await runEngineChecks(olderClaudeBinary) : null;

describe('claude-mem hooks module in the Claude Code engine', () => {
  it.skipIf(!requireEngine && (run === null || /hooks modules are turned off/.test(run.output)))('passes the engine checks of every mod', () => {
    expect(run!.output).toContain(' 0 fail');
    expect(run!.status).toBe(0);
    if (requireEngine) expect(run!.modsOnOlderEngineChecks).toEqual([]);
  });

  it.skipIf(!olderClaudeBinary)('loads on a Claude Code older than the session-start card needs, where the card leaves SessionStart alone', () => {
    // Anything else here means the named Claude Code did not run, has no mods, or is one the card draws on.
    expect(olderRun?.modsOnOlderEngineChecks).toEqual(['session-start-card-mod']);
    expect(olderRun!.output).toContain(' 0 fail');
    expect(olderRun!.status).toBe(0);
  });
});
