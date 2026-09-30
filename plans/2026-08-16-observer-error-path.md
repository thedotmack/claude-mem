# Observer Error Path — classify once, carry the message, tell the user what to do

## Primary goal

**A paying user whose observer stops working finds out within one session — and is told, in plain
words, exactly what happened and the one thing to do about it.** Never a silent 502 loop. Never a
message that only makes sense to us. Every error, every provider, every hop: *what · why · do this · link + request id*.

Everything below is measured against that sentence. If a task doesn't move a user from "it silently
stopped" toward "I know why and I know what to do", it doesn't belong in this plan.

**Problem (observed 2026-08-14 → 16):** Pro users who exhaust their inference allowance see
`OpenRouter upstream error (status 502)` ×3 retries, forever, silently. Root cause is a chain of small
losses: OpenRouter returns **403 `Key limit exceeded`** → the cmem.ai gateway only special-cases **402**
and 502-wraps everything else → the worker classifier treats 5xx as `transient`, retries, and drops the
upstream body (which contains the remedy) → the observer-health ledger (PR #3538) records a useless string.
Meanwhile 6 paying customers were dark for 3–5 days without knowing why.

**Design (one principle):** classify **once**, at the source (the gateway). Every later hop *carries* a
structured error — `{code, message, action, url, request_id}` — never rewrites it, never retries what
cannot succeed, and shows the same words in the log, in session-start context, and (later) in email.

**Taxonomy — 6 codes, that's the whole vocabulary:**

| `code` | HTTP | retry? | worker `kind` |
|---|---|---|---|
| `allowance_exhausted` | 402 | no | `quota_exhausted` |
| `key_invalid` | 401 | no | `auth_invalid` |
| `subscription_inactive` | 402 | no | `auth_invalid` |
| `rate_limited` | 429 | yes (Retry-After) | `rate_limit` |
| `upstream_unavailable` | 503 | yes | `transient` |
| `bad_request` | 400 | no | `unrecoverable` |

**Every message = 4 parts:** *what* happened · *why* · *do this* (one concrete action) · link + request id.

**Repos:** Phase 1 = `claude-mem-pro` (gateway). Phases 2–3 = `claude-mem` (worker). Each phase is
self-contained; run in a fresh context. Phase 3 depends on PR #3538 being merged first.

**Binding constraints:** root-cause fixes only; no new retry loops, no fallbacks, no env-var escape hatches
except the one test seam named below; keep diffs the size of the defect. Do not invent URLs — only
`https://cmem.ai/dashboard`, `support@cmem.ai`, and `https://github.com/thedotmack/claude-mem/issues`
are approved. Do not edit `CHANGELOG.md`.

---

## Phase 0 — Consolidated discovery (read before any phase; do not re-derive)

**How this serves the primary goal:** you can't write an honest error message for a failure you
haven't seen. This phase pins the *actual* upstream bodies (403 `Key limit exceeded`, 401 `User not
found.`), the exact lines where the message gets lost today, and the ledger API the warning will
render through — so every later phase edits the real seam instead of a guessed one.

Verified against `claude-mem` @ `or-issue` HEAD (`d768ba364`), `origin/observer-health-alerts` (PR #3538),
and `claude-mem-pro` @ main (2026-08-16). Empirical upstream facts were captured live against OpenRouter.

### Empirical OpenRouter responses (captured 2026-08-15/16, production keys)

| Situation | HTTP | body |
|---|---|---|
| Child key at cap (`limit_reset: null`, i.e. trial) | **403** | `{"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/<hash>","code":403}}` |
| Child key at cap (`limit_reset: 'monthly'`) | 403 (parenthetical differs, e.g. `(monthly limit)`) — match `/key limit exceeded/i`, never the parenthetical | |
| Invalid key | **401** | `{"error":{"message":"User not found.","code":401}}` |
| Docs-claimed 402 for exhausted key | not observed in production; keep the branch, it costs nothing | |

### Gateway (`claude-mem-pro`) — `src/app/api/inference/v1/chat/completions/route.ts` (432 lines)

Every error return today (line → status → message → condition):

| Line | HTTP | Message | Condition |
|---|---|---|---|
| L83 (`unauthorized()` L60-65) | 401 | `Missing or malformed CMEM Pro key` | no `Bearer cm_pro_…` |
| L92 | 401 | `Unrecognized CMEM Pro key` | no `proUsers.setupToken` match |
| L99-108 | 402 | `CMEM Pro subscription is not active. Manage billing at https://cmem.ai/dashboard` | `!isProActive(proUser)` — collapses `none/pending/past_due/cancelled` |
| L113-118 | 429 | `Rate limit exceeded` + `Retry-After: 60` | `isRateLimited('cmem-inference', userId, 600, 60_000)` |
| L124-127 / L131-134 | 400 | `Invalid JSON body` / `messages[] is required` | body parse |
| L170-173 | 500 | `Inference credential is unreadable` | decrypt failure (fail-closed) |
| L236-239 | 503 | `Could not provision inference access` | mint failure |
| **L279-301** | **402** | trialing / monthly copy (see L291-300) | `upstream.status === 402` **only** |
| **L309-317** | `429→429 else 502` | `payload?.error?.message ?? 'Observer model request failed'` with `code: upstream.status` | the `!upstream.ok \|\| !payload` fallthrough (L274) — **this is where 403 goes today** |
| L420-428 | 504 / 502 | `Observer model timed out` / `unreachable` | fetch threw |

