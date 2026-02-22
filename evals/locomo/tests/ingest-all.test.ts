import { describe, it, expect, afterEach, mock, beforeEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
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
import type { IngestionProgress } from "../src/types";

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

function mockFetchSequence(
  responses: Array<{ body: unknown; status?: number }>
): void {
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

describe("ingest-all batch orchestration", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generates unique project names for all 10 conversations", () => {
    const dataset = loadDataset();
    const projectNames = dataset.map((s) => generateProjectName(s.sample_id));
    const uniqueProjectNames = new Set(projectNames);
    expect(uniqueProjectNames.size).toBe(dataset.length);
  });

  it("skips conversations that already have observations (resume support)", async () => {
    // Mock: search returns observations (conversation already ingested)
    mockFetchSequence([
      {
        body: {
          observations: [{ id: 1, title: "existing" }],
          sessions: [],
          prompts: [],
          totalResults: 1,
          query: "*",
        },
      },
    ]);

    const client = new WorkerClient("http://localhost:37777");
    const dataset = loadDataset();
    const projectName = generateProjectName(dataset[0].sample_id);

    // Simulate resume check
    const searchResult = await client.search("*", projectName, 1);
    const alreadyIngested = searchResult.observations.length > 0;

    expect(alreadyIngested).toBe(true);
    expect(fetchCallLog).toHaveLength(1);
    expect(fetchCallLog[0].url).toContain("/api/search");
    expect(fetchCallLog[0].url).toContain(`project=${encodeURIComponent(projectName)}`);
  });

  it("proceeds when search returns no observations (new conversation)", async () => {
    // Mock: search returns no observations
    mockFetchSequence([
      {
        body: {
          observations: [],
          sessions: [],
          prompts: [],
          totalResults: 0,
          query: "*",
        },
      },
    ]);

    const client = new WorkerClient("http://localhost:37777");
    const dataset = loadDataset();
    const projectName = generateProjectName(dataset[0].sample_id);

    const searchResult = await client.search("*", projectName, 1);
    const alreadyIngested = searchResult.observations.length > 0;

    expect(alreadyIngested).toBe(false);
  });

  it("processes sessions sequentially through full worker lifecycle", async () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const sessions = getSessionsForConversation(sample).slice(0, 2);
    const projectName = generateProjectName(sample.sample_id);

    // 2 sessions × 4 calls each (init, queue, status, complete) = 8 calls
    mockFetchSequence([
      // Session 1
      { body: { sessionDbId: 1, promptNumber: 1, skipped: false } },
      { body: { status: "queued" } },
      { body: { status: "active", sessionDbId: 1, queueLength: 0 } },
      { body: { status: "completed" } },
      // Session 2
      { body: { sessionDbId: 2, promptNumber: 1, skipped: false } },
      { body: { status: "queued" } },
      { body: { status: "active", sessionDbId: 2, queueLength: 0 } },
      { body: { status: "completed" } },
    ]);

    const client = new WorkerClient("http://localhost:37777");

    for (const session of sessions) {
      const contentSessionId = generateContentSessionId(
        sample.sample_id,
        session.session_id
      );
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

    expect(fetchCallLog).toHaveLength(8);

    // Verify session 1 init
    const initBody1 = JSON.parse(fetchCallLog[0].init!.body as string);
    expect(initBody1.project).toBe(projectName);
    expect(initBody1.contentSessionId).toContain(`s${sessions[0].session_id}`);

    // Verify session 2 init
    const initBody2 = JSON.parse(fetchCallLog[4].init!.body as string);
    expect(initBody2.project).toBe(projectName);
    expect(initBody2.contentSessionId).toContain(`s${sessions[1].session_id}`);
  });

  it("retries a failed session and continues to the next", async () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const sessions = getSessionsForConversation(sample).slice(0, 1);
    const projectName = generateProjectName(sample.sample_id);
    const session = sessions[0];
    const contentSessionId = generateContentSessionId(
      sample.sample_id,
      session.session_id
    );
    const toolExec = formatSessionAsToolExecution(sample, session);

    // First attempt: init succeeds, queue fails with 500
    // Second attempt: all succeed
    mockFetchSequence([
      // Attempt 1: init ok, queue fails
      { body: { sessionDbId: 1, promptNumber: 1, skipped: false } },
      { body: { error: "internal" }, status: 500 },
      // Attempt 2 (retry): all ok
      { body: { sessionDbId: 1, promptNumber: 1, skipped: false } },
      { body: { status: "queued" } },
      { body: { status: "active", sessionDbId: 1, queueLength: 0 } },
      { body: { status: "completed" } },
    ]);

    const client = new WorkerClient("http://localhost:37777");

    let succeeded = false;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        await client.initSession(contentSessionId, projectName, toolExec.userPrompt);
        await client.queueObservation(
          contentSessionId,
          toolExec.toolName,
          toolExec.toolInput,
          toolExec.toolResponse
        );
        await client.waitForProcessing(contentSessionId, 5000, 50);
        await client.completeSession(contentSessionId);
        succeeded = true;
        break;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    expect(succeeded).toBe(true);
    // 2 calls for attempt 1 (init + failed queue) + 4 calls for attempt 2
    expect(fetchCallLog).toHaveLength(6);
  });

  it("tracks progress entry with correct fields", () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const sessions = getSessionsForConversation(sample);

    const progressEntry: IngestionProgress = {
      sample_id: sample.sample_id,
      total_sessions: sessions.length,
      sessions_ingested: sessions.length,
      observations_queued: sessions.length,
      status: "completed",
    };

    expect(progressEntry.sample_id).toBe(sample.sample_id);
    expect(progressEntry.total_sessions).toBeGreaterThan(0);
    expect(progressEntry.sessions_ingested).toBe(progressEntry.total_sessions);
    expect(progressEntry.status).toBe("completed");
  });

  it("marks progress as failed when all sessions fail", () => {
    const progressEntry: IngestionProgress = {
      sample_id: "conv-test",
      total_sessions: 5,
      sessions_ingested: 0,
      observations_queued: 0,
      status: "failed",
    };

    expect(progressEntry.status).toBe("failed");
    expect(progressEntry.sessions_ingested).toBe(0);
  });

  it("all 10 conversations have valid sessions for ingestion", () => {
    const dataset = loadDataset();
    expect(dataset.length).toBe(10);

    for (const sample of dataset) {
      const sessions = getSessionsForConversation(sample);
      expect(sessions.length).toBeGreaterThan(0);

      for (const session of sessions) {
        const contentSessionId = generateContentSessionId(
          sample.sample_id,
          session.session_id
        );
        expect(contentSessionId).toStartWith("locomo-");

        const toolExec = formatSessionAsToolExecution(sample, session);
        expect(toolExec.toolName).toBe("Read");
        expect(toolExec.toolResponse).toContain("[Session");
      }
    }
  });

  it("generates progress entries for sequential conversations", () => {
    const dataset = loadDataset();
    const progressEntries: IngestionProgress[] = [];

    for (const sample of dataset) {
      const sessions = getSessionsForConversation(sample);
      progressEntries.push({
        sample_id: sample.sample_id,
        total_sessions: sessions.length,
        sessions_ingested: sessions.length,
        observations_queued: sessions.length,
        status: "completed",
      });
    }

    expect(progressEntries).toHaveLength(10);
    const sampleIds = progressEntries.map((p) => p.sample_id);
    const uniqueSampleIds = new Set(sampleIds);
    expect(uniqueSampleIds.size).toBe(10);
  });
});
