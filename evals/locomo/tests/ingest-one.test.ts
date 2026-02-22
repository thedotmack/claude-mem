import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { WorkerClient } from "../src/ingestion/worker-client";
import {
  generateContentSessionId,
  generateProjectName,
  formatSessionAsToolExecution,
} from "../src/ingestion/adapter";
import {
  loadDataset,
  getSessionsForConversation,
} from "../src/dataset-loader";

// ---------------------------------------------------------------------------
// Mock auth token
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "a".repeat(64);
const originalReadFileSync = require("fs").readFileSync;
const mockReadFileSync = mock((...args: unknown[]) => {
  const filePath = args[0] as string;
  if (filePath.includes(".auth-token")) {
    return FAKE_TOKEN;
  }
  return originalReadFileSync(...args);
});
require("fs").readFileSync = mockReadFileSync;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof mock>;
let fetchCallLog: Array<{ url: string; init?: RequestInit }>;

function mockFetchSequence(responses: Array<{ body: unknown; status?: number }>): void {
  let callIndex = 0;
  fetchCallLog = [];
  fetchMock = mock((url: string, init?: RequestInit) => {
    fetchCallLog.push({ url, init });
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve(
      new Response(JSON.stringify(resp.body), {
        status: resp.status ?? 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });
  globalThis.fetch = fetchMock as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingest-one orchestration", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generates correct IDs for first conversation", () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const sessions = getSessionsForConversation(sample);

    const projectName = generateProjectName(sample.sample_id);
    expect(projectName).toStartWith("locomo-eval-");
    expect(projectName).toContain(sample.sample_id);

    const contentSessionId = generateContentSessionId(
      sample.sample_id,
      sessions[0].session_id
    );
    expect(contentSessionId).toStartWith("locomo-");
    expect(contentSessionId).toContain(`s${sessions[0].session_id}`);
  });

  it("formats first session as tool execution with correct structure", () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const sessions = getSessionsForConversation(sample);

    const toolExec = formatSessionAsToolExecution(sample, sessions[0]);

    expect(toolExec.toolName).toBe("Read");
    expect(JSON.parse(toolExec.toolInput)).toHaveProperty("file_path");
    expect(toolExec.toolResponse).toContain("[Session");
    expect(toolExec.userPrompt).toContain("Conversation between");
  });

  it("processes a single session through the full worker client lifecycle", async () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const sessions = getSessionsForConversation(sample);
    const session = sessions[0];
    const projectName = generateProjectName(sample.sample_id);
    const contentSessionId = generateContentSessionId(
      sample.sample_id,
      session.session_id
    );
    const toolExec = formatSessionAsToolExecution(sample, session);

    // Mock sequence: initSession, queueObservation, getSessionStatus (queue empty), completeSession
    mockFetchSequence([
      { body: { sessionDbId: 1, promptNumber: 1, skipped: false } },
      { body: { status: "queued" } },
      { body: { status: "active", sessionDbId: 1, queueLength: 0 } },
      { body: { status: "completed" } },
    ]);

    const client = new WorkerClient("http://localhost:37777");

    // Run the same lifecycle the script does
    await client.initSession(contentSessionId, projectName, toolExec.userPrompt);
    await client.queueObservation(
      contentSessionId,
      toolExec.toolName,
      toolExec.toolInput,
      toolExec.toolResponse
    );
    await client.waitForProcessing(contentSessionId, 5000, 100);
    await client.completeSession(contentSessionId);

    // Verify the call sequence
    expect(fetchCallLog).toHaveLength(4);
    expect(fetchCallLog[0].url).toContain("/api/sessions/init");
    expect(fetchCallLog[1].url).toContain("/api/sessions/observations");
    expect(fetchCallLog[2].url).toContain("/sessions/1/status");
    expect(fetchCallLog[3].url).toContain("/api/sessions/complete");

    // Verify initSession body
    const initBody = JSON.parse(fetchCallLog[0].init!.body as string);
    expect(initBody.contentSessionId).toBe(contentSessionId);
    expect(initBody.project).toBe(projectName);

    // Verify observation body includes dialog transcript
    const obsBody = JSON.parse(fetchCallLog[1].init!.body as string);
    expect(obsBody.tool_name).toBe("Read");
    expect(obsBody.tool_response).toContain("[Session");
  });

  it("handles health check failure gracefully", async () => {
    // Simulate connection refused on health check
    const originalFetchFn = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("fetch failed"))
    ) as typeof fetch;

    let healthy: boolean;
    try {
      const response = await fetch("http://localhost:37777/api/health");
      healthy = response.ok;
    } catch {
      healthy = false;
    }

    expect(healthy).toBe(false);
    globalThis.fetch = originalFetchFn;
  });

  it("handles multiple sessions in sequence with polling", async () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const sessions = getSessionsForConversation(sample).slice(0, 2);

    // For 2 sessions: each needs init, queue, status poll, complete = 4 calls each = 8 total
    mockFetchSequence([
      // Session 1
      { body: { sessionDbId: 1, promptNumber: 1, skipped: false } },
      { body: { status: "queued" } },
      { body: { status: "active", sessionDbId: 1, queueLength: 1 } }, // still processing
      { body: { status: "active", sessionDbId: 1, queueLength: 0 } }, // done
      { body: { status: "completed" } },
      // Session 2
      { body: { sessionDbId: 2, promptNumber: 1, skipped: false } },
      { body: { status: "queued" } },
      { body: { status: "active", sessionDbId: 2, queueLength: 0 } }, // done immediately
      { body: { status: "completed" } },
    ]);

    const client = new WorkerClient("http://localhost:37777");

    for (const session of sessions) {
      const contentSessionId = generateContentSessionId(
        sample.sample_id,
        session.session_id
      );
      const projectName = generateProjectName(sample.sample_id);
      const toolExec = formatSessionAsToolExecution(sample, session);

      await client.initSession(contentSessionId, projectName, toolExec.userPrompt);
      await client.queueObservation(
        contentSessionId,
        toolExec.toolName,
        toolExec.toolInput,
        toolExec.toolResponse
      );
      await client.waitForProcessing(contentSessionId, 5000, 50);
      await client.completeSession(contentSessionId);
    }

    // Session 1 had an extra poll (queueLength: 1 → 0), so 5 calls
    // Session 2 had 4 calls
    expect(fetchCallLog).toHaveLength(9);
  });
});
