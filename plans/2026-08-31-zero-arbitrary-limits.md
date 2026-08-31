# Zero Arbitrary Limits — derive the ceiling, delete the guards

## Primary goal

**No number in the memory path may destroy a user's data unless that number came from somewhere real.**
Every size ceiling resolves from the model's actual limit, or it is deleted. Every guard that exists only
to defend a non-deterministic recycle is removed rather than repaired.

Everything below is measured against that sentence. If a task does not either (a) replace an invented
number with a derived one, or (b) delete a number that should never have existed, it does not belong here.

**Problem.** `src/` carries 126 named numeric constants and 11 numeric settings defaults. Eight of them
silently discard captured content. Not one of them is connected to what the model can actually accept —
a repo-wide grep for `contextWindow` / `context_length` / `maxInputTokens` returns **no notion of a model's
input limit anywhere in the codebase**. The observer therefore throws away ~96% of its available window
by construction: `OBS_PROMPT_FIELD_MAX_CHARS = 16_000` is ≈4k tokens against a 200k-token model.

Two of those constants are worse than the observer cap and were found only by sweeping for them:
`MAX_TOOL_RESPONSE_LENGTH = 1000` cuts every opencode tool response to 1,000 characters *before it reaches
the worker*, and `MAX_STORED_PROMPT_CHARS = 4000` truncates **the user's own prompt** on its way into SQLite.

Companion audit: <https://claude.ai/code/artifact/c247d008-b689-4b53-a3cd-9c69d7aadca9>

---

## Phase 0 — Consolidated discovery (read before any phase; do not re-derive)

### 0.1 Allowed APIs — OpenRouter model catalogue (verified live 2026-08-31, 395 models)

`GET https://openrouter.ai/api/v1/models` — **no auth**. Edge-cached `max-age=300`.
Top-level keys are exactly `data`, `links`, `total_count`.

Per-model fields that exist (verified in the live payload):
`id`, `canonical_slug`, `name`, `created`, `context_length`, `architecture`, `pricing`,
`top_provider { context_length, max_completion_tokens, is_moderated }`, `per_request_limits`,
`supported_parameters`, `links`.

```json
{
  "id": "anthropic/claude-haiku-4.5",
  "context_length": 200000,
  "top_provider": { "context_length": 200000, "max_completion_tokens": 64000, "is_moderated": true },
  "per_request_limits": null
}
```

**Use `top_provider.context_length`. Never top-level `context_length`.** They are not interchangeable:
top-level is the max across *all* providers, `top_provider` is what the default provider actually serves.
They differ on 39 of 395 models, and the trap case is ours:

```
anthropic/claude-sonnet-4   context_length = 1000000   top_provider.context_length = 200000
```

Google serves 1M, Bedrock serves 200K. Reading the top-level number overstates the real limit by 5× and
would ship a "derived" ceiling that overflows worse than the hardcoded one it replaced.

Other verified facts:
- `context_length` is the **combined input+output** window. An input budget is a subtraction.
- `per_request_limits` is `null` for all 395 models. Useless.
- A true per-provider input cap `max_prompt_tokens` exists but **only** on
  `GET /api/v1/models/{author}/{slug}/endpoints`, is undocumented, and is `null` for every Anthropic
  endpoint checked. Out of scope for Phase 1; revisit only if an OpenAI-model user reports overflow
  (`openai/gpt-5.3-codex` is 400000 context but 272000 input — a 32% overstatement if ignored).
- Route asymmetry, easy to get wrong: single-model detail is `/api/v1/model/...` (**singular**),
  but `/endpoints` hangs off `/api/v1/models/...` (**plural**).

