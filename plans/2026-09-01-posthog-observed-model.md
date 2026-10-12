# PostHog: report the observed model, source, and billing type

**Branch:** `posthog-observed-model` (worktree at repo root of this file). **Base:** `main`.

## Goal

PostHog currently reports only the *observer* model (the model claude-mem uses to write
observations: `model` / `top_model`). We need to also know, per observed session:

1. **`observed_model`** — the model the user is running in their IDE session (e.g. `claude-fable-5-1`).
2. **`ide`** (already exists per-turn but is dropped from the rollup) — the source platform (`claude`, `codex`, `cursor`, …).
3. **`observed_billing`** — Max / Pro / Team / API credits / Bedrock / Vertex / Foundry / unknown, when determinable.

These are **new, separate** properties. Do not touch `model` / `top_model` / `provider` semantics — those stay observer-side.

## Phase 0: Documentation Discovery (DONE — consolidated findings)

### 0.1 Where the observed model is available

| Source | Fact | Evidence |
|---|---|---|
| Claude Code hook stdin | `model` (canonical id string) is present on **SessionStart only**; absent on UserPromptSubmit / PostToolUse / Stop. | https://code.claude.com/docs/en/hooks.md (SessionStart input table) |
| Transcript JSONL | Every assistant entry carries `message.model` (verified on a real transcript: `"model":"claude-fable-5-1"`), alongside `message.role`, `message.content`. Line role is `line.type` (Claude Code) or `line.role` (Cursor). | Real transcript under `~/.claude/projects/…/*.jsonl`; `src/shared/transcript-parser.ts:61` |
| Our hook types | `NormalizedHookInput` already declares `model?`, `permissionMode?`, `sessionSource?` (`src/cli/types.ts:13-15`). Only the codex adapter fills them (`src/cli/adapters/codex.ts:99-101`). The claude-code adapter drops them (`src/cli/adapters/claude-code.ts:15-25`). No downstream consumer reads `input.model` anywhere in `src/`. | grep |
| Stop hook path | `summarize` handler already reads the transcript: `extractLastMessage(transcriptPath, 'assistant', true)` at `src/cli/handlers/summarize.ts:93`, then POSTs `/api/sessions/summarize` with `{ contentSessionId, last_assistant_message, agentId?, platformSource }` (`summarize.ts:138-147`). | read |

**Decision:** read the observed model from the transcript in the Stop hook (`summarize` handler). It is platform-generic, needs no new hook wiring, and refreshes every turn (covers `/model` switches). The SessionStart `model` field is *not* used (it would need a new transport through the `context` handler, which only GETs `/api/context/inject`).

### 0.2 Where billing / plan is available

| Signal | Location | Evidence |
|---|---|---|
| Subscription account | `~/.claude.json` → `oauthAccount.organizationType` (observed: `"claude_max"`), `oauthAccount.billingType` (`"stripe_subscription"`), `oauthAccount.organizationRateLimitTier` (`"default_claude_max_20x"`). Top-level copies of those keys are `null` on this machine — read from `oauthAccount`. | `jq '.oauthAccount' ~/.claude.json` (verified 2026-09-01) |
| API key billing | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the **hook process env** (hooks inherit Claude Code's environment; the worker daemon does NOT have the user's shell env). When a logged-in user also exports a key, Claude Code asks to approve it and records approvals under `customApiKeyResponses.approved` (last 20 chars of the key) in `~/.claude.json`. | https://code.claude.com/docs/en/hooks.md (hook execution environment); `~/.claude.json` key inventory |
| Cloud providers | `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` env vars. | https://code.claude.com/docs/en/settings-reference.md |
| Long-lived OAuth token | `CLAUDE_CODE_OAUTH_TOKEN` env → subscription of unknown tier. | same |
| Config dir | `.claude.json` lives at `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set, else `~/.claude.json`. Existing constant: `CLAUDE_CONFIG_DIR` in `src/shared/paths.ts:43`. | read |

`~/.claude.json` is Claude Code specific → billing detection runs only when `input.platform === 'claude-code'`.

**Decision:** compute billing in the hook process (it has the env), in the same `summarize` handler, and send it alongside the observed model.

Detection order (closed enum, low cardinality):

```
1. CLAUDE_CODE_USE_BEDROCK set (non-empty, not '0'/'false') → 'bedrock'
   CLAUDE_CODE_USE_VERTEX  → 'vertex'
   CLAUDE_CODE_USE_FOUNDRY → 'foundry'
