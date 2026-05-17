# Plan 06 — Worker Env Isolation

> **Goal:** Stop host-side environment variables from contaminating the worker's Anthropic SDK subprocess. Two confirmed bugs anchor this plan: `ANTHROPIC_BASE_URL` leaks from the parent shell while `ANTHROPIC_AUTH_TOKEN` is blocked, breaking proxy/gateway auth (#2375); and `CLAUDE_CODE_EFFORT_LEVEL` propagates from host CLI settings into the SDK subprocess where it triggers a permanent HTTP 400 that the retry classifier mistakes for transient (#2357). Adjacent feature #2289 (`$TIER` alias syntax) is in scope where it shares the same env/model-resolution surface.
>
> **Net effect:**
> - The OAuth-skip predicate requires a real credential (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`), not a bare `ANTHROPIC_BASE_URL`. Proxy/gateway users put credentials in `~/.claude-mem/.env`; nothing relies on parent-shell leaks.
> - `BLOCKED_ENV_VARS` adds `ANTHROPIC_BASE_URL` and the `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` pair (defense in depth alongside the existing `env-sanitizer.ts` `CLAUDE_CODE_*` prefix filter).
> - The Claude provider's error classifier explicitly handles HTTP 400 as `unrecoverable`, matching `GeminiProvider`/`OpenRouterProvider`. No more unbounded retry loop on permanent-error responses.
> - Every spawn boundary that hands env to a child process applies BOTH `buildIsolatedEnv` and `sanitizeEnv`. A grep-based CI check forbids spawning subprocesses with raw `process.env`.
> - `~/.claude-mem/.env` becomes the single source of truth for non-OAuth Anthropic credentials. The loader's whitelist documents this contract.
>
> **Out of scope:**
> - Hook-side env handling (Plan 01 / 02 territory).
> - Worker daemon lifecycle, DB bloat, and chroma-mcp leaks (Plan 03).
> - Observer/Knowledge SDK tool enforcement (Plan 05).
> - Re-auth UX flow (different concern; out of scope for this plan).
> - General provider-router refactor — `$TIER` alias is scoped to model resolution only (Phase 4).

---

## Problem Statement (line citations)

### Bug A — `ANTHROPIC_BASE_URL` leaks, OAuth gets skipped, `ANTHROPIC_AUTH_TOKEN` is missing (#2375)

`src/shared/EnvManager.ts` lines 14–24 (`BLOCKED_ENV_VARS`):

```ts
const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',       // #733
  'ANTHROPIC_AUTH_TOKEN',    // added 5edf1557 (2026-05-04) — leak prevention
  'CLAUDECODE',
  'CLAUDE_CODE_OAUTH_TOKEN', // #2215
];
```

`ANTHROPIC_BASE_URL` is **not** in the list, so it survives `buildIsolatedEnv()` (lines 166–205) and reaches `isolatedEnv` from `process.env`.

`buildIsolatedEnvWithFreshOAuth()` lines 222–288 then runs the OAuth-skip predicate at lines 237–244:

```ts
if (
  isolatedEnv.ANTHROPIC_API_KEY ||
  isolatedEnv.ANTHROPIC_BASE_URL ||
  isolatedEnv.ANTHROPIC_AUTH_TOKEN
) {
  clearStaleMarker();
  return isolatedEnv;
}
```

The bare `BASE_URL` branch was added in commit `a122d34e` (2026-05-04) under the rationale "tokenless gateways may exist." Combined with the `AUTH_TOKEN` block from `5edf1557` the same day, the subprocess ends up with:

- `ANTHROPIC_BASE_URL` ✅ (leaked from parent)
- `ANTHROPIC_AUTH_TOKEN` ❌ (blocked, never re-injected because `~/.claude-mem/.env` is empty for first-time proxy users)
- `CLAUDE_CODE_OAUTH_TOKEN` ❌ (skip path bypassed the keychain read)

Result: `Not logged in · Please run /login` from every SDK subprocess.

### Bug B — `CLAUDE_CODE_EFFORT_LEVEL` triggers permanent 400 + unbounded retry (#2357)

The Anthropic SDK subprocess reads `CLAUDE_CODE_EFFORT_LEVEL` from its env and forwards it as the `effort` parameter on Messages API calls. claude-mem's source contains **zero** references to `effort` — the leak path is environmental, not code. Models without effort support (Haiku 4.5, Sonnet 4.5, older) reject with HTTP 400.

`src/supervisor/env-sanitizer.ts` lines 1–51 already filters `CLAUDE_CODE_*` via `ENV_PREFIXES` (with explicit allowances in `ENV_PRESERVE`). But:

1. `buildIsolatedEnv` does NOT call `sanitizeEnv` internally; callers are expected to chain them.
2. `BLOCKED_ENV_VARS` is the canonical leak deny-list and does not name `CLAUDE_CODE_EFFORT_LEVEL`. Defense-in-depth is currently single-layer.
3. The retry classifier in `src/services/worker/ClaudeProvider.ts` has no HTTP 400 case; the default branch at line 98 returns `kind: 'transient'`, so a permanent 400 loops forever.

`src/services/worker/GeminiProvider.ts` lines 89–94 and `src/services/worker/OpenRouterProvider.ts` lines 82–87 already classify 400 as `unrecoverable`; that pattern is the copy-target for ClaudeProvider.

### Adjacent — `$TIER` alias syntax (#2289)

`src/shared/SettingsDefaultsManager.ts` line 116 already implements a *portable* `'haiku'` alias for `CLAUDE_MEM_TIER_SIMPLE_MODEL` (per #1463). What's missing is the user-facing `$TIER` *syntax* in the `CLAUDE_MEM_MODEL` field that resolves to a provider-appropriate model at request time. Same code surface (model resolution in `ClaudeProvider.getModelId` at lines 442–446); minimal extension.

---

## Phase 0 — Documentation Discovery (already completed)

Findings below are direct file reads dated 2026-05-08. Each implementation phase cites by line number; do not re-derive. **Confidence: HIGH on file/API inventory.** Local-only files were read end-to-end.

### Allowed APIs / patterns to copy

| Item | Location | What to copy |
|---|---|---|
| `BLOCKED_ENV_VARS` array | `src/shared/EnvManager.ts:14–24` | Add new entries; keep the comment-per-entry convention |
| `buildIsolatedEnv` filter pattern | `src/shared/EnvManager.ts:166–205` | Filter on `BLOCKED_ENV_VARS.includes(key)`; defensive `delete isolatedEnv.X` post-filter |
| `buildIsolatedEnvWithFreshOAuth` skip-check | `src/shared/EnvManager.ts:237–244` | Restrict predicate to real credentials only |
| `loadClaudeMemEnv` whitelist + `ClaudeMemEnv` interface | `src/shared/EnvManager.ts:26–32, 79–100` | Single source of truth for what `~/.claude-mem/.env` accepts |
| `ENV_PRESERVE` / `ENV_EXACT_MATCHES` / `ENV_PREFIXES` | `src/supervisor/env-sanitizer.ts:1–51` | Whitelist-based env stripping; do NOT add `CLAUDE_CODE_EFFORT_LEVEL` to `ENV_PRESERVE` |
| Provider error classifier (HTTP 400 → unrecoverable) | `src/services/worker/GeminiProvider.ts:89–94`, `src/services/worker/OpenRouterProvider.ts:82–87` | Identical pattern to apply in `ClaudeProvider` |
| `ClassifiedProviderError` constructor + `kind: 'unrecoverable' \| 'auth_invalid' \| 'transient' \| 'rate_limit' \| 'quota_exhausted'` | `src/services/worker/retry.ts` | Use existing `kind` enum; do not invent `permanent` |
| `isRetryableKind` predicate | `src/services/worker/retry.ts:37–44` | Used by all retry sites; no edit needed once classifier is correct |
| Tier model resolution + `'haiku'` alias | `src/services/worker/http/routes/SessionRoutes.ts:503–521`, `src/shared/SettingsDefaultsManager.ts:51–53, 115–117` | Pattern for extending `$TIER` syntax |
| Settings flat-key + `loadFromFile` | `src/shared/SettingsDefaultsManager.ts:6–67, 70–131, 137–139, 161–206` | New keys MUST be added to interface AND `DEFAULTS` block |
| Plan format (phase numbering, line-cited edits, anti-patterns block) | `plans/01-hook-io-discipline.md`, `plans/05-observer-tool-enforcement.md` | Reuse layout |

### Anti-patterns / methods that DO NOT exist (avoid inventing)

- claude-mem source has **zero references** to `effort`, `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`, or `reasoning_effort`. Do not "remove the effort parameter we forward" — there is none. The leak is the SDK subprocess reading the env var directly.
- `BLOCKED_ENV_VARS` is an `Array<string>` with `.includes` lookup. Do NOT convert to `Set` in the same change — that touches every caller and is an unrelated refactor.
- `ClassifiedProviderError.kind` does NOT support the value `'permanent'`. The existing enum is `'transient' | 'rate_limit' | 'unrecoverable' | 'auth_invalid' | 'quota_exhausted'`. Use `unrecoverable` for permanent 400s.
- `pending_messages` has **no `retry_count` column** (dropped — see `src/services/sqlite/SessionStore.ts:104`'s `deadColumns` array). Issue #2357's "retry counter climbed past #1874" refers to log-line numbering, not a DB counter. Do not add a counter as part of this plan; that's Plan 03 territory.
- `sanitizeEnv` is whitelist-based (preserves a fixed set; strips everything matching `CLAUDE_CODE_*` etc). It is NOT idempotent if you re-add a name to `ENV_PRESERVE`. Do not add `CLAUDE_CODE_EFFORT_LEVEL` to `ENV_PRESERVE` — that's the opposite of what we want.
- `buildIsolatedEnv` and `sanitizeEnv` are **independent layers**. Some callers chain (`sanitizeEnv(buildIsolatedEnv(...))`); some only use one. Do not assume chaining is universal — Phase 5 audits every spawn boundary.
- The `~/.claude-mem/.env` loader at `src/shared/EnvManager.ts:79–100` uses property-by-property assignment as an implicit whitelist. Do NOT replace with `Object.assign(result, parsed)` — that breaks the whitelist guarantee.

### File inventory used by this plan

| File | Lines | Disposition |
|---|---|---|
| `src/shared/EnvManager.ts` | 319 | Edited heavily (Phase 2, Phase 5) |
| `src/supervisor/env-sanitizer.ts` | 51 | Light edit (Phase 3 — comment change only; `CLAUDE_CODE_*` prefix already filters EFFORT_LEVEL) |
| `src/services/worker/ClaudeProvider.ts` | 448 | Edited (Phase 3 — error classifier on `query()` rejection path) |
| `src/services/worker/retry.ts` | small | Confirm-only (Phase 3 — `isRetryableKind` already correct) |
| `src/services/worker/GeminiProvider.ts` | reference only | Read for pattern (Phase 3) |
| `src/services/worker/OpenRouterProvider.ts` | reference only | Read for pattern (Phase 3) |
| `src/shared/SettingsDefaultsManager.ts` | 209 | Edited (Phase 4 — `$TIER` alias resolution) |
| `src/services/worker/http/routes/SessionRoutes.ts` | reference | Read tier-routing pattern (Phase 4) |
| `src/services/infrastructure/ProcessManager.ts` | line 415 | Audit (Phase 5) — confirm `sanitizeEnv` chain is sufficient |
| `src/services/sync/ChromaMcpManager.ts` | line 585 | Audit (Phase 5) |
| `src/supervisor/process-registry.ts` | line 539 | Audit (Phase 5) |
| `src/services/worker-service.ts` | line 412 | Audit (Phase 5) |
| `src/services/worker/knowledge/KnowledgeAgent.ts` | lines 54, 149 | Confirm-only (Phase 5) |
| `tests/env-isolation.test.ts` | NEW | CREATED (Phase 6) |
| `scripts/check-spawn-env-discipline.cjs` | NEW | CREATED (Phase 7) |
| `CLAUDE.md` | small | Edited (Phase 7 — document `~/.claude-mem/.env` contract) |

---

## Phase 1 — Audit & write the failing tests first

**Goal:** Pin down current behavior with red tests so the fix can prove itself green. No production-code changes in this phase.

### 1.1 Tests to add (`tests/env-isolation.test.ts`)

Use `bun:test` per `package.json` `"test": "bun test"`. Pattern from `tests/claude-provider-resume.test.ts:1`.

1. **`buildIsolatedEnvWithFreshOAuth strips ANTHROPIC_BASE_URL when no .env credentials are configured`**
   - Stub `process.env.ANTHROPIC_BASE_URL = 'https://proxy.example'`, no `~/.claude-mem/.env`, no API_KEY/AUTH_TOKEN in env.
   - Call `buildIsolatedEnvWithFreshOAuth()`.
   - Assert: result does NOT have `ANTHROPIC_BASE_URL` (post-fix). Currently RED.
2. **`OAuth-skip does not fire on bare ANTHROPIC_BASE_URL`**
   - Same setup. Spy on `readClaudeOAuthToken`.
   - Assert: `readClaudeOAuthToken` was called (because BASE_URL alone is not enough to skip). Currently RED — `readClaudeOAuthToken` is NOT called today.
3. **`ANTHROPIC_AUTH_TOKEN from ~/.claude-mem/.env reaches the isolated env`**
   - Write a temp `.env` with `ANTHROPIC_AUTH_TOKEN=test-token` and `ANTHROPIC_BASE_URL=https://proxy.example`.
   - Assert: `isolatedEnv.ANTHROPIC_AUTH_TOKEN === 'test-token'` AND `isolatedEnv.ANTHROPIC_BASE_URL === 'https://proxy.example'`. Currently GREEN (already works); test guards against regression.
