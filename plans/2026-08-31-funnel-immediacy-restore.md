# Restore Funnel Immediacy: Provider Choice First, Lazy Login, One Browser Trip

**Date:** 2026-08-31
**Repos:** `claude-mem` CLI (this worktree, branch `fix/installer-preselect-defaults`) + `claude-mem-pro` server (`~/Scripts/claude-mem-pro`, main @ `ea8a4d2`)

---

## Problem

The Aug 31 OAuth rewrite inverted the funnel. Mandatory browser login was placed **before** the value proposition, so:

- A free, open-source plugin demands GitHub/Google OAuth before it will finish installing.
- The pitch had to move *after* the login wall, splitting one offer across three surfaces.
- Users take **5 terminal↔browser context switches**; the old email funnel took 3.

The audit that triggered the rewrite was misread: the terminal email step converted 2,222 installers (96.6% delivery), while the **browser callback** failed 1,907 times (`auth_callback_failed`). The converting step was deleted; the failing step was promoted to mandatory.

**Root cause of the inversion** — from `claim/route.ts`'s own comment: they wanted a `pro_users` row for every install ("registered-but-not-paid is a real state"). Mandatory login was a *measurement* decision wearing an *auth* decision's clothes.

## Goal

Restore the old funnel's shape — **cheap, early, terminal-native commitment** — while keeping every security fix from the rewrite.

Picking "CMEM Pro" in the terminal becomes the new "type your email": instant, free, zero context switch, and it *is* the conversion event.

**Target: 5 context switches → 4. Forced switches for a user who never pays: 1 → 0.**

> **Corrected after verification.** An earlier draft of this plan claimed 5 → 2. That was wrong.
> The device-approval step still sends the user back to the terminal to read the code and then
> returns them to the browser, which costs two switches that Phases 1–3 do not remove. The
> **delta is real** — one entire browser round trip is deleted, −2 switches — but the absolute
> figure is 4. Reaching 2 requires Phase 4 (device-code narrowing), which is deferred.

---

## Phase 0: Discovery Findings (COMPLETE — do not re-investigate)

### Allowed APIs / verified facts

**CLI (`src/npx-cli/commands/install.ts`)**
- `promptProvider(options, pairing, version)` at `:1025`. `pairing` is used in exactly **3** places: the signature (`:1032`), a null-check (`:1102`), and `completeCmemTrialPairing(pairing, version)` (`:1112`). The code is already shaped for lazy login.
- Main flow call sites: `providerNeedsAccount` gate at `:2156`, `requireInstallerOAuthLogin(version)` at `:2157`, `promptProvider(options, oauthPairing, version)` at `:2166`.
- `providerNeedsAccount(provider)` at `:1797` returns `provider !== 'claude'`.
- `validateNonInteractiveProvider(options, summary)` is at `:1925`.
- `hasPairingAndTrialParams` at `:1331`: requires **exactly** `{pairing, trial}`, trial 1–365. FROZEN — back-compat with published installers.
- `parseInstallerOAuthStartBody` at `:1342`: validates origins and that the login `next` is exactly `{pairing, login_only:1}`. FROZEN.
- `CMEM_TRIAL_ACKNOWLEDGEMENT` (`cmem-pro-costs.ts:12`) is **dead code** — no consumer in `src/`.

**Server (`~/Scripts/claude-mem-pro`)**
- `POST /api/installer/oauth/start` returns exactly 7 keys (`start/route.ts:105-116`): `pairing_id`, `secret`, `user_code`, `authorization_url`, `checkout_url`, `expires_in`, `poll_interval`. There is **no `login_next` key** — the login-only claim is embedded in `authorization_url`'s `next=` param (`:56`).
  - `authorization_url` = `/login?next=<urlencoded /api/pro/trial/claim?pairing=X&login_only=1>`
  - `checkout_url` = `/api/pro/trial/claim?pairing=X&trial=30` (`:50-53`, `INSTALLER_TRIAL_DAYS=30` at `:29`)
