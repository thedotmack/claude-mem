# Phase 01: Foundation & Ingestion Prototype

This phase sets up the LoCoMo evaluation project within the claude-mem codebase, downloads the benchmark dataset, builds the ingestion adapter that transforms multi-session conversations into claude-mem observations via the worker API, and ingests one complete conversation as a proof of concept. By the end, real LoCoMo dialog data will be stored as searchable claude-mem observations — demonstrating the full memory pipeline working end-to-end.

**Methodology note:** This eval uses **dual scoring** — token-level F1 (for comparison with the original LoCoMo paper, ACL 2024) and **LLM-as-a-Judge** (for comparison with modern memory systems: Mem0 at 66.88%, Zep at 65.99%, OpenAI Memory at 52.90%, full-context ceiling at 72.90%). The adversarial QA category is excluded from J-score comparison per Mem0's methodology (no available ground truth). See the Mem0 paper (arXiv 2504.19413) for baseline details.

## Tasks

- [x] Create eval project structure:
  - Create directory tree under the project root:
    - `evals/locomo/src/ingestion/`
    - `evals/locomo/src/qa/`
    - `evals/locomo/src/scoring/`
    - `evals/locomo/data/`
    - `evals/locomo/results/checkpoints/`
    - `evals/locomo/scripts/`
    - `evals/locomo/tests/`
  - Create `evals/locomo/tsconfig.json` with strict TypeScript settings (module: esnext, target: esnext, moduleResolution: bundler, strict: true) — Bun runs TS natively so this is primarily for IDE support
  - Add `evals/locomo/data/locomo-repo/` to the project's root `.gitignore` file

- [x] Download LoCoMo dataset and create TypeScript type definitions:
  - Clone `https://github.com/snap-research/locomo` into `evals/locomo/data/locomo-repo/`
  - Verify the dataset file exists (likely at `data/locomo10.json` within the cloned repo — inspect the repo structure to confirm the exact path)
  - Inspect the first entry of `locomo10.json` to understand the exact field names and structure before writing types
  - Create `evals/locomo/src/types.ts` with interfaces based on the actual data:
    - `LoCoMoConversation` — sample_id, speaker_a, speaker_b, conversation (array of sessions), qa (array of questions)
    - `LoCoMoSession` — session_id, date, turns array, plus an index signature `[key: string]: any` for dynamic keys like `session_1_observation`, `session_1_summary`, `events_session_1`
    - `LoCoMoTurn` — speaker ("A" | "B"), dia_id (number), text (string), optional img_url and blip_caption
    - `LoCoMoQA` — question, answer, category (string), evidence_dialog_ids (number array)
    - `IngestionProgress` — sample_id, total_sessions, sessions_ingested, observations_queued, status
    - `QAResult` — question, predicted_answer, ground_truth_answer, category, f1_score, judge_scores (optional JudgeAggregation), search_results_used (number), search_latency_ms (number), answer_latency_ms (number), answer_input_tokens (number), answer_output_tokens (number)
    - `JudgeResult` — score (number 0-100), explanation (string)
    - `JudgeAggregation` — mean_score (number), std_dev (number), run_count (number), individual_scores (number array)
    - `LatencyStats` — search_p50_ms, search_p95_ms, answer_p50_ms, answer_p95_ms, total_p50_ms, total_p95_ms
    - `EvalReport` — results (QAResult array), per_category_f1_scores (map of category to {mean_f1, count, min_f1, max_f1}), overall_f1, per_category_judge_scores (map of category to {mean_j, std_dev, count}), overall_judge_score (JudgeAggregation), latency_stats (LatencyStats), token_stats ({total_input_tokens, total_output_tokens, mean_tokens_per_question}), metadata (model, judge_model, timestamp, total_questions, scoring_methods: string[])

- [x] Build dataset loader module with validation:
  - Create `evals/locomo/src/dataset-loader.ts`
  - `loadDataset()` — reads and parses `locomo10.json` from the cloned repo, returns typed array of conversations
  - `getConversation(sampleId)` — returns a single conversation by sample_id
  - `getSessionsForConversation(conversation)` — extracts sessions and resolves dynamic keys for each session (e.g., for session_id=1, look up `session_1_observation`, `session_1_summary`, `events_session_1`), returning an enriched session object with observation, summary, and events fields
  - `getQuestionsForConversation(conversation, options?)` — returns typed QA questions array. Accept an optional `excludeCategories` array parameter (default: exclude "adversarial" for J-score comparison). When called without options, exclude adversarial. Provide a separate `getAllQuestionsForConversation(conversation)` that returns all categories including adversarial (for F1-only analysis)
  - `getDatasetStats()` — returns object with: conversation_count, total_sessions, total_qa_questions, qa_by_category (map of category string to count), qa_excluding_adversarial (total count without adversarial)
  - Create `evals/locomo/scripts/validate-dataset.ts` — loads the dataset, calls `getDatasetStats()`, prints a formatted stats table showing conversation count, session counts, and QA question counts grouped by category. Clearly show the adversarial count separately and note it's excluded from J-score comparison
  - Run the validation script with `bun evals/locomo/scripts/validate-dataset.ts` and verify the output shows 10 conversations with reasonable session and QA counts

