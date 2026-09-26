# npx installer signup capture (non-TTY default, deferred pairing, poll budget, taxonomy, telemetry)

Branch: `fix/npx-signup-capture`. Measured findings: `/workspace/npx-signup-metrics/FINDINGS.md`.

Problem in one line: AI agents run `npx claude-mem install` in a non-TTY shell, hit the
missing-provider abort, re-run with `--provider claude`, and that path skips OAuth, so
~330 installs/day finish with no email. Separately the CLI stops polling at 4 minutes
while the server pairing lives 30 minutes (16% of OAuth users see a timeout), and
`oauth/start` failures emit no event.

Decisions already made (do not re-litigate):

- Default to claude in non-TTY **only on a fresh config**; reuse the persisted provider otherwise.
- Deferred pairing prints the **login-only** `authorizationUrl`, never `checkoutUrl`.
- Deferred pairing is **skipped under `CI`** and is **not** tied to `DO_NOT_TRACK`.
- Deferred pairing sends `source: 'npx-installer-deferred'`; the server ignores `body.source`
  today and will allowlist it separately. Do not block on that.
- After the 30-min TTL the claim route bounces through `/login`, so no fallback URL is printed.
- Interactive `--provider claude` and the grok-bot implicit `cmem` path stay as they are.
- Add `provider_source` to `install_completed`.

Memory constraint on the build box: run test files **one at a time**, never the whole suite.

---

## Phase 0: Documentation Discovery (consolidated, from direct reads)

Sources read: `src/npx-cli/commands/install.ts`, `src/npx-cli/index.ts`,
`src/npx-cli/installer-provider-choice.ts`, `src/npx-cli/cmem-pro-costs.ts`,
`src/npx-cli/cmem-memory-credentials.ts`, `src/npx-cli/install/error-taxonomy.ts`,
`src/npx-cli/install/error-reporter.ts`, `src/services/telemetry/cli-telemetry.ts`,
`src/services/telemetry/scrub.ts`, `docs/public/telemetry.mdx`, `docs/public/installation.mdx`,
`docs/public/cmem-pro-headless.mdx`, `tests/npx-cli/*.test.ts`, `tests/install-non-tty.test.ts`,
`tests/install-error-matrix.test.ts`.

### Allowed APIs (exist today; copy these, do not invent)

| Symbol | Location | Notes |
|---|---|---|
| `isInteractive` | `install.ts:58` | `process.stdin.isTTY === true`, module const |
| `log.info/success/warn/error` | `install.ts:161-164` | TTY-aware logger; use for all output |
| `getSetting(key)` | `install.ts:54` | reads persisted settings with defaults |
| `readPersistedInstallerSettings()` | used at `install.ts:1081` | raw persisted settings object |
| `mergeSettings(obj)` | used throughout | atomic settings write, returns bool |
| `installerError(severity, ctx, summary)` | `install/error-reporter.ts` | ABORT throws `InstallAbortError` |
| `classifyError(cause, {component, phase})` | `install/error-taxonomy.ts` | first match wins; catch-all last |
| `ERROR_CATEGORIES` | `install/error-taxonomy.ts` | ordered array of `{id, severity, match, remediation}` |
| `captureCliEvent(event, props, {person?})` | `services/telemetry/cli-telemetry.ts:22` | never throws; consent-gated; props scrubbed |
| `ALLOWED_PROPERTY_KEYS` | `services/telemetry/scrub.ts:10` | Set of allowed prop names; unknown keys dropped |
| `startInstallerOAuthPairing()` | `install.ts:1457` | POST start; returns `InstallerOAuthPairing \| null` |
| `parseInstallerOAuthStartBody(body)` | `install.ts:1399` | pure parser, exported, contract-tested |
| `InstallerOAuthPairing` | `install.ts:1340` | `{pairingId, secret, userCode, authorizationUrl, checkoutUrl, pollIntervalMs, delivered?}` |
| `waitForInstallerPairing(pairing, phase, version)` | `install.ts:1600` | poll loop; budget is `OAUTH_POLL_BUDGET_MS` at `:1334` |
| `requireInstallerOAuthLogin(version)` | `install.ts:1740` | blocking login; only caller of start today |
| `providerNeedsAccount(provider)` | `install.ts:1855` | `provider !== 'claude' && provider !== 'host'` |
| `validateNonInteractiveProvider(options, summary)` | `install.ts:1914` | the abort to replace |
| `promptProvider(options, pairing, version)` | `install.ts:1070` | returns `ProviderId`; claude branch calls `useSubscriptionAuth()` |
| `buildAnthropicMaxLocalSettings(settings)` | `cmem-memory-credentials.ts:308` | **blanks cloud-sync token/user/hub and Pro memory key** |
| `resolveInstallerProviderChoice({ide, provider})` | `installer-provider-choice.ts` | grok-bot non-TTY -> `'cmem'` sentinel, applied in `index.ts` |
| `CMEM_INSTALLER_OAUTH_START_URL` | `cmem-pro-costs.ts` | start endpoint |