- **KEY FACT** — `claim/route.ts` already handles sessionless visitors: when `getUser()` returns null it redirects to `/login?next=<the same claim URL>` and returns after auth. **Opening `checkout_url` with no session already performs login-then-claim in one trip.**
- **BLOCKER** — `claim/route.ts:115-123` two-visit state machine: `login_only` advances `pending → authenticated`; the checkout visit advances **only** `authenticated → claimed`. A `pending` row visiting without `login_only` stays `pending`. This must allow `pending → claimed`.
- `poll/route.ts` stages: `awaiting_login` when `!pairing.userId` (`:161`); `awaiting_checkout` when not entitled (`:184`) or entitled-but-no-setupToken (`:198`); `awaiting_approval` when entitled but `!pairing.approvedAt` (`:194`). Returns `authenticated` only when `status === 'authenticated'` (`:169-176`), `ready` after the atomic `deliverPairing` flip (`:228`).
- Poll auth: `secretMatches` — SHA-256 + `timingSafeEqual` against `secret_hash` (`:47-51`, `:149`). No cookie.
- `approve/route.ts` requires **session + user_code + Origin header** (`:124-127`, `:130`, `:174-176`, `:184-186`). It does **NOT** take the pairing secret. The user_code is the real browser↔terminal binding.
- `cliPairings` schema (`src/db/schema.ts:195-212`): `pairingId, secretHash, email, status, userId, source, createdAt, claimedAt, deliveredAt, expiresAt, userCode, deviceName, approvedAt`. **No `authenticatedAt` and no session column.** `status` is overwritten in place, so it cannot distinguish which claim happened.
- `/installer/authorized` page renders only: "Login complete. Close this window and go back to your terminal." — the mid-flow bounce we are deleting from the Pro path.

### Anti-pattern guards
- Do NOT change `checkout_url` / `authorization_url` **URL shapes**. Published installers (≤13.21.2) reject anything else. Redirect *destinations* are free to change; URL *shapes* are frozen.
- Do NOT switch the provider prompt away from `p.multiselect<ProviderChoice>` — pinned at `install-trial-contract.test.ts:167`.
- Do NOT reintroduce `promptBrowserLogin`, `CMEM_PRO_TRIAL_START_URL`, `CLAUDE_MEM_ONLINE_OPTIN`, or `Your email:` — forbidden at `install-trial-contract.test.ts:168-171`. **We are NOT restoring email capture.**
- Do NOT move the `requireInstallerOAuthLogin(version)` call site textually **above** line 1925 — `install-non-tty.test.ts:97-103` asserts `validateNonInteractiveProvider` appears earlier in the file by byte position.

### Commands
- Installer tests: `bun test tests/npx-cli/install-trial-contract.test.ts tests/npx-cli/provider-account-gate.test.ts tests/install-non-tty.test.ts`
- All tests: `npm test` · Typecheck: `npm run typecheck`
- **Verified baseline: 68 pass, 0 fail.**

---

## Phase 1 — Lazy login (CLI only, self-contained)

**Goal:** provider choice happens first and costs nothing; OAuth runs only on the CMEM Pro branch.

### What to implement

Split `promptProvider` into a **choice** step and an **apply** step, so the login call stays in the main flow textually below line 1925 (respects the byte-position trap).

1. In `src/npx-cli/commands/install.ts`, extract the multiselect block (currently `:1066-1092`) into `promptProviderChoice(options): Promise<ProviderChoice>`. It takes **no pairing** and performs **no network calls**. Copy the existing multiselect verbatim — same `p.multiselect<ProviderChoice>`, same `initialValues: ['cmem']`, same `required: true`, same both-selected re-prompt loop.
2. Change `promptProvider` to accept the already-made `selectedProvider` plus `pairing`, keeping its existing CMEM/claude/BYO branches unchanged (`:1101-1140+`).
3. Rewrite the main flow at `:2145-2166` to:
   - call `promptProviderChoice` first when no `options.provider` was given;
   - call `requireInstallerOAuthLogin(version)` **only** when the resolved choice is `'cmem'` (or when `options.provider` is set and `providerNeedsAccount()` is true, preserving the non-interactive path);
   - then call `promptProvider` with the resolved choice and the pairing.
