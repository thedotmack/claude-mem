import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  HOOK_TIMEOUTS,
  defaultSessionInitRequestTimeoutMs,
  getTimeout,
  isToolHookDisabledByEnv,
  isSummarizeDisabledByEnv,
} from '../src/shared/hook-constants.js';

describe('session-init budget vs the UserPromptSubmit host timeout', () => {
  it('SESSION_INIT_HOOK_CAP is the timeout hooks.json gives UserPromptSubmit', () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, '..', 'plugin', 'hooks', 'hooks.json'), 'utf-8'));
    const timeoutsSeconds = hooks.hooks.UserPromptSubmit.flatMap(
      (entry: { hooks: Array<{ timeout: number }> }) => entry.hooks.map((hook) => hook.timeout),
    );
    expect(timeoutsSeconds.map((seconds: number) => seconds * 1000)).toEqual([HOOK_TIMEOUTS.SESSION_INIT_HOOK_CAP]);
  });

  it('leaves Windows its 4-5 s of hook start-up plus an exit margin under the cap', () => {
    // The budget's clock starts inside the handler, after bash, node and the
    // worker bundle load. On Windows that start-up takes 4-5 s, so the old
    // 10 s default could end the hook past the 15 s cap.
    const windowsBudget = defaultSessionInitRequestTimeoutMs('win32');
    expect(windowsBudget + 5_000 + 2_000).toBeLessThanOrEqual(HOOK_TIMEOUTS.SESSION_INIT_HOOK_CAP);
    expect(windowsBudget).toBeGreaterThanOrEqual(5_000);
    expect(defaultSessionInitRequestTimeoutMs('darwin')).toBe(HOOK_TIMEOUTS.SESSION_INIT_REQUEST);
    expect(defaultSessionInitRequestTimeoutMs('linux')).toBe(HOOK_TIMEOUTS.SESSION_INIT_REQUEST);
  });

  it('caps user overrides below the host timeout', () => {
    expect(HOOK_TIMEOUTS.SESSION_INIT_REQUEST_MAX).toBeLessThan(HOOK_TIMEOUTS.SESSION_INIT_HOOK_CAP);
  });
});

describe('hook-constants', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
  });

  it.each([
    ['darwin', 1000, 1000],
    ['darwin', 5000, 5000],
    ['win32', 1000, 1500],
    ['win32', 2000, 3000],
    ['win32', 333, 500],
    ['linux', 1000, 1000],
  ])('getTimeout on %s maps %i to %i', (platform, base, expected) => {
    Object.defineProperty(process, 'platform', {
      value: platform,
      writable: true,
      configurable: true,
    });
    expect(getTimeout(base)).toBe(expected);
  });

  describe('isToolHookDisabledByEnv (#3106)', () => {
    it('is off by default for tool and non-tool events', () => {
      const env = {};
      expect(isToolHookDisabledByEnv('observation', env)).toBe(false);
      expect(isToolHookDisabledByEnv('file-context', env)).toBe(false);
      expect(isToolHookDisabledByEnv('context', env)).toBe(false);
      expect(isToolHookDisabledByEnv('session-init', env)).toBe(false);
      expect(isToolHookDisabledByEnv('summarize', env)).toBe(false);
    });

    it('CLAUDE_MEM_DISABLE_TOOL_HOOKS=1 disables observation and file-context only', () => {
      const env = { CLAUDE_MEM_DISABLE_TOOL_HOOKS: '1' };
      expect(isToolHookDisabledByEnv('observation', env)).toBe(true);
      expect(isToolHookDisabledByEnv('file-context', env)).toBe(true);
      expect(isToolHookDisabledByEnv('context', env)).toBe(false);
      expect(isToolHookDisabledByEnv('session-init', env)).toBe(false);
      expect(isToolHookDisabledByEnv('summarize', env)).toBe(false);
      expect(isToolHookDisabledByEnv('user-message', env)).toBe(false);
    });

    it('ignores non-1 values for the coarse flag', () => {
      expect(isToolHookDisabledByEnv('observation', { CLAUDE_MEM_DISABLE_TOOL_HOOKS: 'true' })).toBe(false);
      expect(isToolHookDisabledByEnv('observation', { CLAUDE_MEM_DISABLE_TOOL_HOOKS: '0' })).toBe(false);
    });

    it('supports granular observation / file-context flags', () => {
      expect(isToolHookDisabledByEnv('observation', { CLAUDE_MEM_DISABLE_OBSERVATION: '1' })).toBe(true);
      expect(isToolHookDisabledByEnv('file-context', { CLAUDE_MEM_DISABLE_OBSERVATION: '1' })).toBe(false);
      expect(isToolHookDisabledByEnv('file-context', { CLAUDE_MEM_DISABLE_FILE_CONTEXT: '1' })).toBe(true);
      expect(isToolHookDisabledByEnv('observation', { CLAUDE_MEM_DISABLE_FILE_CONTEXT: '1' })).toBe(false);
    });
  });

  describe('isSummarizeDisabledByEnv (#4734)', () => {
    it('is off by default for every event', () => {
      const env = {};
      expect(isSummarizeDisabledByEnv('summarize', env)).toBe(false);
      expect(isSummarizeDisabledByEnv('context', env)).toBe(false);
      expect(isSummarizeDisabledByEnv('session-init', env)).toBe(false);
      expect(isSummarizeDisabledByEnv('observation', env)).toBe(false);
      expect(isSummarizeDisabledByEnv('file-context', env)).toBe(false);
      expect(isSummarizeDisabledByEnv('session-end', env)).toBe(false);
    });

    it('CLAUDE_MEM_DISABLE_SUMMARY=1 disables summarize only', () => {
      const env = { CLAUDE_MEM_DISABLE_SUMMARY: '1' };
      expect(isSummarizeDisabledByEnv('summarize', env)).toBe(true);
      // The reads stay on: SessionStart context and UserPromptSubmit session-init
      // are the point of keeping claude-mem enabled for headless runs.
      expect(isSummarizeDisabledByEnv('context', env)).toBe(false);
      expect(isSummarizeDisabledByEnv('session-init', env)).toBe(false);
      expect(isSummarizeDisabledByEnv('observation', env)).toBe(false);
      expect(isSummarizeDisabledByEnv('file-context', env)).toBe(false);
      expect(isSummarizeDisabledByEnv('session-end', env)).toBe(false);
    });

    it('keeps the switches separate: the tool-hook flags never stop the summary', () => {
      expect(isSummarizeDisabledByEnv('summarize', { CLAUDE_MEM_DISABLE_TOOL_HOOKS: '1' })).toBe(false);
      expect(isSummarizeDisabledByEnv('summarize', { CLAUDE_MEM_DISABLE_OBSERVATION: '1' })).toBe(false);
      expect(isSummarizeDisabledByEnv('summarize', { CLAUDE_MEM_DISABLE_FILE_CONTEXT: '1' })).toBe(false);
    });

    it('ignores non-1 values', () => {
      expect(isSummarizeDisabledByEnv('summarize', { CLAUDE_MEM_DISABLE_SUMMARY: 'true' })).toBe(false);
      expect(isSummarizeDisabledByEnv('summarize', { CLAUDE_MEM_DISABLE_SUMMARY: '0' })).toBe(false);
      expect(isSummarizeDisabledByEnv('summarize', { CLAUDE_MEM_DISABLE_SUMMARY: '' })).toBe(false);
    });
  });
});
