/**
 * Tests for context handler byte-limit truncation (#1591)
 *
 * Claude Code >= v2.1.88 truncates hook outputs > 10KB with a <persisted-output>
 * placeholder, making the context invisible. The handler must cap additionalContext
 * at 9,500 bytes to stay safely under the limit.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Mock modules before any handler imports
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
  workerHttpRequest: (apiPath: string) => {
    return globalThis.fetch(`http://127.0.0.1:37777${apiPath}`);
  },
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    projectName: 'test-project',
    allProjects: ['test-project'],
  }),
}));

mock.module('../../src/shared/platform-source.js', () => ({
  normalizePlatformSource: () => 'claude-code',
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    dataIn: () => {},
    dataOut: () => {},
  },
}));

const MAX_CONTEXT_BYTES = 9_500;
const TRUNCATION_MARKER = '[Context trimmed to 9.5KB — lower CLAUDE_MEM_CONTEXT_OBSERVATIONS';

import { contextHandler } from '../../src/cli/handlers/context.js';

describe('Context Handler - byte-limit truncation (#1591)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('passes through context that is within the 9.5KB limit unchanged', async () => {
    const smallContext = 'A'.repeat(100);

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(smallContext),
      } as Response)
    );

    const result = await contextHandler.execute({
      sessionId: 'sess-123',
      cwd: '/test',
      platform: 'claude-code',
    });

    const additionalContext = (result.hookSpecificOutput as any)?.additionalContext ?? '';
    expect(additionalContext).toBe(smallContext);
    expect(additionalContext).not.toContain(TRUNCATION_MARKER);
  });

  it('truncates context exceeding 9.5KB and appends truncation marker', async () => {
    // Build a context string that exceeds MAX_CONTEXT_BYTES
    const largeContext = 'x'.repeat(MAX_CONTEXT_BYTES + 2_000);

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(largeContext),
      } as Response)
    );

    const result = await contextHandler.execute({
      sessionId: 'sess-123',
      cwd: '/test',
      platform: 'claude-code',
    });

    const additionalContext = (result.hookSpecificOutput as any)?.additionalContext ?? '';
    expect(Buffer.byteLength(additionalContext, 'utf8')).toBeLessThanOrEqual(MAX_CONTEXT_BYTES + 200);
    expect(additionalContext).toContain(TRUNCATION_MARKER);
  });

  it('truncates at the last newline boundary to avoid splitting mid-line', async () => {
    // Build context with line breaks, exceeding the limit
    const lineA = 'A'.repeat(3_000);
    const lineB = 'B'.repeat(3_000);
    const lineC = 'C'.repeat(3_000);
    const lineD = 'D'.repeat(3_000); // This line should be cut
    const largeContext = [lineA, lineB, lineC, lineD].join('\n');

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(largeContext),
      } as Response)
    );

    const result = await contextHandler.execute({
      sessionId: 'sess-123',
      cwd: '/test',
      platform: 'claude-code',
    });

    const additionalContext = (result.hookSpecificOutput as any)?.additionalContext ?? '';
    // Must not contain lineD (cut before it)
    expect(additionalContext).not.toContain('D'.repeat(100));
    // Must contain the truncation marker
    expect(additionalContext).toContain(TRUNCATION_MARKER);
    // Must be under the limit (plus marker overhead)
    expect(Buffer.byteLength(additionalContext, 'utf8')).toBeLessThanOrEqual(MAX_CONTEXT_BYTES + 200);
  });

  it('returns empty string when worker returns a non-ok response', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve(''),
      } as Response)
    );

    const result = await contextHandler.execute({
      sessionId: 'sess-123',
      cwd: '/test',
      platform: 'claude-code',
    });

    const additionalContext = (result.hookSpecificOutput as any)?.additionalContext ?? '';
    expect(additionalContext).toBe('');
  });
});
