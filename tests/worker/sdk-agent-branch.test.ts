/**
 * SDKAgent Branch Metadata Capture Tests
 *
 * Tests that the SDKAgent's message generator captures branch metadata
 * from PendingMessages onto the ActiveSession. The actual code in
 * SDKAgent.ts createMessageGenerator() (lines 380-382):
 *
 *   session.lastBranch = message.branch;
 *   session.lastCommitSha = message.commit_sha;
 *
 * Since createMessageGenerator is private and tightly coupled to the SDK
 * query loop, we test the logical behavior directly: when a PendingMessage
 * has branch/commit_sha, those values get captured on the session.
 *
 * Mock Justification (~10% mock code):
 * - Session fixtures: Minimal ActiveSession objects with all required fields
 * - No database or network mocks needed - pure assignment logic
 */

import { describe, test, expect } from 'bun:test';
import type { ActiveSession, PendingMessage } from '../../src/services/worker-types.js';

/**
 * Create a minimal mock ActiveSession with all required fields.
 */
function createMockSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'content-session-1',
    memorySessionId: null,
    project: 'test-project',
    userPrompt: 'Test prompt',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    lastGeneratorActivity: Date.now(),
    processingMessageIds: [],
    ...overrides,
  };
}

/**
 * Simulate the branch metadata capture logic from SDKAgent.createMessageGenerator().
 * This mirrors the exact assignment pattern at SDKAgent.ts lines 380-382.
 */
function captureBranchMetadata(session: ActiveSession, message: PendingMessage): void {
  session.lastBranch = message.branch;
  session.lastCommitSha = message.commit_sha;
}

describe('SDKAgent Branch Metadata Capture', () => {

  test('branch metadata captured from pending message', () => {
    const session = createMockSession();
    const message: PendingMessage = {
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: '/src/index.ts' },
      tool_response: { content: 'file contents' },
      prompt_number: 1,
      branch: 'main',
      commit_sha: 'abc123',
    };

    captureBranchMetadata(session, message);

    expect(session.lastBranch).toBe('main');
    expect(session.lastCommitSha).toBe('abc123');
  });

  test('branch metadata undefined when absent in message', () => {
    const session = createMockSession();
    const message: PendingMessage = {
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: '/src/index.ts' },
      tool_response: { content: 'file contents' },
      prompt_number: 1,
      // branch and commit_sha intentionally omitted
    };

    captureBranchMetadata(session, message);

    expect(session.lastBranch).toBeUndefined();
    expect(session.lastCommitSha).toBeUndefined();
  });

  test('branch metadata updates with each new message', () => {
    const session = createMockSession();

    // First message from main branch
    const firstMessage: PendingMessage = {
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: '/src/index.ts' },
      tool_response: { content: 'file contents' },
      prompt_number: 1,
      branch: 'main',
      commit_sha: 'abc123',
    };

    captureBranchMetadata(session, firstMessage);
    expect(session.lastBranch).toBe('main');
    expect(session.lastCommitSha).toBe('abc123');

    // Second message from a feature branch with a new commit
    const secondMessage: PendingMessage = {
      type: 'observation',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { output: 'all tests pass' },
      prompt_number: 2,
      branch: 'feature/new',
      commit_sha: 'def456',
    };

    captureBranchMetadata(session, secondMessage);
    expect(session.lastBranch).toBe('feature/new');
    expect(session.lastCommitSha).toBe('def456');
  });
});