### Facts that shape the design

- `index.ts` resolves non-TTY `--ide grok-bot` to `provider: 'cmem'` **before** `install.ts` runs.
  So in `install.ts`, `options.provider === undefined` never happens for grok-bot non-TTY.
  Keying every new behaviour on `options.provider === undefined` (default) or
  `!providerNeedsAccount(options.provider)` (deferred pairing) leaves grok-bot untouched.
- `npx claude-mem update` calls `runInstallCommand()` with **no options** (`index.ts`, case
  `'update'`). Non-TTY update therefore hits the same abort today. With a naive default it
  would call `useSubscriptionAuth()` and wipe a Pro user's cloud sync. Hence "fresh config only".
- Currently the timeout event sends `phase` but `phase` is **not** in `ALLOWED_PROPERTY_KEYS`,
  so it is silently dropped. `stage`, `outcome`, `version`, `duration_ms`, `interactive` are allowed.
- `captureCliEvent` does not validate event names; only property keys are scrubbed.
- `parseInstallerOAuthStartBody` ignores unknown fields; `expires_in` is safe to add optionally.
- Poll loop returns `{kind:'gone'}` on 404/410, so polling up to the server TTL is safe.
- Non-TTY exit code: `process.exitCode = 1` only when an IDE failed (`install.ts:~2437`).
  The deferred pairing must never touch exit status.
- `promptTelemetryOptIn()` already skips on `process.env.CI` (`install.ts:1818`); copy that gate.

### Tests that pin source strings (must keep or update deliberately)

| Test | Pinned string / ordering | Impact |
|---|---|---|
| `tests/npx-cli/provider-account-gate.test.ts` | `return provider !== 'claude' && provider !== 'host';`, `if (providerNeedsAccount(options.provider)) {`, regex `providerNeedsAccount(...) {\n oauthPairing = await requireInstallerOAuthLogin(version);`, `if (options.provider !== 'gemini' && options.provider !== 'openrouter') return;`, `throw new Error('CMEM Pro requires a signed-in claude-mem account.');` | **keep all verbatim** |
| `tests/npx-cli/install-trial-contract.test.ts` | first `indexOf('await requireInstallerOAuthLogin(version)')` < first `indexOf('await promptProvider(options, oauthPairing, version)')`; `p.multiselect<ProviderChoice>`; `toEqual` on parsed start body | keep ordering; **update `toEqual` for new field** |
| `tests/npx-cli/grok-bot-install-default.test.ts` | `initialValues: ['cmem']`, `'provider-cutover'`, index.ts imports | keep |
| `tests/install-non-tty.test.ts:96-102` | `validateNonInteractiveProvider(options, summary)` before OAuth call; exact string `A provider must be explicit when stdin is not interactive.` | **rewrite this test** |
| `tests/install-error-matrix.test.ts:75-82` | component `'mystery'` -> `unknown-install-error` | unaffected; add cases |

### Anti-patterns to avoid

- Do not put the claude default in `index.ts`; it would collide with the grok-bot resolution.
- Do not call `requireInstallerOAuthLogin` from the deferred path (test ordering + it blocks).
- Do not print `checkoutUrl` or the device code in the deferred path.
- Do not add a new `p.*` prompt anywhere on a non-TTY path.
- Do not send telemetry props that are not in `ALLOWED_PROPERTY_KEYS`; add the key first.
- Do not gate the pairing on `DO_NOT_TRACK`; only telemetry is gated, and `captureCliEvent` already does it.
- Do not run `bun test` without a file argument.

---

## Phase 1: Provider default on fresh config + persisted-provider reuse

**Files:** `src/npx-cli/commands/install.ts` (`validateNonInteractiveProvider`, `promptProvider`, `InstallOptions`), `src/npx-cli/index.ts` (help text only).