4. **`CLAUDE_CODE_EFFORT_LEVEL is stripped from the isolated env`**
   - Stub `process.env.CLAUDE_CODE_EFFORT_LEVEL = 'MAX'`.
   - Assert: `sanitizeEnv(buildIsolatedEnv())` does NOT contain `CLAUDE_CODE_EFFORT_LEVEL`. Currently GREEN via `env-sanitizer.ENV_PREFIXES`; test guards.
5. **`CLAUDE_CODE_EFFORT_LEVEL is in BLOCKED_ENV_VARS for defense-in-depth`**
   - Assert: `BLOCKED_ENV_VARS.includes('CLAUDE_CODE_EFFORT_LEVEL')`. Currently RED.
6. **`HTTP 400 from Claude SDK is classified unrecoverable`**
   - Construct an error matching the SDK's 400 shape (`error.status === 400`, body contains `does not support the effort parameter`).
   - Assert: `classifyClaudeProviderError(err).kind === 'unrecoverable'`. Currently RED — falls through to `transient`.
7. **`HTTP 400 with effort-parameter body emits a once-only warn log`**
   - Same setup as 6, plus capture `logger.warn` calls.
   - Assert: warn fires once with category `SDK` and a hint pointing at #2357 / `~/.claude-mem/.env`. Currently RED.

