import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hookCommand } from '../../src/cli/hook-command.js';
import { HOOK_EXIT_CODES } from '../../src/shared/hook-constants.js';
import { isPluginDisabledInCodexConfig } from '../../src/shared/plugin-state.js';
import { setActiveHookType } from '../../src/shared/worker-utils.js';
import { restoreStdin } from '../fake-stdin.js';

/**
 * claude-mem's Codex hooks live in the user's hooks.json, which Codex runs
 * whether or not the plugin is switched on. Turning the plugin off in Codex
 * must still stop capture.
 */
describe('Codex plugin toggle', () => {
  const realStdoutWrite = process.stdout.write;
  const originalCodexHome = process.env.CODEX_HOME;
  let codexHome: string;
  let stdout: string[];

  const writeConfig = (text: string) => writeFileSync(join(codexHome, 'config.toml'), text);

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-plugin-toggle-'));
    process.env.CODEX_HOME = codexHome;
    stdout = [];
    process.stdout.write = ((chunk: string, callback?: () => void): boolean => {
      stdout.push(String(chunk).replace(/\n$/, ''));
      callback?.();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = realStdoutWrite;
    restoreStdin();
    setActiveHookType('');
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('counts only an explicit enabled = false as switched off', () => {
    expect(isPluginDisabledInCodexConfig()).toBe(false);

    writeConfig('[features]\nhooks = true\n');
    expect(isPluginDisabledInCodexConfig()).toBe(false);

    writeConfig('[plugins."claude-mem@claude-mem-local"]\nenabled = true\n');
    expect(isPluginDisabledInCodexConfig()).toBe(false);

    writeConfig('[plugins."other@somewhere"]\nenabled = false\n\n[plugins."claude-mem@claude-mem-local"]\nenabled = false # off for now\n');
    expect(isPluginDisabledInCodexConfig()).toBe(true);
  });

  it('answers every Codex hook with a no-op, without reading the payload, when the plugin is off', async () => {
    writeConfig('[plugins."claude-mem@claude-mem-local"]\nenabled = false\n');

    // No stdin is provided: reaching the capture pipeline would hang on it.
    for (const event of ['context', 'session-init', 'file-context', 'observation', 'summarize', 'post-compact', 'subagent-context']) {
      stdout.length = 0;
      const code = await hookCommand('codex', event, { skipExit: true });

      expect(code).toBe(HOOK_EXIT_CODES.SUCCESS);
      expect(stdout).toHaveLength(1);
      const reply = JSON.parse(stdout[0]);
      expect(reply.decision).toBeUndefined();
      expect(reply.hookSpecificOutput?.additionalContext ?? '').toBe('');
    }
  });
});
