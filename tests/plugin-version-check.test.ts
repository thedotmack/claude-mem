import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'fs';
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

function runCodexVersionCheck(root: string) {
  return spawnSync('node', [VERSION_CHECK_SCRIPT], {
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_MEM_CODEX_HOOK: '1' },
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

  it('emits valid SessionStart JSON for a matching marker in Codex hook mode', () => {
    writeFileSync(join(tempDir, '.install-version'), '12.4.4\n');

    const result = runCodexVersionCheck(tempDir);
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
      },
    });
  });

  it('emits Codex upgrade hints as SessionStart additionalContext', () => {
    writeFileSync(join(tempDir, '.install-version'), '12.4.3\n');

    const result = runCodexVersionCheck(tempDir);
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'claude-mem: upgraded to v12.4.4 - run: npx claude-mem@latest install',
      },
    });
  });

  it('emits bare SessionStart JSON when resolveRoot() returns null in Codex hook mode', () => {
    // To force resolveRoot() → null we must defeat both lookup paths:
    //   1. CLAUDE_PLUGIN_ROOT → point at a dir without package.json
    //   2. import.meta.url fallback → run the script from a copy placed inside a temp dir
    //      whose parent also has no package.json, so dirname(scriptDir) can't resolve either.
    const isolatedScriptDir = join(
      tmpdir(),
      `version-check-isolated-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      'scripts',
    );
    mkdirSync(isolatedScriptDir, { recursive: true });
    const isolatedScript = join(isolatedScriptDir, 'version-check.js');
    copyFileSync(VERSION_CHECK_SCRIPT, isolatedScript);

    const emptyRootDir = join(
      tmpdir(),
      `version-check-noroot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(emptyRootDir, { recursive: true });

    try {
      const result = spawnSync('node', [isolatedScript], {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: emptyRootDir, CLAUDE_MEM_CODEX_HOOK: '1' },
      });
      const output = JSON.parse(result.stdout);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(output).toEqual({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
        },
      });
    } finally {
      rmSync(isolatedScriptDir.replace(/\/scripts$/, ''), { recursive: true, force: true });
      rmSync(emptyRootDir, { recursive: true, force: true });
    }
  });
});
