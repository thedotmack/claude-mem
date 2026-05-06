import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const VERSION_CHECK_SCRIPT = join(import.meta.dir, '..', 'plugin', 'scripts', 'version-check.js');

function runVersionCheck(root: string) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root };
  delete env.CLAUDE_MEM_CODEX_HOOK;

  return spawnSync('node', [VERSION_CHECK_SCRIPT], {
    encoding: 'utf-8',
    env,
  });
}

describe('plugin/scripts/version-check.js install marker compatibility', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `version-check-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ version: '12.4.4' }));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts a matching legacy plain-text marker without an upgrade hint', () => {
    writeFileSync(join(tempDir, '.install-version'), '12.4.4\n');

    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('accepts a matching legacy plain-text marker with a leading v', () => {
    writeFileSync(join(tempDir, '.install-version'), 'v12.4.4\n');

    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('emits an upgrade hint for a mismatched legacy plain-text marker', () => {
    writeFileSync(join(tempDir, '.install-version'), '12.4.3\n');

    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      'claude-mem: upgraded to v12.4.4 - run: npx claude-mem@latest install',
    );
  });
});
