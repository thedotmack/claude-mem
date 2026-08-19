# Phase 04: Dual Scoring Engine (F1 + LLM-as-a-Judge)

This phase implements two complementary scoring methodologies. **Token-level F1** follows the original LoCoMo paper (ACL 2024) for comparison with historical baselines. **LLM-as-a-Judge (J-score)** follows the Mem0 paper (arXiv 2504.19413, ECAI accepted) for comparison with modern memory systems — Mem0 (66.88%), Mem0g (68.44%), Zep (65.99%), full-context (72.90%). The J-scorer uses Claude Sonnet 4.6 as judge (different model from the Opus 4.6 answerer to avoid self-judging bias), with 10 independent runs per question for statistical significance, matching Mem0's methodology.

## Tasks

- [x] Build F1 scoring module:
  - Create `evals/locomo/src/scoring/f1.ts`
  - `normalizeAnswer(text: string)` — apply the standard normalization pipeline used in extractive QA benchmarks:
    1. Convert to lowercase
    2. Remove articles: "a", "an", "the"
    3. Remove all punctuation (keep alphanumeric and spaces)
    4. Collapse multiple whitespace to single space
    5. Trim leading/trailing whitespace
  - `porterStem(word: string)` — implement a minimal Porter stemmer (Step 1a/1b/1c at minimum: plurals, -ed, -ing, -ness). Alternatively, check if the LoCoMo repo contains their scoring implementation at `data/locomo-repo/` — if they provide a Python scoring script, match their exact normalization pipeline for fair comparison
  - `tokenize(normalizedText: string)` — split on whitespace, apply Porter stemming to each token
  - `computeTokenF1(predicted: string, groundTruth: string)` — the core scoring function:
    1. Normalize both strings
    2. Tokenize both (with stemming)
    3. Compute token overlap: `common = intersection of predicted tokens and ground truth tokens` (use multiset intersection — count each token occurrence)
    4. Precision = |common| / |predicted_tokens| (0 if predicted is empty)
    5. Recall = |common| / |ground_truth_tokens| (0 if ground truth is empty)
    6. F1 = 2 * P * R / (P + R), or 0 if P + R = 0
    7. Special case: if both are empty strings after normalization, F1 = 1.0 (both "said nothing")
  - Export all functions for testing

- [x] Build LLM-as-a-Judge scoring module:
  - Create `evals/locomo/src/scoring/judge.ts`
  - Import the Anthropic SDK (already installed in Phase 03)
  - **Judge system prompt** — instruct Claude Sonnet 4.6 to act as an impartial evaluator that scores a predicted answer against a ground truth answer on a 0-100 scale. The judge evaluates on four dimensions matching Mem0's criteria:
    - Factual accuracy (is the predicted answer factually correct based on the ground truth?)
    - Completeness (does the prediction capture the key information from the ground truth?)
    - Relevance (is the answer relevant to the question asked?)
    - Contextual appropriateness (is the answer well-grounded in the conversation context?)
  - **Judge user prompt** — `buildJudgePrompt(question: string, groundTruth: string, predictedAnswer: string, category: string)`:
    - Include the question, ground truth answer, and predicted answer
    - Include a category label so the judge can apply appropriate standards (e.g., temporal questions need exact date/order matching)
    - Request structured output: a JSON object with `{"score": <0-100>, "explanation": "<1-2 sentence rationale>"}`
  - `judgeAnswer(question: string, groundTruth: string, predictedAnswer: string, category: string)` — single judge call:
    - Call Anthropic API with model `claude-sonnet-4-6`
    - Set max_tokens to 256
    - Set temperature to 0.5 (enables variance across runs while keeping reasonable consistency — Mem0 reported stddev of ±0.15 to ±0.75 across 10 runs)
    - Parse the JSON response to extract score and explanation
    - Handle parse failures gracefully: if JSON parsing fails, attempt to extract a numeric score from the text; if that fails, return score -1 with error explanation
    - Return `JudgeResult` (score 0-100, explanation string)
  - `judgeAnswerMultipleRuns(question: string, groundTruth: string, predictedAnswer: string, category: string, numRuns: number)` — run `judgeAnswer` N times (default: 10) and aggregate:
    - Execute all runs (can be parallelized with Promise.all in batches of 3 to balance speed vs rate limits)
    - Filter out any runs with score -1 (parse failures)
    - Compute mean score, standard deviation, and individual scores array
    - Return `JudgeAggregation` ({ mean_score, std_dev, run_count, individual_scores })
    - If fewer than 5 successful runs, log a warning (indicates systematic judge failure)

