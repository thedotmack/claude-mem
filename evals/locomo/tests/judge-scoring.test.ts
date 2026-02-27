import { describe, it, expect, mock } from "bun:test";
import {
  buildJudgePrompt,
  judgeAnswer,
  judgeAnswerMultipleRuns,
} from "../src/scoring/judge";

// ---------------------------------------------------------------------------
// buildJudgePrompt
// ---------------------------------------------------------------------------

describe("buildJudgePrompt", () => {
  it("includes question, ground truth, predicted answer, and category", () => {
    const prompt = buildJudgePrompt(
      "What is the capital of France?",
      "Paris",
      "The capital is Paris",
      "single-hop"
    );

    expect(prompt).toContain("What is the capital of France?");
    expect(prompt).toContain("Paris");
    expect(prompt).toContain("The capital is Paris");
    expect(prompt).toContain("single-hop");
  });

  it("includes labeled fields for structured parsing", () => {
    const prompt = buildJudgePrompt("Q", "GT", "Pred", "temporal");

    expect(prompt).toContain("Question:");
    expect(prompt).toContain("Ground Truth Answer:");
    expect(prompt).toContain("Predicted Answer:");
    expect(prompt).toContain("Category:");
  });
});

// ---------------------------------------------------------------------------
// judgeAnswer — mocked Anthropic client
// ---------------------------------------------------------------------------

describe("judgeAnswer", () => {
  it("calls API with model claude-sonnet-4-6, temperature 0.5, max_tokens 256", async () => {
    let capturedParams: Record<string, unknown> = {};

    const mockClient = {
      messages: {
        create: mock(async (params: Record<string, unknown>) => {
          capturedParams = params;
          return {
            content: [{ type: "text", text: '{"score": 85, "explanation": "Good match"}' }],
            usage: { input_tokens: 200, output_tokens: 20 },
          };
        }),
      },
    };

    await judgeAnswer("Q?", "truth", "prediction", "single-hop", mockClient as any);

    expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
    expect(capturedParams.model).toBe("claude-sonnet-4-6");
    expect(capturedParams.temperature).toBe(0.5);
    expect(capturedParams.max_tokens).toBe(256);
  });

  it("parses valid JSON response correctly", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: '{"score": 72, "explanation": "Mostly correct"}' }],
          usage: { input_tokens: 100, output_tokens: 15 },
        })),
      },
    };

    const result = await judgeAnswer("Q?", "truth", "pred", "multi-hop", mockClient as any);

    expect(result.score).toBe(72);
    expect(result.explanation).toBe("Mostly correct");
  });

  it("returns score -1 for completely unparseable response", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: "I cannot evaluate this response at all." }],
          usage: { input_tokens: 100, output_tokens: 15 },
        })),
      },
    };

    const result = await judgeAnswer("Q?", "truth", "pred", "single-hop", mockClient as any);

    expect(result.score).toBe(-1);
    expect(result.explanation).toContain("Failed to parse");
  });

  it("extracts numeric score from malformed JSON as fallback", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: "The score is 65 out of 100." }],
          usage: { input_tokens: 100, output_tokens: 10 },
        })),
      },
    };

    const result = await judgeAnswer("Q?", "truth", "pred", "temporal", mockClient as any);

    expect(result.score).toBe(65);
    expect(result.explanation).toContain("extracted from malformed");
  });

  it("rejects scores outside 0-100 in JSON", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: '{"score": 150, "explanation": "Invalid"}' }],
          usage: { input_tokens: 100, output_tokens: 10 },
        })),
      },
    };

    const result = await judgeAnswer("Q?", "truth", "pred", "single-hop", mockClient as any);

    // Should fall through to text extraction — "150" > 100 so also fails, then -1
    expect(result.score).toBe(-1);
  });

  it("handles score 0 correctly (edge case, not failure)", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: '{"score": 0, "explanation": "Completely wrong"}' }],
          usage: { input_tokens: 100, output_tokens: 10 },
        })),
      },
    };

    const result = await judgeAnswer("Q?", "truth", "pred", "single-hop", mockClient as any);

    expect(result.score).toBe(0);
    expect(result.explanation).toBe("Completely wrong");
  });

  it("handles score 100 correctly", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: '{"score": 100, "explanation": "Perfect match"}' }],
          usage: { input_tokens: 100, output_tokens: 10 },
        })),
      },
    };

    const result = await judgeAnswer("Q?", "truth", "pred", "single-hop", mockClient as any);

    expect(result.score).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// judgeAnswerMultipleRuns — aggregation