4. Update `providerNeedsAccount`'s doc comment at `:1791-1797`: it no longer means "login first for everyone", it means "this flag still needs an account". Keep the function's return values identical — `provider-account-gate.test.ts:10-25` asserts them and those assertions remain correct.
5. Delete the now-stale comment at `:1694-1696` ("logging in is required of every user and runs BEFORE the provider choice") and replace it with one describing lazy login.
6. **Re-check the stdin sequencing dependency at `:1726-1734`.** That comment says `completeCmemTrialPairing` deliberately skips the return-wait because "stdin has already been through the login wait and a clack prompt by now". Reordering changes that history — the provider prompt now runs *before* login. Verify by hand (Phase 5 manual run) whether the wait behaves; adjust only if it actually stalls. No test covers this.

### Tests to update (deliberate contract flips, not incidental breaks)
- `tests/npx-cli/install-trial-contract.test.ts:161-172` — the test named **"requires OAuth before provider selection"**. This assertion *is* the inversion. Rewrite it to assert the opposite: provider choice appears before the login call, and login is reached only on the CMEM branch. Keep the `not.toContain` forbid-list at `:168-171` exactly as is.
- `tests/npx-cli/provider-account-gate.test.ts:35-42` — the verbatim-adjacency regex on `if (providerNeedsAccount(options.provider)) {`. Rewrite to match the new gate.
- `tests/npx-cli/provider-account-gate.test.ts:13-16` — the comment "The provider screen can still offer CMEM Pro, so login has to come first" is now false. Keep `providerNeedsAccount(undefined) === true` (still correct) but rewrite the comment.
- `tests/install-non-tty.test.ts:97-103` — must still pass. If the login call site moved above line 1925, that is a mistake; move it back rather than weakening the test.

### Verification checklist
- [ ] `npm run typecheck` clean
- [ ] `bun test tests/npx-cli/ tests/install-non-tty.test.ts` — all pass
- [ ] `npm test` — no regressions vs the 68-pass baseline
- [ ] `grep -n "requireInstallerOAuthLogin(version)" src/npx-cli/commands/install.ts` returns a line number **> 1925**
- [ ] Manual: `--provider claude` completes with **cmem.ai unreachable** (block it in `/etc/hosts`) and never opens a browser
- [ ] Manual: choosing "Use your Anthropic Max Plan" at the prompt never opens a browser

---

## Phase 2 — One uninterrupted browser trip

**Goal:** OAuth → offer → Stripe → done, with no bounce back to the terminal in the middle.

### Server (`~/Scripts/claude-mem-pro`) — do this FIRST and deploy before shipping the CLI

1. In `src/app/api/pro/trial/claim/route.ts:115-123`, relax the non-`login_only` status transition to also accept `pending`:
   ```
   WHEN status IN ('pending', 'authenticated') THEN 'claimed'
   ```
   Keep the `login_only` branch exactly as is. Preserve every existing guard in the `.where(...)` clause at `:130-137` (`ne(status,'delivered')`, `gt(expiresAt, now)`, the userId ownership check) — those are load-bearing for exactly-once delivery.
2. Do **not** change `authorization_url` or `checkout_url` construction in `start/route.ts:44-57`. Shapes are frozen.
3. Leave `/installer/authorized` in place — installers ≤13.21.2 still land there.

### CLI

4. In the CMEM Pro branch, open `pairing.checkoutUrl` **instead of** `pairing.authorizationUrl`, and drop the separate login round trip. The claim route's sessionless bounce (`claim/route.ts`, the `if (!user)` block) performs login inline and returns to the claim.
5. The poll loop needs no change — with a direct `pending → claimed`, `poll` moves `awaiting_login` → `awaiting_checkout` → `awaiting_approval` on its own.
6. Update `waitForInstallerPairing`'s `stageMessages` (`:1555-1560`) — the `phase: 'login'` vs `'enrollment'` split may collapse to a single phase. Only simplify if Phase 1 actually made one branch unreachable; do not delete a still-used branch.

### Phase 2b — Close the stranding hole (real defect found in discovery)

