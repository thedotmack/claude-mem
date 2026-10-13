import { describe, it, expect } from 'bun:test';
import { isSessionResumeError } from '../../../src/services/worker/knowledge/KnowledgeAgent.js';

describe('KnowledgeAgent isSessionResumeError', () => {
  it('matches the SDK error for a session the CLI cannot resume', () => {
    // Shape produced by the Agent SDK: exit error + stderr tail carrying the CLI line.
    const sdkError = new Error(
      'Claude Code process exited with code 1. stderr: No conversation found with session ID: 7f3c2a10-0000-4000-8000-000000000000'
    );
    expect(isSessionResumeError(sdkError)).toBe(true);
  });

  it('does not reprime on generic errors that merely mention sessions or "not found"', () => {
    for (const message of [
      'Claude Code process exited with code 1',
      'Claude Code executable not found at /usr/local/bin/claude',
      'Model not found',
      'session expired',
      'invalid session token',
      'Failed to resume streaming response',
      'Claude Code process aborted by user',
      'No conversation found to continue',
    ]) {
      expect(isSessionResumeError(new Error(message))).toBe(false);
    }
  });
});