### 1.2 Verification checklist (Phase 1)

- [ ] All 7 tests added; tests 1, 2, 5, 6, 7 are RED; tests 3, 4 are GREEN.
- [ ] `bun test tests/env-isolation.test.ts` runs cleanly (RED tests fail with the expected assertion, no other errors).
- [ ] No production-code changes in this phase (`git diff src/` empty).

### 1.3 Anti-pattern guards

- Do NOT mock `EnvManager.buildIsolatedEnv` — it's the unit under test.
- Do NOT use `vi.*` (project uses `bun:test`, not vitest).
- Do NOT skip cleanup of temp `.env` files. Use a per-test `beforeEach`/`afterEach` with `mkdtempSync`.

---

## Phase 2 — Fix #2375 (BASE_URL leak + OAuth-skip predicate)

**Goal:** Make the OAuth-skip require a real credential, and add `ANTHROPIC_BASE_URL` to the deny-list so it can only be configured via `~/.claude-mem/.env`.

### 2.1 Edit `src/shared/EnvManager.ts:14–24` — extend `BLOCKED_ENV_VARS`

**Before:**
```ts
const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_OAUTH_TOKEN',
];
```

**After (add `ANTHROPIC_BASE_URL`):**
```ts
const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',       // #733
  'ANTHROPIC_AUTH_TOKEN',    // 5edf1557 — leak prevention; re-injected from ~/.claude-mem/.env when configured
  'ANTHROPIC_BASE_URL',      // #2375 — same leak class as AUTH_TOKEN; re-injected from ~/.claude-mem/.env. Without this entry, a leaked BASE_URL alone triggered the OAuth-skip while no auth credential reached the subprocess.
  'CLAUDECODE',
  'CLAUDE_CODE_OAUTH_TOKEN', // #2215
];
```

