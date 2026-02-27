import { describe, it, expect, mock } from "bun:test";
import {
  formatSearchResultsAsContext,
  buildContextWindow,
} from "../src/qa/searcher";
import { QA_SYSTEM_PROMPT, buildUserPrompt } from "../src/qa/prompts";
import { answerQuestion } from "../src/qa/answerer";
import type { SearchObservationResult } from "../src/ingestion/worker-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SearchObservationResult for testing. */
function makeObservation(
  overrides: Partial<SearchObservationResult> = {}
): SearchObservationResult {
  return {
    id: 1,
    memory_session_id: "test-session",
    project: "test-project",
    text: null,
    type: "observation",
    title: null,
    subtitle: null,
    facts: null,
    narrative: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: null,
    created_at: "2026-01-01T00:00:00Z",
    created_at_epoch: 1735689600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatSearchResultsAsContext
// ---------------------------------------------------------------------------

describe("formatSearchResultsAsContext", () => {
  it("formats multiple observations with separators", () => {
    const observations = [
      makeObservation({
        id: 1,
        title: "First Observation",
        facts: "Fact A",
        narrative: "Narrative A",
      }),
      makeObservation({
        id: 2,
        title: "Second Observation",
        facts: "Fact B",
        narrative: "Narrative B",
      }),
    ];

    const result = formatSearchResultsAsContext(observations);

    // Each observation block has title, facts, narrative
    expect(result).toContain("## First Observation");
    expect(result).toContain("Facts: Fact A");
    expect(result).toContain("Narrative: Narrative A");
    expect(result).toContain("## Second Observation");
    expect(result).toContain("Facts: Fact B");
    expect(result).toContain("Narrative: Narrative B");

    // Observations are separated by \n---\n
    expect(result).toContain("\n---\n");

    // Exactly one separator between two observations
    const separatorCount = result.split("\n---\n").length - 1;
    expect(separatorCount).toBe(1);
  });

  it("returns empty string for empty observations array", () => {
    expect(formatSearchResultsAsContext([])).toBe("");
  });

  it("falls back to raw text when no structured fields present", () => {
    const observations = [
      makeObservation({ text: "Raw text content here" }),
    ];
    const result = formatSearchResultsAsContext(observations);
    expect(result).toBe("Raw text content here");
  });

  it("handles observations with partial structured fields", () => {
    const observations = [
      makeObservation({ title: "Title Only" }),
    ];
    const result = formatSearchResultsAsContext(observations);
    expect(result).toBe("## Title Only");
    expect(result).not.toContain("Facts:");
    expect(result).not.toContain("Narrative:");
  });

  it("separates three observations with two separators", () => {
    const observations = [
      makeObservation({ id: 1, title: "Obs 1" }),
      makeObservation({ id: 2, title: "Obs 2" }),
      makeObservation({ id: 3, title: "Obs 3" }),
    ];
    const result = formatSearchResultsAsContext(observations);
    const separatorCount = result.split("\n---\n").length - 1;
    expect(separatorCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildContextWindow
// ---------------------------------------------------------------------------

describe("buildContextWindow", () => {
  it("returns full context when under budget", () => {
    const context = "## Obs 1\nFacts: A\n---\n## Obs 2\nFacts: B";
    const result = buildContextWindow(context, 5000);

    expect(result.context).toBe(context);
    expect(result.observationsUsed).toBe(2);
    expect(result.totalCharacters).toBe(context.length);
  });

  it("truncates at observation boundaries, not mid-text", () => {
    // Build context where each observation block is ~50 chars
    const obs1 = "## First Observation\nFacts: Some fact here";
    const obs2 = "## Second Observation\nFacts: Another fact here";
    const obs3 = "## Third Observation\nFacts: Yet another fact";
    const separator = "\n---\n";
    const fullContext = [obs1, obs2, obs3].join(separator);

    // Set budget so only the first two observations fit
    // obs1 + separator + obs2 = ~95 chars, obs1 + sep + obs2 + sep + obs3 = ~145 chars
    const budgetForTwo = obs1.length + separator.length + obs2.length;

    const result = buildContextWindow(fullContext, budgetForTwo);

    // Should keep exactly 2 observations
    expect(result.observationsUsed).toBe(2);
    expect(result.context).toContain("## First Observation");
    expect(result.context).toContain("## Second Observation");
    expect(result.context).not.toContain("## Third Observation");
    expect(result.totalCharacters).toBeLessThanOrEqual(budgetForTwo);
  });

  it("keeps only the first observation when budget is very tight", () => {
    const obs1 = "## Short";
    const obs2 = "## Also short";
    const fullContext = `${obs1}\n---\n${obs2}`;

    // Budget fits only the first observation
    const result = buildContextWindow(fullContext, obs1.length + 1);

    expect(result.observationsUsed).toBe(1);
    expect(result.context).toBe(obs1);
  });

  it("returns empty context when budget is zero", () => {
    const result = buildContextWindow("## Some content", 0);

    expect(result.context).toBe("");
    expect(result.observationsUsed).toBe(0);
    expect(result.totalCharacters).toBe(0);
  });

  it("handles empty context string", () => {
    const result = buildContextWindow("", 5000);

    expect(result.context).toBe("");
    expect(result.observationsUsed).toBe(0);
    expect(result.totalCharacters).toBe(0);
  });

  it("uses default maxChars of 12000 when not specified", () => {
    // Build a small context that fits within 12000
    const context = "## Test Observation\nFacts: testing default budget";
    const result = buildContextWindow(context);

    expect(result.context).toBe(context);
    expect(result.observationsUsed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildUserPrompt — category hints
// ---------------------------------------------------------------------------

describe("buildUserPrompt", () => {
  const testQuestion = "What is the capital of France?";
  const testContext = "Paris is the capital of France.";

  it("includes the correct category hint for single-hop", () => {
    const prompt = buildUserPrompt(testQuestion, testContext, "single-hop");
    expect(prompt).toContain(
      "Answer using a specific piece of evidence from the context."
    );
  });

  it("includes the correct category hint for multi-hop", () => {
    const prompt = buildUserPrompt(testQuestion, testContext, "multi-hop");
    expect(prompt).toContain(
      "This may require combining information from multiple conversation sessions."
    );
  });

  it("includes the correct category hint for temporal", () => {
    const prompt = buildUserPrompt(testQuestion, testContext, "temporal");
    expect(prompt).toContain(
      "Pay careful attention to dates and the temporal ordering of events."
    );
  });

  it("includes the correct category hint for open-domain", () => {
    const prompt = buildUserPrompt(testQuestion, testContext, "open-domain");
    expect(prompt).toContain(
      "You may use both the provided context and general knowledge."
    );
  });

  it("includes the correct category hint for adversarial", () => {
    const prompt = buildUserPrompt(testQuestion, testContext, "adversarial");
    expect(prompt).toContain(
      "Be careful — verify claims against the context before answering. The question may contain false premises."
    );
  });

  it("includes both the context block and the question", () => {
    const prompt = buildUserPrompt(testQuestion, testContext, "single-hop");

    expect(prompt).toContain("<context>");
    expect(prompt).toContain(testContext);
    expect(prompt).toContain("</context>");
    expect(prompt).toContain(`Question: ${testQuestion}`);
  });

  it("uses a fallback hint for unknown categories", () => {
    const prompt = buildUserPrompt(testQuestion, testContext, "unknown-category");
    expect(prompt).toContain("Answer using the provided context.");
  });
});

// ---------------------------------------------------------------------------
// answerQuestion — mocked Anthropic client
// ---------------------------------------------------------------------------

describe("answerQuestion", () => {
  it("sends correct model, system prompt, and max_tokens to the API", async () => {
    let capturedParams: Record<string, unknown> = {};

    const mockClient = {
      messages: {
        create: mock(async (params: Record<string, unknown>) => {
          capturedParams = params;
          return {
            content: [{ type: "text", text: "Paris" }],
            usage: { input_tokens: 100, output_tokens: 5 },
          };
        }),
      },
    };

    const result = await answerQuestion(
      "What is the capital?",
      "Paris is the capital of France.",
      "single-hop",
      mockClient as any
    );

    // Verify API was called with correct parameters
    expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
    expect(capturedParams.model).toBe("claude-opus-4-6");
    expect(capturedParams.max_tokens).toBe(256);
    expect(capturedParams.temperature).toBe(0);
    expect(capturedParams.system).toBe(QA_SYSTEM_PROMPT);

    // Verify messages contain the user prompt
    const messages = capturedParams.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("What is the capital?");
    expect(messages[0].content).toContain("Paris is the capital of France.");
  });

  it("extracts answer text from response content blocks", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: "  Paris  " }],
          usage: { input_tokens: 80, output_tokens: 3 },
        })),
      },
    };

    const result = await answerQuestion(
      "Capital?",
      "context",
      "single-hop",
      mockClient as any
    );

    expect(result.predicted_answer).toBe("Paris");
  });

  it("returns 'unanswerable' when response has no text content", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [],
          usage: { input_tokens: 80, output_tokens: 0 },
        })),
      },
    };

    const result = await answerQuestion(
      "Unknown?",
      "context",
      "single-hop",
      mockClient as any
    );

    expect(result.predicted_answer).toBe("unanswerable");
  });

  it("returns token usage and latency metrics", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: "answer" }],
          usage: { input_tokens: 150, output_tokens: 10 },
        })),
      },
    };

    const result = await answerQuestion(
      "Q?",
      "ctx",
      "temporal",
      mockClient as any
    );

    expect(result.input_tokens).toBe(150);
    expect(result.output_tokens).toBe(10);
    expect(result.answer_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("joins multiple text content blocks", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [
            { type: "text", text: "Part one " },
            { type: "text", text: "part two" },
          ],
          usage: { input_tokens: 100, output_tokens: 8 },
        })),
      },
    };

    const result = await answerQuestion(
      "Q?",
      "ctx",
      "single-hop",
      mockClient as any
    );

    expect(result.predicted_answer).toBe("Part one part two");
  });
});