Facts that shape Phase 1:
- **No request id anywhere** — nothing generated, nothing read from OpenRouter, nothing logged. Must be minted server-side (`randomUUID()`) and threaded into JSON body, `x-request-id` header, and every `console.*` line.
- `PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' }` is copy-pasted per route (L58 here); **no shared error helper exists** in `src/lib` (grep `errorResponse|jsonError|ApiError` = 0 hits). Phase 1 creates one.
- `paymentStatus` values in use: `'none' | 'pending' | 'active' | 'trialing' | 'past_due' | 'cancelled'` (schema comment `src/db/schema.ts:22` omits `trialing`). Existing per-status copy to match tone: `src/app/api/pro/status/route.ts:142-153`.
- Trial keys are `limit_reset: null` (cumulative) — "resets next cycle" is **false** for them (`src/lib/pro/openrouter-child-keys.ts:63-69`). `trialing` is derived at L280.
- **"Resets on <date>" is not derivable without a Stripe round-trip** (`current_period_end` is not on `proUsers`; only fetched live in `src/lib/pro/account-summary.ts:35`, `src/lib/admin/pro-users.ts:90-92`). **Decision: do not put a date in the message.** Say "at the start of your next billing cycle". Revisit if a denormalized column is added later.
- `captureServer(distinctId, event, props)` — `src/lib/analytics/posthog-server.ts:41-45`, never throws, awaits flush. Rules A3 (no tokens/emails in props) and A7 (analytics never fails inference) live in `plans/2026-08-08-posthog-funnel-and-admin.md:521,567`. Existing event: `pro_inference_cap_exhausted` at L287-290 with `{limit_usd, trialing}`.
- `OpenRouterKeyError` (`src/lib/pro/openrouter-child-keys.ts:89-96`) carries `.status`.
- `isRateLimited(route, key, max, windowMs)` — `src/lib/rate-limit.ts:34-39`; cannot report window remainder — keep `Retry-After: 60`.
- Tests: **no runner**; convention is standalone tsx scripts `scripts/test-<name>.ts` registered as `"test:<name>": "node --import tsx scripts/test-<name>.ts"` (`package.json:17-33`). Copy the shape of `scripts/test-mcp-auth.ts` (`node:assert/strict`, `main().then(...).catch(...)`). `bearerFrom` (route L72) is exported for testability — follow that pattern: **export a pure mapper and test it**, no HTTP mocking needed.
- Deploy: auto on merge to `main` (`CLAUDE.md:4`). Env in Vercel dashboard. `CMEM_PRO_MONTHLY_LIMIT_USD=30` is already set in prod (2026-08-16).
- Email (Resend) exists but `proUsers` has no email column and nothing dedupes — **out of scope** for this plan (noted as follow-up).

