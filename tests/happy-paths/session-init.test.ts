/**
 * Happy Path Test: Session Initialization
 *
 * Tests that when a user's first tool use occurs, the session is
 * created in the database and observations can be queued.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bashCommandScenario, sessionScenario } from '../helpers/scenarios.js';

describe('Session Initialization (UserPromptSubmit)', () => {
  const WORKER_PORT = 37777;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates session when first observation is sent', async () => {
    // This tests the happy path:
    // User types first prompt → Tool runs → Hook sends observation →
    // Worker creates session → Observation queued for SDK processing

    // Setup: Mock successful response from worker
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued', sessionId: 1 })
    });

    // Execute: Send first observation (what save-hook does)
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          tool_name: bashCommandScenario.tool_name,
          tool_input: bashCommandScenario.tool_input,
          tool_response: bashCommandScenario.tool_response,
          cwd: '/project/claude-mem'
        })
      }
    );

    // Verify: Session created and observation queued
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.status).toBe('queued');
    expect(result.sessionId).toBeDefined();

    // Verify: fetch was called with correct endpoint and data
    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining(sessionScenario.claudeSessionId)
      })
    );
  });

  it('handles missing claudeSessionId gracefully', async () => {
    // Setup: Mock error response for missing session ID
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Missing claudeSessionId' })
    });

    // Execute: Send observation without session ID
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_response: { stdout: 'file.txt' }
        })
      }
    );

    // Verify: Returns 400 error
    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.error).toContain('Missing claudeSessionId');
  });

  it('queues multiple observations for the same session', async () => {
    // Setup: Mock successful responses
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      const currentId = ++callCount;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'queued', observationId: currentId })
      };
    });

    const sessionId = sessionScenario.claudeSessionId;

    // Execute: Send multiple observations for the same session
    const obs1 = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionId,
          tool_name: 'Read',
          tool_input: { file_path: '/test.ts' },
          tool_response: { content: 'code...' }
        })
      }
    );

    const obs2 = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionId,
          tool_name: 'Edit',
          tool_input: { file_path: '/test.ts', old_string: 'old', new_string: 'new' },
          tool_response: { success: true }
        })
      }
    );

    // Verify: Both observations were queued successfully
    expect(obs1.ok).toBe(true);
    expect(obs2.ok).toBe(true);

    const result1 = await obs1.json();
    const result2 = await obs2.json();

    expect(result1.status).toBe('queued');
    expect(result2.status).toBe('queued');
    expect(result1.observationId).toBe(1);
    expect(result2.observationId).toBe(2);
  });

  it('includes project context from cwd', async () => {
    // Setup: Mock successful response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    const projectPath = '/Users/alice/projects/my-app';

    // Execute: Send observation with cwd
    await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: { stdout: 'PASS', exit_code: 0 },
          cwd: projectPath
        })
      }
    );

    // Verify: Request includes cwd
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining(projectPath)
      })
    );
  });
});