2. key = ANTHROPIC_API_KEY || ANTHROPIC_AUTH_TOKEN (non-empty)
   if key && (no oauthAccount || customApiKeyResponses.approved includes key.slice(-20)) → 'api_key'
3. oauthAccount.organizationType is a string → strip leading 'claude_' → value
   (e.g. 'max', 'pro', 'team', 'enterprise'); sanitize to /^[a-z0-9_]{1,40}$/ else 'subscription'
4. oauthAccount present || CLAUDE_CODE_OAUTH_TOKEN set → 'subscription'
5. else → 'unknown'
```

### 0.3 How telemetry flows (what must change for a property to reach PostHog)

| Fact | Evidence |
|---|---|
| Per-turn `session_compressed` records are **never sent**; they are aggregated into `observer_turn_rollup` by `computeSessionCompressedRollup` (`src/services/telemetry/buffer.ts:124-241`). Only numeric aggregates and `top_model` survive; `ide`, `provider`, `hook` are dropped. The docs (`docs/public/telemetry.mdx:132`) claim `provider`, `ide`, `hook` are carried — currently false. | read |
| Per-turn records are created at: `src/services/worker/agents/ResponseProcessor.ts:490-511` (`compressionProps`, success), `src/services/worker/http/routes/SessionRoutes.ts:328-336` (error), `SessionRoutes.ts:374-381` (abort). Claude path re-emits `...pending` in `src/services/worker/ClaudeProvider.ts:448-460` and `:469` — spreads the stashed props, so no change needed there. | read |
| Every property must be in `ALLOWED_PROPERTY_KEYS` (`src/services/telemetry/scrub.ts:8-184`) or the scrubber drops it silently. `ide`, `provider`, `model`, `top_model` are already whitelisted (`scrub.ts:30,73,162`). | read |
| In-memory session state type: `ActiveSession` in `src/services/worker-types.ts:9-…` (has `platformSource`, `lastModelId?`, `lastGeneratorSource?`). Built in `SessionManager.initializeSession` (`src/services/worker/SessionManager.ts:23-130`) from `dbManager.getSessionById(sessionDbId)` (`src/services/worker/DatabaseManager.ts:97-113` → `SessionStore.getSessionById`, `src/services/sqlite/SessionStore.ts:2321-2332`, row type `SdkSessionDetailRow` `SessionStore.ts:63-72`). | read |
| Rollup flush points: `SessionManager.ts:260` and `:324` (`flushSession(sessionDbId, 'session_end')`), plus safety sweep and shutdown in `buffer.ts`. | read |
| Summarize route: `handleSummarizeByClaudeId` `SessionRoutes.ts:504-539`; body schema `summarizeByClaudeIdSchema` `SessionRoutes.ts:456-461` (`.passthrough()`); it upserts the session via `store.createSDKSession(contentSessionId, '', '', undefined, platformSource)` (`:514`) then `queueSummarize` → `ensureGeneratorRunning` (`:532-534`). | read |
| SQLite migration pattern: idempotent private method on `SessionStore`, `PRAGMA table_info`, `ALTER TABLE … ADD COLUMN`, `INSERT OR IGNORE INTO schema_versions`, appended to the constructor chain `SessionStore.ts:102-122`. Copy-ready template: `addObservationModelColumns` `SessionStore.ts:1688-1704`. Highest existing version stamp: 49 (`normalizeConceptTags`) → use **50** (the constructor chain is not in stamp order; 34 is already `ensureUserPromptsSessionDbId`). | read |

### 0.4 Allowed APIs (only these — do not invent others)

- `readFileSync`, `existsSync` from `fs`; `join` from `path`; `homedir` from `os`.
- `extractLastMessage` / `extractLastMessageFromJsonl` pattern in `src/shared/transcript-parser.ts` (backward line scan, `JSON.parse` per line in try/catch, `line.type ?? line.role`).
- `telemetryBuffer.record(event, sessionDbId, props)` (`buffer.ts:309`).
- `SessionStore` methods use `this.db.prepare(sql).run(...)` / `.get(...)` (bun:sqlite).
- `sessionManager.getSession(sessionDbId)` (used at `SessionRoutes.ts:621`).
- Zod `z.string().optional()` inside the existing `.passthrough()` schema.
- Logger: `logger.debug('HOOK', msg, ctx)` / `logger.warn(...)`.

### 0.5 Anti-patterns to avoid

- Do NOT put anything free-form into telemetry props (no paths, no prompts). `observed_model` is a model id; `observed_billing` is a closed enum.
- Do NOT send `~/.claude.json` fields other than those named above; never read or log tokens.
- Do NOT reuse `observations.generated_by_model`, `session.lastModelId`, `model`, or `top_model` — those are observer-side.
- Do NOT read the transcript in the PostToolUse (`observation`) handler — it fires per tool call; Stop is once per turn.
- Do NOT add try/catch around new happy-path code except the per-line `JSON.parse` in the transcript scan (existing, documented pattern). Errors must surface.
- Do NOT touch `plugin/scripts/*.cjs` (build artifacts are rebuilt at version-bump time, not in feature PRs — see `git log -- plugin/scripts/worker-service.cjs`).
- Tests that `mock.module('../../../src/shared/transcript-parser.js', …)` (e.g. `tests/cli/handlers/summarize-tag-stripping.test.ts:35-40`) must be extended to export the new function, or the handler import becomes `undefined` at call time.
- Do not add a settings key; telemetry consent is env/`telemetry.json` only (`src/services/telemetry/consent.ts`).

---

## Phase 1: Hook side — extract observed model + billing, send on Stop

### 1.1 `src/shared/transcript-parser.ts` — add `extractLastAssistantModel`

Copy the shape of `extractLastMessage` (`transcript-parser.ts:5-22`) and the backward scan of `extractLastMessageFromJsonl` (`:40-58`):

```ts
export function extractLastAssistantModel(transcriptPath: string): string | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  const content = readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) return undefined;
  return extractLastAssistantModelFromJsonl(content);
}

export function extractLastAssistantModelFromJsonl(content: string): string | undefined {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    let line: any;
    try { line = JSON.parse(rawLine); } catch { continue; } // same tolerated condition as extractLastMessageFromJsonl
    if ((line.type ?? line.role) !== 'assistant') continue;
    const model = line.message?.model;
    if (typeof model === 'string' && model) return model;
  }
  return undefined;
}
```

### 1.2 New `src/shared/observed-billing.ts`

```ts
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type ObservedBilling = string; // closed set documented in docs/public/telemetry.mdx

export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
}

export function detectObservedBilling(
  env: NodeJS.ProcessEnv = process.env,
  claudeJsonFile: string = claudeJsonPath(env),
): ObservedBilling { … order from §0.2 … }
```

- `isTruthyEnv(v)`: non-empty and not `'0'`/`'false'` (case-insensitive).
- Read `.claude.json` with `existsSync` + `readFileSync` + `JSON.parse`. A missing file → treat as no account. (Malformed JSON: let `JSON.parse` throw — fail fast; the Stop handler's existing outer behavior is acceptable. NOTE: `summarize.ts` has no try/catch around this section; if a throw here would abort summarization for users with a corrupt `.claude.json`, wrap ONLY the file read in a guard that returns `null` account and add a `logger.debug` — decide during implementation and document in the code comment.)
- Only inspect: `oauthAccount.organizationType`, `oauthAccount` presence, `customApiKeyResponses.approved` (array of strings). Never read token-like fields.

### 1.3 `src/cli/handlers/summarize.ts` — send the two new fields

After `lastAssistantMessage` is resolved (post `:104`) and before the worker POST (`:138-147`):

```ts
const observedModel = transcriptPath ? extractLastAssistantModel(transcriptPath) : undefined;
const observedBilling = input.platform === 'claude-code' ? detectObservedBilling() : undefined;
```

Add `observedModel`, `observedBilling` to the `/api/sessions/summarize` body (`:141-146`). Leave the server-runtime path (`summarizeViaServer`) untouched.

### 1.4 Tests (Phase 1)

- `tests/transcripts/observed-model-extraction.test.ts` — `extractLastAssistantModelFromJsonl`: returns model of last assistant line (Claude Code `type` form), returns model when a Cursor `role` form carries `message.model`, skips user lines and malformed lines, returns `undefined` when no assistant line has a model.
- `tests/shared/observed-billing.test.ts` — full matrix from §0.2 using an injected `env` object and a temp `.claude.json` written to the scratchpad/tmp dir (`mkdtempSync`): bedrock/vertex/foundry; api key with no account; api key with account but unapproved → account tier; api key approved (last 20 chars) → `api_key`; `organizationType: 'claude_max'` → `max`; account without organizationType → `subscription`; `CLAUDE_CODE_OAUTH_TOKEN` only → `subscription`; nothing → `unknown`; missing file → `unknown`.
- Update `tests/cli/handlers/summarize-tag-stripping.test.ts:35-40` mock to also export `extractLastAssistantModel: () => 'claude-test-model'`, and grep other tests mocking `transcript-parser.js` (`grep -rl "transcript-parser.js" tests`) — extend each.
- New assertion in `tests/cli/handlers/` (add to `summarize-tag-stripping.test.ts` or a new `summarize-observed-fields.test.ts`): the POST body to `/api/sessions/summarize` includes `observedModel` and, for platform `claude-code`, `observedBilling` as a string.

### 1.5 Verification checklist (Phase 1)

```
npm run typecheck
bun test tests/transcripts tests/shared tests/cli
npm run lint:hook-io
grep -n "observedModel\|observedBilling" src/cli/handlers/summarize.ts   # both present in the body
grep -rn "accessToken\|refreshToken" src/shared/observed-billing.ts       # must be EMPTY
```

---

## Phase 2: Worker persistence — store on the session, load into `ActiveSession`

### 2.1 `src/services/sqlite/SessionStore.ts`

- Add `ensureSDKSessionsObservedColumns()` — copy `addObservationModelColumns` (`:1688-1704`), table `sdk_sessions`, columns `observed_model TEXT`, `observed_billing TEXT`, version stamp **50**. Append the call at the end of the constructor chain (`:102-122`, after `normalizeConceptTags()`).
- Extend `SdkSessionDetailRow` (`:63-72`) with `observed_model: string | null; observed_billing: string | null;` and add both columns to the `SELECT` in `getSessionById` (`:2321-2332`).
- Add:

```ts
setSessionObservedMetadata(sessionDbId: number, observedModel?: string, observedBilling?: string): void {
  this.db.prepare(`
    UPDATE sdk_sessions
    SET observed_model = COALESCE(?, observed_model),
        observed_billing = COALESCE(?, observed_billing)
    WHERE id = ?
  `).run(observedModel ?? null, observedBilling ?? null, sessionDbId);
}
```

### 2.2 `src/services/worker/DatabaseManager.ts:97-106`

Extend the inline return type of `getSessionById` with `observed_model: string | null; observed_billing: string | null;`.

### 2.3 `src/services/worker-types.ts` (`ActiveSession`)

Add, next to `lastModelId?` (`:69`), with the same doc-comment style:

```ts
/** Model the OBSERVED IDE session is running (from its transcript) — telemetry observed_model. Not the observer model. */
observedModel?: string;
/** Billing posture of the observed Claude Code session (closed enum, see observed-billing.ts) — telemetry observed_billing. */
observedBilling?: string;
```

### 2.4 `src/services/worker/SessionManager.ts:23-130`

- New-session object (`:103-…`): `observedModel: dbSession.observed_model ?? undefined, observedBilling: dbSession.observed_billing ?? undefined`.
- Cached-session branch (`:57-59` pattern): if `dbSession.observed_model` and it differs, update `session.observedModel`; same for billing.

### 2.5 `src/services/worker/http/routes/SessionRoutes.ts`

- `summarizeByClaudeIdSchema` (`:456-461`): add `observedModel: z.string().max(200).optional(), observedBilling: z.string().max(40).optional()`.
- `handleSummarizeByClaudeId` (`:504-539`): destructure the two fields; after `createSDKSession` (`:514`) and **before** `queueSummarize` (`:532`):

```ts
if (observedModel || observedBilling) {
  store.setSessionObservedMetadata(sessionDbId, observedModel, observedBilling);
  const active = this.sessionManager.getSession(sessionDbId);
  if (active) {
    if (observedModel) active.observedModel = observedModel;
    if (observedBilling) active.observedBilling = observedBilling;
  }
}
```

Note the subagent early-return at `:507-510` stays above this (subagent Stop hooks are skipped).

### 2.6 Tests (Phase 2)

- `tests/sqlite/session-store-sessions.test.ts` (or new `session-store-observed-metadata.test.ts`): fresh `SessionStore(new Database(':memory:'))` → `PRAGMA table_info(sdk_sessions)` has both columns; `createSDKSession` then `setSessionObservedMetadata(id, 'claude-x', 'max')` → `getSessionById(id)` returns them; a second call with `undefined` model keeps the previous model (COALESCE).
- Migration test: seed a legacy `sdk_sessions` table without the columns (pattern in `tests/sqlite/session-store-migrations.test.ts:9-33`), construct `SessionStore`, assert columns exist and `schema_versions` contains 50.

### 2.7 Verification checklist (Phase 2)

```
npm run typecheck
bun test tests/sqlite tests/worker
grep -n "observed_model" src/services/sqlite/SessionStore.ts | wc -l   # ≥ 4 (migration, row type, select, update)
```

---

## Phase 3: Telemetry emission — records, rollup, whitelist, docs

### 3.1 Per-turn records

Add to each record (omit when unknown — the scrubber drops `undefined`; the rollup fills `'unknown'`):

- `src/services/worker/agents/ResponseProcessor.ts:490-511` `compressionProps`: `observed_model: session.observedModel, observed_billing: session.observedBilling`.
- `SessionRoutes.ts:328-336` (error) and `:374-381` (abort): same two fields.

### 3.2 Rollup carries source + observed fields — `src/services/telemetry/buffer.ts:124-241`

Inside the record loop, track last-seen non-empty strings for `ide`, `provider`, `observed_model`, `observed_billing`. After the `rollup` object is built (`:199-226`):

```ts
if (lastIde) rollup.ide = lastIde;
if (lastProvider) rollup.provider = lastProvider;
rollup.observed_model = lastObservedModel ?? 'unknown';
rollup.observed_billing = lastObservedBilling ?? 'unknown';
```

`ide`/`provider` fix the documented-but-missing behavior (`docs/public/telemetry.mdx:132`). `hook` varies per turn and is intentionally not carried.

### 3.3 Whitelist — `src/services/telemetry/scrub.ts`

Add after `'top_model'` (`:162`), with the house comment style:

```ts
// Observed-session identity (NOT the observer): the model id the user's IDE
// session ran (from its transcript) and a closed-enum billing posture
// (max | pro | team | enterprise | subscription | api_key | bedrock | vertex | foundry | unknown).
'observed_model',
'observed_billing',
```

### 3.4 Docs — `docs/public/telemetry.mdx`

- `observer_turn_rollup` row (`:132`): add `observed_model`, `observed_billing`, and change "plus the per-turn fields it summarizes (`provider`, `ide`, `hook`)" to "(`provider`, `ide`)".
- If a "what we collect / never collect" list exists above the events table (grep `top_model` and `never` in the file), add one sentence: the observed session's model id and a closed-set billing tier are collected; never account ids, emails, or tokens.

### 3.5 Tests (Phase 3)

- `tests/telemetry/buffer.test.ts`: rollup carries last-seen `ide`, `provider`, `observed_model`, `observed_billing`; `observed_*` default to `'unknown'` when no record had them; a later record overrides an earlier one (last-seen semantics). Follow the existing `top_model` test at `:116`/`:175-181`.
- `tests/telemetry/scrub.test.ts`: `observed_model` and `observed_billing` survive `scrubProperties`.

### 3.6 Verification checklist (Phase 3)

```
npm run typecheck
bun test tests/telemetry
grep -n "observed_model" src/services/telemetry/scrub.ts src/services/telemetry/buffer.ts src/services/worker/agents/ResponseProcessor.ts src/services/worker/http/routes/SessionRoutes.ts
grep -n "observed_model\|observed_billing" docs/public/telemetry.mdx
```

---

## Phase 4: Verification (final)

1. `npm run typecheck && npm run build && bun test tests` (mirrors `.github/workflows/ci.yml`).
2. `npm run lint:hook-io && npm run lint:spawn-env`.
3. Anti-pattern greps:
   - `grep -rn "accessToken\|refreshToken\|emailAddress\|accountUuid" src/shared/observed-billing.ts` → empty.
   - `grep -rn "extractLastAssistantModel" src/cli/handlers/observation.ts` → empty (not in the per-tool path).
   - `git status --porcelain plugin/scripts` → empty (no build artifacts in the feature PR).
   - `grep -rln "transcript-parser.js" tests | xargs grep -L extractLastAssistantModel` → only files that don't mock the module.
4. Live smoke (this machine): `npm run build-and-sync`, then after the next Stop hook fires in any Claude Code session:
   `sqlite3 ~/.claude-mem/claude-mem.db "select id, platform_source, observed_model, observed_billing from sdk_sessions order by id desc limit 3"` → expect a real model id and `max`.
5. Open PR against `main`, babysit (CI + review bots), merge, then version-bump **MINOR** (13.21.2 → 13.22.0) per the version-bump skill.
