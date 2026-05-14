/**
 * Tests for ClaudeCodeHooksInstaller: Windows PowerShell hooks generation.
 *
 * Issue: On Windows, "shell":"bash" in hooks.json causes Claude Code (a GUI process)
 * to spawn bash.exe with a visible console window on every hook invocation. This test
 * suite verifies that the Windows-specific hooks use "shell":"powershell", include
 * the correct path-discovery logic, and carry the right hook sub-commands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildWindowsHooksJson,
  writeWindowsHooksJson,
  readHooksShells,
} from '../src/services/integrations/ClaudeCodeHooksInstaller.js';

describe('ClaudeCodeHooksInstaller: buildWindowsHooksJson', () => {
  it('returns a hooks object with the standard Claude Code lifecycle events', () => {
    const hooks = buildWindowsHooksJson();
    expect(hooks.hooks).toBeDefined();
    expect(hooks.hooks.Setup).toBeDefined();
    expect(hooks.hooks.SessionStart).toBeDefined();
    expect(hooks.hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.hooks.PostToolUse).toBeDefined();
    expect(hooks.hooks.PreToolUse).toBeDefined();
    expect(hooks.hooks.Stop).toBeDefined();
  });

  it('uses "powershell" as the shell for every hook entry (no "bash" entries)', () => {
    const hooks = buildWindowsHooksJson();
    const shells: string[] = [];
    for (const groups of Object.values(hooks.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          shells.push((hook as any).shell);
        }
      }
    }
    expect(shells.length).toBeGreaterThan(0);
    expect(shells.every((s) => s === 'powershell')).toBe(true);
    expect(shells.some((s) => s === 'bash')).toBe(false);
  });

  it('Setup hook calls version-check.js (not bun-runner.js)', () => {
    const hooks = buildWindowsHooksJson();
    const setupHook = hooks.hooks.Setup[0].hooks[0];
    expect(setupHook.command).toContain('version-check.js');
    expect(setupHook.command).not.toContain('bun-runner.js');
  });

  it('Setup hook timeout is 300 seconds', () => {
    const hooks = buildWindowsHooksJson();
    const setupHook = hooks.hooks.Setup[0].hooks[0];
    expect(setupHook.timeout).toBe(300);
  });

  it('PostToolUse hook has matcher "*" and calls "observation" sub-command', () => {
    const hooks = buildWindowsHooksJson();
    const postToolGroup = hooks.hooks.PostToolUse[0];
    expect(postToolGroup.matcher).toBe('*');
    const cmd = postToolGroup.hooks[0].command;
    expect(cmd).toContain('hook claude-code observation');
  });

  it('PostToolUse hook timeout is 120 seconds', () => {
    const hooks = buildWindowsHooksJson();
    expect(hooks.hooks.PostToolUse[0].hooks[0].timeout).toBe(120);
  });

  it('PreToolUse hook has matcher "Read" and calls "file-context" sub-command', () => {
    const hooks = buildWindowsHooksJson();
    const preToolGroup = hooks.hooks.PreToolUse[0];
    expect(preToolGroup.matcher).toBe('Read');
    const cmd = preToolGroup.hooks[0].command;
    expect(cmd).toContain('hook claude-code file-context');
  });

  it('SessionStart first hook calls "start" sub-command with suppress-output JSON', () => {
    const hooks = buildWindowsHooksJson();
    const startHook = hooks.hooks.SessionStart[0].hooks[0];
    expect(startHook.command).toContain('worker-service.cjs') ;
    expect(startHook.command).toContain(' start');
    // Must emit the suppressOutput JSON so Claude Code hides the worker-start output.
    expect(startHook.command).toContain('"suppressOutput":true');
  });

  it('SessionStart second hook calls "context" sub-command', () => {
    const hooks = buildWindowsHooksJson();
    const contextHook = hooks.hooks.SessionStart[0].hooks[1];
    expect(contextHook.command).toContain('hook claude-code context');
  });

  it('UserPromptSubmit hook calls "session-init" sub-command', () => {
    const hooks = buildWindowsHooksJson();
    const cmd = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain('hook claude-code session-init');
  });

  it('Stop hook calls "summarize" sub-command', () => {
    const hooks = buildWindowsHooksJson();
    const cmd = hooks.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('hook claude-code summarize');
  });

  it('Stop hook timeout is 120 seconds', () => {
    const hooks = buildWindowsHooksJson();
    expect(hooks.hooks.Stop[0].hooks[0].timeout).toBe(120);
  });

  it('bun-runner commands reference bun-runner.js and worker-service.cjs', () => {
    const hooks = buildWindowsHooksJson();
    const bunRunnerEvents = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Stop'];
    for (const event of bunRunnerEvents) {
      const groups = hooks.hooks[event];
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          const cmd = (hook as any).command as string;
          expect(cmd).toContain('bun-runner.js');
          expect(cmd).toContain('worker-service.cjs');
        }
      }
    }
  });

  it('PS commands include CLAUDE_CONFIG_DIR fallback to USERPROFILE/.claude', () => {
    const hooks = buildWindowsHooksJson();
    const setupCmd = hooks.hooks.Setup[0].hooks[0].command;
    expect(setupCmd).toContain('CLAUDE_CONFIG_DIR');
    expect(setupCmd).toContain('USERPROFILE');
    expect(setupCmd).toContain('.claude');
  });

  it('PS commands include CLAUDE_PLUGIN_ROOT override support', () => {
    const hooks = buildWindowsHooksJson();
    // Check the PostToolUse command (representative bun-runner hook)
    const cmd = hooks.hooks.PostToolUse[0].hooks[0].command;
    expect(cmd).toContain('CLAUDE_PLUGIN_ROOT');
    expect(cmd).toContain('PLUGIN_ROOT');
  });

  it('PS commands discover cache directory under plugins/cache/thedotmack/claude-mem', () => {
    const hooks = buildWindowsHooksJson();
    const cmd = hooks.hooks.PostToolUse[0].hooks[0].command;
    // In the JS string value, \\ is used as path separator (TypeScript \\ → single \)
    // so the command contains literal \plugins\cache\ etc.
    expect(cmd).toContain('plugins\\cache\\thedotmack\\claude-mem');
  });

  it('PS commands include marketplace fallback path', () => {
    const hooks = buildWindowsHooksJson();
    const cmd = hooks.hooks.PostToolUse[0].hooks[0].command;
    expect(cmd).toContain('plugins\\marketplaces\\thedotmack\\plugin');
  });

  it('produces valid JSON when serialized', () => {
    const hooks = buildWindowsHooksJson();
    const json = JSON.stringify(hooks, null, 2);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.hooks.PostToolUse[0].hooks[0].shell).toBe('powershell');
  });
});

describe('ClaudeCodeHooksInstaller: writeWindowsHooksJson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-mem-hooks-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid hooks.json file', () => {
    const hooksPath = join(tmpDir, 'hooks', 'hooks.json');
    writeWindowsHooksJson(hooksPath);
    const content = readFileSync(hooksPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.PostToolUse[0].hooks[0].shell).toBe('powershell');
  });

  it('creates parent directories if they do not exist', () => {
    const hooksPath = join(tmpDir, 'deep', 'nested', 'dir', 'hooks.json');
    expect(() => writeWindowsHooksJson(hooksPath)).not.toThrow();
    const content = readFileSync(hooksPath, 'utf-8');
    expect(JSON.parse(content).hooks).toBeDefined();
  });

  it('file content ends with newline', () => {
    const hooksPath = join(tmpDir, 'hooks.json');
    writeWindowsHooksJson(hooksPath);
    const content = readFileSync(hooksPath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('overwrites existing file cleanly', () => {
    const hooksPath = join(tmpDir, 'hooks.json');
    writeWindowsHooksJson(hooksPath);
    writeWindowsHooksJson(hooksPath); // second call should succeed
    const content = readFileSync(hooksPath, 'utf-8');
    expect(JSON.parse(content).hooks.Stop[0].hooks[0].shell).toBe('powershell');
  });
});

describe('ClaudeCodeHooksInstaller: readHooksShells', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-mem-hooks-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all shell values from a written Windows hooks.json', () => {
    const hooksPath = join(tmpDir, 'hooks.json');
    writeWindowsHooksJson(hooksPath);
    const shells = readHooksShells(hooksPath);
    expect(shells.length).toBeGreaterThan(0);
    expect(shells.every((s) => s === 'powershell')).toBe(true);
  });

  it('returns empty array for a non-existent file', () => {
    const shells = readHooksShells(join(tmpDir, 'nonexistent.json'));
    expect(shells).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    const hooksPath = join(tmpDir, 'bad.json');
    writeFileSync(hooksPath, 'not json', 'utf-8');
    const shells = readHooksShells(hooksPath);
    expect(shells).toEqual([]);
  });
});

describe('ClaudeCodeHooksInstaller: source-level invariants for install.ts integration', () => {
  const installSource = readFileSync(
    join(import.meta.dir, '..', 'src', 'npx-cli', 'commands', 'install.ts'),
    'utf-8',
  );

  it('imports writeWindowsHooksJson from ClaudeCodeHooksInstaller', () => {
    expect(installSource).toContain("writeWindowsHooksJson");
    expect(installSource).toContain("ClaudeCodeHooksInstaller");
  });

  it('calls writeWindowsHooksJson on Windows after copyPluginToCache', () => {
    // Verify IS_WINDOWS guard is present near the cache copy logic
    const cacheSection = installSource.match(
      /function copyPluginToCache[\s\S]*?^\}/m
    )?.[0];
    expect(cacheSection).toBeDefined();
    expect(cacheSection).toContain('IS_WINDOWS');
    expect(cacheSection).toContain('writeWindowsHooksJson');
    expect(cacheSection).toContain("hooks.json");
  });

  it('calls writeWindowsHooksJson on Windows after copyPluginToMarketplace', () => {
    const marketplaceSection = installSource.match(
      /function copyPluginToMarketplace[\s\S]*?^\}/m
    )?.[0];
    expect(marketplaceSection).toBeDefined();
    expect(marketplaceSection).toContain('IS_WINDOWS');
    expect(marketplaceSection).toContain('writeWindowsHooksJson');
    expect(marketplaceSection).toContain("hooks.json");
  });
});