### 2.2 Edit `src/shared/EnvManager.ts:237–244` — restrict OAuth-skip to real credentials

**Before:**
```ts
if (
  isolatedEnv.ANTHROPIC_API_KEY ||
  isolatedEnv.ANTHROPIC_BASE_URL ||
  isolatedEnv.ANTHROPIC_AUTH_TOKEN
) {
  clearStaleMarker();
  return isolatedEnv;
}
```

**After:**
```ts
// Skip OAuth lookup ONLY when a real credential is configured. A bare
// ANTHROPIC_BASE_URL is not a credential — every documented gateway needs
// either an AUTH_TOKEN or an API_KEY. This guards #2375 against a class of
// leaks where a parent shell exports BASE_URL (e.g. for the Claude Code CLI
// itself) while no token is present.
if (isolatedEnv.ANTHROPIC_API_KEY || isolatedEnv.ANTHROPIC_AUTH_TOKEN) {
  clearStaleMarker();
  return isolatedEnv;
}
```

### 2.3 Verify the `~/.claude-mem/.env` re-injection at `src/shared/EnvManager.ts:178–195`

Currently the loader path covers BASE_URL re-injection from `.env`. Confirm by reading the function. No code change required here, but add a TS comment block above lines 178–195 documenting the new contract:

```ts
// Contract (post-#2375): ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, and
// ANTHROPIC_API_KEY are *only* populated from ~/.claude-mem/.env. They are
// in BLOCKED_ENV_VARS so parent-shell values never leak through.
```

### 2.4 Verification checklist (Phase 2)

- [ ] Tests 1, 2 from Phase 1 now GREEN.
- [ ] Existing test suite still passes (`bun test`).
- [ ] `grep -n "ANTHROPIC_BASE_URL" src/shared/EnvManager.ts` shows entries at: `BLOCKED_ENV_VARS`, `ClaudeMemEnv` interface, loader, re-injection, OAuth-skip predicate (NOT in skip predicate).
- [ ] Smoke: with a `~/.claude-mem/.env` containing `ANTHROPIC_BASE_URL=...` and `ANTHROPIC_AUTH_TOKEN=...`, the worker actually authenticates against the proxy. Test with BigModel or any sandboxed proxy.

