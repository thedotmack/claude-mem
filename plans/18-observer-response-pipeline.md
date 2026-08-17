# [plan-18] Observer Response Pipeline — classify every output, never confirm a batch on failure, bound every history

> **Tracker:** #3606 · **Design doc:** `plans/18-observer-response-pipeline.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611

## Defect

`ResponseProcessor` has effectively one bucket for "the model did not return well-formed `<observation>`/`<summary>`/`<skip_summary/>` XML", and that bucket **confirms the claimed batch** (`confirmClaimedMessages()`) — so every non-XML reply is silent data loss, and the pipeline's countermeasures are either dead or self-defeating:

- Skip contract mismatch: `modes/*.json` `skip_guidance` says "return an empty response"; the parser accepts only `<skip_summary reason=…/>`; empty → `idle`, "no observations to record" → `prose`. Both were counted toward `consecutiveInvalidOutputs >= 3` → "SDK session poisoned — killing and respawning" (hundreds of respawns/day, `conversationHistory` wiped, batches never redelivered). 13.11.0 removed the escalation but left the counter assigned `0` at five sites and never incremented, and left the silent drop.
- Auth failures (`Failed to authenticate 403/401`, `Not logged in`), model errors (`There's an issue with the selected model`), transport errors (`Connection closed mid-response`), context overflow (`Prompt is too long` arriving as assistant *text*, not a throw), XML schema drift (`<kind>/<detail>` instead of `<type>/<title>`), and closed `<observation>` blocks with prose but no fields are all classified `prose`/`xml` and dropped; only quota and (recently) auth have preserve-work branches; the malformed turn is pushed into `conversationHistory` *before* validation so drift self-reinforces for the rest of the session.
- Empty requests: the generator auto-starts with `queueDepth=0`, sends an empty INIT turn, gets `""` back, and bins already-claimed messages; `SessionManager` discards the stored `memory_session_id` whenever the session is absent from the in-memory map ("Issue #817") even when the worker never restarted, so a 180 s idle eviction sends the next batch back through INIT where the model's reply consumes it.
- No token budget anywhere: `session.conversationHistory` is push-only (`ClaudeProvider.ts:490/528/552`, `OpenAICompatibleProvider.ts:105/215/265`, `ResponseProcessor.ts:294`) and #3096 removed the OpenAI-compatible `truncateHistory()`; the OpenRouter copy that remains returns `[]` when a single message exceeds `MAX_TOKENS` (400 from the API, observation marked failed); the OpenAI-compatible provider appends each assistant reply **twice**; `max_tokens: 4096` is hardcoded and `finish_reason=length` is never logged (76 % of responses truncated, trailing block lost, degenerate repetition hidden by `content_hash`); base64/image payloads and unbounded per-field tool output go straight into the prompt; the paused-for-auth buffer (`buffers=new Map`, removed only by `confirm()`) grows to GBs; ~10× token amplification is billed to the user's subscription at DEBUG log level.
- Output quality is unenforced: the `type` enum is logged as invalid then stored verbatim (or defaulted to `bugfix`); write-time dedup is byte-identical `content_hash` only, so paraphrased restatements flood the recall window; reasoning models' legitimately empty `content` with `reasoning_content` is treated as an init failure; provider settings are validated for *all* providers regardless of the active one so a retired Gemini id blocks every settings save.

The fix is one explicit classifier with one policy table: every output class maps to {preserve batch | confirm batch | abort session with reason}, and every history/buffer/response has a budget.

## Children