**Unverified assumptions to guard, not rely on:** OpenRouter publishes no formal JSON schema for this
endpoint (two plausible doc URLs 404'd); the "top-level ≥ top_provider" invariant held across all 395
models but is not a documented contract; `max_prompt_tokens` is entirely undocumented and may change.
Treat a missing or malformed field as "fall back", never as "assume".

### 0.2 House patterns to copy

| Need | Copy from | Notes |
|---|---|---|
| Fetch OpenRouter `/models` + fallback table | `src/npx-cli/cmem-pro-costs.ts:24-30`, `:103-115`, `:125-159` | **Already solves this exact problem** for pricing. Uses `AbortSignal.timeout`, per-item fallback, returns a `live` boolean. Has no cache — that is the only piece to add. |
| Per-key TTL cache | `src/shared/process-identity.ts:26-27`, `:75-80`, `:93` | `Map<key, { value, capturedAtMs }>`, elapsed-since check. Caches null results too. |
| Single-value TTL cache | `src/shared/find-claude-executable.ts:62-75`, `:278-281` | Only if caching one thing. Note: failures are never cached, and there is a validity predicate beyond the clock. |
| Settings read + parse fallback | `src/shared/observer-recycle.ts:55-65` (helper) + `src/services/worker/ClaudeProvider.ts:177-182` (call) | Pure helper in `src/shared/`, read fresh per call so operators need no restart. Register the key in **both** `SettingsDefaultsManager.ts:61` (interface) and `:157` (`DEFAULTS`) — `loadFromFile` only copies keys present in `DEFAULTS` (`:290-295`). |
| Test seam for a fetching module | `src/shared/find-claude-executable.ts:77-89` (`_internals`) + `tests/shared/find-claude-executable.test.ts:10-14`, `:72-83` | House rule: swap `_internals` members; **do not** `mock.module` — it is process-global and sticky in bun. |
| Clock injection | `src/shared/quota-cooldown.ts` + `tests/worker/quota-cooldown.test.ts:46-58` | Optional `nowMs` parameter, not fake timers. |
| Test reset export | `resetQuotaCooldownsForTesting()` (`quota-cooldown.ts:149`) | Convention for a Map in `src/shared/`. Requires **both** `beforeEach` and `afterAll` — the whole suite runs in one bun process. |

`SettingsDefaultsManager.get()` is **env-only** (`:214-216`) and never reads settings.json. Use
`loadFromFile(USER_SETTINGS_PATH)` (`:233`); it never throws (catch at `:288` returns defaults).

A new module in `src/shared/` **is** scanned by `tests/logger-usage-standards.test.ts` (exclusion list at
`:9-45`). Use `logger` from `src/utils/logger.ts` with a valid `Component` tag. Never `console.*`.

### 0.3 Facts that shape the design

- **Real token counts already exist on the session.** `ActiveSession.lastUsage { input, output, costUsd }`
  and `cumulativeInputTokens` (`src/services/worker-types.ts`) are populated from provider-reported usage.
  The conversation's true input size is therefore **measured, not estimated** — the recycle decision does
  not need a chars-per-token guess at all.
- **One session can use two model ids.** `OpenAICompatibleProvider` swaps in `resolveSummaryTierModel`
  (`src/services/worker/model-aliases.ts:36`) for summary turns. Cache per model id, never per session.
- **Model ids may be aliases.** `CLAUDE_MEM_MODEL` can be `$TIER:<fast|smart|simple|summary>`, resolved by
  `resolveTierAlias` (`model-aliases.ts:16`). The resolver takes the **already-resolved** id.
- **ClaudeProvider has no `getConfig()` and no API key** (auth is OAuth via `buildIsolatedEnvWithFreshOAuth`).
  This does **not** block it: `/api/v1/models` needs no auth, so the Claude path fetches like the others.
  Do not build a static table for Claude.
- **Tests are excluded from `tsc --noEmit`** (`tsconfig.json`), so a broken test surfaces only at runtime.
  Typecheck passing is not evidence that a phase is done.

### 0.4 Anti-patterns (do not)

- Do not read top-level `context_length` (see 0.1).
- Do not invent fields. `max_input_tokens`, `max_tokens`, `input_limit` do **not** exist on the list payload.
- Do not put the fetch in the hot path. Resolve once, cache, degrade to a fallback.
- Do not build a central "limits registry" or policy engine resolving all 126 constants. The job is one
  derived number plus a set of deletions. A registry is more code and more failure surface than the
  constants it replaces.
- Do not make timeouts, grace periods or process caps adaptive. They have no external truth to discover.
- Do not delete `MAX_CONCURRENT_AGENTS` (`SettingsDefaultsManager.ts:156`) or `TOTAL_PROCESS_HARD_CAP`
  (`supervisor/process-registry.ts:464`). They look arbitrary and are the only thing standing between a
  runaway loop and the user's machine.
- Do not touch `CONTENT_BODY_MAX_BYTES` — see Phase 5.1.

---

## Phase 1 — Resolve the real model limit

### 1.1 New module `src/shared/model-limits.ts`

Copy the fetch body from `src/npx-cli/cmem-pro-costs.ts:125-159` and the cache shape from
`src/shared/process-identity.ts:26-27`.

```ts
export interface ModelLimits {
  /** top_provider.context_length — combined input+output window, in tokens. */
  contextTokens: number;
  /** top_provider.max_completion_tokens, when reported. */
  maxCompletionTokens: number | null;
  /** False when this came from the fallback table rather than the live catalogue. */
  live: boolean;
}

export async function resolveModelLimits(modelId: string, nowMs?: number): Promise<ModelLimits>;
export function resolveInputBudgetTokens(limits: ModelLimits, reservedOutputTokens: number): number;
export function resetModelLimitsForTesting(): void;
```

- `MODELS_URL = 'https://openrouter.ai/api/v1/models'`, `FETCH_TIMEOUT_MS = 3_000`, `AbortSignal.timeout`.
- Cache `Map<string, { limits: ModelLimits; capturedAtMs: number }>`, TTL **≥ 300_000** to match the
  endpoint's own `max-age=300`. Cache fallback results too, with a shorter TTL, so an outage does not
  re-fetch per observation.
- Read `top_provider.context_length`; if `top_provider` is absent, fall back to top-level `context_length`;
  if both are absent or non-finite, use the fallback table.
- Fallback table carries only the models claude-mem actually ships with, and repeats the
  `cmem-pro-costs.ts:103-115` comment: *a floor for graceful degradation, NOT a source of truth. If you
  are tempted to "just update these", fix the fetch instead.*
- `resolveInputBudgetTokens` = `contextTokens − reservedOutputTokens`. The reserve is the `max_tokens`
  claude-mem actually sends (`CLAUDE_MEM_OPENROUTER_MAX_TOKENS`), **not** `max_completion_tokens` — we
  reserve what we request, which is a real number we control, not a hypothetical ceiling.

### 1.2 Settings key

Add `CLAUDE_MEM_MODEL_LIMIT_TTL_MS` to `SettingsDefaultsManager.ts:61` and `:157` only if a knob is
actually wanted. **Default position: do not add one.** The TTL is dictated by the endpoint's cache header,
which is an external fact, so it is not an arbitrary limit and needs no override.

### 1.3 Tests — `tests/shared/model-limits.test.ts`

Follow `tests/worker/quota-cooldown.test.ts` (reset in `beforeEach` **and** `afterAll`) and the fetch-mock
idiom from `tests/gemini_provider.test.ts:52-56`, `:168-176` (save `originalFetch`, restore, `mock.restore()`).

Cases: reads `top_provider.context_length`; **prefers `top_provider` over a larger top-level
`context_length`** (use the real `anthropic/claude-sonnet-4` 1000000/200000 pair as the fixture); falls
back on non-200; falls back on network rejection; falls back on malformed JSON; caches within TTL (one
fetch for two calls); re-fetches after TTL via injected `nowMs`; subtracts the reserve.

### 1.4 Verification checklist

- [ ] `bun test tests/shared/model-limits.test.ts` passes.
- [ ] `grep -rn "context_length" src/shared/model-limits.ts` shows `top_provider` guarded before any
      top-level read.
- [ ] Live check: `bun -e "import('./src/shared/model-limits.js').then(async m => console.log(await m.resolveModelLimits('anthropic/claude-haiku-4.5')))"`
      prints `contextTokens: 200000, live: true`.
- [ ] Airplane check: same call with the network disabled returns `live: false` and does not throw.
- [ ] `npm run typecheck` clean.

### 1.5 Anti-pattern guards

- No `console.*` in the new module (`tests/logger-usage-standards.test.ts` will fail).
- No `mock.module` in the test (process-global and sticky in bun — see `tests/preload.ts`).
- The module must not import from `src/services/worker/**`; it lives in `src/shared/` and is consumed
  downward, not sideways.

---

## Phase 2 — Delete the give-up machinery

A recycle is a boundary, not a failure. The only way a fresh generation cannot fit is when the framing
prompt plus injected context already exceed the limit *before a single observation is recorded* — and the
fix for that is a progress invariant, not a counter.

### 2.1 The invariant that replaces all of it

In both providers, **a generation always records at least one observation before its budget is re-checked.**
Move the budget check so it cannot fire on the first observation of a generation.

- `src/services/worker/ClaudeProvider.ts:588` (check inside the `for await` loop)
- `src/services/worker/OpenAICompatibleProvider.ts:249`

This makes forward progress structural: every generation drains ≥1 observation, so the recycle loop cannot
spin without recording anything.

### 2.2 Delete

| Symbol | Sites |
|---|---|
| `MAX_CONSECUTIVE_RECYCLES` | `recycle-conversation.ts:68-75`, `:105`, `:117` |
| `OVERFLOW_EXHAUSTED_COOLDOWN_MS` | `recycle-conversation.ts:77-83`, `:113` |
| `RecycleOutcome` | `recycle-conversation.ts:85-90` — all three callers ignore the return (`ResponseProcessor.ts:325`, `ClaudeProvider.ts:589`, `OpenAICompatibleProvider.ts:250`) |
| `consecutiveContextOverflows` | `worker-types.ts:35`, `:37-46`; `SessionManager.ts:131`; `recycle-conversation.ts:99-100`; `ResponseProcessor.ts:386`, `:396`, `:410`; `SessionRoutes.ts:108` |
| `overflowPausedUntilMs` | `worker-types.ts:47-52`; `recycle-conversation.ts:113`; `SessionRoutes.ts:95`, `:99`, `:103`, `:107` |
| `overflow:exhausted` | written at `recycle-conversation.ts:114` |

`overflow:recycle` (`recycle-conversation.ts:129`) and its self-resume branch
(`SessionRoutes.ts:357`) **stay** — that is the working path.

Both consumers of the abort reason key off the `overflow` prefix via `reason.split(':')[0]`
(`GeneratorExitHandler.ts:44-49`, `SessionRoutes.ts:52-58`), so they keep working unchanged once the
`:exhausted` variant is gone. `worker-types.ts:60` has an open union (`| string`) and needs no edit.

### 2.3 Tests

- Delete `tests/worker/overflow-recycle-resume.test.ts:97-112` (`does not resume once the recycle budget
  is exhausted`) — it exists to prove the give-up sticks.
- Delete `tests/worker/agents/response-processor.test.ts:626-647` and `:649-670` entirely.
- Drop only the counter assertions from `response-processor.test.ts:607` and `:682`; the rest of both
  tests stays valid.
- Drop the field from mock session literals: `overflow-recycle-resume.test.ts:28`,
  `response-processor.test.ts:210`.
- **Add** a test for the new invariant: a generation whose init prompt + injected context is already near
  the budget still records one observation before recycling, and two consecutive recycles both make
  progress (no counter, no pause).

### 2.4 Verification checklist

- [ ] `grep -rn "MAX_CONSECUTIVE_RECYCLES\|OVERFLOW_EXHAUSTED_COOLDOWN_MS\|consecutiveContextOverflows\|overflowPausedUntilMs\|overflow:exhausted" src/ tests/` returns **zero** hits.
- [ ] `grep -rn "overflow:recycle" src/` still shows the write and the resume branch.
- [ ] `bun test tests/worker/ tests/shared/observer-recycle.test.ts` passes.
- [ ] Live: drive a long session with a low budget; the log shows repeated `Retiring the observer
      conversation` with observations landing between each, and **no** `still does not fit`.

### 2.5 Anti-pattern guards

- Do not replace the counter with a different counter.
- Do not add a "max generations per session" cap. That is the same mistake wearing a new name.

---

## Phase 3 — Derive the size caps; collapse the token estimate

### 3.1 Recycle on measured tokens, not estimated characters

`ActiveSession.lastUsage.input` is the provider's own count of the last request. Recycle when the next
send would exceed `resolveInputBudgetTokens(...)`, using that measured value plus the pending observation's
estimated size. This removes the chars-per-token guess from the decision entirely.

Replace in `src/shared/observer-recycle.ts:22-65`:
- `OBSERVER_CONVERSATION_MAX_CHARS = 400_000` → derived budget
- `shouldRecycleConversation(history, maxChars)` → takes measured input tokens + the budget
- Keep `resolveConversationMaxChars` **only** as an operator override; when the setting is unset the value
  comes from Phase 1, not from a constant.

Callers: `ClaudeProvider.ts:32-35`, `:178-182`, `:588`, `:594`; `OpenAICompatibleProvider.ts:13-16`,
`:107-111`, `:249`, `:255`.

### 3.2 Derive the field cap

`OBS_PROMPT_FIELD_MAX_CHARS` (`src/sdk/prompts.ts:138`) and `MAX_PAYLOAD_CHARS`
(`src/server/generation/providers/shared/prompt-builder.ts:41`) both become a share of the resolved input
budget rather than 16k. `OBS_PROMPT_FIELD_HEAD_RATIO` / `TAIL_RATIO` (`:139-140`) die with the truncation
path once the Phase-1 budget makes head/tail cutting a last resort behind the condenser.

`truncateObservationField` (`prompts.ts:142`, used at `:181`, `:182`) stays as the final fallback only.

### 3.3 Collapse `CHARS_PER_TOKEN_ESTIMATE` — three definitions, not two

- `src/services/context/types.ts:99` (exported — keep this one)
- `src/services/worker/FormattingService.ts:6` (duplicate — delete, import)
- `src/services/worker/OpenRouterProvider.ts:176` (duplicate — delete, import)

**Do not change the value.** `src/services/telemetry/backfill.ts:377` interpolates it directly into SQL,
and `tests/telemetry/backfill.test.ts:359-372` pins the resulting numbers (`203`, `4797`). Changing 4 to
anything else silently rewrites historical telemetry math. This phase is de-duplication only.

### 3.4 Tests

- `tests/sdk/prompts.test.ts:22-41` — `expect(prompt.length).toBeLessThan(40_000)` at `:40` must become a
  function of the resolved budget, not a literal.
- `tests/sdk/prompts.test.ts:43-56` survives; refresh the stale comments at `:53-54`.
- `tests/shared/observer-recycle.test.ts:18-61` — rewrite against the derived budget. The `wrapPriorContext`
  block at `:64-92` is independent and survives untouched.
- `tests/context/token-calculator.test.ts:30-34` asserts `CHARS_PER_TOKEN_ESTIMATE === 4` — **keep passing**;
  3.3 does not change the value.
- `tests/worker/field-optimizer.test.ts` passes its own `MAX = 200`, so it survives as long as the
  `maxChars` parameter remains.
- `tests/server/generation/providers.test.ts` has **no** coverage of the `MAX_PAYLOAD_CHARS` branch — add one.

### 3.5 Verification checklist

- [ ] `grep -rn "CHARS_PER_TOKEN_ESTIMATE *=" src/` returns exactly **one** definition.
- [ ] `grep -rn "16_000\|16 \* 1024\|400_000" src/sdk src/shared src/server/generation` returns no size caps.
- [ ] `bun test tests/sdk tests/shared tests/context tests/telemetry tests/server` passes.
- [ ] Live: an 80k-char tool output on a 200k-token model is sent **whole** — the log shows no
      `Condensed an oversized observation field` line, because it now fits.

### 3.6 Anti-pattern guards

- Do not change `CHARS_PER_TOKEN_ESTIMATE`'s value in this phase (SQL + pinned telemetry tests).
- Do not delete `truncateObservationField`; it remains the last-resort fallback.

---

## Phase 4 — Delete the upstream truncations

Neither number has a constraint behind it.

### 4.1 `MAX_TOOL_RESPONSE_LENGTH = 1000` — two copies

- `src/integrations/opencode-plugin/index.ts:104`, used by `truncate` at `:183-187`, called at `:206`, `:231`
- **Second, independent copy** at `openclaw/src/index.ts:815-818`

Provenance, from `.maestro/playbooks/2026-02-23-Issue-Triage/.../TRIAGE-07-Installation-Distribution.md:41`:
the openclaw truncation was added **to satisfy a pre-existing test**. The number was chosen to match a
test, not an external ceiling.

`openclaw/src/index.test.ts:395-412` asserts `tool_response.length === 1000`. That assertion is the only
thing holding the limit up — delete the truncation and the test together. Check whether `openclaw/dist/`
is checked in; if so it carries a stale copy.

`tests/integrations/opencode-plugin-contract.test.ts:119` uses a short payload and does not exercise
truncation. Safe.

### 4.2 `MAX_STORED_PROMPT_CHARS = 4000`

- `src/services/sqlite/prompt-storage.ts:4`, used at `:11`, `:18`, `:20`
- `normalizeStoredPromptText` callers: `SessionStore.ts:19`, `:2128` (dedupe key), `:2389`, `:2472`

Note `:2128` uses the normalized text as a **duplicate-detection key**, so removing truncation changes
dedupe behaviour for prompts over 4,000 chars. Verify dedupe still works on full-length text.

Tests asserting truncation happened, all three symbolic against the constant:
`tests/session_store.test.ts:4`, `:60`, `:68`; `tests/sqlite/session-store-prompts.test.ts:3`, `:47`, `:53`;
`tests/sqlite/session-store-sessions.test.ts:3`, `:35`, `:40`.

Stale doc reference to correct: `plans/2026-07-17-endless-mode-v1-handoff.md:55`.

### 4.3 Verification checklist

- [ ] `grep -rn "MAX_TOOL_RESPONSE_LENGTH\|MAX_STORED_PROMPT_CHARS" src/ openclaw/src tests/` returns zero hits.
- [ ] `bun test tests/sqlite tests/session_store.test.ts tests/integrations` passes.
- [ ] `cd openclaw && bun test` passes.
- [ ] Live: a >4,000-char prompt round-trips into SQLite intact — `SELECT LENGTH(prompt_text)` matches input.
- [ ] Live: two identical long prompts still dedupe to one row.

### 4.4 Anti-pattern guards

- Do not "raise" either number. Delete them.
- Do not skip the openclaw copy; the two drift independently.

---

## Phase 5 — Resolve the two unknowns

### 5.1 `CONTENT_BODY_MAX_BYTES = 256_000` — **KEEP. Do not touch.**

This one is real, and the audit's open question is now answered. It is a wire-protocol ceiling shared with
the sync hub:

- Mirrored implementation: `src/services/sync/CanonicalContent.ts:6` and `workers/sync-hub/src/canonical-content.ts:3`
- Source of truth: `fixtures/tpuf-content-v2.json:5` (`operation_body_utf8_bytes: 256000`) with boundary
  vectors at `:536-538`; `tests/worker/sync/canonical-content.test.ts:45` asserts the fixture's sha256
- Publicly documented: `docs/public/cloud-sync.mdx:56`

Changing it is a cross-repo protocol change, not a tuning decision. The only work here is a code comment
citing the fixture, so the next audit does not re-litigate it.

### 5.2 `WINDSURF_CONTEXT_CHAR_LIMIT = 6000` — unsourced

`src/services/integrations/WindsurfHooksInstaller.ts:31`, used at `:98-100`. No comment, no docs, no tests,
no design note; introduced wholesale in `f2cc33b49` alongside the entire Windsurf integration.

**This requires one external check we have not done: does Windsurf actually impose a rules-file ceiling?**
Nothing in this repo claims one, but absence of evidence here is not evidence of absence there.

- If Windsurf documents a limit → keep the number, add a comment citing the source URL.
- If it does not → delete the truncation like Phase 4.

### 5.3 Verification checklist

- [ ] `CanonicalContent.ts:6` carries a comment citing `fixtures/tpuf-content-v2.json`.
- [ ] Windsurf: either a comment with a source URL, or the truncation is gone.
- [ ] `bun test tests/worker/sync` passes unchanged.

---

## Phase 6 — Verification & release

1. `npm run typecheck` — clean. **Remember tests are excluded from `tsc`**; this proves nothing about them.
2. `bun test tests` — compare against the recorded baseline. Known pre-existing flakes:
   `tests/services/infrastructure/worktree-adoption-chroma.test.ts` and
   `tests/worker/sync/mutation-sites.test.ts` fail only in full-suite runs and pass in isolation.
3. `cd openclaw && bun test`, and the sync-hub worker tests.
4. `npm run build` and confirm `plugin/scripts/worker-service.cjs` contains the new module.
5. Grep sweep for every deleted symbol (the per-phase checklists, run together).
6. **Live long-session run** against an isolated worker (`CLAUDE_MEM_DATA_DIR` + a spare port, never the
   real DB). Confirm, in order:
   - observations land continuously across a recycle boundary
   - `Briefed the observer generation with session-start context` shows a non-zero `contextChars` on the
     replacement generation
   - no `still does not fit`, no overflow cooldown
   - an 80k-char tool output is carried whole rather than condensed or elided
   - a >4,000-char user prompt is stored intact
7. Re-run the audit sweep and confirm the Class 1 table is empty except the two justified entries
   (`CONTENT_BODY_MAX_BYTES`, and `MESSAGE_MAX_CHARS` which is telemetry, not memory).

---

## Sequencing note

Phase 1 gates Phase 3. Phases 2 and 4 are independent of both and of each other — either can ship first,
and Phase 2 is the smallest and highest-confidence change in the plan. Phase 5.1 is a comment. Phase 5.2
is blocked on an external documentation check that costs one web search.