### 2.5 Anti-pattern guards

- Do NOT add `ANTHROPIC_BASE_URL` to `ENV_PRESERVE` in `env-sanitizer.ts` — `BLOCKED_ENV_VARS` is the right layer; `env-sanitizer` is a downstream filter.
- Do NOT keep the BASE_URL branch in the OAuth-skip predicate "for tokenless gateways may exist" — every documented gateway requires a token. The skip path was a misdesign.
- Do NOT delete the existing `delete isolatedEnv.CLAUDE_CODE_OAUTH_TOKEN` defensive line at line 229. That guard is intact; it's belt-and-suspenders for #2215 and orthogonal to this plan.

---

## Phase 3 — Fix #2357 (CLAUDE_CODE_EFFORT_LEVEL leak + 400 retry classification)

**Goal:** Two-layer defense for the env leak (existing `CLAUDE_CODE_*` prefix filter + new `BLOCKED_ENV_VARS` entries), plus a permanent classification for the resulting HTTP 400 so the retry loop terminates if the leak ever sneaks past either layer.

### 3.1 Edit `src/shared/EnvManager.ts:14–24` — add EFFORT entries to `BLOCKED_ENV_VARS`

After the Phase 2 edit, the list is:

```ts
const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDECODE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // #2357 — host CLI config, not part of the plugin's contract. The
  // env-sanitizer's CLAUDE_CODE_* prefix filter strips these for spawn paths
  // that go through it, but BLOCKED_ENV_VARS is the canonical deny-list and
  // belongs in defense-in-depth.
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
];
```

### 3.2 Edit `src/services/worker/ClaudeProvider.ts` — classify HTTP 400 as unrecoverable

Locate the existing error-classification path. The Anthropic SDK raises errors with `error.status` and a body containing the failure description. Pattern from `src/services/worker/GeminiProvider.ts:89–94` (the canonical copy-target):

```ts
if (status === 400) {
  return new ClassifiedProviderError(
    `Gemini bad request (status 400)`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}
```

Add the equivalent in `ClaudeProvider`'s error classifier (new function or existing — read the file; create if absent, mirroring `GeminiProvider` shape):