`ProOffer.tsx:91-92` derives `installerPairing` from a 32-hex `pairing` param, but `funnelSource === 'installer'` is driven by `from=installer` **alone** (`:83-84`). So an installer-tagged visit with a missing or malformed `pairing` skips the resume branch at `:166`, falls through to `startCheckout` (`:172`), and lands on `/pro/key` — a manual paste-back screen the installer has **no paste path for**. The Stripe session is tagged `funnel_source: installer` but carries **no `pairing_id` metadata**, so the webhook can never match delivery back to the waiting terminal. It polls `awaiting_approval` until timeout.

This is the `/pro/key` dead-end observed in production on 2026-08-31.

Fix: when `fromInstaller` is true but `installerPairing` is null, do **not** silently start a bare checkout. Show a recoverable error telling the user to re-run `npx claude-mem install` for a fresh link (the same message `/pro?trial_error=expired` already renders). Add a `posthog.capture` for this branch so the rate is visible.

Verification:
- [ ] Visiting `/pro?from=installer` with no `pairing` param shows the recover-and-rerun message, not a checkout button that strands the terminal
- [ ] Visiting `/pro?from=installer&pairing=notvalidhex` does the same
- [ ] A valid pairing still routes through `/api/pro/trial/claim?...&checkout=1` unchanged

### Verification checklist
- [ ] Server: existing pro tests pass; typecheck/build clean
- [ ] A **published** installer (13.21.2 from npm, not the local build) still completes end-to-end against the updated server — this is the back-compat gate, and it must be run
- [ ] New CLI: exactly one browser window opens on the CMEM Pro path
- [ ] Confirm `pro_users` still gets a row for a user who reaches checkout
- [ ] Confirm an expired/delivered pairing still fails closed (guards intact)

---

## Phase 3 — Copy trim

**Goal:** one offer, one line. (The cost overwording is already ~80% resolved — the live pricing engine was deleted in `2ed78c58d`, and the billing acknowledgement was moved to the checkout page. Do **not** re-litigate that.)

1. In `src/npx-cli/cmem-pro-costs.ts:33-38`, trim the CMEM Pro label from its current two-line run-on to a single line. Constraints from `install-trial-contract.test.ts:146-149`: hints must stay `''`, the cmem label must still contain `30 Day Free Trial`, the claude label must still contain `no cloud sync`. Keep the rationale comment at `:22-31` (clack renders hints only on the focused row).
2. Delete the dead `CMEM_TRIAL_ACKNOWLEDGEMENT` export at `:12-13`. Confirm with `grep -rn CMEM_TRIAL_ACKNOWLEDGEMENT src/` returning nothing. Leave the guard at `install-trial-contract.test.ts:158` in place — it should keep passing.
3. Update the exact-copy assertion at `install-trial-contract.test.ts:132-138` to the new label.

### Verification checklist
- [ ] `bun test tests/npx-cli/install-trial-contract.test.ts` passes
- [ ] Label renders on one line at 80 columns
- [ ] `grep -rn "CMEM_TRIAL_ACKNOWLEDGEMENT" src/` is empty

---

## Phase 4 — Device-code narrowing (OPTIONAL, LAST, SECURITY-REVIEWED)

**Do not start this until Phases 1–3 are shipped and verified.** Phases 1–3 already deliver 5 switches → 2. This phase is a bonus and must not risk them.

**Discovery confirmed this is genuinely expensive:**
- There is **no** `authenticatedAt` or browser-session column on `cliPairings`; `status` is overwritten in place. Same-session continuity requires a **migration**.
- `approve/route.ts` does **not** take the pairing secret — it authenticates with session + user_code + Origin. The user_code is the actual browser↔terminal binding.
- The pairing id **does** travel in URLs (checkout_url, offer link, success URL), so it is a bearer value. The code defends against someone holding a leaked pairing id completing checkout against your terminal, and against your terminal receiving credentials provisioned under an attacker-chosen account.

**Therefore: narrowing, never deletion.** Only skip the code re-entry when the *same browser session* both (a) completed the claim for this pairing and (b) returned from Stripe with matching `pairing_id` metadata.

Requires: a new nullable column (e.g. `authenticated_session_id`), a migration, and an explicit security review. Write the migration additively; never drop `userCode`.

**If review rejects this, close it out. Phases 1–3 stand alone.**

---

## Phase 5 — Final verification

