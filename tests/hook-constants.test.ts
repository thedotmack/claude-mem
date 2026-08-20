import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  HOOK_TIMEOUTS,
  HOOK_EXIT_CODES,
  getTimeout,
  isToolHookDisabledByEnv,
} from '../src/shared/hook-constants.js';

describe('hook-constants', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
  });

  describe('HOOK_TIMEOUTS', () => {
    it('should define HEALTH_CHECK timeout as 3s (reduced from 30s)', () => {
      expect(HOOK_TIMEOUTS.HEALTH_CHECK).toBe(3000);
    });

    it('should define POST_SPAWN_WAIT as 15s', () => {
      expect(HOOK_TIMEOUTS.POST_SPAWN_WAIT).toBe(15000);
    });

    it('should define PORT_IN_USE_WAIT as 3s', () => {
      expect(HOOK_TIMEOUTS.PORT_IN_USE_WAIT).toBe(3000);
    });

    it('should define WINDOWS_MULTIPLIER', () => {
      expect(HOOK_TIMEOUTS.WINDOWS_MULTIPLIER).toBe(1.5);
    });

    it('should define POWERSHELL_COMMAND timeout as 10000ms', () => {
      expect(HOOK_TIMEOUTS.POWERSHELL_COMMAND).toBe(10000);
    });
  });

  describe('HOOK_EXIT_CODES', () => {
    it('should define SUCCESS exit code', () => {
      expect(HOOK_EXIT_CODES.SUCCESS).toBe(0);
    });

    it('should define BLOCKING_ERROR exit code', () => {
      expect(HOOK_EXIT_CODES.BLOCKING_ERROR).toBe(2);
    });
  });

  describe('getTimeout', () => {
    it('should return base timeout on non-Windows platforms', () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
        configurable: true
      });

      expect(getTimeout(1000)).toBe(1000);
      expect(getTimeout(5000)).toBe(5000);
    });

    it('should apply Windows multiplier on Windows platform', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      expect(getTimeout(1000)).toBe(1500);
      expect(getTimeout(2000)).toBe(3000);
    });

    it('should round Windows timeout to nearest integer', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      expect(getTimeout(333)).toBe(500);
    });

    it('should return base timeout on Linux', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        writable: true,
        configurable: true
      });

      expect(getTimeout(1000)).toBe(1000);
    });
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
});
