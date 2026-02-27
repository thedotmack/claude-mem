import { describe, it, expect } from "bun:test";
import {
  generateContentSessionId,
  generateProjectName,
  formatSessionAsToolExecution,
} from "../src/ingestion/adapter";
import type { LoCoMoSample, LoCoMoSession } from "../src/types";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

describe("generateContentSessionId", () => {
  it("returns deterministic ID with sample and session", () => {
    expect(generateContentSessionId("conv-26", 1)).toBe("locomo-conv-26-s1");
    expect(generateContentSessionId("conv-26", 15)).toBe("locomo-conv-26-s15");
    expect(generateContentSessionId("conv-50", 3)).toBe("locomo-conv-50-s3");
  });

  it("same inputs always produce same output", () => {
    const id1 = generateContentSessionId("conv-42", 7);
    const id2 = generateContentSessionId("conv-42", 7);
    const id3 = generateContentSessionId("conv-42", 7);
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it("different sampleId/sessionId combinations never collide", () => {
    const ids = new Set([
      generateContentSessionId("conv-26", 1),
      generateContentSessionId("conv-26", 2),
      generateContentSessionId("conv-26", 10),
      generateContentSessionId("conv-30", 1),
      generateContentSessionId("conv-30", 2),
      generateContentSessionId("conv-42", 1),
      generateContentSessionId("conv-50", 15),
      generateContentSessionId("conv-99", 99),
    ]);
    expect(ids.size).toBe(8);
  });
});

describe("generateProjectName", () => {
  it("returns locomo-eval prefixed project name", () => {
    expect(generateProjectName("conv-26")).toBe("locomo-eval-conv-26");
    expect(generateProjectName("conv-50")).toBe("locomo-eval-conv-50");
  });
});

// ---------------------------------------------------------------------------
// Session formatting
// ---------------------------------------------------------------------------

const MOCK_SAMPLE: LoCoMoSample = {
  sample_id: "conv-26",
  conversation: {
    speaker_a: "Caroline",
    speaker_b: "Melanie",
    session_1: [
      { speaker: "A", dia_id: "D1:1", text: "Hey Mel! How are you?" },
      { speaker: "B", dia_id: "D1:2", text: "Good! Just got back from yoga." },
      { speaker: "A", dia_id: "D1:3", text: "That sounds relaxing." },
    ],
    session_1_date_time: "1:56 pm on 8 May, 2023",
  },
  observation: {},
  session_summary: {},
  event_summary: {},
  qa: [],
};

const MOCK_SESSION: LoCoMoSession = {
  session_id: 1,
  date: "1:56 pm on 8 May, 2023",
  turns: [
    { speaker: "A", dia_id: "D1:1", text: "Hey Mel! How are you?" },
    { speaker: "B", dia_id: "D1:2", text: "Good! Just got back from yoga." },
    { speaker: "A", dia_id: "D1:3", text: "That sounds relaxing." },
  ],
};

describe("formatSessionAsToolExecution", () => {
  const result = formatSessionAsToolExecution(MOCK_SAMPLE, MOCK_SESSION);

  it("uses Read as the tool name", () => {
    expect(result.toolName).toBe("Read");
  });

  it("formats toolInput as JSON with file_path", () => {
    const parsed = JSON.parse(result.toolInput);
    expect(parsed.file_path).toBe("conversation-transcript/session-1.txt");
  });

  it("formats transcript with header and speaker names", () => {
    expect(result.toolResponse).toContain("[Session 1 — 1:56 pm on 8 May, 2023]");
    expect(result.toolResponse).toContain("[Conversation between Caroline and Melanie]");
  });

  it("maps speaker A/B to actual names in dialog lines", () => {
    expect(result.toolResponse).toContain("Caroline: Hey Mel! How are you?");
    expect(result.toolResponse).toContain("Melanie: Good! Just got back from yoga.");
    expect(result.toolResponse).toContain("Caroline: That sounds relaxing.");
  });

  it("has blank line between header and dialog", () => {
    const lines = result.toolResponse.split("\n");
    expect(lines[0]).toMatch(/^\[Session/);
    expect(lines[1]).toMatch(/^\[Conversation/);
    expect(lines[2]).toBe("");
    expect(lines[3]).toMatch(/^Caroline:/);
  });

  it("formats userPrompt with speaker names and date", () => {
    expect(result.userPrompt).toBe(
      "Conversation between Caroline and Melanie on 1:56 pm on 8 May, 2023"
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("formatSessionAsToolExecution edge cases", () => {
  it("handles session with a single turn", () => {
    const singleTurnSession: LoCoMoSession = {
      session_id: 5,
      date: "3:00 pm on 1 Jan, 2024",
      turns: [{ speaker: "A", dia_id: "D5:1", text: "Hello there." }],
    };
    const result = formatSessionAsToolExecution(MOCK_SAMPLE, singleTurnSession);

    expect(result.toolResponse).toContain("[Session 5 — 3:00 pm on 1 Jan, 2024]");
    expect(result.toolResponse).toContain("Caroline: Hello there.");
    // Only one dialog line after the header
    const lines = result.toolResponse.split("\n");
    expect(lines[0]).toMatch(/^\[Session 5/);
    expect(lines[1]).toMatch(/^\[Conversation/);
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("Caroline: Hello there.");
    expect(lines).toHaveLength(4);
  });

  it("handles session with empty turns array", () => {
    const emptySession: LoCoMoSession = {
      session_id: 9,
      date: "noon on 15 Mar, 2024",
      turns: [],
    };
    const result = formatSessionAsToolExecution(MOCK_SAMPLE, emptySession);

    expect(result.toolResponse).toContain("[Session 9 — noon on 15 Mar, 2024]");
    expect(result.toolResponse).toContain("[Conversation between Caroline and Melanie]");
    // Header + blank separator + empty dialog join = ends with \n\n
    const lines = result.toolResponse.split("\n");
    expect(lines[0]).toMatch(/^\[Session 9/);
    expect(lines[1]).toMatch(/^\[Conversation/);
    expect(lines[2]).toBe("");
    // Empty join produces trailing empty element
    expect(lines[3]).toBe("");
  });

  it("handles very long dialog (50+ turns)", () => {
    const manyTurns = Array.from({ length: 60 }, (_, i) => ({
      speaker: i % 2 === 0 ? "A" : "B",
      dia_id: `D1:${i + 1}`,
      text: `Turn number ${i + 1} content here.`,
    }));
    const longSession: LoCoMoSession = {
      session_id: 2,
      date: "10:00 am on 20 Jun, 2023",
      turns: manyTurns,
    };
    const result = formatSessionAsToolExecution(MOCK_SAMPLE, longSession);

    // Header is present
    expect(result.toolResponse).toContain("[Session 2 — 10:00 am on 20 Jun, 2023]");

    // All 60 turns are present (2 header lines + 1 blank + 60 dialog lines)
    const lines = result.toolResponse.split("\n");
    expect(lines).toHaveLength(63);

    // First and last turns use correct speaker names
    expect(lines[3]).toBe("Caroline: Turn number 1 content here.");
    expect(lines[62]).toBe("Melanie: Turn number 60 content here.");

    // toolInput file_path uses correct session_id
    expect(JSON.parse(result.toolInput).file_path).toBe(
      "conversation-transcript/session-2.txt"
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: real dataset
// ---------------------------------------------------------------------------

describe("adapter with real dataset", () => {
  it("formats the first session of conv-26 correctly", async () => {
    const { loadDataset, getSessionsForConversation } = await import(
      "../src/dataset-loader"
    );
    const dataset = loadDataset();
    const sample = dataset[0];
    const sessions = getSessionsForConversation(sample);

    const result = formatSessionAsToolExecution(sample, sessions[0]);

    expect(result.toolName).toBe("Read");
    expect(JSON.parse(result.toolInput).file_path).toBe(
      "conversation-transcript/session-1.txt"
    );
    expect(result.toolResponse).toContain("[Session 1");
    expect(result.toolResponse).toContain("Caroline");
    expect(result.toolResponse).toContain("Melanie");
    expect(result.userPrompt).toContain("Caroline");
    expect(result.userPrompt).toContain("Melanie");

    // Content session ID and project name
    const contentSessionId = generateContentSessionId(sample.sample_id, sessions[0].session_id);
    expect(contentSessionId).toBe("locomo-conv-26-s1");

    const projectName = generateProjectName(sample.sample_id);
    expect(projectName).toBe("locomo-eval-conv-26");
  });
});