- [x] Build results aggregation and reporting module with dual metrics:
  - Create `evals/locomo/src/scoring/reporter.ts`
  - Import types from `evals/locomo/src/types.ts`
  - `scoreResultsF1(results: Array<{predicted_answer: string, ground_truth: string, category: string}>)` — apply `computeTokenF1` to each result, return array of QAResult with f1_score filled in
  - `aggregateF1ByCategory(results: QAResult[])` — group by category, compute mean F1 per category, return map of category to {mean_f1, count, min_f1, max_f1}
  - `computeOverallF1(results: QAResult[])` — macro average: sum of all F1 scores / total questions
  - `aggregateJudgeByCategory(results: QAResult[])` — group by category, compute mean J-score per category (averaging the per-question mean_scores), return map of category to {mean_j, pooled_std_dev, count}
  - `computeOverallJudge(results: QAResult[])` — macro average of per-question mean J-scores, with pooled standard deviation
  - Define **F1 baselines** (from original LoCoMo paper + Mem0 paper):
    ```
    F1_BASELINES = {
      "Human": { overall: 87.9 },
      "Mem0": { overall: null, single_hop: 38.72, multi_hop: 28.64, temporal: 48.93, open_domain: 47.65 },
      "Mem0g": { overall: null, single_hop: 38.09, multi_hop: 24.32, temporal: 51.55, open_domain: 49.27 },
      "Zep": { overall: null, single_hop: 35.74, multi_hop: 19.37, temporal: 42.00, open_domain: 49.56 },
      "LangMem": { overall: null, single_hop: 35.51, multi_hop: 26.04, temporal: 30.75, open_domain: 40.91 },
      "OpenAI Memory": { overall: null, single_hop: 34.30, multi_hop: 20.09, temporal: 14.04, open_domain: 39.31 },
      "A-Mem": { overall: null, single_hop: 20.76, multi_hop: 9.22, temporal: 35.40, open_domain: 33.34 },
      "GPT-3.5-turbo-16K": { overall: 37.8 },
      "RAG-observations (original paper)": { overall: 41.4 },
      "GPT-4-turbo": { overall: 32.1 }
    }
    ```
  - Define **J-score baselines** (from Mem0 paper, arXiv 2504.19413 — adversarial excluded):
    ```
    J_BASELINES = {
      "Full-context": { overall: 72.90 },
      "Mem0g": { overall: 68.44, single_hop: 65.71, multi_hop: 47.19, temporal: 58.13, open_domain: 75.71 },
      "Mem0": { overall: 66.88, single_hop: 67.13, multi_hop: 51.15, temporal: 55.51, open_domain: 72.93 },
      "Zep": { overall: 65.99, single_hop: 61.70, multi_hop: 41.35, temporal: 49.31, open_domain: 76.60 },
      "RAG (best, k=2 256-tok)": { overall: 60.97 },
      "LangMem": { overall: 58.10, single_hop: 62.23, multi_hop: 47.92, temporal: 23.43, open_domain: 71.12 },
      "OpenAI Memory": { overall: 52.90, single_hop: 63.79, multi_hop: 42.92, temporal: 21.71, open_domain: 62.29 },
      "A-Mem": { overall: 48.38, single_hop: 39.79, multi_hop: 18.85, temporal: 49.91, open_domain: 54.05 }
    }
    ```
    **Note:** Letta reports 74.0% "accuracy" using a different scoring methodology (not LLM-as-a-Judge), so it's not directly comparable. Include as a footnote only.
  - `formatF1ComparisonTable(evalResults: QAResult[], f1Baselines)` — markdown table comparing claude-mem F1 against all F1 baselines, per-category and overall
  - `formatJudgeComparisonTable(evalResults: QAResult[], jBaselines)` — markdown table comparing claude-mem J-scores against all J baselines, per-category and overall, with ± stddev
  - `formatLatencyComparisonTable(latencyStats: LatencyStats)` — markdown table comparing claude-mem latency/tokens against Mem0's published numbers (search p50: 0.148s, search p95: 0.200s, total p50: 0.708s, total p95: 1.440s, tokens: 1,764)
  - `formatFullReport(evalResults: QAResult[])` — generate complete markdown report string combining all three comparison tables plus per-category breakdown, top-5/bottom-5 questions for error analysis, and latency/token summary

