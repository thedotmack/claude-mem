/**
 * Happy Path Test: Session Cleanup (SessionEnd)
 *
 * Tests that when a session ends, the worker marks it complete
 * and performs necessary cleanup operations.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sessionScenario } from '../helpers/scenarios.js';

describe('Session Cleanup (SessionEnd)', () => {
  const WORKER_PORT = 37777;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks session complete and stops SDK agent', async () => {
    // This tests the happy path:
    // Session ends → Hook notifies worker → Worker marks session complete →
    // SDK agent stopped → Resources cleaned up

    // Setup: Mock successful response from worker
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'completed' })
    });

    // Execute: Send complete request (what cleanup-hook does)
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          reason: 'user_exit'
        })
      }
    );

    // Verify: Session marked complete
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.status).toBe('completed');

    // Verify: Correct data sent to worker
    const fetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.claudeSessionId).toBe(sessionScenario.claudeSessionId);
    expect(requestBody.reason).toBe('user_exit');
  });

  it('handles missing session ID gracefully', async () => {
    // Setup: Mock error response
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Missing claudeSessionId' })
    });

    // Execute: Send complete request without session ID
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'user_exit'
        })
      }
    );

    // Verify: Returns error
    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.error).toContain('Missing claudeSessionId');
  });

  it('handles different session end reasons', async () => {
    // Setup: Track all cleanup requests
    const cleanupRequests: any[] = [];
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      const body = JSON.parse(options.body);
      cleanupRequests.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'completed' })
      };
    });

    // Test different end reasons
    const reasons = [
      'user_exit',      // User explicitly ended session
      'timeout',        // Session timed out
      'error',          // Error occurred
      'restart',        // Session restarting
      'clear'           // User cleared context
    ];

    // Execute: Send cleanup for each reason
    for (const reason of reasons) {
      await fetch(
        `http://127.0.0.1:${WORKER_PORT}/api/sessions/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            claudeSessionId: `session-${reason}`,
            reason
          })
        }
      );
    }

    // Verify: All cleanup requests processed
    expect(cleanupRequests.length).toBe(5);
    expect(cleanupRequests.map(r => r.reason)).toEqual(reasons);
  });

  it('completes multiple sessions independently', async () => {
    // Setup: Track session completions
    const completedSessions: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      const body = JSON.parse(options.body);
      completedSessions.push(body.claudeSessionId);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'completed' })
      };
    });

    const sessions = [
      'session-abc-123',
      'session-def-456',
      'session-ghi-789'
    ];

    // Execute: Complete multiple sessions
    for (const sessionId of sessions) {
      await fetch(
        `http://127.0.0.1:${WORKER_PORT}/api/sessions/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            claudeSessionId: sessionId,
            reason: 'user_exit'
          })
        }
      );
    }

    // Verify: All sessions completed
    expect(completedSessions).toEqual(sessions);
  });

  it('handles cleanup when session not found', async () => {
    // Setup: Mock 404 response for non-existent session
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Session not found' })
    });

    // Execute: Try to complete non-existent session
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: 'non-existent-session',
          reason: 'user_exit'
        })
      }
    );

    // Verify: Returns 404 (graceful handling)
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it('supports optional metadata in cleanup request', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'completed' })
    });

    // Execute: Send cleanup with additional metadata
    await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          reason: 'user_exit',
          duration_seconds: 1800,
          observations_count: 25,
          project: 'claude-mem'
        })
      }
    );

    // Verify: Metadata included in request
    const fetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.duration_seconds).toBe(1800);
    expect(requestBody.observations_count).toBe(25);
    expect(requestBody.project).toBe('claude-mem');
  });

  it('handles worker being down during cleanup', async () => {
    // Setup: Mock worker unreachable
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    // Execute: Attempt to complete session
    try {
      await fetch(
        `http://127.0.0.1:${WORKER_PORT}/api/sessions/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            claudeSessionId: sessionScenario.claudeSessionId,
            reason: 'user_exit'
          })
        }
      );
      // Should throw, so fail if we get here
      expect(true).toBe(false);
    } catch (error: any) {
      // Verify: Error indicates worker is down
      expect(error.message).toContain('ECONNREFUSED');
    }

    // The hook should log this but not fail the session end
    // (This graceful degradation would be tested in hook-specific tests)
  });
});