1. Add `providerSource?: 'flag' | 'default' | 'persisted' | 'prompt'` to `InstallOptions`
   (`install.ts:1858`). `index.ts` sets `providerSource: 'flag'` when `--provider` was given
   (and for the grok-bot implicit `cmem`, `'flag'` too; it is an explicit product default).
2. In `validateNonInteractiveProvider` (`install.ts:1914`), replace the `!options.provider` abort:
   - Read `persisted = readPersistedInstallerSettings()`.
   - If `persisted.CLAUDE_MEM_PROVIDER` is a valid `ProviderId` (`'claude' | 'gemini' | 'openrouter'`),
     set `options.provider = that`, `options.providerSource = 'persisted'`, and
     `log.info('Non-interactive run: keeping the configured provider (<id>).')`.
     Then `return` **before** the gemini/openrouter key check (the persisted key is already there,
     and a persisted Pro config must not hit the `configuredCmemKey` abort).
   - Else set `options.provider = 'claude'`, `options.providerSource = 'default'`, and
     `log.info('No --provider given on a non-interactive run: defaulting to your Anthropic plan (local memory).')`.
   - Keep the existing gemini/openrouter key validation for the explicit-flag case unchanged
     (the pinned line `if (options.provider !== 'gemini' && options.provider !== 'openrouter') return;` must stay verbatim).
3. In `promptProvider` (`install.ts:1108`): when `options.providerSource === 'persisted'`,
   return `options.provider` **without** calling `useSubscriptionAuth()`, `persistClaudeProvider()`,
   or any `mergeSettings`. Place this check first, before the `if (options.provider)` branch.
   Comment why: a persisted Pro config must survive a non-TTY update run.
4. Interactive flow: `providerSource = 'prompt'` when the multiselect ran. No other change.
5. `index.ts` help: change `--provider` line to say it is optional non-interactively and defaults
   to `claude` on a fresh install.
6. Update the comment block above the account gate (`install.ts:~2205-2213`) so it no longer
   says `--provider claude` "never touches cmem.ai" (Phase 2 will).

**Verification**
- `grep -n "A provider must be explicit" src/npx-cli/commands/install.ts` -> no hits.
- `grep -n "providerSource" src/npx-cli/commands/install.ts src/npx-cli/index.ts` -> set in index.ts, read in validate + promptProvider + install_completed (Phase 5).
- `bun test tests/npx-cli/provider-account-gate.test.ts` passes unchanged.
- `bun test tests/npx-cli/grok-bot-install-default.test.ts` passes unchanged.
- `tests/install-non-tty.test.ts` is updated in Phase 6 and must not be run until then.

**Anti-pattern guards:** no `p.select`/`p.confirm` added; no `mergeSettings` on the persisted branch; grok-bot `'cmem'` never reaches the default branch (assert with a test in Phase 6).

---

## Phase 2: Deferred login-only pairing at the end of non-interactive installs

**Files:** `src/npx-cli/commands/install.ts` (new helper + call site), `src/npx-cli/cmem-pro-costs.ts` (no change needed; reuse `CMEM_INSTALLER_OAUTH_START_URL`).

1. Give `startInstallerOAuthPairing` an options arg: `startInstallerOAuthPairing(opts?: { source?: string })`,
   default source `'npx-installer'`. Body becomes `{ source, device_name: hostname() }`. Existing caller unchanged.
2. Add `async function offerDeferredLogin(options: InstallOptions, version: string): Promise<void>`
   next to `requireInstallerOAuthLogin`:
   - Return immediately if `isInteractive`, if `providerNeedsAccount(options.provider)`, or if
     `process.env.CI` is set (copy the exact gate from `promptTelemetryOptIn`, `install.ts:1819-1820`).
   - `const pairing = await startInstallerOAuthPairing({ source: 'npx-installer-deferred' })`.
   - On `null`: emit the start-failed event (Phase 5) and return silently (no log line, exit status untouched).
   - On success, print with `log.info`, in this order and **last in the install output**:
     ```
     Optional: sign in to claude-mem to unlock cloud sync and the CMEM Pro trial.
     Sign-in link: <pairing.authorizationUrl>
     AGENT: show this link to the user so they can finish signing in. Do not open it yourself; the install is already complete.
     ```
     Then `await captureCliEvent('installer_oauth_deferred', { version, interactive: false })`.
   - Never poll. Never print `userCode` or `checkoutUrl`.
