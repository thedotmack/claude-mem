import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildKiroHooksBlock,
  isClaudeMemHookEntry,
  mergeHooksIntoAgentConfig,
  installKiroCliIntegration,
  uninstallKiroCliIntegration,
  getKiroHomeDir,
} from '../../src/services/integrations/KiroCliInstaller.js';
import { USER_SETTINGS_PATH, DATA_DIR } from '../../src/shared/paths.js';

const MANIFEST_PATH = join(DATA_DIR, 'kiro-install.json');

let kiroHome: string;
let previousKiroHomeEnv: string | undefined;
let previousSettingsContent: string | null;

beforeEach(() => {
  previousKiroHomeEnv = process.env.KIRO_HOME;
  kiroHome = mkdtempSync(join(tmpdir(), 'kiro-home-'));
  process.env.KIRO_HOME = kiroHome;
  // The installer defaults CLAUDE_MEM_SEMANTIC_INJECT in the shared test-run
  // settings file; snapshot and restore so other suites see pristine settings.
  // Then start from NO settings file: earlier suites in a full run may have
  // written an explicit CLAUDE_MEM_SEMANTIC_INJECT, which the installer
  // (correctly) refuses to override.
  previousSettingsContent = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : null;
  rmSync(USER_SETTINGS_PATH, { force: true });
});

afterEach(() => {
  if (previousKiroHomeEnv === undefined) {
    delete process.env.KIRO_HOME;
  } else {
    process.env.KIRO_HOME = previousKiroHomeEnv;
  }
  rmSync(kiroHome, { recursive: true, force: true });
  rmSync(MANIFEST_PATH, { force: true });
  if (previousSettingsContent === null) {
    rmSync(USER_SETTINGS_PATH, { force: true });
  } else {
    writeFileSync(USER_SETTINGS_PATH, previousSettingsContent);
  }
});

