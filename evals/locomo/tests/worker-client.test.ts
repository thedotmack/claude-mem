import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { WorkerClient } from "../src/ingestion/worker-client";
import type {
  InitSessionResponse,
  SessionStatusResponse,
  SearchResponse,
} from "../src/ingestion/worker-client";

// ---------------------------------------------------------------------------
// Mock the auth token read — WorkerClient reads it on construction.
// We mock the fs module so readFileSync returns a fake token.
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "a".repeat(64);

// Mock fs.readFileSync to return our fake token
const originalReadFileSync = require("fs").readFileSync;
const mockReadFileSync = mock((...args: unknown[]) => {
  const filePath = args[0] as string;
  if (filePath.includes(".auth-token")) {
    return FAKE_TOKEN;
  }
  return originalReadFileSync(...args);
});

// Apply the mock before importing creates the module
require("fs").readFileSync = mockReadFileSync;

// ---------------------------------------------------------------------------
// Helpers: mock fetch responses
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof mock>;

function mockFetchResponse(body: unknown, status = 200): void {
  fetchMock = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
  globalThis.fetch = fetchMock as typeof fetch;
}

function mockFetchError(message: string): void {
  fetchMock = mock(() => Promise.reject(new TypeError(message)));
  globalThis.fetch = fetchMock as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkerClient", () => {
  let client: WorkerClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new WorkerClient("http://localhost:37777");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ---- initSession -------------------------------------------------------

  describe("initSession", () => {
    it("sends correct request and returns parsed response", async () => {
      const responseBody: InitSessionResponse = {
        sessionDbId: 42,
        promptNumber: 1,
        skipped: false,
      };
      mockFetchResponse(responseBody);

      const result = await client.initSession(
        "locomo-conv-26-s1",
        "locomo-eval-conv-26",
        "Conversation between Caroline and Melanie on 8 May 2023"
      );

      expect(result.sessionDbId).toBe(42);
      expect(result.promptNumber).toBe(1);
      expect(result.skipped).toBe(false);

      // Verify the fetch was called with correct args
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:37777/api/sessions/init");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string);
      expect(body.contentSessionId).toBe("locomo-conv-26-s1");
      expect(body.project).toBe("locomo-eval-conv-26");
      expect(body.prompt).toBe(
        "Conversation between Caroline and Melanie on 8 May 2023"
      );

      // Verify auth header is present with Bearer scheme
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toStartWith("Bearer ");
      expect(headers["Authorization"].length).toBeGreaterThan("Bearer ".length);
    });
  });

  // ---- queueObservation ---------------------------------------------------

  describe("queueObservation", () => {
    it("sends tool_input as parsed object in the body", async () => {
      mockFetchResponse({ status: "queued" });

      await client.queueObservation(
        "locomo-conv-26-s1",
        "Read",
        '{"file_path":"conversation-transcript/session-1.txt"}',
        "[Session 1]\nCaroline: Hello!"
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:37777/api/sessions/observations");

      const body = JSON.parse(init.body as string);
      expect(body.contentSessionId).toBe("locomo-conv-26-s1");
      expect(body.tool_name).toBe("Read");
      // tool_input should be parsed object, not a string
      expect(body.tool_input).toEqual({
        file_path: "conversation-transcript/session-1.txt",
      });
      expect(body.tool_response).toBe("[Session 1]\nCaroline: Hello!");
      expect(body.cwd).toBe("");
    });

    it("falls back to string if toolInput is not valid JSON", async () => {
      mockFetchResponse({ status: "queued" });

      await client.queueObservation(
        "locomo-conv-26-s1",
        "Read",
        "not-json",
        "response"
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.tool_input).toBe("not-json");
    });
  });

  // ---- completeSession ----------------------------------------------------

  describe("completeSession", () => {
    it("sends correct request", async () => {
      mockFetchResponse({ status: "completed", sessionDbId: 42 });

      const result = await client.completeSession("locomo-conv-26-s1");

      expect(result.status).toBe("completed");
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:37777/api/sessions/complete");
      const body = JSON.parse(init.body as string);
      expect(body.contentSessionId).toBe("locomo-conv-26-s1");
    });
  });

  // ---- getSessionStatus ---------------------------------------------------

  describe("getSessionStatus", () => {
    it("uses sessionDbId from initSession mapping", async () => {
      // First init to populate the mapping
      mockFetchResponse({ sessionDbId: 99, promptNumber: 1, skipped: false });
      await client.initSession("my-session", "proj", "prompt");

      // Now get status
      const statusBody: SessionStatusResponse = {
        status: "active",
        sessionDbId: 99,
        project: "proj",
        queueLength: 3,
        uptime: 5000,
      };
      mockFetchResponse(statusBody);
      const status = await client.getSessionStatus("my-session");

      expect(status.status).toBe("active");
      expect(status.queueLength).toBe(3);

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:37777/sessions/99/status");
    });

    it("throws if initSession was not called first", async () => {
      expect(client.getSessionStatus("unknown")).rejects.toThrow(
        'No sessionDbId known for contentSessionId "unknown"'
      );
    });
  });

  // ---- waitForProcessing --------------------------------------------------

  describe("waitForProcessing", () => {
    it("returns immediately when queue is empty", async () => {
      // Init first
      mockFetchResponse({ sessionDbId: 1, promptNumber: 1, skipped: false });
      await client.initSession("sess", "proj", "prompt");

      // Status shows empty queue
      mockFetchResponse({
        status: "active",
        sessionDbId: 1,
        queueLength: 0,
      } as SessionStatusResponse);

      const result = await client.waitForProcessing("sess", 5000);
      expect(result.queueLength).toBe(0);
    });

    it("returns when session is not_found", async () => {
      mockFetchResponse({ sessionDbId: 1, promptNumber: 1, skipped: false });
      await client.initSession("sess", "proj", "prompt");

      mockFetchResponse({ status: "not_found" } as SessionStatusResponse);

      const result = await client.waitForProcessing("sess", 5000);
      expect(result.status).toBe("not_found");
    });

    it("throws on timeout", async () => {
      mockFetchResponse({ sessionDbId: 1, promptNumber: 1, skipped: false });
      await client.initSession("sess", "proj", "prompt");

      // Always return non-empty queue
      mockFetchResponse({
        status: "active",
        sessionDbId: 1,
        queueLength: 5,
      } as SessionStatusResponse);

      expect(
        client.waitForProcessing("sess", 100, 50)
      ).rejects.toThrow("Timeout");
    });
  });

  // ---- search -------------------------------------------------------------

  describe("search", () => {
    it("sends correct query params and instruments latency", async () => {
      const searchBody = {
        observations: [
          {
            id: 1,
            title: "Test observation",
            narrative: "Some narrative text",
          },
        ],
        sessions: [],
        prompts: [],
        totalResults: 1,
        query: "test query",
      };
      mockFetchResponse(searchBody);

      const result = await client.search(
        "test query",
        "locomo-eval-conv-26",
        10
      );

      expect(result.observations).toHaveLength(1);
      expect(result.totalResults).toBe(1);
      expect(result.search_latency_ms).toBeGreaterThanOrEqual(0);

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/search?");
      expect(url).toContain("query=test+query");
      expect(url).toContain("project=locomo-eval-conv-26");
      expect(url).toContain("limit=10");
      expect(url).toContain("type=observations");
      expect(url).toContain("format=json");
    });
  });

  // ---- error handling -----------------------------------------------------

  describe("error handling", () => {
    it("throws descriptive error on connection refused", async () => {
      mockFetchError("fetch failed");

      expect(
        client.initSession("s", "p", "u")
      ).rejects.toThrow("Worker not running at http://localhost:37777");
    });

    it("throws descriptive error on ECONNREFUSED", async () => {
      mockFetchError("ECONNREFUSED");

      expect(
        client.initSession("s", "p", "u")
      ).rejects.toThrow("Worker not running at http://localhost:37777");
    });

    it("throws on 401 unauthorized", async () => {
      mockFetchResponse({ error: "Unauthorized" }, 401);

      expect(
        client.initSession("s", "p", "u")
      ).rejects.toThrow("Invalid auth token");
    });

    it("includes response body on 500 error", async () => {
      mockFetchResponse({ error: "Internal server error" }, 500);

      expect(
        client.initSession("s", "p", "u")
      ).rejects.toThrow("Worker returned 500");
    });
  });
});