1. `npm run typecheck` and `npm test` both clean.
2. Anti-pattern grep:
   - `grep -rn "promptBrowserLogin\|CMEM_PRO_TRIAL_START_URL\|CLAUDE_MEM_ONLINE_OPTIN\|Your email:" src/` → **empty** (we did not restore email capture)
   - `grep -n "p.multiselect<ProviderChoice>" src/npx-cli/commands/install.ts` → present
   - login call site line number > 1925
3. **Full manual walkthrough**, counting context switches out loud:
   - CMEM Pro path: expect **4** (terminal → browser → terminal for the code → browser → terminal). Was 5; Phase 4 would take it to 2.
   - Anthropic Max path: expect **0** browser opens
   - `--provider claude` with cmem.ai unreachable: completes offline
4. **Back-compat gate:** published 13.21.2 from npm still completes against the updated server.
5. Count switches before/after and record them in the PR body.

---

## Sequencing & release notes

- **Server Phase 2 deploys before the CLI ships.** claude-mem-pro auto-deploys from main on push to Vercel. A new CLI opening `checkout_url` first would break against the old state machine.
- Phase 1 is CLI-only and self-contained — it can land and be tested independently.
- CLI release needs a version bump + npm publish, which is human-gated (see the `version-bump` skill). Do not publish autonomously.
- Two repos, two PRs. Branch `fix/installer-preselect-defaults` already has PR #3825 open; consider a fresh branch for this work rather than growing that PR.

## Verified risks (from the Phase 5 adversarial trace)

1. **Poll budget — FIXED during Phase 5.** `OAUTH_POLL_BUDGET_MS` was a single 240s window. Under the old two-trip flow it was spent twice (240s for login, a fresh 240s for checkout); the one-trip design silently collapsed that into one 240s window covering OAuth + reading the offer + Stripe card entry + device-code entry, exiting the installer non-zero on overrun. Split into `OAUTH_POLL_BUDGET_LOGIN_MS` (240s) and `OAUTH_POLL_BUDGET_ENROLLMENT_MS` (25 min, bounded by the server's 30-min `PAIRING_TTL_SECONDS`).
2. **Misleading failure message — FIXED during Phase 5.** A CMEM Pro path that failed at checkout or approval printed "OAuth login is required to finish installation." It now names the step that actually failed.
3. **Stripe cancel stranded the user — FIXED during Phase 5.** `cancelUrl` carried `from=installer` but no `pairing`, so cancelling tripped the new Phase 2b guard and told the user their authorization had expired while their pairing was still live and still being polled. `cancelUrl` now carries the pairing, so cancel offers a retry rather than a restart.
4. **UNVERIFIED — stdin sequencing.** `waitForReturnToOpenBrowser` runs after a clack multiselect on the CMEM path. A pty repro passed, but the same harness also passed the ordering the code comment says previously stalled, so it has no demonstrated sensitivity. Structural argument says low risk (the "clack prompt precedes this wait" configuration already ships today, and the *second* raw-mode wait that was blamed no longer exists on this path). Only a live interactive run settles it.
5. **UNVERIFIED — the back-compat gate was not run.** A published 13.21.2 installer from npm has not been exercised against the updated server. Static evidence is strong: `hasPairingAndTrialParams` and `parseInstallerOAuthStartBody` are byte-identical to HEAD, `start/route.ts` is not in the diff at all, and the state-machine walk shows `'authenticated'` still matches the widened CASE. But the gate is formally open.
6. **UNTESTED — the Phase 2b guard** has no automated coverage in any server `test:*` script.

## Open risk

Making login lazy costs `pro_users` its `registered` rows — and this is **broader than first stated**. New installers never send `login_only=1`, and that branch is the only place the `registered` row is inserted. So a user who signs in via the checkout URL and then abandons at the offer page or at Stripe now leaves **no `pro_users` row at all**, not merely the Anthropic-Max users. The server-side `installer_oauth_completed` capture lives on the same branch and likewise stops firing for new installers (the CLI still emits its own client-side event). **That is a deliberate, stated trade** — top-of-funnel visibility moves to anonymous installer telemetry (`captureCliEvent`, `installId`), which already exists and does not require an account. Measurement should ride on telemetry, not on a login wall.
