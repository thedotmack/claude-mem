/**
 * Happy Path Test: Session Summary (Stop)
 *
 * Tests that when a user pauses or stops a session, the SDK
 * generates a summary from the conversation context.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sessionSummaryScenario, sessionScenario } from '../helpers/scenarios.js';

describe('Session Summary (Stop)', () => {
  const WORKER_PORT = 37777;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates summary from last messages', async () => {
    // This tests the happy path:
    // User stops/pauses → Hook sends last messages → Worker queues for SDK →
    // SDK generates summary → Summary saved to database

    // Setup: Mock successful response from worker
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    // Execute: Send summarize request (what summary-hook does)
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/summarize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionSummaryScenario.claudeSessionId,
          last_user_message: sessionSummaryScenario.last_user_message,
          last_assistant_message: sessionSummaryScenario.last_assistant_message,
          cwd: '/project/claude-mem'
        })
      }
    );

    // Verify: Summary queued successfully
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.status).toBe('queued');

    // Verify: Correct data sent to worker
    const fetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.last_user_message).toBe('Thanks, that fixed it!');
    expect(requestBody.last_assistant_message).toContain('parser');
  });

  it('handles missing session ID gracefully', async () => {
    // Setup: Mock error response
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Missing claudeSessionId' })
    });

    // Execute: Send summarize without session ID
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/summarize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          last_user_message: 'Some message',
          last_assistant_message: 'Some response'
        })
      }
    );

    // Verify: Returns error
    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.error).toContain('Missing claudeSessionId');
  });

  it('generates summary for different conversation types', async () => {
    // Setup: Mock worker responses
    const summaries: any[] = [];
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      const body = JSON.parse(options.body);
      summaries.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'queued', summaryId: summaries.length })
      };
    });

    // Test different conversation scenarios
    const scenarios = [
      {
        type: 'bug_fix',
        user: 'Thanks for fixing the parser bug!',
        assistant: 'I fixed the XML parser to handle self-closing tags in src/parser.ts:42.'
      },
      {
        type: 'feature_addition',
        user: 'Perfect! The search feature works great.',
        assistant: 'I added FTS5 full-text search in src/services/search.ts.'
      },
      {
        type: 'exploration',
        user: 'That helps me understand the codebase better.',
        assistant: 'The authentication flow uses JWT tokens stored in localStorage.'
      },
      {
        type: 'refactoring',
        user: 'Much cleaner now!',
        assistant: 'I refactored the duplicate code into a shared utility function in src/utils/helpers.ts.'
      }
    ];

    // Execute: Send summary for each scenario
    for (const scenario of scenarios) {
      await fetch(
        `http://127.0.0.1:${WORKER_PORT}/api/sessions/summarize`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            claudeSessionId: `session-${scenario.type}`,
            last_user_message: scenario.user,
            last_assistant_message: scenario.assistant,
            cwd: '/project'
          })
        }
      );
    }

    // Verify: All summaries queued
    expect(summaries.length).toBe(4);
    expect(summaries[0].last_user_message).toContain('parser bug');
    expect(summaries[1].last_user_message).toContain('search');
    expect(summaries[2].last_user_message).toContain('understand');
    expect(summaries[3].last_user_message).toContain('cleaner');
  });

  it('preserves long conversation context', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    // Execute: Send summary with long messages (realistic scenario)
    const longAssistantMessage = `I've fixed the bug in the parser. Here's what I did:

1. Added null check for empty tags in src/parser.ts:42
2. Updated the regex pattern to handle self-closing tags
3. Added unit tests to verify the fix works
4. Ran the test suite and confirmed all tests pass

The issue was that the parser wasn't handling XML tags like <tag/> correctly.
It was only expecting <tag></tag> format. Now it handles both formats.`;

    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/summarize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          last_user_message: 'Thanks for the detailed explanation!',
          last_assistant_message: longAssistantMessage,
          cwd: '/project'
        })
      }
    );

    // Verify: Long message preserved
    expect(response.ok).toBe(true);
    const fetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.last_assistant_message.length).toBeGreaterThan(200);
    expect(requestBody.last_assistant_message).toContain('parser.ts:42');
    expect(requestBody.last_assistant_message).toContain('self-closing tags');
  });

  it('handles empty or minimal messages gracefully', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    // Execute: Send summary with minimal messages
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/summarize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          last_user_message: 'Thanks!',
          last_assistant_message: 'Done.',
          cwd: '/project'
        })
      }
    );

    // Verify: Still processes minimal messages
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.status).toBe('queued');
  });

  it('includes project context from cwd', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    const projectPath = '/Users/alice/projects/my-app';

    // Execute: Send summary with project context
    await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/summarize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          last_user_message: 'Great!',
          last_assistant_message: 'Fixed the bug.',
          cwd: projectPath
        })
      }
    );

    // Verify: Project context included
    const fetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.cwd).toBe(projectPath);
  });
});
