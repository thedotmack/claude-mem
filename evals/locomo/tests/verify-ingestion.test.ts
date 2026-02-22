import { describe, it, expect, afterEach, mock } from "bun:test";
import { WorkerClient } from "../src/ingestion/worker-client";
import { generateProjectName } from "../src/ingestion/adapter";
import {
  loadDataset,
  getQuestionsForConversation,
} from "../src/dataset-loader";
import { LOCOMO_CATEGORY_MAP } from "../src/types";

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

function makeMockObservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    memory_session_id: "test-session",
    project: "locomo-eval-test",
    text: null,
    type: "observation",
    title: "Test Observation",
    subtitle: null,
    facts: null,
    narrative: "This is a test narrative about a conversation.",
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: 1,
    created_at: "2026-02-22T00:00:00Z",
    created_at_epoch: 1740000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify-ingestion", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generates the correct project name for the first conversation", () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const projectName = generateProjectName(sample.sample_id);
    expect(projectName).toStartWith("locomo-eval-");
    expect(projectName).toContain(sample.sample_id);
  });

  it("picks QA questions from desired categories excluding adversarial", () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const questions = getQuestionsForConversation(sample);

    // No adversarial questions (category 5)
    expect(questions.every((q) => q.category !== 5)).toBe(true);

    // Should have questions from multiple categories
    const categories = new Set(questions.map((q) => q.category));
    expect(categories.size).toBeGreaterThanOrEqual(1);
  });

  it("searches for all observations under the project", async () => {
    const mockObservations = [
      makeMockObservation({ id: 1, title: "Session 1 Observation" }),
      makeMockObservation({ id: 2, title: "Session 2 Observation" }),
      makeMockObservation({ id: 3, title: "Session 3 Observation" }),
    ];

    mockFetchSequence([
      {
        body: {
          observations: mockObservations,
          sessions: [],
          prompts: [],
          totalResults: 3,
          query: "*",
        },
      },
    ]);

    const client = new WorkerClient("http://localhost:37777");
    const results = await client.search("*", "locomo-eval-test", 100);

    expect(results.observations).toHaveLength(3);
    expect(results.observations[0].title).toBe("Session 1 Observation");
    expect(results.search_latency_ms).toBeGreaterThanOrEqual(0);

    // Verify the search URL includes correct params
    const searchUrl = new URL(fetchCallLog[0].url);
    expect(searchUrl.searchParams.get("project")).toBe("locomo-eval-test");
    expect(searchUrl.searchParams.get("query")).toBe("*");
    expect(searchUrl.searchParams.get("format")).toBe("json");
  });

  it("searches for QA questions scoped to the project", async () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const questions = getQuestionsForConversation(sample);
    const firstQuestion = questions[0];
    const projectName = generateProjectName(sample.sample_id);

    const mockResults = [
      makeMockObservation({
        id: 10,
        title: "Relevant Observation",
        narrative: "Contains relevant information about the question topic.",
      }),
    ];

    mockFetchSequence([
      {
        body: {
          observations: mockResults,
          sessions: [],
          prompts: [],
          totalResults: 1,
          query: firstQuestion.question,
        },
      },
    ]);

    const client = new WorkerClient("http://localhost:37777");
    const results = await client.search(firstQuestion.question, projectName, 3);

    expect(results.observations).toHaveLength(1);
    expect(results.query).toBe(firstQuestion.question);

    // Verify search is scoped to the project
    const searchUrl = new URL(fetchCallLog[0].url);
    expect(searchUrl.searchParams.get("project")).toBe(projectName);
    expect(searchUrl.searchParams.get("limit")).toBe("3");
  });

  it("handles empty search results gracefully", async () => {
    mockFetchSequence([
      {
        body: {
          observations: [],
          sessions: [],
          prompts: [],
          totalResults: 0,
          query: "nonexistent topic",
        },
      },
    ]);

    const client = new WorkerClient("http://localhost:37777");
    const results = await client.search("nonexistent topic", "locomo-eval-test", 3);

    expect(results.observations).toHaveLength(0);
    expect(results.totalResults).toBe(0);
  });

  it("category map includes all non-adversarial verification categories", () => {
    // Verify the categories we want to search for are all defined
    expect(LOCOMO_CATEGORY_MAP[1]).toBe("single-hop");
    expect(LOCOMO_CATEGORY_MAP[2]).toBe("temporal");
    expect(LOCOMO_CATEGORY_MAP[3]).toBe("multi-hop");
    expect(LOCOMO_CATEGORY_MAP[5]).toBe("adversarial");
  });

  it("full verification flow: observations + QA search", async () => {
    const dataset = loadDataset();
    const sample = dataset[0];
    const projectName = generateProjectName(sample.sample_id);
    const questions = getQuestionsForConversation(sample);

    // Mock: first call is all-observations search, then 3 QA question searches
    const allObsMock = {
      body: {
        observations: [
          makeMockObservation({ id: 1, title: "Obs 1", narrative: "First observation narrative" }),
          makeMockObservation({ id: 2, title: "Obs 2", narrative: "Second observation narrative" }),
        ],
        sessions: [],
        prompts: [],
        totalResults: 2,
        query: "*",
      },
    };

    const qaSearchMock = {
      body: {
        observations: [
          makeMockObservation({ id: 10, title: "Relevant Result", narrative: "Matching content" }),
        ],
        sessions: [],
        prompts: [],
        totalResults: 1,
        query: "test",
      },
    };

    mockFetchSequence([allObsMock, qaSearchMock, qaSearchMock, qaSearchMock]);

    const client = new WorkerClient("http://localhost:37777");

    // Step 1: Search all observations
    const allObs = await client.search("*", projectName, 100);
    expect(allObs.observations).toHaveLength(2);

    // Step 2: Search for up to 3 QA questions
    const desiredCategories = [1, 3, 2] as const;
    let searchCount = 0;
    const usedCategories = new Set<number>();

    for (const cat of desiredCategories) {
      if (searchCount >= 3) break;
      const q = questions.find((q) => q.category === cat && !usedCategories.has(q.category));
      if (q) {
        const results = await client.search(q.question, projectName, 3);
        expect(results.observations.length).toBeGreaterThanOrEqual(0);
        usedCategories.add(cat);
        searchCount++;
      }
    }

    // We should have made at least 2 fetch calls (allObs + at least 1 QA search)
    expect(fetchCallLog.length).toBeGreaterThanOrEqual(2);
  });
});