```ts
function classifyClaudeProviderError(input: { cause: unknown }): ClassifiedProviderError {
  const err = input.cause;
  const status = (err as { status?: number })?.status;
  const bodyText = String((err as { message?: string })?.message ?? '');

  // Permanent: SDK rejected the request itself. Most common cause in the wild
  // is a leaked CLAUDE_CODE_EFFORT_LEVEL the SDK subprocess forwarded as
  // `effort` against a model that doesn't support it (#2357). The leak is
  // also blocked at BLOCKED_ENV_VARS + env-sanitizer; this classifier ends
  // the retry loop if either layer is bypassed.
  if (status === 400) {
    if (/effort parameter/i.test(bodyText)) {
      logger.warn(
        'SDK',
        'Claude API rejected effort parameter — likely CLAUDE_CODE_EFFORT_LEVEL leaked into SDK env (issue #2357). Configure CLAUDE_MEM_MODEL or set credentials in ~/.claude-mem/.env.',
        { status, bodyText },
      );
    }
    return new ClassifiedProviderError(
      `Claude bad request (status 400): ${bodyText}`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  // 401 / 403 → auth_invalid (existing pattern from GeminiProvider:96-103)
  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      `Claude auth rejected (status ${status})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  // 429 → rate_limit
  if (status === 429) {
    return new ClassifiedProviderError(
      `Claude rate limited (status 429)`,
      { kind: 'rate_limit', cause: input.cause },
    );
  }

  // Default: transient (preserves the existing fall-through behavior).
  return new ClassifiedProviderError(
    `Claude SDK error: ${bodyText}`,
    { kind: 'transient', cause: input.cause },
  );
}
```

Wire this classifier into the existing `try { ... } catch` around `query(...)` in `ClaudeProvider.ts`. **Read the actual catch shape before editing** — the function lives near line 180–195 and the existing `for await` over `queryResult` is where rejections surface.

### 3.3 Confirm `src/supervisor/env-sanitizer.ts` already strips `CLAUDE_CODE_EFFORT_LEVEL`

Read lines 1–51. Verify:
- `ENV_PREFIXES` includes `'CLAUDE_CODE_'`.
- `ENV_PRESERVE` does NOT include `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`.

Add an inline comment at the `ENV_PREFIXES` declaration:

```ts
// Filters CLAUDE_CODE_* unless explicitly preserved in ENV_PRESERVE.
// This is layer 2 of defense for #2357 — layer 1 is BLOCKED_ENV_VARS in EnvManager.
```

No code change to behavior here.

### 3.4 Verification checklist (Phase 3)

- [ ] Tests 5, 6, 7 from Phase 1 now GREEN.
- [ ] `grep -n "CLAUDE_CODE_EFFORT_LEVEL" src/` returns hits in `EnvManager.ts` (BLOCKED_ENV_VARS) and the test file. Nothing else.
- [ ] Reproduce #2357 scenario locally:
  ```bash
  CLAUDE_CODE_EFFORT_LEVEL=MAX bun run src/services/worker-service.ts --daemon
  # Observe: no `effort` parameter on outgoing requests.
  ```
- [ ] If a 400 is forced (e.g., via a mocked SDK reject), the retry loop terminates after the first attempt; `logger.warn` fires once.

### 3.5 Anti-pattern guards

- Do NOT add a separate "permanent error" enum value — `kind: 'unrecoverable'` already exists and is the right slot.
- Do NOT regex on the entire error stack — `error.status === 400` is the deterministic signal; the body text check is purely for the user-facing log hint.
- Do NOT log inside `classifyClaudeProviderError` for every 400 — only the effort-parameter sub-case warrants a hint. Generic 400s are noisy enough at the call site.
- Do NOT mark all 400s with body matching `/effort/i` as `auth_invalid` — that would trigger the "re-login" flow incorrectly. Use `unrecoverable`.
- Do NOT rely on the SDK supporting an `effort` SDK-option that we strip. The SDK type does not expose `effort`; the leak is the SDK's own subprocess (`pathToClaudeCodeExecutable`) reading the env var. Stripping at our env layer is the only fix we control.

---

## Phase 4 — `$TIER` alias syntax (#2289)

**Goal:** Allow `CLAUDE_MEM_MODEL=$TIER:summary` (and similar) to resolve at request time to a provider-appropriate model, reusing the existing `'haiku'` portable alias machinery (line 116, #1463). Optional phase; can be deferred without blocking Phase 2/3.

### 4.1 Edit `src/shared/SettingsDefaultsManager.ts` — extend tier interface

Add to the `SettingsDefaults` interface near lines 51–53:

```ts
CLAUDE_MEM_TIER_FAST_MODEL: string;     // for $TIER:fast — defaults to 'haiku'
CLAUDE_MEM_TIER_SMART_MODEL: string;    // for $TIER:smart — defaults to 'sonnet' (or provider-equivalent)
```

Add to the `DEFAULTS` block near lines 115–117:

```ts
CLAUDE_MEM_TIER_FAST_MODEL: 'haiku',
CLAUDE_MEM_TIER_SMART_MODEL: 'sonnet',
```

### 4.2 Edit `src/services/worker/ClaudeProvider.ts:442–446` — add `$TIER` resolution

Replace `getModelId()`:

```ts
private getModelId(): string {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return resolveTierAlias(settings.CLAUDE_MEM_MODEL, settings);
}
```

Add `resolveTierAlias` to a shared util (`src/services/worker/model-aliases.ts`, NEW):

```ts
import type { SettingsDefaults } from '../../shared/SettingsDefaultsManager';

const TIER_PATTERN = /^\$TIER:(fast|smart|simple|summary)$/;

