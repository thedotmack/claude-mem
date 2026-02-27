import { describe, it, expect } from "bun:test";
import {
  normalizeAnswer,
  porterStem,
  tokenize,
  computeTokenF1,
} from "../src/scoring/f1";
import {
  scoreResultsF1,
  aggregateF1ByCategory,
  computeOverallF1,
} from "../src/scoring/reporter";
import type { QAResult } from "../src/types";

// ---------------------------------------------------------------------------
// normalizeAnswer
// ---------------------------------------------------------------------------

describe("normalizeAnswer", () => {
  it("lowercases and removes punctuation", () => {
    expect(normalizeAnswer("The Cat!")).toBe("cat");
  });

  it("removes articles: a, an, the, and", () => {
    expect(normalizeAnswer("a big dog")).toBe("big dog");
    expect(normalizeAnswer("an apple")).toBe("apple");
    expect(normalizeAnswer("the house and the car")).toBe("house car");
  });

  it("collapses multiple whitespace to single space", () => {
    expect(normalizeAnswer("hello   world")).toBe("hello world");
  });

  it("removes commas before other normalization", () => {
    expect(normalizeAnswer("red, green, blue")).toBe("red green blue");
  });

  it("returns empty string for articles-only input", () => {
    expect(normalizeAnswer("the the the")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// porterStem
// ---------------------------------------------------------------------------

describe("porterStem", () => {
  it("stems plurals (-s, -es, -ies)", () => {
    expect(porterStem("cats")).toBe("cat");
    expect(porterStem("caresses")).toBe("caress");
    expect(porterStem("ponies")).toBe("poni");
  });

  it("stems -ed suffix", () => {
    expect(porterStem("agreed")).toBe("agree");
    expect(porterStem("plastered")).toBe("plaster");
  });

  it("stems -ing suffix", () => {
    expect(porterStem("running")).toBe("run");
    expect(porterStem("motoring")).toBe("motor");
  });

  it("stems -ness suffix when measure > 0", () => {
    expect(porterStem("goodness")).toBe("good");
  });

  it("leaves short words unchanged", () => {
    expect(porterStem("go")).toBe("go");
    expect(porterStem("a")).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// computeTokenF1
// ---------------------------------------------------------------------------

describe("computeTokenF1", () => {
  it("exact match: 'the cat sat' vs 'the cat sat' → F1 = 1.0", () => {
    // Both normalize to "cat sat", tokens = ["cat", "sat"]
    expect(computeTokenF1("the cat sat", "the cat sat")).toBe(1.0);
  });

  it("partial match: 'the big cat sat' vs 'the cat sat' → F1 reflects overlap", () => {
    // Predicted: "big cat sat" → ["big", "cat", "sat"]
    // Ground truth: "cat sat" → ["cat", "sat"]
    // Common = 2, Precision = 2/3, Recall = 2/2 = 1.0
    // F1 = 2 * (2/3) * 1 / (2/3 + 1) = 4/5 = 0.8
    const f1 = computeTokenF1("the big cat sat", "the cat sat");
    expect(f1).toBeCloseTo(0.8, 5);
  });

  it("no match: 'dog' vs 'cat' → F1 = 0.0", () => {
    expect(computeTokenF1("dog", "cat")).toBe(0.0);
  });

  it("normalization: 'The Cat!' vs 'the cat' → F1 = 1.0", () => {
    // Both normalize to "cat" (article "the" removed, punctuation stripped)
    expect(computeTokenF1("The Cat!", "the cat")).toBe(1.0);
  });

  it("article removal: 'a big dog' vs 'big dog' → F1 = 1.0", () => {
    // Both normalize to "big dog" after removing article "a"
    expect(computeTokenF1("a big dog", "big dog")).toBe(1.0);
  });

  it("stemming: 'running quickly' vs 'runs quick' → non-zero F1", () => {
    // "running" → "run", "runs" → "run" (matches)
    // "quickly" → "quickli", "quick" → "quick" (no match — minimal stemmer)
    // Common = 1, Precision = 1/2, Recall = 1/2
    // F1 = 2 * 0.5 * 0.5 / (0.5 + 0.5) = 0.5
    const f1 = computeTokenF1("running quickly", "runs quick");
    expect(f1).toBeGreaterThan(0);
    expect(f1).toBeCloseTo(0.5, 5);
  });

  it("empty predicted with non-empty truth → F1 = 0.0", () => {
    expect(computeTokenF1("", "hello world")).toBe(0.0);
  });

  it("both empty → F1 = 1.0", () => {
    expect(computeTokenF1("", "")).toBe(1.0);
  });

  it("token counting with duplicates (articles-only): 'the the the' vs 'the' → both empty → 1.0", () => {
    // LoCoMo normalization removes "the" as an article
    // Both become empty after normalization, so F1 = 1.0
    expect(computeTokenF1("the the the", "the")).toBe(1.0);
  });

  it("multiset intersection with non-article duplicate tokens", () => {
    // "cat cat cat" → tokens = ["cat", "cat", "cat"]
    // "cat" → tokens = ["cat"]
    // Common (multiset) = min(3,1) = 1
    // Precision = 1/3, Recall = 1/1 = 1.0
    // F1 = 2 * (1/3) * 1 / (1/3 + 1) = (2/3) / (4/3) = 1/2 = 0.5
    const f1 = computeTokenF1("cat cat cat", "cat");
    expect(f1).toBeCloseTo(0.5, 5);
  });

  it("multiset intersection with matching duplicates", () => {
    // "cat cat" → tokens = ["cat", "cat"]
    // "cat cat" → tokens = ["cat", "cat"]
    // Common = min(2,2) = 2
    // Precision = 2/2 = 1.0, Recall = 2/2 = 1.0
    // F1 = 1.0
    expect(computeTokenF1("cat cat", "cat cat")).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// aggregateF1ByCategory
// ---------------------------------------------------------------------------

function makeQAResult(overrides: Partial<QAResult> & { f1_score: number; category: string }): QAResult {
  return {
    question: "test question",
    predicted_answer: "pred",
    ground_truth_answer: "truth",
    category: overrides.category,
    f1_score: overrides.f1_score,
    search_results_used: 0,
    search_latency_ms: 0,
    answer_latency_ms: 0,
    answer_input_tokens: 0,
    answer_output_tokens: 0,
    ...overrides,
  };
}

describe("aggregateF1ByCategory", () => {
  it("computes correct mean F1 per category", () => {
    const results: QAResult[] = [
      makeQAResult({ category: "single-hop", f1_score: 0.8 }),
      makeQAResult({ category: "single-hop", f1_score: 0.6 }),
      makeQAResult({ category: "single-hop", f1_score: 1.0 }),
      makeQAResult({ category: "multi-hop", f1_score: 0.5 }),
      makeQAResult({ category: "multi-hop", f1_score: 0.7 }),
    ];

    const stats = aggregateF1ByCategory(results);

    // single-hop mean = (0.8 + 0.6 + 1.0) / 3 = 0.8
    expect(stats["single-hop"].mean_f1).toBeCloseTo(0.8, 5);
    expect(stats["single-hop"].count).toBe(3);
    expect(stats["single-hop"].min_f1).toBe(0.6);
    expect(stats["single-hop"].max_f1).toBe(1.0);

    // multi-hop mean = (0.5 + 0.7) / 2 = 0.6
    expect(stats["multi-hop"].mean_f1).toBeCloseTo(0.6, 5);
    expect(stats["multi-hop"].count).toBe(2);
    expect(stats["multi-hop"].min_f1).toBe(0.5);
    expect(stats["multi-hop"].max_f1).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// computeOverallF1
// ---------------------------------------------------------------------------

describe("computeOverallF1", () => {
  it("computes macro average of all F1 scores", () => {
    const results: QAResult[] = [
      makeQAResult({ category: "single-hop", f1_score: 0.8 }),
      makeQAResult({ category: "single-hop", f1_score: 0.6 }),
      makeQAResult({ category: "single-hop", f1_score: 1.0 }),
      makeQAResult({ category: "multi-hop", f1_score: 0.5 }),
      makeQAResult({ category: "multi-hop", f1_score: 0.7 }),
    ];

    // Overall = (0.8 + 0.6 + 1.0 + 0.5 + 0.7) / 5 = 3.6 / 5 = 0.72
    expect(computeOverallF1(results)).toBeCloseTo(0.72, 5);
  });

  it("returns 0 for empty results", () => {
    expect(computeOverallF1([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scoreResultsF1
// ---------------------------------------------------------------------------

describe("scoreResultsF1", () => {
  it("populates f1_score on each result", () => {
    const input = [
      { predicted_answer: "the cat sat", ground_truth: "the cat sat", category: "single-hop" },
      { predicted_answer: "dog", ground_truth: "cat", category: "multi-hop" },
    ];

    const scored = scoreResultsF1(input);

    expect(scored[0].f1_score).toBe(1.0);
    expect(scored[1].f1_score).toBe(0.0);
    expect(scored[0].category).toBe("single-hop");
    expect(scored[1].category).toBe("multi-hop");
  });
});
