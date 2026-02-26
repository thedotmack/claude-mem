/**
 * Tests for Hook Layer Branch Detection
 *
 * Validates that hookCommand correctly integrates detectCurrentBranch
 * to populate input.branch and input.commitSha before passing to the event handler.
 *
 * Scenarios:
 * - Normal branch with commit SHA
 * - Detached HEAD (null branch, valid commitSha)
 * - Non-git directory (both null)
 */
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { NormalizedHookInput } from '../src/cli/types.js';

// --- Mocks (MUST be before imports of mocked modules) ---

// Track what detectCurrentBranch returns
let mockBranchResult = { branch: null as string | null, commitSha: null as string | null };

mock.module('../src/services/integrations/git-branch.js', () => ({
  detectCurrentBranch: async (_cwd: string) => mockBranchResult,
}));

// Mock stdin reader to provide controlled JSON input
let mockStdinResult: unknown = {};

mock.module('../src/cli/stdin-reader.js', () => ({
  readJsonFromStdin: async () => mockStdinResult,
}));

// Capture the input passed to the event handler
let capturedHandlerInput: NormalizedHookInput | null = null;

mock.module('../src/cli/handlers/index.js', () => ({
  getEventHandler: (_eventType: string) => ({
    execute: async (input: NormalizedHookInput) => {
      capturedHandlerInput = { ...input };
      return { continue: true, suppressOutput: true, exitCode: 0 };
    },
  }),
}));

// Mock logger to suppress log output during tests
mock.module('../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
  },
}));

// --- Import after mocks ---
import { hookCommand } from '../src/cli/hook-command.js';

// Suppress console.log output from hookCommand (it JSON.stringify's the output)
let consoleLogSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  capturedHandlerInput = null;
  mockBranchResult = { branch: null, commitSha: null };
  mockStdinResult = {};
  consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
});

describe('hookCommand branch detection integration', () => {
  it('hook populates branch and commitSha from cwd', async () => {
    mockBranchResult = { branch: 'feature/test', commitSha: 'abc123' };
    mockStdinResult = { session_id: 'test-session', cwd: '/tmp/project' };

    await hookCommand('claude-code', 'observation', { skipExit: true });

    expect(capturedHandlerInput).not.toBeNull();
    expect(capturedHandlerInput!.branch).toBe('feature/test');
    expect(capturedHandlerInput!.commitSha).toBe('abc123');
  });

  it('hook handles null branch (detached HEAD)', async () => {
    mockBranchResult = { branch: null, commitSha: 'abc123' };
    mockStdinResult = { session_id: 'test-session', cwd: '/tmp/project' };

    await hookCommand('claude-code', 'observation', { skipExit: true });

    expect(capturedHandlerInput).not.toBeNull();
    expect(capturedHandlerInput!.branch).toBeUndefined();
    expect(capturedHandlerInput!.commitSha).toBe('abc123');
  });

  it('hook handles non-git directory', async () => {
    mockBranchResult = { branch: null, commitSha: null };
    mockStdinResult = { session_id: 'test-session', cwd: '/tmp/not-a-repo' };

    await hookCommand('claude-code', 'observation', { skipExit: true });

    expect(capturedHandlerInput).not.toBeNull();
    expect(capturedHandlerInput!.branch).toBeUndefined();
    expect(capturedHandlerInput!.commitSha).toBeUndefined();
  });
});