export function resolveTierAlias(model: string, settings: SettingsDefaults): string {
  const match = TIER_PATTERN.exec(model);
  if (!match) return model;

  switch (match[1]) {
    case 'fast':    return settings.CLAUDE_MEM_TIER_FAST_MODEL || 'haiku';
    case 'smart':   return settings.CLAUDE_MEM_TIER_SMART_MODEL || 'sonnet';
    case 'simple':  return settings.CLAUDE_MEM_TIER_SIMPLE_MODEL || 'haiku';
    case 'summary': return settings.CLAUDE_MEM_TIER_SUMMARY_MODEL || settings.CLAUDE_MEM_MODEL;
    default:        return model;
  }
}
```

### 4.3 Same call site in `KnowledgeAgent.ts:149` (`getModelId`)

Apply the same `resolveTierAlias` wrap. Knowledge agent uses the same settings path.

### 4.4 Verification checklist (Phase 4)

- [ ] New test: `resolveTierAlias('$TIER:fast', settings)` returns `settings.CLAUDE_MEM_TIER_FAST_MODEL`.
- [ ] New test: `resolveTierAlias('claude-haiku-4-5-20251001', settings)` returns input unchanged (non-tier passthrough).
- [ ] Setting `CLAUDE_MEM_MODEL=$TIER:fast` and starting the worker actually queries against the fast-tier model.
- [ ] Documentation updated in `docs/public/configuration.mdx` with the four tier aliases.

### 4.5 Anti-pattern guards

- Do NOT match `$TIER:*` greedily — the regex is anchored.
- Do NOT add `$PROVIDER:` or `$MODEL:` aliases in this phase — out of scope; one syntax at a time.
- Do NOT mutate `settings` inside `resolveTierAlias`; pure function only.
- Do NOT resolve the alias at settings-load time — resolve at *request* time so users can edit settings without restarting the worker.

---

## Phase 5 — Cross-spawn-boundary audit

**Goal:** Every place claude-mem spawns a subprocess must apply both `buildIsolatedEnv` (or the async variant) AND `sanitizeEnv`. A grep-based check codifies the rule.

### 5.1 Audit table — current state per call site

| File | Line | Spawn target | Env construction | Sufficient? |
|---|---|---|---|---|
| `src/services/worker/ClaudeProvider.ts` | 155 | Anthropic SDK subprocess | `sanitizeEnv(await buildIsolatedEnvWithFreshOAuth())` | ✅ |
| `src/services/worker/knowledge/KnowledgeAgent.ts` | 54, 149 | Knowledge SDK subprocess | `sanitizeEnv(await buildIsolatedEnvWithFreshOAuth())` | ✅ |
| `src/services/infrastructure/ProcessManager.ts` | 415 | Worker daemon | `sanitizeEnv({...process.env, CLAUDE_MEM_WORKER_PORT, ...extraEnv})` | ⚠️ daemon inherits parent env then sanitizes — does not pass through `buildIsolatedEnv`. **Document why this is OK**: daemon is the trust boundary; parent env IS the truth. But it should still strip `CLAUDE_CODE_EFFORT_LEVEL` via the prefix filter. Confirm. |
| `src/services/sync/ChromaMcpManager.ts` | 585 | chroma-mcp subprocess | `sanitizeEnv(process.env)` | ⚠️ same as above. |
| `src/supervisor/process-registry.ts` | 539 | Generic spawn factory | `sanitizeEnv(options.env ?? process.env)` | ⚠️ same. |
| `src/services/worker-service.ts` | 412 | MCP server subprocess | `sanitizeEnv(process.env)` | ⚠️ same. |

For the worker-daemon and downstream MCP/chroma spawns, parent-process env IS the source of truth — they are pre-credential paths. As long as `CLAUDE_CODE_EFFORT_LEVEL` and the Anthropic credentials are stripped (which `sanitizeEnv` does via `CLAUDE_CODE_*` prefix and the existing `ANTHROPIC_AUTH_TOKEN` block), behavior is correct. The plan does not change these paths — it adds tests that prove they stay correct.

### 5.2 Add audit test — `tests/env-isolation.test.ts`

8. **`every documented spawn site applies sanitizeEnv`**
   - Read each file from the audit table.
   - Assert: each line cited contains `sanitizeEnv(`. Currently GREEN; test prevents regression.
9. **`worker-daemon spawn env does not contain CLAUDE_CODE_EFFORT_LEVEL`**
   - Stub `process.env.CLAUDE_CODE_EFFORT_LEVEL = 'MAX'`.
   - Construct the env block as ProcessManager.ts:415 does.
   - Assert: result does not contain `CLAUDE_CODE_EFFORT_LEVEL`. Currently GREEN.

### 5.3 Verification checklist (Phase 5)

- [ ] Tests 8, 9 GREEN.
- [ ] No new spawn sites introduced; if any are added by accident, the CI check (Phase 7) flags them.

### 5.4 Anti-pattern guards

- Do NOT add `buildIsolatedEnv` calls to ProcessManager / ChromaMcpManager / MCP server spawn paths. They legitimately need parent-shell `PATH`, `HOME`, etc. — those would be wiped by the credential-isolated builder.
- Do NOT consolidate the two layers into one helper "for clarity" — they have distinct contracts and are layered intentionally.

---

## Phase 6 — Test the full integration end-to-end

**Goal:** Smoke test the proxy/gateway path so we know the fix works in the real world.

### 6.1 Manual smoke (BigModel proxy or any equivalent)

```bash
# Setup:
cat > ~/.claude-mem/.env <<'EOF'
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
ANTHROPIC_AUTH_TOKEN=<your-bigmodel-token>
EOF
chmod 600 ~/.claude-mem/.env

# Reset worker:
npm run build-and-sync
pkill -f worker-service.cjs

# Trigger:
# In any Claude Code session, use any tool — PostToolUse hook should land an observation.

# Verify:
tail -f ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log
# Expect: no "Not logged in" errors; observations land via the proxy.
```

### 6.2 Manual smoke (CLAUDE_CODE_EFFORT_LEVEL leak)

```bash
# Setup:
export CLAUDE_CODE_EFFORT_LEVEL=MAX
export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=true

# Restart Claude Code so the env propagates to the hook subprocess.

# Verify:
tail -f ~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log
# Expect: NO repeated "API Error: 400 This model does not support the effort parameter."
# Expect: NO "PARSER returned non-XML response; marking messages as failed for retry".
```

### 6.3 Verification checklist (Phase 6)

- [ ] Both smoke scenarios pass.
- [ ] `bun test` is green.
- [ ] One iteration on a fresh machine confirms `~/.claude-mem/.env` is the only knob users need for proxy auth.

---

## Phase 7 — CI guard + documentation

**Goal:** A grep-based CI check rejects PRs that introduce a subprocess spawn without `sanitizeEnv`. Documentation aligns with the new contract.

### 7.1 Add `scripts/check-spawn-env-discipline.cjs`

Pattern from `plans/01-hook-io-discipline.md` Phase 6 (`scripts/check-hook-io-discipline.cjs`):

```js
#!/usr/bin/env node
// Forbid raw process.env in subprocess spawn calls. Every spawn must use
// sanitizeEnv(...) and (where credentials are involved) buildIsolatedEnv*.

const { execSync } = require('node:child_process');

const VIOLATIONS = [];

// Find every `spawn(` / `spawnSync(` / `child_process.spawn(` call in src/
const grep = execSync(
  `grep -rEn "spawn(Sync)?\\(" src/ | grep -v "node_modules" | grep -v "\\.test\\."`,
  { encoding: 'utf8' },
);

for (const line of grep.split('\n').filter(Boolean)) {
  // Allow if the same logical block contains sanitizeEnv
  // (heuristic: read 5 lines after the match in the source file)
  const [filePath, lineNumStr] = line.split(':', 2);
  const lineNum = Number.parseInt(lineNumStr, 10);
  const src = require('node:fs').readFileSync(filePath, 'utf8').split('\n');
  const window = src.slice(lineNum - 1, lineNum + 8).join('\n');
  if (!/sanitizeEnv\s*\(/.test(window)) {
    VIOLATIONS.push(`${filePath}:${lineNum} — spawn without sanitizeEnv`);
  }
}

if (VIOLATIONS.length > 0) {
  console.error('Spawn-env discipline check FAILED:');
  VIOLATIONS.forEach(v => console.error('  ' + v));
  process.exit(1);
}
console.log('Spawn-env discipline check passed.');
```

Wire to `package.json` `scripts.test:env-discipline`. Add to CI alongside existing hook checks.

### 7.2 Edit `CLAUDE.md` — document the `~/.claude-mem/.env` contract

Add a section under "Configuration":

```markdown
### Anthropic Credentials (proxies, gateways, BigModel, etc.)

For non-OAuth Anthropic credentials (proxies / gateways / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`), put them in `~/.claude-mem/.env`:

\```
ANTHROPIC_BASE_URL=https://your-proxy.example
ANTHROPIC_AUTH_TOKEN=your-token
\```

The file is read at worker spawn time and re-injected into the SDK subprocess. **Parent-shell exports of these variables are intentionally ignored** — they are in `BLOCKED_ENV_VARS` to prevent host-config bleed-through (#2375).

If you only have an OAuth subscription, no `.env` is needed; the worker reads the token from your keychain at spawn time.
```

### 7.3 Verification checklist (Phase 7)

- [ ] `npm run test:env-discipline` passes on the post-fix tree.
- [ ] CI pipeline runs the new check.
- [ ] CLAUDE.md section exists and accurately reflects the new contract.

### 7.4 Anti-pattern guards

- Do NOT extend the CI check to flag every `process.env` read — only `spawn*()` call sites need `sanitizeEnv`. Reads are fine.
- Do NOT add the `.env` file path to `.gitignore` — it lives in `~/.claude-mem/`, not in the repo, so it's already outside.

---

## Cross-plan dependencies

- **Plan 01 (Hook IO Discipline):** Independent. Both can be implemented in parallel.
- **Plan 02 (Spawn-Contract Templating):** Independent. Both touch templating but at different layers.
- **Plan 03 (Worker Lifecycle):** Phase 3.2's HTTP 400 classification removes a class of unbounded retries. Plan 03's "circuit breaker" + "stale-session sweep" handles other retry classes. Merge order: this plan first (small, surgical), then Plan 03.
- **Plan 04 (Installer Transparency):** Independent.
- **Plan 05 (Observer Tool Enforcement):** Adjacent — `KnowledgeAgent` is touched in both plans (this one for `getModelId`, Plan 05 for tool enforcement). Sequence Plan 05 first (security urgency), then Plan 06.

## Pre-/do checklist

- [ ] Verify `BLOCKED_ENV_VARS` is still an `Array<string>` and not converted to a `Set` (Phase 2 refactor risk).
- [ ] Verify the existing test suite passes against current `main` before starting (`bun test`).
- [ ] Re-confirm `effort` is still absent from `src/` (`grep -rn "effort" src/`) — if a future change adds the parameter, Phase 3.2's regex needs revisiting.
- [ ] Read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` to confirm `query()` options does NOT support `effort` natively. If the SDK adds it, Phase 3.2's body-text regex still works as a fallback, but a code-level strip becomes the right fix.
- [ ] Verify `~/.claude-mem/.env` permissions are `0o600` post-fix (the saver enforces this; readers should not weaken it).
