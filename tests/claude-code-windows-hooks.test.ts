import { describe, it, expect } from 'bun:test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { rewriteInstalledClaudeCodeHooksForWindows } from '../src/services/integrations/ClaudeCodeHooksInstaller.js';

function readHooks(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; args?: string[]; shell?: string; timeout?: number }> }>>;
  };
}

describe('rewriteInstalledClaudeCodeHooksForWindows', () => {
  it('rewrites the seven Claude Code hooks to exec form while preserving matchers and timeouts', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cm-win-hooks-'));
    const pluginRoot = path.join(tempRoot, 'plugin');
    mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
    cpSync(
      path.join(import.meta.dir, '..', 'plugin', 'hooks', 'hooks.json'),
      path.join(pluginRoot, 'hooks', 'hooks.json'),
    );

    try {
      rewriteInstalledClaudeCodeHooksForWindows(pluginRoot, 'C:\\Program Files\\nodejs\\node.exe');
      const hooks = readHooks(path.join(pluginRoot, 'hooks', 'hooks.json')).hooks;

      const setup = hooks.Setup[0].hooks[0];
      const sessionStartStart = hooks.SessionStart[0].hooks[0];
      const sessionStartContext = hooks.SessionStart[0].hooks[1];
      const promptSubmit = hooks.UserPromptSubmit[0].hooks[0];
      const postToolUse = hooks.PostToolUse[0].hooks[0];
      const preToolUse = hooks.PreToolUse[0].hooks[0];
      const stop = hooks.Stop[0].hooks[0];

      expect(hooks.Setup[0].matcher).toBe('*');
      expect(hooks.SessionStart[0].matcher).toBe('startup|clear|compact');
      expect(hooks.PostToolUse[0].matcher).toBe('*');
      expect(hooks.PreToolUse[0].matcher).toBe('Read');

      expect(setup.timeout).toBe(300);
      expect(sessionStartStart.timeout).toBe(60);
      expect(postToolUse.timeout).toBe(120);
      expect(stop.timeout).toBe(120);

      for (const hook of [setup, sessionStartStart, sessionStartContext, promptSubmit, postToolUse, preToolUse, stop]) {
        expect(hook.command).toBe('C:\\Program Files\\nodejs\\node.exe');
        expect(hook.shell).toBeUndefined();
        expect(Array.isArray(hook.args)).toBe(true);
      }

      expect(setup.args).toEqual([
        path.join(pluginRoot, 'scripts', 'version-check.js'),
      ]);
      expect(sessionStartStart.args).toEqual([
        path.join(pluginRoot, 'scripts', 'bun-runner.js'),
        '--hook-continue-json',
        path.join(pluginRoot, 'scripts', 'worker-service.cjs'),
        'start',
      ]);
      expect(sessionStartContext.args).toEqual([
        path.join(pluginRoot, 'scripts', 'bun-runner.js'),
        path.join(pluginRoot, 'scripts', 'worker-service.cjs'),
        'hook',
        'claude-code',
        'context',
      ]);
      expect(promptSubmit.args).toEqual([
        path.join(pluginRoot, 'scripts', 'bun-runner.js'),
        path.join(pluginRoot, 'scripts', 'worker-service.cjs'),
        'hook',
        'claude-code',
        'session-init',
      ]);
      expect(postToolUse.args?.slice(-2)).toEqual(['claude-code', 'observation']);
      expect(preToolUse.args?.slice(-2)).toEqual(['claude-code', 'file-context']);
      expect(stop.args?.slice(-2)).toEqual(['claude-code', 'summarize']);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('is wired into both marketplace and cache install roots', () => {
    const installSource = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'npx-cli', 'commands', 'install.ts'),
      'utf-8',
    );

    expect(installSource).toContain("rewriteInstalledClaudeCodeHooksForWindows(join(marketplaceDir, 'plugin'))");
    expect(installSource).toContain('rewriteInstalledClaudeCodeHooksForWindows(cachePath)');
  });
});