- [x] Write scoring tests (F1 + Judge):
  - Create `evals/locomo/tests/f1-scoring.test.ts`
  - Test exact match: "the cat sat" vs "the cat sat" → F1 = 1.0
  - Test partial match: "the big cat sat" vs "the cat sat" → F1 should reflect correct token overlap
  - Test no match: "dog" vs "cat" → F1 = 0.0
  - Test normalization: "The Cat!" vs "the cat" → F1 = 1.0
  - Test article removal: "a big dog" vs "big dog" → F1 = 1.0
  - Test stemming: "running quickly" vs "runs quick" → should have non-zero F1 after stemming
  - Test empty predicted with non-empty truth → F1 = 0.0
  - Test both empty → F1 = 1.0
  - Test token counting with duplicates: "the the the" vs "the" → verify multiset precision/recall behavior
  - Test aggregateF1ByCategory with mock data: 3 single-hop (F1: 0.8, 0.6, 1.0) and 2 multi-hop (F1: 0.5, 0.7) → verify category means are correct
  - Test computeOverallF1 matches expected weighted average
  - Create `evals/locomo/tests/judge-scoring.test.ts`
  - Test `buildJudgePrompt` includes question, ground truth, predicted answer, and category
  - Mock the Anthropic SDK to test `judgeAnswer` — verify it calls with model `claude-sonnet-4-6`, temperature 0.5, max_tokens 256
  - Test JSON parse error handling: mock a response with malformed JSON → verify score -1 returned
  - Test `judgeAnswerMultipleRuns` aggregation: mock 10 runs returning scores [70, 72, 68, 71, 73, 69, 70, 72, 71, 70] → verify mean ≈ 70.6, stddev ≈ ~1.5
  - Test filtering of failed runs: mock 10 runs where 2 return score -1 → verify aggregation uses only 8 successful runs and warns

- [x] Run all scoring tests and fix failures:
  - Run: `bun test evals/locomo/tests/f1-scoring.test.ts`
  - Run: `bun test evals/locomo/tests/judge-scoring.test.ts`
  - Fix any test failures
  - ✅ All tests pass: 25/25 F1 scoring, 14/14 judge scoring, 119/119 full suite (0 failures)

- [x] Score the Phase 03 prototype results with both methods:
  - Create `evals/locomo/scripts/score-prototype.ts`
  - Load prototype results from `evals/locomo/results/qa-prototype-results.json`
  - **F1 scoring**: Apply `scoreResultsF1` to get F1 scores for each question. Print per-category F1 breakdown and overall F1.
  - **J-scoring**: For each question, run `judgeAnswerMultipleRuns` with 10 runs. This will make 10 × N judge API calls — for the ~20 prototype questions, that's ~200 calls. Add a 200ms delay between batches.
  - Print dual comparison tables:
    - F1 comparison against F1 baselines
    - J-score comparison against J baselines
    - Latency summary from the prototype run data
  - Note in output: "Prototype only (~20 questions from 1 conversation). Full eval in Phase 05."
  - Run: `bun evals/locomo/scripts/score-prototype.ts`