- [x] Build worker API client module:
  - Read the worker's HTTP routes to understand exact API contract: examine `src/services/worker/http/routes/SessionRoutes.ts` and `src/services/worker/http/routes/SearchRoutes.ts` for endpoint paths, request/response formats, and authentication requirements
  - Create `evals/locomo/src/ingestion/worker-client.ts`
  - Read the auth token from `~/.claude-mem/.env` (look for variables like `AUTH_TOKEN` or `CLAUDE_MEM_AUTH_TOKEN` — read the file to find the exact variable name used)
  - Base URL: `http://localhost:37777`
  - Implement typed methods:
    - `initSession(contentSessionId: string, project: string, userPrompt: string)` — POST to session init endpoint
    - `queueObservation(contentSessionId: string, toolName: string, toolInput: string, toolResponse: string, promptNumber: number)` — POST to observations endpoint
    - `completeSession(contentSessionId: string)` — POST to session complete endpoint
    - `getSessionStatus(contentSessionId: string)` — GET session status
    - `waitForProcessing(contentSessionId: string, timeoutMs: number)` — poll getSessionStatus every 2 seconds until queue is empty or timeout reached
    - `search(query: string, project: string, limit: number)` — GET search endpoint. **Instrument with timing**: record search_latency_ms from request start to response received
  - Include error handling with descriptive messages: connection refused → "Worker not running at localhost:37777", 401 → "Invalid auth token", 5xx → include response body

- [x] Build ingestion adapter:
  - Create `evals/locomo/src/ingestion/adapter.ts`
  - `generateContentSessionId(sampleId: string, sessionId: number)` — returns deterministic ID like `locomo-{sampleId}-s{sessionId}`
  - `generateProjectName(sampleId: string)` — returns `locomo-eval-{sampleId}` (one project per conversation for isolated search during QA)
  - `formatSessionAsToolExecution(conversation, session, enrichedSession)` — transforms a LoCoMo session into worker API parameters:
    - `toolName`: `"Read"`
    - `toolInput`: `JSON.stringify({file_path: "conversation-transcript/session-" + sessionId + ".txt"})`
    - `toolResponse`: formatted dialog transcript like:
      ```
      [Session {N} — {date}]
      [Conversation between {speaker_a} and {speaker_b}]

      {speaker_a}: {turn 1 text}
      {speaker_b}: {turn 2 text}
      ...
      ```
    - `userPrompt`: `"Conversation between {speaker_a} and {speaker_b} on {date}"`
  - Keep the tool_response as raw dialog only — let claude-mem's Sonnet 4.6 agent compress and extract observations naturally, simulating real usage

- [x] Create and run prototype ingestion script for one conversation:
  - Create `evals/locomo/scripts/ingest-one.ts`
  - On startup, check if the worker is running by fetching `http://localhost:37777/api/health` (or any known endpoint) — if connection refused, print a message asking the user to start the worker with `bun plugin/scripts/worker-service.cjs start`, then exit with code 1
  - Load the first conversation from the dataset
  - For each session in the conversation:
    1. Generate IDs using the adapter
    2. Init a claude-mem session via worker client
    3. Format dialog turns as a tool execution via adapter
    4. Queue the observation via worker client
    5. Wait for processing to complete (poll every 3 seconds, timeout 180 seconds per session)
    6. Complete the session
    7. Log: `"Session {N}/{total} ingested — processing took {seconds}s"`
  - Print final summary: conversation sample_id, total sessions ingested, total time elapsed
  - Run: `bun evals/locomo/scripts/ingest-one.ts`
  - Verify it completes without errors (note: this makes real API calls to Anthropic for observation compression, so it may take several minutes)

- [x] Verify ingested data via search and display results:
  - Create `evals/locomo/scripts/verify-ingestion.ts`
  - Search claude-mem for all observations under the first conversation's project name (use the same project name from the adapter)
  - Print: total observations found, and for each observation print its title and first 100 chars of narrative
  - Pick 3 QA questions from the ingested conversation (one single-hop, one multi-hop if available, one temporal if available — skip adversarial)
  - For each question, search claude-mem with the question text scoped to the conversation's project
  - Print formatted output for each question:
    ```
    Q: {question text}
    Category: {category}
    Ground Truth: {answer}
    Top Search Results:
      1. {observation title} — {first 80 chars of narrative}
      2. {observation title} — {first 80 chars of narrative}
      3. {observation title} — {first 80 chars of narrative}
    ```
  - Run: `bun evals/locomo/scripts/verify-ingestion.ts`
  - This validates that the ingestion pipeline works end-to-end: LoCoMo dialog → claude-mem observations → searchable context
