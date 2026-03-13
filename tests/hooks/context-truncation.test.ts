/**
 * Tests for Context Truncation (#1269)
 *
 * Validates:
 * - Context under 50KB is returned unchanged
 * - Context over 50KB is truncated with a helpful message
 * - Truncation happens before hookSpecificOutput is returned
 * - Empty/small contexts are unaffected
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Mock modules that cause import chain issues - MUST be before handler imports
mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({
      CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false',
      CLAUDE_MEM_EXCLUDED_PROJECTS: [],
    }),
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
  getProjectContext: () => ({
    primary: 'test-project',
    parent: null,
    isWorktree: false,
    allProjects: ['test-project'],
  }),
}));

import { logger } from '../../src/utils/logger.js';

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

describe('Context Truncation (#1269)', () => {
  describe('context under 50KB', () => {
    it('should return small context unchanged', async () => {
      const smallContext = 'This is a small context string.';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock((url: string | URL | Request) => {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(smallContext),
        });
      }) as any;

      try {
        const { contextHandler } = await import('../../src/cli/handlers/context.js');

        const result = await contextHandler.execute({
          sessionId: 'test-session',
          cwd: '/test/project',
        });

        expect(result.hookSpecificOutput).toBeDefined();
        expect(result.hookSpecificOutput!.additionalContext).toBe(smallContext);
        expect(result.hookSpecificOutput!.hookEventName).toBe('SessionStart');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should return empty context unchanged', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(() => {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(''),
        });
      }) as any;

      try {
        const { contextHandler } = await import('../../src/cli/handlers/context.js');

        const result = await contextHandler.execute({
          sessionId: 'test-session',
          cwd: '/test/project',
        });

        expect(result.hookSpecificOutput).toBeDefined();
        expect(result.hookSpecificOutput!.additionalContext).toBe('');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should return context at exactly 50000 chars unchanged', async () => {
      const exactLimitContext = 'x'.repeat(50_000);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(() => {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(exactLimitContext),
        });
      }) as any;

      try {
        const { contextHandler } = await import('../../src/cli/handlers/context.js');

        const result = await contextHandler.execute({
          sessionId: 'test-session',
          cwd: '/test/project',
        });

        expect(result.hookSpecificOutput).toBeDefined();
        expect(result.hookSpecificOutput!.additionalContext).toBe(exactLimitContext);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('context over 50KB', () => {
    it('should truncate context exceeding 50KB and append truncation message', async () => {
      const largeContext = 'A'.repeat(60_000);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(() => {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(largeContext),
        });
      }) as any;

      try {
        const { contextHandler } = await import('../../src/cli/handlers/context.js');

        const result = await contextHandler.execute({
          sessionId: 'test-session',
          cwd: '/test/project',
        });

        expect(result.hookSpecificOutput).toBeDefined();
        const ctx = result.hookSpecificOutput!.additionalContext;

        // Should start with the first 50000 chars of the original
        expect(ctx.startsWith('A'.repeat(50_000))).toBe(true);

        // Should contain the truncation message
        expect(ctx).toContain('[Context truncated');
        expect(ctx).toContain('50KB limit');
        expect(ctx).toContain('mem-search');

        // Should be shorter than the original (50000 + truncation message)
        expect(ctx.length).toBeLessThan(largeContext.length);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should log a warning when truncating', async () => {
      const largeContext = 'B'.repeat(75_000);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(() => {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(largeContext),
        });
      }) as any;

      try {
        const { contextHandler } = await import('../../src/cli/handlers/context.js');

        await contextHandler.execute({
          sessionId: 'test-session',
          cwd: '/test/project',
        });

        // logger.warn should have been called with truncation info
        const warnSpy = loggerSpies.find(s => s.getMockName?.() === 'warn') ?? loggerSpies[2];
        expect(warnSpy).toHaveBeenCalled();

        const warnCalls = warnSpy.mock.calls;
        const truncationCall = warnCalls.find(
          (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('50KB')
        );
        expect(truncationCall).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should truncate 100KB+ context correctly', async () => {
      const hugeContext = 'C'.repeat(100_000);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(() => {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(hugeContext),
        });
      }) as any;

      try {
        const { contextHandler } = await import('../../src/cli/handlers/context.js');

        const result = await contextHandler.execute({
          sessionId: 'test-session',
          cwd: '/test/project',
        });

        const ctx = result.hookSpecificOutput!.additionalContext;
        // The truncated content should be ~50KB + truncation message (~70 chars)
        expect(ctx.length).toBeLessThan(50_200);
        expect(ctx.length).toBeGreaterThan(50_000);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('observation handler does not return hookSpecificOutput', () => {
    it('should confirm observation handler returns no hookSpecificOutput', async () => {
      // Verify that the observation handler does not contribute to saved_hook_context bloat
      const observationSource = await Bun.file(
        new URL('../../src/cli/handlers/observation.ts', import.meta.url).pathname
      ).text();

      // observation handler should NOT return hookSpecificOutput
      expect(observationSource).not.toContain('hookSpecificOutput');
    });
  });
});
