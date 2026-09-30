# Phase 03: QA Answer Pipeline

This phase builds the question-answering pipeline that searches claude-mem for relevant context and uses Opus 4.6 to generate answers. For each LoCoMo QA question, the pipeline retrieves observations from the ingested conversation, formats them as context with category-specific prompting, and calls Opus 4.6 for an extractive answer. All calls are instrumented with latency and token tracking for production-readiness comparison against Mem0's published metrics (p95 latency 1.44s, ~1,764 tokens/query). A prototype run on one conversation's questions validates the pipeline end-to-end.

## Tasks

- [x] Build search retrieval module: *(completed 2026-02-26 — created `evals/locomo/src/qa/searcher.ts` with `searchForContext`, `formatSearchResultsAsContext`, `buildContextWindow`; reuses WorkerClient from ingestion layer; observation-boundary-aware truncation)*
  - Create `evals/locomo/src/qa/searcher.ts`
  - Reuse the worker client from `evals/locomo/src/ingestion/worker-client.ts` for search API access
  - `searchForContext(question: string, project: string, limit: number)` — searches claude-mem observations using the worker client's search method, scoped to the conversation's project. Returns `{ results, search_latency_ms }` where search_latency_ms is measured from the worker client's instrumented search method
  - `formatSearchResultsAsContext(searchResults)` — concatenates observation titles, facts, and narratives from search results into a single context string, with clear section separators between observations
  - `buildContextWindow(formattedContext: string, maxChars: number)` — truncates context to fit within a character budget (default: 12000 chars, roughly 3000 tokens), truncating at the last complete observation boundary rather than mid-sentence
  - Return type should include both the formatted context string and metadata: number of observations used, total characters

- [x] Build QA prompt templates and answer generator: *(completed 2026-02-26 — installed `@anthropic-ai/sdk@0.78.0`; created `prompts.ts` with `QA_SYSTEM_PROMPT` and `buildUserPrompt` with 5 category hints; created `answerer.ts` with `answerQuestion` using claude-opus-4-6, temperature=0, max_tokens=256, latency+token instrumentation)*
  - Check if `@anthropic-ai/sdk` is already in the root `package.json` — if not, install it with `bun add @anthropic-ai/sdk`
  - Create `evals/locomo/src/qa/prompts.ts`
  - System prompt: instruct the model to answer based ONLY on the provided conversation context, give short extractive answers (not full sentences), and respond with exactly "unanswerable" if the context doesn't contain sufficient information
  - `buildUserPrompt(question: string, context: string, category: string)` — format the user message with the context block followed by the question, including a category-specific instruction hint:
    - single-hop: "Answer using a specific piece of evidence from the context."
    - multi-hop: "This may require combining information from multiple conversation sessions."
    - temporal: "Pay careful attention to dates and the temporal ordering of events."
    - open-domain: "You may use both the provided context and general knowledge."
    - adversarial: "Be careful — verify claims against the context before answering. The question may contain false premises."
  - Create `evals/locomo/src/qa/answerer.ts`
  - `answerQuestion(question: string, context: string, category: string)` — calls Anthropic API with model `claude-opus-4-6`:
    - Use the system prompt and user prompt from the prompts module
    - Set max_tokens to 256 (answers should be short and extractive)
    - Set temperature to 0 for deterministic answers
    - **Instrument with timing**: record `answer_latency_ms` from API call start to response received
    - **Track tokens**: extract `input_tokens` and `output_tokens` from the API response `usage` field
  - Extract the answer text from the API response content blocks
  - Return: `{ predicted_answer: string, input_tokens: number, output_tokens: number, answer_latency_ms: number }`

- [x] Create and run QA prototype on one conversation: *(completed 2026-02-26 — created `evals/locomo/scripts/run-qa-one.ts` with OpenRouter fallback auth; ran on conv-26 with 20 questions (10 temporal, 8 single-hop, 2 multi-hop); mean search latency 1165ms, mean answer latency 2032ms, ~455 tokens/question; results saved to `qa-prototype-results.json`)*
  - Create `evals/locomo/scripts/run-qa-one.ts`
  - Load the first conversation (same one ingested in Phase 01)
  - Get all QA questions for this conversation (use `getQuestionsForConversation` which excludes adversarial by default)
  - For speed, limit to the first 20 questions for the prototype (include mix of categories)
  - For each question:
    1. Search claude-mem for context using the conversation's project name (limit: 10 results)
    2. Build context window from search results
    3. Call answerer to generate predicted answer with Opus 4.6
    4. Log one line per question: `"{category} | Q: {question_truncated} | Pred: {answer} | Truth: {ground_truth} | search: {search_latency_ms}ms | answer: {answer_latency_ms}ms"`
  - Save all results to `evals/locomo/results/qa-prototype-results.json` as an array of objects with: question, category, predicted_answer, ground_truth, search_results_count, search_latency_ms, answer_latency_ms, answer_input_tokens, answer_output_tokens
  - Print summary: total questions answered, breakdown by category, sample of 3 predictions vs ground truth, **latency summary** (mean/p95 search latency, mean/p95 answer latency, mean tokens per question)
  - Add a 500ms delay between API calls to avoid rate limits
  - Run: `bun evals/locomo/scripts/run-qa-one.ts`

- [x] Write and run QA pipeline tests: *(completed 2026-02-26 — created `evals/locomo/tests/qa-pipeline.test.ts` with 23 tests: formatSearchResultsAsContext (5 tests: multi-obs separators, empty array, raw text fallback, partial fields, 3-obs separators), buildContextWindow (6 tests: under-budget passthrough, boundary truncation, tight budget, zero budget, empty context, default maxChars), buildUserPrompt (7 tests: all 5 category hints, context+question inclusion, unknown category fallback), answerQuestion with mocked Anthropic client (5 tests: correct model/system/max_tokens, text extraction+trim, empty content→unanswerable, token/latency metrics, multi-block join); all 80 tests across 7 files pass)*
  - Create `evals/locomo/tests/qa-pipeline.test.ts`
  - Test `formatSearchResultsAsContext` correctly formats multiple observations with separators
  - Test `buildContextWindow` truncates at observation boundaries (not mid-text)
  - Test `buildContextWindow` returns full context when under budget
  - Test `buildUserPrompt` includes the correct category hint for each of the 5 categories
  - Test `buildUserPrompt` includes both the context block and the question
  - Mock the Anthropic SDK client to test `answerQuestion` without real API calls — verify it sends the correct model, system prompt, and max_tokens
  - Run: `bun test evals/locomo/tests/qa-pipeline.test.ts`
  - Fix any failures