3. Call site: in `runInstallCommandInner`, after the non-TTY "Next Steps" block and after the
   `console.log('\nclaude-mem installed successfully!')` / failures branch, and **before**
   `captureCliEvent('install_completed', ...)` (`install.ts:~2445`). Wrap in `try {} catch {}`
   so nothing here can change exit status or throw past the summary.
4. Keep the pinned source strings from Phase 0 intact; the new helper must not contain the text
   `await requireInstallerOAuthLogin(version)` or `await promptProvider(options, oauthPairing, version)`.

**Verification**
- `grep -n "npx-installer-deferred" src/npx-cli/commands/install.ts` -> one hit in the helper.
- `grep -n "checkoutUrl\|userCode" src/npx-cli/commands/install.ts` -> no new hits inside `offerDeferredLogin`.
- `grep -n "offerDeferredLogin" src/npx-cli/commands/install.ts` -> definition + one call site before `install_completed`.
- `bun test tests/npx-cli/install-trial-contract.test.ts` still passes the ordering test.

**Anti-pattern guards:** no poll loop, no `process.exit`, no `process.exitCode` write, no `DO_NOT_TRACK` read in the helper, no stdin listeners.

---

## Phase 3: Poll budget from `expires_in`

**Files:** `src/npx-cli/commands/install.ts` (`InstallerOAuthPairing`, `parseInstallerOAuthStartBody`, `waitForInstallerPairing`).

1. Constants next to `OAUTH_POLL_BUDGET_MS` (`install.ts:1334`): keep `OAUTH_POLL_BUDGET_MS = 240_000`
   as the fallback and add `OAUTH_POLL_BUDGET_MAX_MS = 30 * 60 * 1000`.
2. `InstallerOAuthPairing`: add optional `expiresAt?: number` (epoch ms, absolute, measured from parse time).
3. `parseInstallerOAuthStartBody`: read `b.expires_in`; when it is a finite number > 0,
   `expiresAt = Date.now() + Math.min(expires_in * 1000, OAUTH_POLL_BUDGET_MAX_MS)`.
   When absent or invalid, leave `expiresAt` undefined. Add `expires_in?: unknown` to the local body type.
4. `waitForInstallerPairing`: compute `const deadline = pairing.expiresAt ?? (startedAt + OAUTH_POLL_BUDGET_MS)`
   and loop `while (Date.now() < deadline)`. Both phases (`login`, `enrollment`) share the same
   pairing so the deadline is the pairing's, not per-phase. Keep every other branch (`gone`,
   `unreachable`, cancel, stage messages) unchanged.
5. The timeout event keeps `duration_ms`; add nothing else there (Phase 5 fixes `phase` allowlisting).

**Verification**
- Contract test: the `toEqual` in `parses an OAuth-only pairing ...` (`install-trial-contract.test.ts:~74`)
  must be extended in Phase 6 to include `expiresAt` when `expires_in` is supplied, and to omit it when not.
- Hand-built pairings in `runCompletedPairingChild` have no `expiresAt` -> fallback path; that test must still pass.
- `grep -n "OAUTH_POLL_BUDGET_MS" src/npx-cli/commands/install.ts` -> constant + fallback use only.

**Anti-pattern guards:** do not make `expiresAt` required; do not read `expires_in` anywhere except the parser; do not exceed 30 minutes.

---

## Phase 4: Taxonomy ids

**Files:** `src/npx-cli/install/error-taxonomy.ts`.

Insert two entries directly above `unknown-install-error`, copying the shape of `all-ides-failed`
(`error-taxonomy.ts`, `match: (_cause, ctx) => ctx.component === '...'`):

| id | severity | match | remediation |
|---|---|---|---|
| `provider-selection-non-interactive` | ABORT | `ctx.component === 'provider-selection'` | "Non-interactive installs need a provider. Pass `--provider claude` for local memory on your Anthropic plan, or run `npx claude-mem install` in an interactive terminal." |
| `provider-credentials-missing` | ABORT | `ctx.component === 'provider-credentials'` | "The selected provider needs a personal API key on non-interactive runs. Save it in settings first, or run the installer interactively so it can ask securely." |

After Phase 1 the first id fires only if a future caller reintroduces the abort; it still labels
that path. The second id fires today for explicit `--provider gemini|openrouter` without a key.

