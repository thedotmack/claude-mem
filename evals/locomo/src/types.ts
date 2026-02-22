/**
 * Type definitions for the LoCoMo evaluation harness.
 *
 * Raw types match the actual locomo10.json structure from the ACL 2024 dataset.
 * Eval types support dual scoring: token-level F1 + LLM-as-a-Judge.
 */

// ---------------------------------------------------------------------------
// Category mapping (from LoCoMo paper + task_eval/evaluation.py)
// ---------------------------------------------------------------------------

/**
 * LoCoMo QA category numbers as used in locomo10.json.
 *   1 = single-hop
 *   2 = temporal
 *   3 = multi-hop
 *   4 = open-domain
 *   5 = adversarial
 */
export const LOCOMO_CATEGORY_MAP: Record<number, string> = {
  1: "single-hop",
  2: "temporal",
  3: "multi-hop",
  4: "open-domain",
  5: "adversarial",
} as const;

export type LoCoMoCategoryNumber = 1 | 2 | 3 | 4 | 5;
export type LoCoMoCategoryName = "single-hop" | "temporal" | "multi-hop" | "open-domain" | "adversarial";

// ---------------------------------------------------------------------------
// Raw dataset types (matching locomo10.json on disk)
// ---------------------------------------------------------------------------

/** A single dialog turn within a session. */
export interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  /** Image URL(s) — present only in multimodal turns. */
  img_url?: string[];
  /** BLIP-generated image caption — present only in multimodal turns. */
  blip_caption?: string;
  /** Search query used by icrawler to retrieve the image. */
  query?: string;
}

/**
 * The `conversation` object within a LoCoMo sample.
 *
 * Has fixed keys `speaker_a` and `speaker_b`, plus dynamic keys:
 *   - `session_<N>`: array of LoCoMoTurn
 *   - `session_<N>_date_time`: string timestamp
 *
 * Some conversations have more date_time keys than session keys
 * (e.g., conv-26 has 35 date_time keys but only 19 session arrays).
 */
export interface LoCoMoConversation {
  speaker_a: string;
  speaker_b: string;
  /** Dynamic session and date_time keys. */
  [key: string]: string | LoCoMoTurn[] | undefined;
}

/** A single QA annotation from locomo10.json. */
export interface LoCoMoQA {
  question: string;
  /** Ground truth answer — usually string, occasionally number (e.g., a year). */
  answer: string | number;
  /** Numeric category: 1=single-hop, 2=temporal, 3=multi-hop, 4=open-domain, 5=adversarial. */
  category: LoCoMoCategoryNumber;
  /** Dialog IDs that contain evidence for the answer (e.g., ["D1:3", "D2:8"]). */
  evidence: string[];
}

/**
 * Per-speaker observations for a session.
 * Keys are speaker names, values are arrays of [observation_text, evidence_dia_id] tuples.
 */
export type LoCoMoSessionObservation = Record<string, [string, string][]>;

/**
 * Per-speaker event summaries for a session.
 * Keys are speaker names (+ "date"), values are string arrays of events.
 */
export type LoCoMoSessionEvents = Record<string, string[] | string>;

/** Top-level sample in locomo10.json. */
export interface LoCoMoSample {
  sample_id: string;
  conversation: LoCoMoConversation;
  /** Keyed by `session_<N>_observation`. */
  observation: Record<string, LoCoMoSessionObservation>;
  /** Keyed by `session_<N>_summary`. */
  session_summary: Record<string, string>;
  /** Keyed by `events_session_<N>`. */
  event_summary: Record<string, LoCoMoSessionEvents>;
  qa: LoCoMoQA[];
}

// ---------------------------------------------------------------------------
// Enriched types (produced by the dataset loader for the eval pipeline)
// ---------------------------------------------------------------------------

/** A session extracted and normalized from the dynamic-key conversation object. */
export interface LoCoMoSession {
  session_id: number;
  date: string;
  turns: LoCoMoTurn[];
  /** Pre-generated observations from the dataset (per speaker). */
  observation?: LoCoMoSessionObservation;
  /** Pre-generated session summary from the dataset. */
  summary?: string;
  /** Annotated event summaries from the dataset (per speaker). */
  events?: LoCoMoSessionEvents;
}

// ---------------------------------------------------------------------------
// Ingestion tracking
// ---------------------------------------------------------------------------

export interface IngestionProgress {
  sample_id: string;
  total_sessions: number;
  sessions_ingested: number;
  observations_queued: number;
  status: "pending" | "in_progress" | "completed" | "failed";
}

// ---------------------------------------------------------------------------
// QA + Scoring types (dual scoring: F1 + LLM-as-a-Judge)
// ---------------------------------------------------------------------------

export interface JudgeResult {
  score: number;        // 0–100
  explanation: string;
}

export interface JudgeAggregation {
  mean_score: number;
  std_dev: number;
  run_count: number;
  individual_scores: number[];
}

export interface QAResult {
  question: string;
  predicted_answer: string;
  ground_truth_answer: string;
  category: string;
  f1_score: number;
  judge_scores?: JudgeAggregation;
  search_results_used: number;
  search_latency_ms: number;
  answer_latency_ms: number;
  answer_input_tokens: number;
  answer_output_tokens: number;
}

// ---------------------------------------------------------------------------
// Reporting types
// ---------------------------------------------------------------------------

export interface LatencyStats {
  search_p50_ms: number;
  search_p95_ms: number;
  answer_p50_ms: number;
  answer_p95_ms: number;
  total_p50_ms: number;
  total_p95_ms: number;
}

export interface CategoryF1Stats {
  mean_f1: number;
  count: number;
  min_f1: number;
  max_f1: number;
}

export interface CategoryJudgeStats {
  mean_j: number;
  std_dev: number;
  count: number;
}

export interface EvalReport {
  results: QAResult[];
  per_category_f1_scores: Record<string, CategoryF1Stats>;
  overall_f1: number;
  per_category_judge_scores: Record<string, CategoryJudgeStats>;
  overall_judge_score: JudgeAggregation;
  latency_stats: LatencyStats;
  token_stats: {
    total_input_tokens: number;
    total_output_tokens: number;
    mean_tokens_per_question: number;
  };
  metadata: {
    model: string;
    judge_model: string;
    timestamp: string;
    total_questions: number;
    scoring_methods: string[];
  };
}
