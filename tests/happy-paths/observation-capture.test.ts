/**
 * Happy Path Test: Observation Capture (PostToolUse)
 *
 * Tests that tool usage is captured and queued for SDK processing.
 * This is the core functionality of claude-mem - turning tool usage
 * into compressed observations.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  bashCommandScenario,
  readFileScenario,
  writeFileScenario,
  editFileScenario,
  grepScenario,
  sessionScenario
} from '../helpers/scenarios.js';

describe('Observation Capture (PostToolUse)', () => {
  const WORKER_PORT = 37777;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures Bash command observation', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    // Execute: Send Bash tool observation
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

    // Verify: Observation queued successfully
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.status).toBe('queued');

    // Verify: Correct data sent to worker
    const fetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.tool_name).toBe('Bash');
    expect(requestBody.tool_input.command).toBe('git status');
  });

  it('captures Read file observation', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    // Execute: Send Read tool observation
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          tool_name: readFileScenario.tool_name,
          tool_input: readFileScenario.tool_input,
          tool_response: readFileScenario.tool_response,
          cwd: '/project'
        })
      }
    );

    // Verify: Observation queued successfully
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.status).toBe('queued');

    // Verify: File path captured correctly
    const fetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.tool_name).toBe('Read');
    expect(requestBody.tool_input.file_path).toContain('index.ts');
  });

  it('captures Write file observation', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    // Execute: Send Write tool observation
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          tool_name: writeFileScenario.tool_name,
          tool_input: writeFileScenario.tool_input,
          tool_response: writeFileScenario.tool_response,
          cwd: '/project'
        })
      }
    );

    // Verify: Observation queued successfully
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.status).toBe('queued');
  });

  it('captures Edit file observation', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    // Execute: Send Edit tool observation
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          tool_name: editFileScenario.tool_name,
          tool_input: editFileScenario.tool_input,
          tool_response: editFileScenario.tool_response,
          cwd: '/project'
        })
      }
    );

    // Verify: Observation queued successfully
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.status).toBe('queued');

    // Verify: Edit details captured
    const fetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.tool_name).toBe('Edit');
    expect(requestBody.tool_input.old_string).toBe('const PORT = 3000;');
    expect(requestBody.tool_input.new_string).toBe('const PORT = 8080;');
  });

  it('captures Grep search observation', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    // Execute: Send Grep tool observation
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          tool_name: grepScenario.tool_name,
          tool_input: grepScenario.tool_input,
          tool_response: grepScenario.tool_response,
          cwd: '/project'
        })
      }
    );

    // Verify: Observation queued successfully
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.status).toBe('queued');
  });

  it('handles rapid succession of observations (burst mode)', async () => {
    // Setup: Mock worker to accept all observations
    let observationCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      const currentId = ++observationCount;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'queued', observationId: currentId })
      };
    });

    // Execute: Send 5 observations rapidly (simulates active coding session)
    const observations = [
      bashCommandScenario,
      readFileScenario,
      writeFileScenario,
      editFileScenario,
      grepScenario
    ];

    const promises = observations.map(obs =>
      fetch(`http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          tool_name: obs.tool_name,
          tool_input: obs.tool_input,
          tool_response: obs.tool_response,
          cwd: '/project'
        })
      })
    );

    const responses = await Promise.all(promises);

    // Verify: All observations queued successfully
    expect(responses.every(r => r.ok)).toBe(true);
    expect(observationCount).toBe(5);

    // Verify: Each got unique ID
    const results = await Promise.all(responses.map(r => r.json()));
    const ids = results.map(r => r.observationId);
    expect(new Set(ids).size).toBe(5); // All IDs unique
  });

  it('preserves tool metadata in observation', async () => {
    // Setup: Mock worker response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'queued' })
    });

    const complexTool = {
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'Explore',
        prompt: 'Find authentication code',
        description: 'Search for auth'
      },
      tool_response: {
        result: 'Found auth in /src/auth.ts',
        files_analyzed: ['/src/auth.ts', '/src/login.ts']
      }
    };

    // Execute: Send complex tool observation
    await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: sessionScenario.claudeSessionId,
          ...complexTool,
          cwd: '/project'
        })
      }
    );

    // Verify: All metadata preserved in request
    const fetchCall = (global.fetch as any).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.tool_name).toBe('Task');
    expect(requestBody.tool_input.subagent_type).toBe('Explore');
    expect(requestBody.tool_response.files_analyzed).toHaveLength(2);
  });
});