- #2817 — v13.4.0: observer still poison-loops on prose-empty responses despite plan-11 recovery
- #2866 — Observer silently drops observations on "Prompt is too long" — strip image/base64 payloads
- #2906 — Flood queue: over 100 nested observer packages appearing in a single message
- #2915 — After switching Claude Code to Zhipu GLM via cc switch, only prompts are recorded, never answers (model error classified as prose)
- #2935 — Generator poison loop: prompt says 'return empty response' but parser only accepts <skip_summary/>
- #2955 — SDK session poison-loop: generator emits prose "empty observation" instead of <skip_summary/>
- #2956 — Claude provider (SDKAgent) has no context bound — observer overflows and saves zero memory on long sessions
- #2958 — tracking: Claude provider observer overflows context window — no bound on history size
- #2960 — tracking: observer poison loop — skip-prose counted as invalid
- #2995 — Support disabling reasoning for OpenRouter / OpenAI-compatible providers (reasoning eats `max_tokens`)
- #3038 — Near-duplicate observations accumulate: content_hash only dedups byte-identical rows
- #3083 — Windows reliability: poison-loop still present in 13.8.1 (lifecycle half → plan-15)
- #3163 — Capture-side dedup: title-level boilerplate observations bypass content_hash and flood the recall window
- #3188 — Surface BYOK / custom OpenAI-compatible endpoint in the CLI installer and Settings UI
- #3193 — Observer poisons on correct-empty batches: polite 'ready/waiting' prose counts as 3-strikes invalid
- #3351 — Data loss: closed <observation> blocks with unstructured prose are permanently discarded (no salvage, no retry)
- #3443 — Observer history is unbounded again since #3096: 1M-token single calls on the OpenAI-compatible provider path
- #3454 — Observer discards 63% of turns — 170/day empty (idle) responses, plus dead consecutiveInvalidOutputs counter
- #3457 — Viewer settings can never be saved when a retired Gemini model is left in settings.json — and the UI hides the reason
- #3461 — Observer XML schema drift causes permanent, silent observation loss for the rest of a session
- #3490 — `max_tokens` hardcoded to 4096 silently truncates 76% of observation responses
- #3491 — OpenRouter truncateHistory returns an empty array when one message exceeds MAX_TOKENS → 400 and a lost observation
- #3492 — Observer never leaves the INIT prompt: idle eviction discards memory_session_id on a worker that never restarted
- #3495 — Claude-mem logs dead-ends and incorrect memories
- #3497 — Observer conversationHistory is never trimmed — ~10x token amplification billed silently
- #3499 — OpenAI-compatible provider appends the same assistant response to conversationHistory twice
- #3560 — Filter Bash capture by command pattern (SKIP_TOOLS is too coarse) — capture gate as token budget
- #3569 — OpenRouter init fails on empty content from reasoning models (DeepSeek V4 Flash)
- #3588 — Auth failure → buffered observations never drain: single worker heap reaches 5.6 GB
- #3589 — Observer context overflow is classified as prose and silently discards the batch
- #3592 — Observation `type` enum is unenforced: parser stores invalid types verbatim; missing `<type>` defaults to `bugfix`

Related PRs to evaluate/rebase: #3460 (transport-error classifier), #2957 (SDKAgent sliding window), #2884, #2943, #2927, #2857, #2905, #1775 (prose salvage), #3352 (prompt: check prior output), #3207 (auth-prose preserve batch), #3283 (retired model ids).

## Fix sequence