**Verification**
- `bun test tests/install-error-matrix.test.ts` (with the two new cases from Phase 6).
- `grep -n "provider-selection\|provider-credentials" src/npx-cli/install/error-taxonomy.ts` -> both present, both above the catch-all.

---

## Phase 5: Telemetry

**Files:** `src/npx-cli/commands/install.ts`, `src/services/telemetry/scrub.ts`, `docs/public/telemetry.mdx`, `src/npx-cli/commands/telemetry.ts` (`COLLECTED_FIELDS`/`EVENT_NAMES` lists).

1. `scrub.ts` `ALLOWED_PROPERTY_KEYS`: add `'phase'` (next to `'stage'`, line ~43) and `'provider_source'`
   (next to `'interactive'`, line ~45). Both are enum-valued, never user data.
2. Start-failure classification: change `startInstallerOAuthPairing` to record why it failed without
   changing its return type. Simplest: an internal `let lastStartFailure: 'http_error' | 'network' | 'timeout' | 'bad_body' | null`
   module variable set inside the function, plus `export function lastOAuthStartFailure()` for callers.
   (Alternative: return `{ pairing: null, reason }`; either is fine, but keep `parseInstallerOAuthStartBody` pure and exported.)
   Map: `!response.ok` -> `http_error`; parser null -> `bad_body`; `AbortError` -> `timeout`; other throw -> `network`.
3. Emit `captureCliEvent('installer_oauth_start_failed', { version, outcome: <reason>, interactive: isInteractive, phase: 'login' | 'deferred' })`
   from both callers: `requireInstallerOAuthLogin` (`install.ts:1745`, before the error log) and `offerDeferredLogin` (Phase 2).
4. `install_completed` (`install.ts:~2445`): add `provider_source: options.providerSource ?? 'prompt'`.
5. `docs/public/telemetry.mdx` events table: add rows for `installer_oauth_started`, `installer_oauth_completed`,
   `installer_oauth_timeout` (`version`, `phase`, `duration_ms`), `installer_oauth_start_failed`
   (`version`, `outcome`, `interactive`, `phase`), `installer_oauth_deferred` (`version`, `interactive`).
   Add `provider_source` to the `install_completed` row and to the property table. Document `phase` values
   (`login` / `enrollment` / `deferred`) and the new `outcome` values.
6. `src/npx-cli/commands/telemetry.ts`: add `provider_source` and `phase` lines to `COLLECTED_FIELDS`;
   add the `installer_oauth_*` names to `EVENT_NAMES` so `telemetry enable` shows them.

**Verification**
- `CLAUDE_MEM_TELEMETRY_DEBUG=1` dry run (see Phase 7) shows `phase` and `provider_source` surviving the scrubber.
- `grep -n "'phase'\|'provider_source'" src/services/telemetry/scrub.ts` -> both present.
- `DO_NOT_TRACK=1` dry run emits no `[telemetry]` lines at all (consent gate unchanged).

**Anti-pattern guards:** no free-text in any property; no event carries a URL, pairing id, secret, or device code.

---

## Phase 6: Docs and tests

**Docs**
- `docs/public/installation.mdx:33` and `:48`: replace "never touches cmem.ai" wording with: interactive
  `--provider claude` skips sign-in; non-interactive runs without `--provider` default to the Anthropic plan
  on a fresh install and reuse the configured provider otherwise; every non-interactive install that skipped
  sign-in prints an optional sign-in link at the end (best-effort, never blocks, skipped under `CI`).
- `docs/public/cmem-pro-headless.mdx:19`: same rewording; add one line that agents should show the printed link to the user.
- `docs/public/telemetry.mdx`: done in Phase 5.

**Tests (one file per `bun test` invocation)**

1. `tests/install-non-tty.test.ts:96-102` — rewrite `fails before installation when a non-interactive run omits its provider` to:
   - `validateNonInteractiveProvider(options, summary)` still appears before `await requireInstallerOAuthLogin(version)`.
   - source no longer contains `A provider must be explicit when stdin is not interactive.`
   - source contains `providerSource = 'default'` and `providerSource = 'persisted'`.
   - source contains `'npx-installer-deferred'` and the `AGENT:` line.
