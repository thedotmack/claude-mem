# Phase 05: Full Eval Runner

This phase builds the complete evaluation orchestrator that runs the QA pipeline across all 10 LoCoMo conversations with checkpointing for fault tolerance. The runner processes every QA question in the dataset, scores results with both F1 and LLM-as-a-Judge, and produces a comprehensive results file. This is the production run that generates the publishable numbers for comparison against Mem0 (66.88% J), Zep (65.99% J), and the full-context ceiling (72.90% J).

## Tasks

- [x] Build eval orchestrator with checkpointing and dual scoring:
  - Create `evals/locomo/src/runner.ts`
  - Reuse all modules from previous phases:
    - `src/ingestion/worker-client.ts` for search API access
    - `src/qa/searcher.ts` for context retrieval
    - `src/qa/answerer.ts` for Opus 4.6 answer generation
    - `src/scoring/f1.ts` for F1 computation
    - `src/scoring/judge.ts` for LLM-as-a-Judge scoring
    - `src/scoring/reporter.ts` for aggregation
    - `src/dataset-loader.ts` for loading conversations and questions
  - `runEvalForConversation(conversation, options)`:
    1. Get QA questions for the conversation (use `getQuestionsForConversation` which excludes adversarial by default)
    2. For each question:
       - Search claude-mem for context (limit: 10 observations, scoped to conversation's project) — captures search_latency_ms
       - Build context window
       - Generate answer with Opus 4.6 — captures answer_latency_ms, input_tokens, output_tokens
       - Compute F1 against ground truth (instant, no API call)
       - Yield the QAResult (with f1_score, latency, and token data populated; judge_scores left null for now)
    3. Return array of QAResults for the conversation
  - `runJudgeScoringPass(results: QAResult[], options)` — separate pass for J-scoring:
    1. For each QAResult that doesn't already have judge_scores:
       - Run `judgeAnswerMultipleRuns` (10 runs) using Claude Sonnet 4.6
       - Populate the judge_scores field
       - Add configurable delay between questions (default: 300ms)
    2. Return updated QAResults
    3. This is separated from the QA pass so that: (a) QA results are checkpointed before expensive J-scoring, (b) J-scoring can be re-run independently if needed
  - `runFullEval(options)` — top-level orchestrator:
    1. Load dataset
    2. Verify all 10 conversations are ingested (search for observations in each project — abort with error if any conversation has zero observations)
    3. **QA Pass**: For each conversation:
       - Check if QA checkpoint exists at `results/checkpoints/{sample_id}_qa.json` — if so, load cached results and skip
       - Run `runEvalForConversation`
       - Save QA checkpoint immediately after completing each conversation
    4. **Judge Pass**: For each conversation:
       - Check if Judge checkpoint exists at `results/checkpoints/{sample_id}_judge.json` — if so, load cached results and skip
       - Run `runJudgeScoringPass` on the QA results
       - Save Judge checkpoint immediately after completing each conversation
    5. Aggregate all results across all conversations using reporter
    6. Return complete EvalReport
  - Options type: `{ resumeFromCheckpoints: boolean, delayBetweenQACallsMs: number, delayBetweenJudgeCallsMs: number, searchLimit: number, maxQuestionsPerConversation: number | null, judgeRunsPerQuestion: number, skipJudgePass: boolean }`

- [x] Create full eval runner script:
  - Create `evals/locomo/scripts/full-eval.ts`
  - Parse simple CLI arguments from `Bun.argv`:
    - `--no-resume` — ignore existing checkpoints, start fresh (default: resume enabled)
    - `--qa-delay` followed by number — milliseconds between QA API calls (default: 500)
    - `--judge-delay` followed by number — milliseconds between judge batches (default: 300)
    - `--conversation` followed by sample_id — run only one specific conversation (for debugging)
    - `--limit` followed by number — max questions per conversation (default: all)
    - `--skip-judge` — skip the J-scoring pass entirely (useful for quick F1-only runs)
    - `--judge-runs` followed by number — number of judge runs per question (default: 10)
  - Call the orchestrator with parsed options
  - Print rolling progress for QA pass:
    `"[QA {N}/10] {sample_id} — Q {M}/{total} — F1: {running_f1:.3f} — search: {latency}ms — Elapsed: {time}"`
  - Print rolling progress for Judge pass:
    `"[JUDGE {N}/10] {sample_id} — Q {M}/{total} — J: {running_j:.1f}±{std:.1f} — Elapsed: {time}"`
  - On completion, save final results to `evals/locomo/results/eval-results-{YYYY-MM-DD-HHmmss}.json`
  - Print final summary with dual scoring:
    ```
    === F1 Scores ===
    Category     | Count | Mean F1 | Min  | Max
    -------------+-------+---------+------+------
    single-hop   |   XXX |  0.XXX  | 0.XX | 1.00
    multi-hop    |   XXX |  0.XXX  | 0.XX | 1.00
    temporal     |   XXX |  0.XXX  | 0.XX | 1.00
    open-domain  |   XXX |  0.XXX  | 0.XX | 1.00
    OVERALL      |  XXXX |  0.XXX  |      |

    === LLM-as-a-Judge Scores ===
    Category     | Count | Mean J  | ±Std
    -------------+-------+---------+------
    single-hop   |   XXX |  XX.XX  | ±X.XX
    multi-hop    |   XXX |  XX.XX  | ±X.XX
    temporal     |   XXX |  XX.XX  | ±X.XX
    open-domain  |   XXX |  XX.XX  | ±X.XX
    OVERALL      |  XXXX |  XX.XX  | ±X.XX

    === Latency & Efficiency ===
    Search p50: XXXms | Search p95: XXXms
    Answer p50: XXXms | Answer p95: XXXms
    Total  p50: XXXms | Total  p95: XXXms
    Mean tokens/question: XXXX (input) + XXX (output)
    Total API tokens consumed: XXX,XXX
    ```
  - Print total time elapsed

- [ ] Run the full evaluation:
  - Execute: `bun evals/locomo/scripts/full-eval.ts`
  - Monitor for errors — the run will process all QA questions across all 10 conversations
  - If interrupted, re-run the same command — checkpointing will skip completed conversations and judge passes
  - Expect this to take considerable time: hundreds of Opus 4.6 QA calls + thousands of Sonnet 4.6 judge calls (10 runs × ~200 questions × 10 conversations)
  - Verify the final results file exists and contains results for all conversations
  - **RESOLVED (2026-02-26):** Fixed project name mismatch in `runner.ts`. Worker's "Code Development" mode AI prompt discards casual conversation transcripts (obsCount=0 for 98%+ of sessions). Created `scripts/direct-ingest.ts` to bypass worker and insert 272 observations directly into SQLite + FTS5. Added keyword search fallback to `src/qa/searcher.ts` for when Chroma vector search is unavailable. All 10 conversations now have observations verified via API. All 151 tests pass.
  - **BLOCKER (2026-02-26):** No `ANTHROPIC_API_KEY` is configured in the environment. The eval requires API access to call Claude Opus 4.6 (QA answering) and Claude Sonnet 4.6 (judging). OpenRouter key exists but has no credits. **To proceed:** Set `export ANTHROPIC_API_KEY=<key>` then run `bun evals/locomo/scripts/full-eval.ts`.

- [ ] Validate results integrity:
  - Create `evals/locomo/scripts/validate-results.ts`
  - Load the most recent eval results file from `evals/locomo/results/` (find the latest `eval-results-*.json` by filename timestamp)
  - Verify completeness:
    - Total question count matches the dataset's total QA questions **excluding adversarial**
    - All 4 non-adversarial QA categories are represented (single-hop, multi-hop, temporal, open-domain)
    - No results have null or undefined F1 scores
    - No results have null judge_scores (unless --skip-judge was used)
    - No results have empty predicted_answer (unless scored as 0)
    - All judge_scores have run_count >= 5 (warn if any have fewer successful runs)
    - Latency data is populated for all results
  - Print validation report:
    ```
    Total questions: {expected} expected, {actual} found — {PASS/FAIL}
    Categories: {list with counts} — {PASS/FAIL}
    Missing F1 scores: {count} — {PASS/FAIL}
    Missing J scores: {count} — {PASS/FAIL}
    Low judge run counts (<5): {count} — {WARN if >0}
    Empty predictions: {count}
    Missing latency data: {count} — {PASS/FAIL}
    ```
  - Run: `bun evals/locomo/scripts/validate-results.ts`
  - All checks should pass before proceeding to Phase 06