1. **One classifier, one policy table.** `sdk/output-classifier.ts` returns a closed enum — `valid`, `skip`, `empty_request`, `idle`, `auth`, `quota`, `model_error`, `transport`, `overflow`, `xml_drift`, `prose_salvageable`, `prose` — and `ResponseProcessor` dispatches through a table: preserve batch (`resetProcessingToPending`) for `empty_request|idle|auth|quota|transport|overflow|xml_drift`, confirm for `valid|skip`, salvage-then-confirm for `prose_salvageable` (title = first 100 chars, narrative = text, WARN), confirm-with-ERROR for true `prose`. Nothing reaches `conversationHistory` before it passes validation; `xml_drift` pops the bad turn and re-sends the schema. `consecutiveInvalidOutputs` either counts and aborts with a typed `abortReason` (`drift:*`, `overflow:*`) after 3 or is deleted — not assigned `0` and logged.
2. **Skip is a sentinel, not silence.** Every mode's `skip_guidance` emits `<skip_summary reason="…"/>` (and `<skip_observation/>` for observation turns); the parser accepts both; the generator never sends a turn with `queueDepth=0`; the INIT prompt is only sent when `bootId` changed (plan-15 owner record) — a stored `memory_session_id` is resumed on the same worker instance instead of being discarded on idle eviction.
3. **Token budget as a first-class object.** `ObserverBudget {maxHistoryTokens (fraction of model context), maxFieldChars, maxToolOutputChars, maxOutputTokens}` shared by all providers; history is trimmed (compact older half → summary) never emptied (`truncateHistory` keeps ≥ 1 message and truncates content instead); the duplicate append is removed; base64/image blobs replaced with `[image omitted: type, N KB]` at ingest; `max_tokens` configurable and coupled to `CLAUDE_MEM_API_TIMEOUT_MS`; `finish_reason=length` and repeated `obsIds` logged WARN; cumulative input/output tokens logged INFO and exposed on `/api/health` + statusline; the auth-paused buffer is capped with spill-to-disk and stops accepting past the cap.
4. **Provider adapter parity.** One `OpenAICompatibleProvider` config surface: base URL, `max_tokens`, `reasoning: {effort}` (only when advertised), empty-content-with-`reasoning_content` treated as no-op, `SettingsRoutes` validates only the active provider's fields and normalizes retired ids at load; the viewer save handler surfaces the JSON error body; installer/Settings UI expose the base URL.
5. **Output quality gates.** Unknown `type` → coerced to a neutral type with the raw value in `metadata` (enum restated in the per-tool-use template); missing title rejected; write-time (title, project) normalized dedup with `occurrence_count` (opt-in fuzzy tier review-only); `CLAUDE_MEM_SKIP_BASH_PATTERNS` at the same gate as `SKIP_TOOLS`; a "check your prior output" line in the observation prompt.

## Test matrix

| Provider | Output | Required behavior |
|---|---|---|
| claude (SDK), openrouter, gemini, openai-compatible | `""` on empty request | class `empty_request`; batch preserved; no INIT churn; no log spam |
| all | `<skip_summary reason=…/>` / `<skip_observation/>` | confirmed; zero ERROR lines |
| all | "No observations to record" prose | class `idle`; batch preserved; counter untouched |
| all | 401/403/`Not logged in`/`OAuth session expired` text | class `auth`; batch preserved; session paused with ERROR + health flag |
| claude | `Prompt is too long` as text | class `overflow`; batch preserved; history reset; retried once with budget halved |
| all | `<observation><kind>…` drift | class `xml_drift`; turn popped; schema resent; abort after 3 with `drift:observer_schema` |
| all | closed `<observation>` with 1,000 chars prose | salvaged as narrative; WARN |
| all | `type=verification` (not in enum) | stored as neutral type + metadata; never `bugfix` by default |
| openrouter | one message > MAX_TOKENS | request still has ≥ 1 message; content truncated; no 400 |
| openai-compatible | 200 turns | history tokens ≤ budget; each assistant reply present exactly once |
| openrouter/gemini | `finish_reason=length` | WARN logged; partial block salvaged; no blind retry |
| all | 50 h paused for auth | buffer ≤ cap; heap flat; observations drain after `/login` |
| all | model returns paraphrase of previous title | dedup increments `occurrence_count`, no new row |
| claude, gemini | settings save with retired gemini id while provider=claude | 200; id normalized |

The matrix lives in CI (`tests/sdk/output-classifier.test.ts` + `tests/services/worker/ResponseProcessor.test.ts` with recorded provider transcripts). A regression must fail CI before a user can file.

## Out of scope

How the observer subprocess is spawned, authenticated, isolated, and where its transcripts live (plan-19). Which project an observation is filed under (plan-20). Queue/session state persistence and retry (plan-21).