2. `tests/npx-cli/install-trial-contract.test.ts`:
   - extend the first `toEqual` with `expires_in: 1800` -> `expiresAt` within `[now+1800s-2s, now+1800s]` (use `expect.any(Number)` plus a range assertion), and a second case with `expires_in: 7200` clamped to 30 min, and a third with no `expires_in` -> no `expiresAt` key.
   - add `runDeferredLoginChild(status)` modelled on `runCompletedPairingChild` (`:26-64`): mock `fetch` to return a valid start body (reuse `pairingId`/`authorizationUrl`/`checkoutUrl` fixtures), set `CI` unset, import `offerDeferredLogin` (export it), call with `{ provider: 'claude', providerSource: 'default' }`. Assert output contains `Sign-in link: https://cmem.ai/login?next=` and the `AGENT:` line, does **not** contain the checkout URL, `ABCD-2345`, or the secret, and exit code 0. Second case: `fetch` returns 503 -> no link printed, exit 0. Third case: `CI=1` -> `fetch` never called (mock throws if called).
   - keep the ordering test untouched.
3. `tests/install-error-matrix.test.ts`: add two cases classifying `{component:'provider-selection', phase:'non-interactive-validation'}` -> `provider-selection-non-interactive` ABORT, and `{component:'provider-credentials', ...}` -> `provider-credentials-missing` ABORT.
4. `tests/npx-cli/grok-bot-install-default.test.ts`: add one assertion that `resolveInstallerProviderChoice({ ide: 'grok-bot' })` is `'cmem'` **and** that `install.ts` keys the default on `options.provider` being undefined (grep for `options.providerSource = 'default'` living inside `validateNonInteractiveProvider`). Existing cases unchanged.
5. `tests/npx-cli/provider-account-gate.test.ts`: no change; run to confirm.
6. New `tests/npx-cli/telemetry-scrub-installer-keys.test.ts`: `scrubProperties({ phase: 'login', provider_source: 'default', secret: 'x' })` keeps the first two and drops `secret`.

**Verification:** each file green individually:
```
bun test tests/install-non-tty.test.ts
bun test tests/npx-cli/install-trial-contract.test.ts
bun test tests/install-error-matrix.test.ts
bun test tests/npx-cli/grok-bot-install-default.test.ts
bun test tests/npx-cli/provider-account-gate.test.ts
bun test tests/npx-cli/telemetry-scrub-installer-keys.test.ts
```

---

## Phase 7: Final verification

1. `npm run build` (not `build-and-sync`; the worker restart is not needed for the CLI).
2. Anti-pattern greps, all must be empty:
   - `grep -n "A provider must be explicit" src/npx-cli/`
   - `grep -n "checkoutUrl" src/npx-cli/commands/install.ts | grep -i deferred`
   - `grep -n "DO_NOT_TRACK" src/npx-cli/commands/install.ts` -> only the pre-existing telemetry prompt hit
3. Dry runs against a throwaway data dir (no real install; use `--no-auto-start --ide claude-code` and a mocked `fetch` via `--eval` as in the contract tests), each in a fresh process:
   - non-TTY, no `--provider`, empty settings: output shows the default line, the sign-in link, the `AGENT:` line last, exit 0; `CLAUDE_MEM_TELEMETRY_DEBUG=1` shows `install_completed` with `provider_source: 'default'` and `installer_oauth_deferred`.
   - non-TTY, no `--provider`, settings with `CLAUDE_MEM_PROVIDER=openrouter` + cmem base URL + sync token: provider kept, sync token still present after the run, no `useSubscriptionAuth` log line, sign-in link **not** printed (openrouter needs an account, and the account gate would have run; confirm the run aborts or logs in exactly as before this change).
   - non-TTY, `--provider claude`, `CI=1`: no fetch to `oauth/start`, exit 0.
   - non-TTY, `--ide grok-bot`, no `--provider`: still enters the blocking OAuth login (unchanged).
   - `DO_NOT_TRACK=1`: no `[telemetry]` lines; sign-in link still printed.
4. Run the six test files from Phase 6 one at a time.
5. Confirm `docs/public/telemetry.mdx` lists every event name that `grep -n "captureCliEvent('" src/npx-cli/commands/install.ts` emits.

## Out of scope

- Server allowlisting of `source: 'npx-installer-deferred'` (separate change in claude-mem-pro).
- Any change to the interactive provider prompt, checkout flow, or `completeCmemTrialPairing`.
- Changelog (auto-generated).