### Worker (`claude-mem`)

- `classifyOpenRouterError` — `src/services/worker/OpenRouterProvider.ts:30-95`. Branch order: body markers `quota exceeded|insufficient credits|insufficient_quota` → `quota_exhausted` (L44-53); 429 → `rate_limit` (L55-60); 401/403 → `auth_invalid` (L62-67); 400/404 → `unrecoverable` (L69-74); 5xx → `transient` (L76-81); no status → `transient` (L84-89); fallback (incl. 402) → `unrecoverable` with body[:200] (L91-94). **`input.requestId` is accepted and never used.** Only the fallback keeps any of the body.
- `ClassifiedProviderError` — `src/services/worker/provider-errors.ts:2-33`: `{ kind, retryAfterMs?, cause }`, kinds are an open string union. No structured fields today.
- Retry policy — `src/services/worker/retry.ts`: `isRetryableKind` L56-61 retries `transient|rate_limit` and **unclassified errors**; `withRetry` L76; retry warn at L116-119 (`Retrying ${label} after …ms (attempt n/2)`).
- Call site — `queryOpenRouterMultiTurn` L227-329: request id captured L256 (`x-request-id` ?? `x-openrouter-request-id`); `!response.ok` throw L263-272 passes `status, bodyText, headers, cause, requestId`; 200-with-`error` throw L276-284 flattens `{code,message}` into a string and **does not pass requestId**.
- Log fan-out per failure (5 lines): retry warn ×2 (`retry.ts:116`), `init query failed` (`OpenAICompatibleProvider.ts:114/116`), `✗ <Provider> agent error` (`handleSessionError` L305), `Generator failed` (`SessionRoutes.ts:211-215`, has `provider` + `errorMsg` from L179).
- Sibling classifiers: Gemini `GeminiProvider.ts:25-97` (uses requestId in synthesized cause L37-39), Claude `ClaudeProvider.ts:54-164` (preserves message verbatim). **Server-side copy that must be mirrored:** `src/server/generation/providers/shared/error-classification.ts:73-135` (`classifyHttpProviderError`; header L3-6 forbids importing worker code).
- Base URL: `resolveOpenRouterChatCompletionsUrl` `src/shared/openrouter-base-url.ts:48-62`; Pro users' URL is `https://cmem.ai/api/inference/v1/chat/completions` (`src/npx-cli/cmem-pro-costs.ts:197`) → `endpointClass: 'custom'` (`OpenRouterProvider.ts:159`).
- PR #3538 `src/shared/observer-health.ts` (on `origin/observer-health-alerts`): `ObserverHealthState` L21-34 (`lastErrorMessage: string|null` — flat), `scrubErrorMessage` L71-80, `readObserverHealth` L82-93 (`{...EMPTY_STATE, ...parsed}` merge → additive fields are backward compatible), `recordObserverFailure(provider, errorMessage, filePath?)` L180-197, `recordObserverSuccess` L199-209, `renderObserverHealthWarning(state, nowMs?)` L232-254 (emits `Latest error: <message>` + generic remedy text L253-254 that says "check ~/.claude-mem/settings.json" — wrong for Pro users). Hook: `SessionRoutes.ts` right after the `Generator failed` log → `recordObserverFailure(provider, errorMsg)`. Consumer: `ContextBuilder.ts:181-189` (`withObserverHealthWarning`) applied at L208/221/235.
- Tests: `tests/worker/provider-classifiers.test.ts` (`describe('classifyOpenRouterError')` L136-202, 7 cases, **assert only `kind`/`retryAfterMs`, never `message`**); PR adds `tests/observer-health.test.ts` (fixture already uses `Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/keys/abc`). Runner: `bun test tests` (`package.json:98`), pattern `import { describe, it, expect } from 'bun:test'`. `plugin/scripts/*.cjs` are committed bundles — run `npm run build` after source changes.

