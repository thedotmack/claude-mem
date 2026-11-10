/**
 * Runs the auto-clear mod through Claude Code's own engine with
 * `claude plugin test`: the bundled hooks module is loaded the way a session
 * loads it, tool calls and turn ends go through its hooks, and stubs stand in
 * for the model, /clear and the context reading. The checks themselves live in
 * tests/fixtures/auto-clear-mod/engine-checks.ts (Claude Code's test kit, not
 * bun's), copied into a scratch plugin as its tests/engine.test.ts.
 *
 * Skipped when no Claude Code with mods (2.1.287+) is on PATH.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const MODS_MINIMUM = [2, 1, 287];

function claudeWithMods(): boolean {
  const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 30_000 });
  if (result.status !== 0) return false;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? '');
  if (!match) return false;
  const version = match.slice(1).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== MODS_MINIMUM[i]) return version[i] > MODS_MINIMUM[i];
  }
  return true;
}

const repoRoot = join(import.meta.dir, '..', '..');

async function runEngineChecks() {
  const plugin = mkdtempSync(join(tmpdir(), 'auto-clear-engine-'));
  try {
    mkdirSync(join(plugin, '.claude-plugin'));
    mkdirSync(join(plugin, 'hooks'));
    mkdirSync(join(plugin, 'tests'));
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'autoclear-engine-test', version: '0.0.0', description: 'auto-clear engine checks', author: { name: 'claude-mem' }, license: 'Apache-2.0',
    }));
    writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./auto-clear.js'] }));
    await build({
      entryPoints: [join(repoRoot, 'src', 'mods', 'auto-clear', 'register.ts')],
      bundle: true,
      platform: 'neutral',
      target: 'es2022',
      format: 'esm',
      outfile: join(plugin, 'hooks', 'auto-clear.js'),
      logLevel: 'error',
    });
    copyFileSync(join(repoRoot, 'tests', 'fixtures', 'auto-clear-mod', 'engine-checks.ts'), join(plugin, 'tests', 'engine.test.ts'));

    return spawnSync('claude', ['plugin', 'test'], { cwd: plugin, encoding: 'utf-8', timeout: 180_000 });
  } finally {
    rmSync(plugin, { recursive: true, force: true });
  }
}

const run = claudeWithMods() ? await runEngineChecks() : null;
const output = `${run?.stdout ?? ''}\n${run?.stderr ?? ''}`;
const requireEngine = process.env.CLAUDE_MEM_TEST_AUTO_CLEAR_ENGINE === '1';

describe.skipIf(!requireEngine && (run === null || /hooks modules are turned off/.test(output)))('auto-clear mod in the Claude Code engine', () => {
  it('passes the engine checks', () => {
    expect(output).toContain(' 0 fail');
    expect(run!.status).toBe(0);
  });
});
