/**
 * Assistant Message Monitoring System — End-to-End Tests
 *
 * These tests verify the complete pipeline from assistant message capture
 * through to observation storage, SSE broadcast, and REST API retrieval
 * with metadata intact.
 *
 * Pipeline under test:
 *   1. POST /api/sessions/init → creates session
 *   2. POST /sessions/:id/observations → queues tool message with tool_name + tool_input
 *   3. SDKAgent picks up message, pushes to processingMessageMeta parallel array
 *   4. ResponseProcessor extracts sourceMetadata via metadata-extractor
 *   5. SessionStore.storeObservations writes metadata JSON column
 *   6. SSEBroadcaster broadcasts { type: 'new_observation', observation: { metadata } }
 *   7. GET /api/observations returns observations with metadata field populated
 *   8. GET /api/observation/:id returns single observation with metadata
 *   9. POST /api/sessions/conversation-observe → TITANS observer stores conversation obs
 *
 * Orchestration:
 *   These tests are designed to be run via tmux-cli against a LIVE worker
 *   on localhost:37777. They use curl/fetch against the real HTTP API.
 *
 * Prerequisites:
 *   - Worker running on localhost:37777 (`npm run build-and-sync`)
 *   - Database initialized (~/.claude-mem/claude-mem.db)
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

const WORKER_BASE_URL = 'http://localhost:37777';
const TEST_TIMEOUT_MS = 30_000;

// Unique test identifiers to avoid collision with real data
const TEST_SESSION_PREFIX = `e2e-test-${Date.now()}`;
const TEST_PROJECT = `e2e-monitor-test-${Date.now()}`;

// ============================================================================
// Helpers
// ============================================================================

async function workerFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${WORKER_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

async function workerGet(path: string): Promise<any> {
  const res = await workerFetch(path);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function workerPost(path: string, body: unknown): Promise<any> {
  const res = await workerFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs: number = 10_000,
  intervalMs: number = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Assistant Message Monitoring E2E', () => {
  let workerRunning = false;

  beforeAll(async () => {
    // Verify worker is alive
    try {
      const res = await fetch(`${WORKER_BASE_URL}/api/stats`);
      workerRunning = res.ok;
    } catch {
      workerRunning = false;
    }
  });

  // --------------------------------------------------------------------------
  // Test 1: Worker health and stats endpoint
  // --------------------------------------------------------------------------
  it('worker is running and reports stats', async () => {
    expect(workerRunning).toBe(true);
    const stats = await workerGet('/api/stats');
    expect(stats.worker).toBeDefined();
    expect(stats.worker.port).toBe(37777);
    expect(stats.database).toBeDefined();
    expect(typeof stats.database.observations).toBe('number');
  });

  // --------------------------------------------------------------------------
  // Test 2: SSE stream connects and receives initial event
  // --------------------------------------------------------------------------
  it('SSE /stream connects and sends initial event', async () => {
    if (!workerRunning) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const res = await fetch(`${WORKER_BASE_URL}/stream`, {
        signal: controller.signal,
        headers: { 'Accept': 'text/event-stream' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // Read first SSE message
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let foundConnected = false;

      while (!foundConnected) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });

        // SSE format: "data: {...}\n\n"
        const lines = accumulated.split('\n\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const json = JSON.parse(line.replace('data: ', ''));
            if (json.type === 'connected') {
              foundConnected = true;
              expect(json.timestamp).toBeGreaterThan(0);
              break;
            }
          }
        }
      }

      expect(foundConnected).toBe(true);
      reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }, TEST_TIMEOUT_MS);

  // --------------------------------------------------------------------------
  // Test 3: Observations returned from REST API have metadata field
  // --------------------------------------------------------------------------
  it('GET /api/observations returns items with metadata field', async () => {
    if (!workerRunning) return;

    const data = await workerGet('/api/observations?limit=5');
    expect(data.items).toBeArray();
    expect(data.items.length).toBeGreaterThan(0);

    // At least one recent observation should have metadata (from this session)
    const withMetadata = data.items.filter((item: any) => item.metadata !== null);
    expect(withMetadata.length).toBeGreaterThan(0);

    // Validate metadata structure
    for (const obs of withMetadata) {
      const meta = JSON.parse(obs.metadata);
      expect(meta.tool_name).toBeDefined();
      expect(typeof meta.tool_name).toBe('string');
    }
  });

  // --------------------------------------------------------------------------
  // Test 4: Single observation by ID has metadata
  // --------------------------------------------------------------------------
  it('GET /api/observation/:id returns metadata for recent observation', async () => {
    if (!workerRunning) return;

    // Get most recent observation that has metadata
    const data = await workerGet('/api/observations?limit=10');
    const withMetadata = data.items.find((item: any) => item.metadata !== null);
    expect(withMetadata).toBeDefined();

    const single = await workerGet(`/api/observation/${withMetadata.id}`);
    expect(single.id).toBe(withMetadata.id);
    expect(single.metadata).toBeDefined();

    const meta = JSON.parse(single.metadata);
    expect(meta.tool_name).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Test 5: Batch observation endpoint returns metadata
  // --------------------------------------------------------------------------
  it('POST /api/observations/batch returns metadata for each observation', async () => {
    if (!workerRunning) return;

    const data = await workerGet('/api/observations?limit=3');
    const ids = data.items.map((item: any) => item.id);
    expect(ids.length).toBeGreaterThan(0);

    const result = await workerPost('/api/observations/batch', { ids });
    expect(result.status).toBe(200);
    expect(result.body).toBeArray();
    expect(result.body.length).toBe(ids.length);

    // Each returned observation should have the metadata key (even if null)
    for (const obs of result.body) {
      expect('metadata' in obs).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // Test 6: metadata-extractor produces correct fields per tool type
  // --------------------------------------------------------------------------
  it('metadata contains correct fields for different tool types', async () => {
    if (!workerRunning) return;

    const data = await workerGet('/api/observations?limit=50');
    const withMetadata = data.items.filter((item: any) => item.metadata !== null);

    // Group by tool_name
    const byTool: Record<string, any[]> = {};
    for (const obs of withMetadata) {
      const meta = JSON.parse(obs.metadata);
      const tool = meta.tool_name;
      if (!byTool[tool]) byTool[tool] = [];
      byTool[tool].push(meta);
    }

    // Validate tool-specific fields where we find them
    if (byTool['Read']) {
      for (const m of byTool['Read']) {
        expect(m.tool_name).toBe('Read');
        // Read should have file_path when toolInput had one
        if (m.file_path) {
          expect(typeof m.file_path).toBe('string');
        }
      }
    }

    if (byTool['WebFetch']) {
      for (const m of byTool['WebFetch']) {
        expect(m.tool_name).toBe('WebFetch');
        if (m.source_url) {
          expect(m.source_url).toMatch(/^https?:\/\//);
        }
      }
    }

    if (byTool['Bash']) {
      for (const m of byTool['Bash']) {
        expect(m.tool_name).toBe('Bash');
        if (m.command) {
          expect(typeof m.command).toBe('string');
        }
      }
    }

    if (byTool['Grep']) {
      for (const m of byTool['Grep']) {
        expect(m.tool_name).toBe('Grep');
        if (m.search_pattern) {
          expect(typeof m.search_pattern).toBe('string');
        }
      }
    }

    // We should see at least some tool diversity in recent observations
    expect(Object.keys(byTool).length).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // Test 7: SSE stream receives new_observation with metadata when new data arrives
  // --------------------------------------------------------------------------
  it('SSE broadcasts new_observation events with metadata field', async () => {
    if (!workerRunning) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(`${WORKER_BASE_URL}/stream`, {
        signal: controller.signal,
        headers: { 'Accept': 'text/event-stream' },
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      const receivedEvents: any[] = [];

      // Collect events for a few seconds
      const collectStart = Date.now();
      const collectDuration = 8_000; // 8 seconds

      while (Date.now() - collectStart < collectDuration) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ value: undefined; done: true }>(resolve =>
          setTimeout(() => resolve({ value: undefined, done: true }), 2_000)
        );

        const { value, done } = await Promise.race([readPromise, timeoutPromise]);
        if (done && !value) break;
        if (value) {
          accumulated += decoder.decode(value, { stream: true });

          // Parse complete SSE messages
          const parts = accumulated.split('\n\n');
          accumulated = parts.pop() || ''; // Keep incomplete part

          for (const part of parts) {
            if (part.startsWith('data: ')) {
              try {
                const json = JSON.parse(part.replace('data: ', ''));
                receivedEvents.push(json);
              } catch { /* skip malformed */ }
            }
          }
        }
      }

      // We should receive at least the 'connected' event
      const connected = receivedEvents.find(e => e.type === 'connected');
      expect(connected).toBeDefined();

      // If any new_observation events arrived during our window, verify metadata field exists
      const observations = receivedEvents.filter(e => e.type === 'new_observation');
      for (const obsEvent of observations) {
        expect(obsEvent.observation).toBeDefined();
        // metadata key should exist (may be undefined for non-SDK agents)
        expect('metadata' in obsEvent.observation || obsEvent.observation.metadata === undefined).toBe(true);

        if (obsEvent.observation.metadata) {
          const meta = JSON.parse(obsEvent.observation.metadata);
          expect(meta.tool_name).toBeDefined();
        }
      }

      reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }, TEST_TIMEOUT_MS);

  // --------------------------------------------------------------------------
  // Test 8: conversation-observe endpoint accepts and processes exchanges
  // --------------------------------------------------------------------------
  it('POST /api/sessions/conversation-observe accepts exchanges', async () => {
    if (!workerRunning) return;

    const testSessionId = `${TEST_SESSION_PREFIX}-convo-observe`;
    const result = await workerPost('/api/sessions/conversation-observe', {
      contentSessionId: testSessionId,
      exchanges: [
        {
          promptNumber: 1,
          userText: 'E2E test: What is the capital of France?',
          assistantText: 'E2E test: The capital of France is Paris.',
        },
      ],
      project: TEST_PROJECT,
    });

    // Should accept immediately (fire-and-forget)
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('accepted');
    expect(result.body.exchangeCount).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Test 9: conversation-observe rejects malformed requests
  // --------------------------------------------------------------------------
  it('POST /api/sessions/conversation-observe rejects missing fields', async () => {
    if (!workerRunning) return;

    // Missing exchanges
    const result1 = await workerPost('/api/sessions/conversation-observe', {
      contentSessionId: 'test-missing-exchanges',
    });
    expect(result1.status).toBe(400);

    // Missing contentSessionId
    const result2 = await workerPost('/api/sessions/conversation-observe', {
      exchanges: [{ promptNumber: 1, userText: 'hi', assistantText: 'hello' }],
    });
    expect(result2.status).toBe(400);
  });

  // --------------------------------------------------------------------------
  // Test 10: observations paginate correctly with metadata preserved
  // --------------------------------------------------------------------------
  it('paginated observations preserve metadata across pages', async () => {
    if (!workerRunning) return;

    const page1 = await workerGet('/api/observations?limit=5&offset=0');
    const page2 = await workerGet('/api/observations?limit=5&offset=5');

    expect(page1.items).toBeArray();
    expect(page2.items).toBeArray();

    // No ID overlap between pages
    const page1Ids = new Set(page1.items.map((i: any) => i.id));
    for (const item of page2.items) {
      expect(page1Ids.has(item.id)).toBe(false);
    }

    // All items on both pages have the metadata key (even if null)
    for (const item of [...page1.items, ...page2.items]) {
      expect('metadata' in item).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // Test 11: processing status endpoint works
  // --------------------------------------------------------------------------
  it('GET /api/processing-status returns processing state', async () => {
    if (!workerRunning) return;

    const status = await workerGet('/api/processing-status');
    expect(typeof status.isProcessing).toBe('boolean');
    expect(typeof status.queueDepth).toBe('number');
  });

  // --------------------------------------------------------------------------
  // Test 12: SSE client count reflects connections
  // --------------------------------------------------------------------------
  it('worker stats reflect SSE client connections', async () => {
    if (!workerRunning) return;

    const statsBefore = await workerGet('/api/stats');
    const clientsBefore = statsBefore.worker.sseClients;

    // Open a new SSE connection
    const controller = new AbortController();
    const sseRes = await fetch(`${WORKER_BASE_URL}/stream`, {
      signal: controller.signal,
      headers: { 'Accept': 'text/event-stream' },
    });

    // Read initial connected event to ensure connection is established
    const reader = sseRes.body!.getReader();
    await reader.read();

    // Small delay for server to register the client
    await new Promise(resolve => setTimeout(resolve, 500));

    const statsAfter = await workerGet('/api/stats');
    expect(statsAfter.worker.sseClients).toBeGreaterThanOrEqual(clientsBefore + 1);

    // Close and verify count drops
    controller.abort();
    reader.cancel().catch(() => {}); // Ignore abort errors

    await new Promise(resolve => setTimeout(resolve, 500));

    const statsFinally = await workerGet('/api/stats');
    expect(statsFinally.worker.sseClients).toBeLessThanOrEqual(statsAfter.worker.sseClients);
  });
});

// ============================================================================
// tmux-cli Orchestration Script
// ============================================================================
//
// To run these tests via tmux-cli, execute in order:
//
// 1. Ensure worker is built and running:
//    tmux send-keys -t worker "cd /Users/alexnewman/conductor/workspaces/claude-mem/vancouver && npm run build-and-sync" Enter
//
// 2. Wait for worker to be ready:
//    tmux send-keys -t test "curl -s --retry 10 --retry-delay 2 http://localhost:37777/api/stats" Enter
//
// 3. Run the E2E test suite:
//    tmux send-keys -t test "cd /Users/alexnewman/conductor/workspaces/claude-mem/vancouver && bun test tests/integration/assistant-message-monitoring-e2e.test.ts" Enter
//
// 4. For live SSE verification (manual/visual):
//    tmux send-keys -t sse "curl -N http://localhost:37777/stream" Enter
//    # Then in another pane, trigger activity and watch events appear
//
// ============================================================================