### Anti-patterns (do not)
- Do not 502-wrap anything user-actionable. Do not return `code: <upstream status>` in the body.
- Do not put child keys, setup tokens, or emails in PostHog props or in error messages.
- Do not invent a `cmem.ai/upgrade` or `/billing` URL — they don't exist. Approved links only (see top).
- Do not make a Stripe call on the error path for a date.
- Do not add a new retry layer; do not make unclassified errors non-retryable (that's a behaviour change outside scope).
- Do not import `src/services/worker/*` from `src/server/*`.

---

## Phase 1 — Gateway: classify once, honest status, structured envelope, request id (`claude-mem-pro`)

**How this serves the primary goal:** this is where the message is *born*. The gateway is the only
hop that knows the user's plan, trial state, and limit, so it's the only place that can say "You've
used your $30 allowance — it resets next cycle, email support if you need more". Honest status
codes mean the worker stops retrying the unretryable; the request id means "email support" is a
real path, not a dead end.

**Branch:** `feat/inference-error-taxonomy` off `main`.

### 1.1 New module `src/lib/http/gateway-error.ts`
Copy the one-liner response shape from `src/app/api/pro/trial/approve/route.ts:38` and grow it:

```ts
import { NextResponse } from 'next/server';

export type GatewayErrorCode =
  | 'allowance_exhausted' | 'key_invalid' | 'subscription_inactive'
  | 'rate_limited' | 'upstream_unavailable' | 'bad_request';

export const GATEWAY_ERROR_STATUS: Record<GatewayErrorCode, number> = {
  allowance_exhausted: 402, key_invalid: 401, subscription_inactive: 402,
  rate_limited: 429, upstream_unavailable: 503, bad_request: 400,
};

export interface GatewayError {
  code: GatewayErrorCode;
  message: string;      // what happened + why, one sentence
  action: string;       // what the user should do, one sentence
  url?: string;         // approved links only
  request_id: string;
}

export const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

export function gatewayErrorResponse(err: GatewayError, extraHeaders: Record<string,string> = {}) {
  return NextResponse.json({ error: err }, {
    status: GATEWAY_ERROR_STATUS[err.code],
    headers: { ...PRIVATE_HEADERS, 'x-request-id': err.request_id, ...extraHeaders },
  });
}
```

Also export a **pure** upstream mapper (this is what gets tested — mirrors the `bearerFrom` export-for-test pattern at route L72):

```ts
export type UpstreamOutcome =
  | { kind: 'allowance_exhausted' }
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'upstream_unavailable'; detail: string };

/** Map a non-OK (or unparseable) OpenRouter response to a taxonomy outcome. */
export function mapUpstreamFailure(status: number, payload: unknown): UpstreamOutcome
```
Rules (in this order):
1. `status === 402` **or** (`status === 403 || status === 401` **and** `/key limit exceeded|limit exceeded|insufficient credits|negative credit/i.test(message)`) → `allowance_exhausted`.
2. `status === 429` → `rate_limited` (retryAfterSec 60; the upstream `retry-after` header is not read today — keep 60).
3. Everything else (5xx, 401 `User not found.`, 403 without a limit phrase, non-JSON/`!payload`, unknown 4xx) → `upstream_unavailable` with `detail = payload?.error?.message ?? 'HTTP <status>'` for the server log **only** (never sent to the client — it may contain a manage-key URL for *our* workspace).

### 1.2 Message copy (final; the client renders `message` + `action` verbatim)

| code | message | action | url |
|---|---|---|---|
| `allowance_exhausted` (active) | `You've used your $<limit> CMEM Pro inference allowance for this billing cycle.` | `It resets at the start of your next billing cycle. Need more before then? Email support@cmem.ai.` | `https://cmem.ai/dashboard` |
| `allowance_exhausted` (trialing) | `You've used your free-week inference allowance ($<limit>).` | `Your full allowance unlocks when your trial converts. Want it sooner? Email support@cmem.ai.` | `https://cmem.ai/dashboard` |
| `key_invalid` | `This CMEM Pro key isn't recognized.` | `Run \`npx claude-mem pro-setup\` to re-link this machine, or copy a fresh key from your dashboard.` | `https://cmem.ai/dashboard` |
| `subscription_inactive` (`past_due`) | `Your CMEM Pro payment didn't go through, so the observer is paused.` | `Update your card in the dashboard and observations resume immediately.` | `https://cmem.ai/dashboard` |
| `subscription_inactive` (`cancelled`) | `Your CMEM Pro subscription has ended.` | `Resubscribe from the dashboard to turn the observer back on.` | `https://cmem.ai/dashboard` |
| `subscription_inactive` (other) | `Your CMEM Pro subscription isn't active.` | `Check billing in the dashboard, or email support@cmem.ai.` | `https://cmem.ai/dashboard` |
| `rate_limited` | `Too many observer requests in the last minute.` | `Retrying automatically in 60s — nothing to do.` | — |
| `upstream_unavailable` | `The observer model is temporarily unavailable.` | `claude-mem retries automatically. If this lasts more than an hour, email support@cmem.ai with the request id.` | — |
| `bad_request` | `The observer sent a request the gateway couldn't parse.` | `This is a claude-mem bug — please open an issue with the request id.` | `https://github.com/thedotmack/claude-mem/issues` |

`<limit>` = `proUser.openrouterKeyLimitUsd` formatted with no trailing zeros (`$30`, `$2.33`); if null, omit the dollar clause.

### 1.3 Route changes (`route.ts`)
- Top of `POST`: `const requestId = randomUUID();` (`node:crypto`). Prefix every `console.warn/error` in this file with `{ requestId }` in the context object.
- Replace L60-65 `unauthorized()` + call sites L83/L92 → `gatewayErrorResponse({ code: 'key_invalid', … })`.
- Replace L99-108 → `subscription_inactive` with the per-`paymentStatus` copy from 1.2 (`proUser.paymentStatus`).
- Replace L113-118 → `rate_limited`, keep `Retry-After: '60'` via `extraHeaders`.
- Replace L124-127 / L131-134 → `bad_request`.
- L170-173 (decrypt) and L236-239 (mint) → `upstream_unavailable` (these are our fault, not the user's; keep the existing `console.error` lines, add `requestId`).
- **Replace the whole L274-317 block** with `const outcome = mapUpstreamFailure(upstream.status, payload)` and a `switch`:
  - `allowance_exhausted` → keep the existing `console.warn` (L281-284) and the `captureServer('pro_inference_cap_exhausted', { limit_usd, trialing })` (L287-290) exactly as-is (A3/A7), then respond with the trialing/active copy.
  - `rate_limited` → respond 429 + `Retry-After`.
  - `upstream_unavailable` → `console.error('[cmem-inference] upstream failed', { requestId, userId, status: upstream.status, detail })` then respond 503. **Never 502.**
- L420-428 (fetch threw / abort) → `upstream_unavailable` (503 for both; the timeout distinction goes in the server log `{ requestId, aborted }`).
- The success path is untouched.

### 1.4 Test `scripts/test-inference-errors.ts` + `package.json` script `test:inference-errors`
Copy the skeleton of `scripts/test-mcp-auth.ts` (imports, `main().then().catch()`), but test the **pure** functions only:
- `mapUpstreamFailure(403, {error:{message:'Key limit exceeded (total limit). Manage it using https://openrouter.ai/…',code:403}})` → `allowance_exhausted`
- `mapUpstreamFailure(403, {error:{message:'Key limit exceeded (monthly limit). …'}})` → `allowance_exhausted`
- `mapUpstreamFailure(402, {…})` → `allowance_exhausted`
- `mapUpstreamFailure(401, {error:{message:'User not found.',code:401}})` → `upstream_unavailable`
- `mapUpstreamFailure(429, {})` → `rate_limited`
- `mapUpstreamFailure(500, null)` and `(200, null)` → `upstream_unavailable`
- `GATEWAY_ERROR_STATUS` has exactly the 6 keys with the statuses in the taxonomy table.
- `gatewayErrorResponse(...)` sets `x-request-id` and `Cache-Control: private, no-store` and status from the map (call `.headers.get(...)`, `.status`).

### 1.5 Verification checklist
- `npm run test:inference-errors` passes; `npm run build` (Next) passes.
- `grep -n "502" src/app/api/inference/v1/chat/completions/route.ts` → **0 hits**.
- `grep -n "NextResponse.json({ error" src/app/api/inference/v1/chat/completions/route.ts` → 0 hits (all through `gatewayErrorResponse`).
- `grep -n "randomUUID" route.ts` → 1 hit at top of `POST`.
- Live smoke after deploy (owner key, from the claude-mem worktree):
  `curl -sD - https://cmem.ai/api/inference/v1/chat/completions -H "Authorization: Bearer cm_pro_bogus" -d '{}'` → HTTP 401, JSON `error.code === 'key_invalid'`, `x-request-id` header present.
- Open PR to `main`; PR body links this plan.

### 1.6 Anti-pattern guards
No Stripe calls added. No new env vars. `detail` from upstream never reaches the response body. Message strings contain no `cm_pro_`/`sk-or-` fragments (add an `assert(!/cm_pro_|sk-or-/.test(JSON.stringify(err)))` in the test over every rendered message).

---

## Phase 2 — Worker: carry the envelope, stop retrying quota, log once (`claude-mem`)

**How this serves the primary goal:** today the worker *has* the answer in hand (the upstream body
with the manage-key link) and throws it away, then buries the failure under five log lines and two
pointless retries. This phase makes the worker a faithful courier: the gateway's words survive
verbatim, quota errors fail fast instead of looping, and there is exactly one log line a user (or
their agent) can read and act on. It also fixes the same loss for non-Pro OpenRouter users, whose
"Key limit exceeded" body was equally discarded.

**Branch:** `fix/observer-error-envelope` off `main`. Independent of Phase 1 (works with legacy bodies too) and of PR #3538.

### 2.1 `src/services/worker/provider-errors.ts` — add optional structured fields
Extend the constructor opts and readonly fields (keep everything existing):
```ts
export interface ProviderErrorDetail { code?: string; action?: string; url?: string; requestId?: string }
constructor(message: string, opts: { kind: ProviderErrorClass; cause: unknown; retryAfterMs?: number } & ProviderErrorDetail)
```
Expose them as `readonly code?, action?, url?, requestId?`. Add `export function describeProviderError(err: ClassifiedProviderError): string` → `` `${err.message}${err.action ? ' — ' + err.action : ''}${err.url ? ' ' + err.url : ''}${err.requestId ? ` (req ${err.requestId})` : ''}` `` — this is the **one** rendering used by the log line and the ledger.

### 2.2 `classifyOpenRouterError` (`OpenRouterProvider.ts:30-95`) — parse the envelope, keep the body, use requestId
Insert **before** the existing body-marker branch (L44):
1. Try `JSON.parse(bodyText)`; if `parsed?.error?.code` is one of the six taxonomy strings → build the error with `message = parsed.error.message`, `action`, `url`, `requestId = parsed.error.request_id ?? input.requestId`, and `kind` from the mapping table at the top of this plan (`allowance_exhausted→quota_exhausted`, `key_invalid|subscription_inactive→auth_invalid`, `rate_limited→rate_limit` (+`retryAfterMs`), `upstream_unavailable→transient`, `bad_request→unrecoverable`). Return.
2. Otherwise fall through to legacy classification with these changes:
   - Body markers for `quota_exhausted` become `quota exceeded|insufficient credits|insufficient_quota|key limit exceeded|limit exceeded|negative credit`, **and** `status === 402` → `quota_exhausted` (today 402 falls to `unrecoverable`).
   - Every branch's message must **include the upstream body** (parsed `error.message` if JSON, else `bodyText.substring(0, 300)`), and set `requestId: input.requestId`. Message shape: `` `OpenRouter <class> (status N): <upstream message>` `` — e.g. `OpenRouter quota exhausted (status 403): Key limit exceeded (total limit). Manage it using https://openrouter.ai/…`.
3. In `queryOpenRouterMultiTurn` L276-284 (200-with-`error`), pass `bodyText: JSON.stringify(responseData)` (so step 1 can parse it) and `...(requestId ? { requestId } : {})`.

Mirror the **body-marker list only** in `src/server/generation/providers/shared/error-classification.ts:82-92` (add `key limit exceeded|limit exceeded|negative credit`, and 402→quota). Do not import across the boundary.

### 2.3 Log once per failure
- `retry.ts:116` warn: unchanged (only fires for retryable kinds; after 2.2 quota/auth no longer retry).
- `OpenAICompatibleProvider.ts:114/116` (`init query failed`) and `:125/127` (`message loop failed`): when `isClassified(error)`, log at `debug`, not `error`. Same for `handleSessionError` L305 (`✗ … agent error`) — `debug` when classified. Unclassified errors keep today's behaviour.
- `SessionRoutes.ts:211-215` (`Generator failed`) becomes the single error-level line for classified errors, rendered with `describeProviderError(error)`:
  `logger.error('SESSION', 'Observer failed', { sessionId, provider, kind: error.kind, code: error.code, requestId: error.requestId }, describeProviderError(error))` — pass the string, not the Error object, for classified errors so `errorSink`/captureException isn't triple-fired. Unclassified errors: unchanged.
- Result: one WARN per retry attempt (only for transient/rate-limit) + exactly one ERROR per failure that names the code, the message, the action, and the request id.

### 2.4 Tests (`tests/worker/provider-classifiers.test.ts`, extend `describe('classifyOpenRouterError')` L136-202)
Add cases; **assert `message`, `code`, `action`, `url`, `requestId`, not just `kind`**:
- envelope: `{status:402, bodyText: JSON.stringify({error:{code:'allowance_exhausted', message:'You've used your $30 …', action:'It resets …', url:'https://cmem.ai/dashboard', request_id:'abc'}})}` → `kind quota_exhausted`, `code allowance_exhausted`, `message` verbatim, `action` verbatim, `requestId 'abc'`.
- envelope `key_invalid` (401) → `auth_invalid`; `rate_limited` (429, `retry-after: 60`) → `rate_limit`, `retryAfterMs 60000`; `upstream_unavailable` (503) → `transient`; `bad_request` (400) → `unrecoverable`.
- legacy 403 `{"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/94121a…","code":403}}` → `quota_exhausted`, message contains `Key limit exceeded` **and** the `https://openrouter.ai/` URL, `requestId` = the passed id.
- legacy 402 → `quota_exhausted`; legacy 502 with body → `transient` and message contains the body.
- `describeProviderError` renders `message — action url (req id)` and omits missing parts.
- Add `tests/worker/retry-policy.test.ts`: `isRetryableKind` false for `quota_exhausted|auth_invalid|unrecoverable`, true for `transient|rate_limit`, true for a plain `Error` (pins current unclassified behaviour).

### 2.5 Verification
- `bun test tests/worker` green. `npm run build` regenerates `plugin/scripts/worker-service.cjs`; commit the bundle.
- `grep -n "requestId" src/services/worker/OpenRouterProvider.ts` shows it used inside `classifyOpenRouterError` (not just accepted).
- `grep -rn "key limit exceeded" src/services/worker/OpenRouterProvider.ts src/server/generation/providers/shared/error-classification.ts` → 2 hits.
- Manual: with the owner's `~/.claude-mem/settings.json` pointing at cmem.ai, temporarily set the child key limit to its current usage (`PATCH /api/v1/keys/<hash> {"limit": <usage>}`), trigger one observer turn, confirm the worker log shows **exactly one** `Observer failed` line whose text contains `Key limit exceeded` (pre-Phase-1) or the taxonomy `action` (post-Phase-1) and **no** `Retrying OpenRouter` lines. Restore the limit.

### 2.6 Anti-pattern guards
Do not change `isRetryableKind`'s treatment of unclassified errors. Do not add retries. Do not touch Gemini/Claude classifiers beyond nothing (they're out of scope). Do not swallow errors — the `debug` downgrade only applies when the error is already classified and will be logged once at `Generator failed`.

---

## Phase 3 — Ledger + session-start warning render the structured error (`claude-mem`, after PR #3538 merges)

**How this serves the primary goal:** this is the "finds out within one session" half. Users don't
read worker logs; they open Claude Code. PR #3538 already puts a warning at the top of the next
session — this phase makes that warning say the *right* thing: the gateway's message, a "What to
do:" line, the link, and the request id, instead of a generic "check your settings.json" that is
wrong for a Pro user. Without this phase, Phases 1–2 produce a good message nobody sees.

**Precondition:** merge `origin/observer-health-alerts` (PR #3538) to `main` first. Then branch `feat/observer-health-structured` off `main` (which now has Phase 2 too).

### 3.1 `src/shared/observer-health.ts`
- `ObserverHealthState` (L21-34): add optional `lastErrorCode: string|null; lastErrorAction: string|null; lastErrorUrl: string|null; lastErrorRequestId: string|null` (default `null` in `EMPTY_STATE`; `readObserverHealth`'s `{...EMPTY_STATE, ...parsed}` merge keeps old files valid).
- `recordObserverFailure(provider, error, filePath?)` (L180-197): second param becomes `string | { message: string; code?: string; action?: string; url?: string; requestId?: string }`. Strings behave exactly as today. Objects populate the new fields (scrub `message` and `action` with `scrubErrorMessage`; `url` and `requestId` are stored as-is).
- `renderObserverHealthWarning` (L232-254): after `Latest error: <message>` add, when present, `What to do: <action>` and `Link: <url>` and `Request id: <requestId>`. **When `action` is present, replace** the generic remedy lines (L253-254, "check the observer provider's API key, spend limit, and base URL in ~/.claude-mem/settings.json") — that text is wrong for Pro users. Keep the generic remedy only when no `action` exists.

### 3.2 `SessionRoutes.ts` hook (the line PR #3538 added after `Generator failed`)
`recordObserverFailure(provider, isClassified(error) ? { message: error.message, code: error.code, action: error.action, url: error.url, requestId: error.requestId } : errorMsg)`.

### 3.3 Tests (`tests/observer-health.test.ts`, extend)
- Object form round-trips all four new fields through the file; string form leaves them `null`.
- `renderObserverHealthWarning` with `action` present includes `What to do:` and **does not** include `~/.claude-mem/settings.json`; without `action` it still includes the generic remedy (pins existing behaviour).
- Old ledger file (no new keys) reads back with the new fields `null`.

### 3.4 Verification
- `bun test tests/observer-health.test.ts tests/worker` green; `npm run build`; commit bundles.
- End-to-end (owner account): cap the key as in 2.5, run one observer turn, then start a new Claude Code session in any project and confirm the session-start context begins with the health warning containing the taxonomy `message`, `What to do:` line, `https://cmem.ai/dashboard`, and a request id. Restore the limit; run a successful turn; confirm the warning clears (`recordObserverSuccess`).

---

## Phase 4 — Verification & release

**How this serves the primary goal:** the goal is a *user outcome*, so the proof has to be the
user's experience, not green tests alone: cap a real key, watch one log line appear and zero
retries, open a fresh session and read the warning. If any of the three surfaces (log, session
warning, gateway response) shows a different message than the others, the phase fails.

1. Both repos: all tests green; PRs merged (Phase 1 in `claude-mem-pro` → auto-deploys; Phases 2–3 in `claude-mem`).
2. Grep guards: `claude-mem-pro`: `grep -rn "502" src/app/api/inference` = 0. `claude-mem`: `grep -rn "OpenRouter upstream error (status" src/` = 0 (message shape now includes the body).
3. Live: from a capped test key, the worker log has one `Observer failed` line + zero retries; the next session start shows the warning with the action; the gateway response carries `x-request-id`; PostHog receives `pro_inference_cap_exhausted` (check `captureServer` still fires — query the event in PostHog for the test user id).
4. Release `claude-mem` per `/claude-mem:version-bump` (patch). No changelog edits.

**Follow-ups (explicitly out of scope here):** the "you hit $30 → next tier" nag/email (needs an email lookup + dedupe state), a denormalized billing-period column so `allowance_exhausted` can say a date, and per-plan limits ($20 vs $30) in `openrouter-child-keys.ts`.
