import { describe, it, expect } from "bun:test";
import type {
  LoCoMoSample,
  LoCoMoTurn,
  LoCoMoQA,
  LoCoMoSession,
  LoCoMoConversation,
  LoCoMoCategoryNumber,
  QAResult,
  JudgeResult,
  JudgeAggregation,
  EvalReport,
  IngestionProgress,
  LatencyStats,
} from "../src/types";
import { LOCOMO_CATEGORY_MAP } from "../src/types";

describe("LoCoMo type definitions", () => {
  it("LOCOMO_CATEGORY_MAP has all 5 categories", () => {
    expect(Object.keys(LOCOMO_CATEGORY_MAP)).toHaveLength(5);
    expect(LOCOMO_CATEGORY_MAP[1]).toBe("single-hop");
    expect(LOCOMO_CATEGORY_MAP[2]).toBe("temporal");
    expect(LOCOMO_CATEGORY_MAP[3]).toBe("multi-hop");
    expect(LOCOMO_CATEGORY_MAP[4]).toBe("open-domain");
    expect(LOCOMO_CATEGORY_MAP[5]).toBe("adversarial");
  });

  it("LoCoMoTurn matches actual data shape", () => {
    const turn: LoCoMoTurn = {
      speaker: "Caroline",
      dia_id: "D1:1",
      text: "Hey Mel!",
    };
    expect(turn.speaker).toBe("Caroline");
    expect(turn.img_url).toBeUndefined();
  });

  it("LoCoMoTurn with multimodal fields", () => {
    const turn: LoCoMoTurn = {
      speaker: "Caroline",
      dia_id: "D1:5",
      text: "The transgender stories were so inspiring!",
      img_url: ["https://example.com/image.jpg"],
      blip_caption: "a photo of a dog",
      query: "transgender pride flag mural",
    };
    expect(turn.img_url).toHaveLength(1);
    expect(turn.blip_caption).toBe("a photo of a dog");
  });

  it("LoCoMoQA matches actual data shape", () => {
    const qa: LoCoMoQA = {
      question: "When did Caroline go to the LGBTQ support group?",
      answer: "7 May 2023",
      evidence: ["D1:3"],
      category: 2,
    };
    expect(qa.category).toBe(2);
    expect(LOCOMO_CATEGORY_MAP[qa.category]).toBe("temporal");
  });

  it("LoCoMoQA answer can be a number", () => {
    const qa: LoCoMoQA = {
      question: "When did Melanie paint a sunrise?",
      answer: 2022,
      evidence: ["D1:12"],
      category: 2,
    };
    expect(qa.answer).toBe(2022);
  });

  it("LoCoMoSession enriched type has all fields", () => {
    const session: LoCoMoSession = {
      session_id: 1,
      date: "1:56 pm on 8 May, 2023",
      turns: [{ speaker: "A", dia_id: "D1:1", text: "Hi" }],
      observation: {
        Caroline: [["Caroline attended a group.", "D1:3"]],
        Melanie: [],
      },
      summary: "Caroline and Melanie talked.",
      events: {
        Caroline: ["Caroline attends an LGBTQ support group."],
        Melanie: [],
        date: "8 May, 2023",
      },
    };
    expect(session.session_id).toBe(1);
    expect(session.observation?.Caroline).toHaveLength(1);
  });

  it("IngestionProgress has correct status union", () => {
    const progress: IngestionProgress = {
      sample_id: "conv-26",
      total_sessions: 19,
      sessions_ingested: 5,
      observations_queued: 5,
      status: "in_progress",
    };
    expect(progress.status).toBe("in_progress");
  });

  it("validates the actual locomo10.json against LoCoMoSample type", async () => {
    const dataPath = `${import.meta.dir}/../data/locomo-repo/data/locomo10.json`;
    const raw = JSON.parse(await Bun.file(dataPath).text()) as LoCoMoSample[];
    expect(raw).toHaveLength(10);

    const first = raw[0];
    expect(first.sample_id).toBe("conv-26");
    expect(first.conversation.speaker_a).toBe("Caroline");
    expect(first.conversation.speaker_b).toBe("Melanie");
    expect(first.qa.length).toBeGreaterThan(0);

    // Verify session turns exist as dynamic keys
    const session1Turns = first.conversation["session_1"] as LoCoMoTurn[];
    expect(Array.isArray(session1Turns)).toBe(true);
    expect(session1Turns[0].speaker).toBe("Caroline");
    expect(session1Turns[0].dia_id).toBe("D1:1");

    // Verify date_time keys
    expect(first.conversation["session_1_date_time"]).toBeDefined();

    // Verify observations
    expect(first.observation["session_1_observation"]).toBeDefined();

    // Verify session summary
    expect(first.session_summary["session_1_summary"]).toBeDefined();

    // Verify event summary
    expect(first.event_summary["events_session_1"]).toBeDefined();
  });
});