function writeAgent(name: string, config: Record<string, unknown>): string {
  const agentsDir = join(kiroHome, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const agentPath = join(agentsDir, `${name}.json`);
  writeFileSync(agentPath, JSON.stringify(config, null, 2) + '\n');
  return agentPath;
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

describe('getKiroHomeDir', () => {
  it('honours the KIRO_HOME env override', () => {
    expect(getKiroHomeDir()).toBe(kiroHome);
  });
});

describe('buildKiroHooksBlock', () => {
  it('wires the four Kiro events with correct injection hygiene', () => {
    const hooks = buildKiroHooksBlock();

    expect(Object.keys(hooks).sort()).toEqual(['agentSpawn', 'postToolUse', 'stop', 'userPromptSubmit']);

    // agentSpawn stdout is injected into model context: the version-check and
    // worker warm-up hooks MUST be silenced; only `hook kiro context` prints.
    expect(hooks.agentSpawn).toHaveLength(3);
    expect(hooks.agentSpawn[0].command).toContain('version-check.js');
    expect(hooks.agentSpawn[0].command).toContain('>/dev/null');
    // Self-heal hook may run a one-time `bun install` — needs the long timeout.
    expect(hooks.agentSpawn[0].timeout_ms).toBe(300000);
    expect(hooks.agentSpawn[1].command).toContain('" start >/dev/null');
    expect(hooks.agentSpawn[2].command).toContain('hook kiro context');
    expect(hooks.agentSpawn[2].command).not.toContain('/dev/null');

    expect(hooks.userPromptSubmit[0].command).toContain('hook kiro session-init');

    expect(hooks.postToolUse[0].matcher).toBe('*');
    expect(hooks.postToolUse[0].command).toContain('hook kiro observation');
    // Kiro's default timeout_ms is 30000 — too short for observation posts
    // behind a cold worker.
    expect(hooks.postToolUse[0].timeout_ms).toBe(120000);

    expect(hooks.stop[0].command).toContain('hook kiro summarize');
    expect(hooks.stop[0].timeout_ms).toBe(120000);
  });
});

describe('isClaudeMemHookEntry', () => {
  it('claims worker-service and version-check commands, leaves user hooks alone', () => {
    expect(isClaudeMemHookEntry({ command: '"/x/bun" "/y/worker-service.cjs" hook kiro context' })).toBe(true);
    expect(isClaudeMemHookEntry({ command: '"/x/bun" "/y/worker-service.cjs" start >/dev/null 2>&1 || true' })).toBe(true);
    expect(isClaudeMemHookEntry({ command: '"/x/node" "/y/version-check.js" >/dev/null 2>&1 || true' })).toBe(true);
    expect(isClaudeMemHookEntry({ command: 'cargo fmt --all' })).toBe(false);
    expect(isClaudeMemHookEntry({ command: '' })).toBe(false);
  });

  it('does not claim user hooks that merely mention the script names', () => {
    // A user wrapping worker-service themselves, or a generic version-check.js
    // of their own, must survive install/uninstall untouched.
    expect(isClaudeMemHookEntry({ command: 'my-wrapper.sh /y/worker-service.cjs status' })).toBe(false);
    expect(isClaudeMemHookEntry({ command: 'node ./scripts/version-check.js --strict' })).toBe(false);
  });
});

describe('mergeHooksIntoAgentConfig', () => {
  it('preserves user hook entries and unknown agent keys', () => {
    const agent = {
      name: 'rust-agent',
      model: 'claude-sonnet-4',
      toolsSettings: { write: { allowedPaths: ['src/**'] } },
      hooks: {
        postToolUse: [{ matcher: 'fs_write', command: 'cargo fmt --all' }],
      },
    };

    const merged = mergeHooksIntoAgentConfig(agent, buildKiroHooksBlock());

    expect(merged.model).toBe('claude-sonnet-4');
    expect(merged.toolsSettings).toEqual({ write: { allowedPaths: ['src/**'] } });
    const postToolUse = merged.hooks!.postToolUse;
    expect(postToolUse.some(entry => entry.command === 'cargo fmt --all')).toBe(true);
    expect(postToolUse.some(entry => entry.command.includes('hook kiro observation'))).toBe(true);
  });

  it('is idempotent: merging twice produces the same config as merging once', () => {
    const hooks = buildKiroHooksBlock();
    const once = mergeHooksIntoAgentConfig({ name: 'a' }, hooks);
    const twice = mergeHooksIntoAgentConfig(once, hooks);

    expect(twice).toEqual(once);
  });

  it('replaces stale claude-mem entries instead of duplicating them', () => {
    const stale = {
      name: 'a',
      hooks: {
        stop: [{ command: '"/old/bun" "/old/path/worker-service.cjs" hook kiro summarize' }],
      },
    };

    const merged = mergeHooksIntoAgentConfig(stale, buildKiroHooksBlock());

    expect(merged.hooks!.stop).toHaveLength(1);
    expect(merged.hooks!.stop[0].command).not.toContain('/old/path');
  });
});

describe('installKiroCliIntegration / uninstallKiroCliIntegration', () => {
  it('fails cleanly when Kiro is not installed', async () => {
    rmSync(kiroHome, { recursive: true, force: true });

    expect(await installKiroCliIntegration()).toBe(1);
  });

  it('refuses to touch a corrupt agent config', async () => {
    const agentsDir = join(kiroHome, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'broken.json'), '{ not json');

    expect(await installKiroCliIntegration()).toBe(1);
    expect(readFileSync(join(agentsDir, 'broken.json'), 'utf-8')).toBe('{ not json');
  });

  it('aborts on a corrupt mcp.json before mutating any agent config', async () => {
    const agentPath = writeAgent('daily', { name: 'daily' });
    const before = readFileSync(agentPath, 'utf-8');
    mkdirSync(join(kiroHome, 'settings'), { recursive: true });
    writeFileSync(join(kiroHome, 'settings', 'mcp.json'), '{ not json');

    expect(await installKiroCliIntegration()).toBe(1);

    expect(readFileSync(join(kiroHome, 'settings', 'mcp.json'), 'utf-8')).toBe('{ not json');
    expect(readFileSync(agentPath, 'utf-8')).toBe(before);
    expect(existsSync(MANIFEST_PATH)).toBe(false);
  });

  it('patches existing agents, registers MCP, copies skills, and uninstalls exactly', async () => {
    const agentPath = writeAgent('daily', {
      name: 'daily',
      description: 'my agent',
      resources: ['file://README.md'],
      hooks: { stop: [{ command: 'npm test' }] },
    });

    expect(await installKiroCliIntegration()).toBe(0);

    const patched = readJson(agentPath);
    expect(patched.resources).toEqual(['file://README.md']);
    expect(patched.hooks.agentSpawn).toHaveLength(3);
    expect(patched.hooks.stop.some((e: any) => e.command === 'npm test')).toBe(true);
    expect(patched.hooks.stop.some((e: any) => e.command.includes('hook kiro summarize'))).toBe(true);

    const mcpConfig = readJson(join(kiroHome, 'settings', 'mcp.json'));
    expect(mcpConfig.mcpServers['claude-mem'].args[0]).toContain('mcp-server.cjs');
    expect(mcpConfig.mcpServers['claude-mem'].autoApprove).toContain('search');
    expect(mcpConfig.mcpServers['claude-mem'].autoApprove).not.toContain('build_corpus');

    expect(existsSync(join(kiroHome, 'skills', 'mem-search', 'SKILL.md'))).toBe(true);

    const manifest = readJson(MANIFEST_PATH);
    expect(manifest.patchedAgentFiles).toEqual([agentPath]);
    expect(manifest.installedSkillDirs.length).toBeGreaterThan(0);

    const settings = readJson(USER_SETTINGS_PATH);
    expect(settings.CLAUDE_MEM_SEMANTIC_INJECT).toBe('true');

    // Re-install is idempotent.
    expect(await installKiroCliIntegration()).toBe(0);
    expect(readJson(agentPath)).toEqual(patched);

    expect(uninstallKiroCliIntegration()).toBe(0);

    const cleaned = readJson(agentPath);
    expect(cleaned.hooks.stop).toEqual([{ command: 'npm test' }]);
    expect(cleaned.hooks.agentSpawn).toBeUndefined();
    expect(readJson(join(kiroHome, 'settings', 'mcp.json')).mcpServers['claude-mem']).toBeUndefined();
    expect(existsSync(join(kiroHome, 'skills', 'mem-search'))).toBe(false);
    expect(existsSync(MANIFEST_PATH)).toBe(false);
  });

  it('creates a fallback agent when none exist and removes it on uninstall', async () => {
    mkdirSync(join(kiroHome, 'agents'), { recursive: true });

    expect(await installKiroCliIntegration()).toBe(0);

    const fallbackPath = join(kiroHome, 'agents', 'claude-mem.json');
    const fallback = readJson(fallbackPath);
    expect(fallback.name).toBe('claude-mem');
    expect(fallback.includeMcpJson).toBe(true);
    // No `tools` field would mean NO tools on kiro-cli 2.11.0.
    expect(fallback.tools).toEqual(['*']);
    expect(fallback.hooks.agentSpawn).toHaveLength(3);

    expect(uninstallKiroCliIntegration()).toBe(0);
    expect(existsSync(fallbackPath)).toBe(false);
  });

  it('keeps fallback-agent ownership across an idempotent reinstall', async () => {
    mkdirSync(join(kiroHome, 'agents'), { recursive: true });
    expect(await installKiroCliIntegration()).toBe(0);
    // Reinstall: the created agent now exists on disk and is re-patched, but
    // it must stay uninstall-deletable.
    expect(await installKiroCliIntegration()).toBe(0);

    const manifest = readJson(MANIFEST_PATH);
    const fallbackPath = join(kiroHome, 'agents', 'claude-mem.json');
    expect(manifest.createdAgentFiles).toEqual([fallbackPath]);

    expect(uninstallKiroCliIntegration()).toBe(0);
    expect(existsSync(fallbackPath)).toBe(false);
  });

  it('keeps a user-customised fallback agent on uninstall', async () => {
    mkdirSync(join(kiroHome, 'agents'), { recursive: true });
    expect(await installKiroCliIntegration()).toBe(0);

    const fallbackPath = join(kiroHome, 'agents', 'claude-mem.json');
    const adopted = readJson(fallbackPath);
    adopted.description = 'my daily driver';
    writeFileSync(fallbackPath, JSON.stringify(adopted, null, 2) + '\n');

    expect(uninstallKiroCliIntegration()).toBe(0);
    expect(existsSync(fallbackPath)).toBe(true);
    expect(readJson(fallbackPath).description).toBe('my daily driver');
    expect(readJson(fallbackPath).hooks).toBeUndefined();
  });

  it('reverts the installer-written semantic-inject default on uninstall, but not a user value', async () => {
    writeAgent('daily', { name: 'daily' });
    expect(await installKiroCliIntegration()).toBe(0);
    expect(readJson(USER_SETTINGS_PATH).CLAUDE_MEM_SEMANTIC_INJECT).toBe('true');

    expect(uninstallKiroCliIntegration()).toBe(0);
    expect(readJson(USER_SETTINGS_PATH).CLAUDE_MEM_SEMANTIC_INJECT).toBeUndefined();

    // User changed the value after install → uninstall leaves it alone.
    expect(await installKiroCliIntegration()).toBe(0);
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }, null, 2));
    expect(uninstallKiroCliIntegration()).toBe(0);
    expect(readJson(USER_SETTINGS_PATH).CLAUDE_MEM_SEMANTIC_INJECT).toBe('false');
  });

  it('does not clobber a user skill directory with the same name', async () => {
    writeAgent('daily', { name: 'daily' });
    const userSkill = join(kiroHome, 'skills', 'mem-search');
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, 'SKILL.md'), '---\nname: mem-search\n---\nuser-owned\n');

    expect(await installKiroCliIntegration()).toBe(0);

    expect(readFileSync(join(userSkill, 'SKILL.md'), 'utf-8')).toContain('user-owned');
    const manifest = readJson(MANIFEST_PATH);
    expect(manifest.installedSkillDirs).not.toContain(userSkill);

    // Uninstall must leave the user's skill in place.
    expect(uninstallKiroCliIntegration()).toBe(0);
    expect(existsSync(join(userSkill, 'SKILL.md'))).toBe(true);
  });

  it('does not override an explicit user semantic-inject setting', async () => {
    writeAgent('daily', { name: 'daily' });
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }, null, 2));

    expect(await installKiroCliIntegration()).toBe(0);

    expect(readJson(USER_SETTINGS_PATH).CLAUDE_MEM_SEMANTIC_INJECT).toBe('false');
  });

  it('writes a hook-less, tool-less observer agent and never patches hooks into it', async () => {
    writeAgent('daily', { name: 'daily' });

    expect(await installKiroCliIntegration()).toBe(0);
    // Re-run: the observer file now exists on disk and must stay hook-free.
    expect(await installKiroCliIntegration()).toBe(0);

    const observerPath = join(kiroHome, 'agents', 'claude-mem-observer.json');
    const observer = readJson(observerPath);
    // Recursion guard: hooks here would make the compression chat observe itself.
    expect(observer.hooks).toBeUndefined();
    expect(observer.tools).toEqual([]);
    // Cheapest Kiro tier by default; dot notation is the id kiro-cli accepts.
    expect(observer.model).toBe('claude-haiku-4.5');

    const manifest = readJson(MANIFEST_PATH);
    expect(manifest.observerAgentFile).toBe(observerPath);
    // The observer is internal — not a patched/created user-facing agent, and
    // its presence must not have suppressed the fallback-agent decision.
    expect(manifest.patchedAgentFiles).not.toContain(observerPath);
    expect(manifest.createdAgentFiles).not.toContain(observerPath);

    expect(uninstallKiroCliIntegration()).toBe(0);
    expect(existsSync(observerPath)).toBe(false);
  });

  it('defaults CLAUDE_MEM_PROVIDER to kiro when unset and reverts on uninstall', async () => {
    writeAgent('daily', { name: 'daily' });

    expect(await installKiroCliIntegration()).toBe(0);
    expect(readJson(USER_SETTINGS_PATH).CLAUDE_MEM_PROVIDER).toBe('kiro');

    expect(uninstallKiroCliIntegration()).toBe(0);
    expect(readJson(USER_SETTINGS_PATH).CLAUDE_MEM_PROVIDER).toBeUndefined();
  });

  it('never overrides an explicit provider choice', async () => {
    writeAgent('daily', { name: 'daily' });
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'claude' }, null, 2));

    expect(await installKiroCliIntegration()).toBe(0);
    expect(readJson(USER_SETTINGS_PATH).CLAUDE_MEM_PROVIDER).toBe('claude');

    expect(uninstallKiroCliIntegration()).toBe(0);
    expect(readJson(USER_SETTINGS_PATH).CLAUDE_MEM_PROVIDER).toBe('claude');
  });
});