// ---------------------------------------------------------------------------

describe("judgeAnswerMultipleRuns", () => {
  it("aggregates 10 successful runs with correct mean and stddev", async () => {
    const scores = [70, 72, 68, 71, 73, 69, 70, 72, 71, 70];
    let callIndex = 0;

    const mockClient = {
      messages: {
        create: mock(async () => {
          const score = scores[callIndex % scores.length];
          callIndex++;
          return {
            content: [{ type: "text", text: JSON.stringify({ score, explanation: "ok" }) }],
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        }),
      },
    };

    const result = await judgeAnswerMultipleRuns(
      "Q?", "truth", "pred", "single-hop", 10, mockClient as any
    );

    expect(result.run_count).toBe(10);
    expect(result.individual_scores).toEqual(scores);

    // Mean = (70+72+68+71+73+69+70+72+71+70)/10 = 706/10 = 70.6
    expect(result.mean_score).toBeCloseTo(70.6, 1);

    // Stddev ≈ 1.43
    expect(result.std_dev).toBeGreaterThan(1);
    expect(result.std_dev).toBeLessThan(2);
  });

  it("filters out failed runs (score -1) and uses only successful ones", async () => {
    const responses = [
      '{"score": 80, "explanation": "ok"}',
      '{"score": 75, "explanation": "ok"}',
      "INVALID JSON",                         // will become -1
      '{"score": 70, "explanation": "ok"}',
      '{"score": 85, "explanation": "ok"}',
      '{"score": 72, "explanation": "ok"}',
      "ALSO INVALID",                         // will become -1 (no extractable number)
      '{"score": 78, "explanation": "ok"}',
      '{"score": 82, "explanation": "ok"}',
      '{"score": 76, "explanation": "ok"}',
    ];
    let callIndex = 0;

    const mockClient = {
      messages: {
        create: mock(async () => {
          const text = responses[callIndex % responses.length];
          callIndex++;
          return {
            content: [{ type: "text", text }],
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        }),
      },
    };

    // Suppress warning output during test
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

    const result = await judgeAnswerMultipleRuns(
      "Q?", "truth", "pred", "temporal", 10, mockClient as any
    );

    console.warn = originalWarn;

    // 8 successful, 2 failed
    expect(result.run_count).toBe(8);
    expect(result.individual_scores).toHaveLength(8);
    expect(result.individual_scores).not.toContain(-1);

    // Mean of successful: (80+75+70+85+72+78+82+76)/8 = 618/8 = 77.25
    expect(result.mean_score).toBeCloseTo(77.25, 1);
  });

  it("warns when fewer than 5 runs succeed", async () => {
    // All fail
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: "totally broken" }],
          usage: { input_tokens: 100, output_tokens: 10 },
        })),
      },
    };

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

    const result = await judgeAnswerMultipleRuns(
      "Q?", "truth", "pred", "single-hop", 6, mockClient as any
    );

    console.warn = originalWarn;

    expect(result.run_count).toBe(0);
    expect(result.mean_score).toBe(-1);
    expect(warnings.some((w) => w.includes("Only 0/6 runs succeeded"))).toBe(true);
  });

  it("handles all runs succeeding with identical scores", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: '{"score": 50, "explanation": "ok"}' }],
          usage: { input_tokens: 100, output_tokens: 10 },
        })),
      },
    };

    const result = await judgeAnswerMultipleRuns(
      "Q?", "truth", "pred", "open-domain", 5, mockClient as any
    );

    expect(result.run_count).toBe(5);
    expect(result.mean_score).toBe(50);
    expect(result.std_dev).toBe(0);
  });

  it("respects custom numRuns parameter", async () => {
    const mockClient = {
      messages: {
        create: mock(async () => ({
          content: [{ type: "text", text: '{"score": 60, "explanation": "ok"}' }],
          usage: { input_tokens: 100, output_tokens: 10 },
        })),
      },
    };

    const result = await judgeAnswerMultipleRuns(
      "Q?", "truth", "pred", "single-hop", 3, mockClient as any
    );

    expect(result.run_count).toBe(3);
    expect(mockClient.messages.create).toHaveBeenCalledTimes(3);
  });
});
