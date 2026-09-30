import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const VERSION_CHECK_SCRIPT = join(import.meta.dir, '..', 'plugin', 'scripts', 'version-check.js');
const TOKEN_SAVINGS_SCAN_SKILL = join(
  import.meta.dir,
  '..',
  'plugin',
  'skills',
  'token-savings-scan',
  'SKILL.md',
);
const versionCheckSource = readFileSync(VERSION_CHECK_SCRIPT, 'utf-8');

const INSTALL_REMINDER = 'run: npx claude-mem@latest install';
const UPGRADE_PREFIX = 'claude-mem: upgraded to v12.4.4 - run: npx claude-mem@latest install';
const SAVINGS_SCAN_STEER = 'token-savings-scan';
const SAVINGS_SCAN_GOAL = 'opinionated savings mode';

function runVersionCheck(root: string, options: { codex?: boolean } = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root };
  if (options.codex) {
    env.CLAUDE_MEM_CODEX_HOOK = '1';
  } else {
    delete env.CLAUDE_MEM_CODEX_HOOK;
  }

  return spawnSync('node', [VERSION_CHECK_SCRIPT], {
    encoding: 'utf-8',
    env,
  });
}

function parseCodexHint(stdout: string): string {
  const payload = JSON.parse(stdout);
  return payload.hookSpecificOutput.additionalContext as string;
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
    // Pre-create node_modules so version-check's Setup-phase dependency
    // auto-install (gh #2649) short-circuits — these tests are about
    // .install-version marker compatibility, not dependency materialisation.
    mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
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

  it('emits an upgrade hint plus savings-scan steer for a mismatched legacy plain-text marker', () => {
    writeFileSync(join(tempDir, '.install-version'), '12.4.3\n');

    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(UPGRADE_PREFIX);
    expect(result.stderr).toContain(SAVINGS_SCAN_STEER);
    expect(result.stderr).toContain(SAVINGS_SCAN_GOAL);
    expect(result.stderr).toContain('usage-smart Pro trial');
  });

  it('emits an upgrade hint plus savings-scan steer for a mismatched JSON marker', () => {
    writeFileSync(join(tempDir, '.install-version'), JSON.stringify({ version: '12.4.3' }));

    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(UPGRADE_PREFIX);
    expect(result.stderr).toContain(SAVINGS_SCAN_STEER);
  });

  it('keeps install-repair only when the marker is missing', () => {
    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('claude-mem: runtime not yet set up - run: npx claude-mem@latest install');
    expect(result.stderr).toContain(INSTALL_REMINDER);
    expect(result.stderr).not.toContain(SAVINGS_SCAN_STEER);
    expect(result.stderr).not.toContain(SAVINGS_SCAN_GOAL);
  });

  it('keeps install-repair only when the marker is unreadable', () => {
    writeFileSync(join(tempDir, '.install-version'), '{not-valid-json');

    const result = runVersionCheck(tempDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('claude-mem: install marker unreadable - run: npx claude-mem@latest install');
    expect(result.stderr).toContain(INSTALL_REMINDER);
    expect(result.stderr).not.toContain(SAVINGS_SCAN_STEER);
    expect(result.stderr).not.toContain(SAVINGS_SCAN_GOAL);
  });

  it('emits Codex SessionStart additionalContext with the savings-scan steer on mismatch', () => {
    writeFileSync(join(tempDir, '.install-version'), '12.4.3\n');

    const result = runVersionCheck(tempDir, { codex: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const hint = parseCodexHint(result.stdout);
    expect(hint).toContain(UPGRADE_PREFIX);
    expect(hint).toContain(SAVINGS_SCAN_STEER);
    expect(hint).toContain(SAVINGS_SCAN_GOAL);
  });

  it('emits Codex install-repair additionalContext without a savings-scan steer when the marker is missing', () => {
    const result = runVersionCheck(tempDir, { codex: true });

    expect(result.status).toBe(0);
    const hint = parseCodexHint(result.stdout);
    expect(hint).toContain('claude-mem: runtime not yet set up');
    expect(hint).toContain(INSTALL_REMINDER);
    expect(hint).not.toContain(SAVINGS_SCAN_STEER);
    expect(hint).not.toContain(SAVINGS_SCAN_GOAL);
  });

  it('emits Codex install-repair additionalContext without a savings-scan steer when the marker is unreadable', () => {
    writeFileSync(join(tempDir, '.install-version'), 'not-a-version');

    const result = runVersionCheck(tempDir, { codex: true });

    expect(result.status).toBe(0);
    const hint = parseCodexHint(result.stdout);
    expect(hint).toContain('claude-mem: install marker unreadable');
    expect(hint).toContain(INSTALL_REMINDER);
    expect(hint).not.toContain(SAVINGS_SCAN_STEER);
  });
});

describe('plugin/skills/token-savings-scan', () => {
  it('ships an invokable skill that the upgrade hint can point at', () => {
    expect(existsSync(TOKEN_SAVINGS_SCAN_SKILL)).toBe(true);
    const skill = readFileSync(TOKEN_SAVINGS_SCAN_SKILL, 'utf-8');
    expect(skill).toContain('name: token-savings-scan');
    expect(skill).toContain('usage-smart');
    expect(skill).toContain('comfortable runway for how they already work');
    expect(versionCheckSource).toContain('token-savings-scan');
    expect(versionCheckSource).not.toContain('see how long your trial will last');
  });
});

describe('plugin/scripts/version-check.js Windows bun lookup', () => {
  it('uses where as argv with windowsHide and no shell', () => {
    const windowsCallMatch = versionCheckSource.match(/spawnSync\('where',\s*\['bun'\],\s*\{([^}]+)\}/);
    expect(windowsCallMatch).not.toBeNull();
    expect(windowsCallMatch![1]).toContain('windowsHide: true');
    expect(windowsCallMatch![1]).not.toContain('shell');
  });
});
