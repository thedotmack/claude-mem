# Install-First Flow: Browser Login, Universal OpenRouter Key, "% More Usage" Messaging

**Date**: 2026-08-26
**Branch**: `almondine-detective`
**Status**: Ready to execute

## Goal

Redesign the `npx claude-mem install` experience:

1. **Install first, login second.** All mechanical install work (marketplace copy, deps, IDE integrations) completes BEFORE any account interaction. Then the installer requires a browser login.
2. **Universal OpenRouter-backed key.** Every login provisions a memory key delivered to the installer — it just has a $0 balance until the user signs up for Pro. No more "paste your key" path as the primary flow.
3. **Provider choice for everyone.** After login, the user picks their memory provider. "claude-mem" (the hosted observer) is the recommended option: free for 7 days, and when the free week ends without a subscription, memory generation **automatically falls back to the user's Anthropic plan** instead of erroring.
4. **No more scary dollar figures.** Every `$X/1k observations` and "burns your plan's tokens" line is removed. All messaging speaks in **"get % more usage from your plan"**.
5. **The animation always plays** in every real terminal — narrow terminals get a scaled render, `NO_COLOR` gets monochrome. Only non-TTY/CI skips.

## Phase 0: Consolidated Discovery (COMPLETE — findings below are line-verified)

### Allowed APIs / existing machinery (source of truth — do NOT invent alternatives)

| Machinery | Location | Signature / contract |
|---|---|---|
| CLI router + install flags | `src/npx-cli/index.ts:63-99, 101-235` | `--ide --provider --model --runtime --no-auto-start`; provider allowlist `claude\|gemini\|openrouter` |
| Install orchestrator | `src/npx-cli/commands/install.ts:1933-2408` (`runInstallCommandInner`) | Full step order documented below |
| Interactivity probe | `install.ts:54` | `const isInteractive = process.stdin.isTTY === true` |
| Banner player | `src/npx-cli/banner.ts:112-182` (`playBanner`), gate `isBannerEnabled()` `:101-108` | Skips: non-TTY, `CI`, `CLAUDE_MEM_NO_BANNER`, `NO_COLOR`, columns < 128 |
| Banner frames | `src/npx-cli/banner-frames.ts:15-21` | base64 raw-deflate, 192 frames, 128×36, 22ms; decode `banner.ts:27-42` (fail-open); span markers parsed by `styleFrame` `banner.ts:44-68` |
| Trial pairing start | `install.ts:1434-1466` (`startTrialPairing(email)`) | `POST {CMEM_PRO_TRIAL_START_URL}` body `{email, source, device_name}` → `{pairing_id, secret, poll_interval, user_code}` |
| Trial poll | `install.ts:1479-1530` (`pollTrialOnce`) | `POST {CMEM_PRO_TRIAL_POLL_URL}` body `{pairing_id, secret}`; `202+{stage}` pending, `200+{status:'ready', user_id, setup_token, hub_url, trial:{ends_at}}` ready, `410/404` gone |
| Poll driver | `install.ts:1699-1850` (`completeTrialPairing`) | 240s budget (`:1383`), Ctrl+C escape `:1731-1739`, stages `awaiting_login\|awaiting_checkout\|awaiting_approval` (`:1468`) |
| Ready-state settings write | `install.ts:1767-1776` | Writes 8 keys atomically via one `mergeSettings` call |
| Settings merge | `install.ts:776-832` (`mergeSettings`) | Preserves unknown keys + legacy `{env:{}}` shape, chmod 0600 at `:823` |
| Browser open | `install.ts:990-1004` (`openBrowser`) | `open` / `cmd /c start` / `xdg-open`, fail-soft |
| Endpoint constants | `src/npx-cli/cmem-pro-costs.ts:169-207` | `CMEM_PRO_ORIGIN` (env-overridable), `CMEM_PRO_SIGNUP_URL`, `CMEM_PRO_TRIAL_START_URL/POLL_URL`, `CMEM_PRO_TRIAL_DAYS=7`, `CMEM_PRO_BASE_URL`, `CMEM_PRO_MODEL='cmem-observer'`, `CMEM_PRO_KEY_PATTERN` |
| Pricing engine (TO BE DELETED) | `cmem-pro-costs.ts:24-161` | `fetchBlendedRates`, `costPer1kObservations`, `buildProviderLabels`, `MODEL_IDS`, `TOKENS_PER_OBSERVATION` |
| Provider prompt | `install.ts:1006-1283` (`promptProvider`) | `cmem` is a prompt-only sentinel (`:834-841`) — runtime only knows `claude\|gemini\|openrouter` |
| Claude auth sub-flow | `install.ts:1135-1177` | subscription / api-key / gateway |
| Model prompt | `install.ts:1285-1360` (`promptClaudeModel`) | |
| Settings schema | `src/shared/SettingsDefaultsManager.ts:22-114` (interface), `:117-206` (defaults) | `CLAUDE_MEM_PROVIDER` default `'claude'` (`:124`) |
| Runtime provider dispatch | `src/services/worker/http/routes/SessionRoutes.ts:70-75` + duplicate `src/services/worker-service.ts:280-282` | Silent fall-through to `claude` when selected provider unavailable |
| OpenRouter predicates | `src/services/worker/OpenRouterProvider.ts:440-450` | `isOpenRouterAvailable()`, `isOpenRouterSelected()` |
| Gateway error taxonomy | `OpenRouterProvider.ts:28-34` | `allowance_exhausted → 'quota_exhausted'`, thrown `:130` |
| Base URL resolver | `src/shared/openrouter-base-url.ts:48-62` | blank → openrouter.ai default |
| Promo constants (Node) | `src/shared/pro-promo.ts:17-48` | `PRO_TRIAL_PITCH` `:39`, `proTrialUrl()` `:34`, `proTrialLine()` `:46`, source union `:24-31` |
| Promo constants (viewer duplicate — must edit in lockstep) | `src/ui/viewer/constants/promo.ts:10-15` | tsconfig rootDir constraint documented at `pro-promo.ts:11-13` |
| Promo consumers | `src/cli/handlers/context.ts:163`, `src/cli/handlers/user-message.ts:42`, `src/services/worker/http/routes/SearchRoutes.ts:319` (+ template `:47-60`), `install.ts:2363-2364`, `src/ui/viewer/components/Header.tsx:55-62` | |
| Trial pitch note (aggressive copy) | `install.ts:1624-1637` | "burns ~$X/1k … Pro takes $0" |
| Observer health warnings | `src/shared/observer-health.ts:271-301` | Session-start outage warning pattern; credential scrubbing `:92-111` |
| Task runner / logging | `install.ts:104-161` | `runTasks`, `startHeartbeat`, `bufferConsole`, `log` |
| Non-interactive matrix | `install.ts:54, 893-896, 1121-1133, 1577-1579, 1861-1866, 2013-2015, 2195` | |
| Worker settings HTTP validation | `src/services/worker/http/routes/SettingsRoutes.ts:87-90, 145-147` | `CLAUDE_MEM_OPENROUTER_BASE_URL` missing from exposed list (known gap) |

### Current install order (what we are changing FROM)

banner → **trial opt-in email prompt (`:1985`)** → overwrite confirm → IDE select → runtime → **trial poll / provider prompt (`:2022-2029`)** → model → stop worker → copy/register/deps tasks (`:2064-2153`) → IDE integrations → auto-memory → worker start → summary → next steps → telemetry → outro.

### Anti-patterns (repo-verified — do NOT do these)

- Do NOT write `cmem` to `CLAUDE_MEM_PROVIDER` — runtime rejects it (`SettingsRoutes.ts:145-147`).
- Do NOT use `git stash` (worktree shares stash stack — session rule).
- Do NOT invent an OpenRouter provisioning call in THIS repo — provisioning happens server-side at cmem.ai (separate repo). This repo only consumes what the poll endpoint returns.
- Do NOT print credentials — scrubbing conventions in `observer-health.ts:92-111`; never log the key.
- Do NOT add try/catch during initial development phases (project style: error handling is a final-phase concern; the existing installer's fail-soft helpers already encapsulate their own).
- Do NOT edit `CHANGELOG.md` (auto-generated).
- No ink/react-ink — the repo uses `@clack/prompts` only.

### Backend contract (cmem.ai — SEPARATE REPO, document only)

This plan requires the cmem.ai backend (cmem-pro-mvp repo) to evolve the poll contract. Client code in THIS repo must tolerate both old and new shapes:

```
POST /api/pro/trial/poll  { pairing_id, secret }
  200 ready (NEW shape):
  {
    status: 'ready',
    user_id: string,
    setup_token: string,          // cloud-sync token (unchanged)
    hub_url: string,              // unchanged
    memory_key: string,           // NEW: cm_pro_… key minted for EVERY login (maps to an
                                  //      OpenRouter provisioned key server-side; $0 balance
                                  //      until the user subscribes)
    memory_base_url?: string,     // NEW: defaults to CMEM_PRO_BASE_URL when absent
    memory_model?: string,        // NEW: defaults to CMEM_PRO_MODEL when absent
    trial?: { ends_at: string },  // present when the free week is active
    plan: 'trial' | 'pro' | 'none'  // NEW: 'none' = logged in, not subscribed, $0 balance
  }
```

Login alone must satisfy the poll — the `awaiting_checkout` stage becomes optional server-side (client already renders whatever stage string arrives, `install.ts:1701-1710`, so no client change needed for stage handling). A `SYNC-NOTES.md` note for the backend repo is produced in Phase 4.

---

## Phase 1: Messaging Engine — "% more usage", delete the pricing engine

**Self-contained context**: `src/npx-cli/cmem-pro-costs.ts` computes live $/1k-observation figures shown in installer provider labels and the trial pitch. `src/shared/pro-promo.ts:39` + `src/ui/viewer/constants/promo.ts:12,15` hold the "Get 2x more use out of your Max plan for free (7-day trial, $30/mo)" pitch. The user wants ALL dollar-figure cost framing replaced with "get % more usage" framing.

### What to implement

1. In `src/shared/pro-promo.ts`, replace `PRO_TRIAL_PITCH` (`:39`) with the new canonical pitch and add a shared gain constant:
   ```ts
   export const PLAN_USAGE_GAIN_PERCENT = 100;
   export const PRO_TRIAL_PITCH = `Get up to ${PLAN_USAGE_GAIN_PERCENT}% more usage from your plan — memory runs off-plan, free for 7 days`;
   ```
   Keep `proTrialUrl`/`proTrialLine` signatures unchanged (consumers at `context.ts:163`, `user-message.ts:42`, `SearchRoutes.ts:319`, `Header.tsx:55-62` keep working with zero changes).
2. Mirror both constants verbatim in `src/ui/viewer/constants/promo.ts` (`:12` pitch, `:15` short form → `'Get up to 100% more usage from your plan'`). The duplication is mandatory — see the rootDir note at `pro-promo.ts:11-13`.
3. In `src/npx-cli/cmem-pro-costs.ts`:
   - DELETE the pricing machinery: `MODELS_URL`, fetch timeout, `TOKENS_PER_OBSERVATION`, `INPUT_SHARE`/`OUTPUT_SHARE`, `MODEL_IDS`, `FALLBACK_BLENDED_PER_M`, `fetchBlendedRates`, `costPer1kObservations`, and the `Rates` types (`:24-123`).
   - REWRITE `buildProviderLabels()` (`:146-161`) as a synchronous, network-free function returning static labels (final copy in Phase 5's prompt spec). Keep `ProviderLabels` field names so call sites only drop an `await`.
   - KEEP the endpoint/constant block `:169-207` untouched (`CMEM_PRO_*` constants are load-bearing).
   - `CMEM_PRO_MONTHLY_USD` (`:44`) survives ONLY for the single price-disclosure line ("7 days free, then $30/mo — cancel anytime"), which is required honesty at the opt-in moment, not an "extreme cost number".
4. In `install.ts`, update the two `fetchBlendedRates()` call sites (`:1621-1622` and inside `buildProviderLabels` usage at `:1186`) — the trial pitch note rewrite itself lands in Phase 4, but the code must compile after this phase: replace the `haikuPer1k` interpolation in the pitch note (`:1624-1637`) with the new `PRO_TRIAL_PITCH`-based copy (temporary is fine; Phase 4 finalizes).
5. Update the 4 hand-copied markdown promo lines to the new pitch: `cursor-hooks/README.md:58`, `cursor-hooks/QUICKSTART.md:86`, `cursor-hooks/STANDALONE-SETUP.md:15` and `:152`.

### Documentation references

- Pitch consumers inventory: `pro-promo.ts:24-31` (exhaustive `ProPromoSource` union).
- Existing computed savings system (`TokenCalculator.ts:25-28`, `AgentFormatter.ts:56-69`) is a DIFFERENT metric (context-reuse savings) — leave untouched.

### Verification checklist

- `grep -rn "costPer1kObservations\|fetchBlendedRates\|TOKENS_PER_OBSERVATION\|blended" src/` → zero hits.
- `grep -rn "2x more" src/ cursor-hooks/` → zero hits.
- `grep -n "PRO_TRIAL_PITCH" src/shared/pro-promo.ts src/ui/viewer/constants/promo.ts` → identical strings.
- `bun run build` (or the repo's typecheck script) passes.

### Anti-pattern guards

- Do not leave a dead `Rates` type or unused import behind (delete aggressively).
- Do not change `proTrialUrl` query-param behavior (`?from=<source>` attribution must survive).

---

## Phase 2: Always-On Animation

**Self-contained context**: `src/npx-cli/banner.ts` plays a 192-frame, 128-col ASCII animation, but `isBannerEnabled()` (`:101-108`) skips it on `NO_COLOR` and on terminals narrower than 128 columns. The user wants the install flow to ALWAYS load the animation.

### What to implement

1. In `banner.ts`, change `isBannerEnabled()` to skip ONLY on: `!process.stdout.isTTY`, `process.env.CI`, `process.env.CLAUDE_MEM_NO_BANNER` (escape hatch stays). Remove the `NO_COLOR` and `columns < 128` skips.
2. Add adaptive rendering:
   - Parse each frame line into per-char cells with an accent flag (reuse the span-marker parsing approach from `styleFrame` `:44-68`).
   - When `process.stdout.columns < 128`, downsample columns by even nearest-neighbor sampling to `min(columns, 128)`; when `process.stdout.rows < 36 + 4`, downsample rows the same way. Apply the same scale to the wordmark reveal (`WORDMARK_BUBBLE` `:74-80`) — if the scaled width can't fit the wordmark, center-crop it.
   - When `NO_COLOR` is set, emit frames without any SGR color sequences (plain glyphs; keep cursor-hide/clear codes, which are not color).
3. Keep the resize-abort behavior (`:117-119`) — on resize, re-derive target size for subsequent frames instead of aborting, if simple; otherwise keep abort (acceptable).
4. Existing fail-open decode (`:27-42`) must remain: a corrupt payload can never break install.

### Documentation references

- Frame payload format: `banner-frames.ts:5-21` (base64 raw-deflate, `\x01` separators). Note: no in-repo frame generator exists — do NOT attempt to regenerate frames; scale at render time only.
- Truecolor/256-color fallback: `banner.ts:11-25, 70-72`.

### Verification checklist

- `COLUMNS=80 <run banner in a pty>` renders scaled without wrapping artifacts (manual check via a small scratch script in the scratchpad dir that calls `playBanner()`).
- `NO_COLOR=1` renders monochrome, exits cleanly, restores cursor.
- Non-TTY (`node script | cat`) prints nothing from the player (gate works).
- Unit-test the pure scaling function (cell parsing + downsampling) in `tests/` with a synthetic 8×4 frame.

### Anti-pattern guards

- No new dependencies (no ink, no chalk) — raw escape codes only, matching existing style.
- Never write frames when `!isTTY` (escape codes in logs are corruption, not "always").

---

## Phase 3: Flow Reorder — Install Everything First

**Self-contained context**: `runInstallCommandInner` (`install.ts:1933-2408`) currently prompts for the Pro trial email FIRST (`:1985`, before anything is installed) and resolves the provider mid-flow (`:2022-2029`). The user wants: banner → minimal setup questions → ALL mechanical install work → login → provider → finish.

### What to implement

Reorder `runInstallCommandInner` to this exact sequence (each item is an existing block — this phase MOVES code, it does not rewrite the blocks internally):

1. Banner (`:1941-1946`) + version/intro lines (`:1947-1969`) + Windows preflight (`:1976-1981`).
2. Overwrite confirm (`:1987-1999`).
3. IDE selection (`:2001-2015`) — needed before mechanical work.
4. Runtime choice (`:2017`) + server API-key bootstrap.
5. Claude model prompt REMOVED from here (moves to Phase 5's provider step).
6. Stop running worker (`:2041-2062`).
7. ALL mechanical tasks: marketplace copy, cache, registration, plugin enable, bun/uv + deps (`:2064-2153`), then per-IDE integrations (`:2156`), then auto-memory choice (`:2164-2189`).
8. **Login step** (Phase 4) — first account interaction, AFTER install is complete on disk.
9. **Provider choice** (Phase 5).
10. Worker autostart (`:2195-2227`) — must run AFTER provider settings are written so the worker boots with the right provider.
11. Summary, flushSummary, health poll, Next Steps, telemetry consent (last), outro (`:2233-2407`).

Delete the early trial opt-in call site (`:1985`) and the mid-flow `completeTrialPairing`/`promptProvider` resolution (`:2022-2029`) — their replacements land in Phases 4–5 at the new positions. To keep this phase shippable on its own, temporarily place the EXISTING `promptProvider()` + `promptClaudeModel()` calls at position 9 and the EXISTING `promptProTrialOptIn`/`completeTrialPairing` pair at positions 8/9 (same functions, new order). Phases 4–5 then replace their internals.

### Documentation references

- Non-interactive matrix (`install.ts:54, 1121-1133, 2013-2015, 2195`) — flags-driven installs must behave identically before/after reorder: `--provider X` still skips all account interaction.
- `autoStartSkipped` logic `:2195` — verify the worker still starts after the move.

### Verification checklist

- Interactive dry-run (scratchpad HOME sandbox): prompts appear in the new order; no prompt appears between the task list and IDE integrations.
- `npx claude-mem install --ide claude-code --provider claude` (non-interactive path, `install.ts:1121-1133`): zero account prompts, install completes, provider persisted.
- `install_completed` telemetry (`:2395-2407`) still fires with ide/provider/runtime fields.
- Worker starts AFTER settings write (check `~/.claude-mem/settings.json` mtime < worker start log time in the sandbox run).

### Anti-pattern guards

- Do not change `mergeSettings`, task internals, or IDE installers — pure reordering.
- Do not break `runRepairCommandInner` (`:2410-2473`) — it shares helpers but not the order.

---

## Phase 4: Required Browser Login + Universal Key Delivery

**Self-contained context**: The pairing client exists (`startTrialPairing` `:1434-1466`, `pollTrialOnce` `:1479-1530`, `completeTrialPairing` `:1699-1850`) but is framed as an optional paid-trial upsell with aggressive cost copy (`:1624-1637`). It becomes the standard login step for everyone, delivering a memory key to every account ($0 balance until subscribed).

### What to implement

1. Rename/reframe `promptProTrialOptIn` → `promptBrowserLogin` at its new position (after mechanical install, Phase 3 position 8):
   - New note copy (uses Phase 1 constants; NO dollar figures except the single price-disclosure line):
     ```
     Sign in to claude-mem

     Your account unlocks memory that runs off-plan —
     get up to 100% more usage from your plan.
     Includes a key for every provider, cloud sync, and the claude-mem observer
     (free for 7 days, then $30/mo — cancel anytime, no card required to sign in).

     Enter your email — we'll send a sign-in link.
     ```
   - The email prompt is REQUIRED in interactive mode: on empty input, re-explain once and re-prompt; a second refusal or Ctrl+C prints "Skipped sign-in — finish anytime with npx claude-mem install" and continues (never trap the user; `TRIAL_FINISH_LATER_WARNING` pattern `:1387`).
   - Skip conditions unchanged in kind: `!isInteractive`, `CI`, `CLAUDE_MEM_ONLINE_OPTIN=false`, explicit `--provider` flag, already-logged-in state (`:1577-1589`).
2. Open the browser to the magic-link landing automatically once the link is sent (reuse `openBrowser` `:990-1004` with `CMEM_PRO_SIGNUP_URL`) and show the device user-code (`noteTrialUserCode` `:1555-1565`).
3. Update `completeTrialPairing` (runs immediately after, still with its 240s budget + Ctrl+C escape):
   - Parse the NEW ready shape (Phase 0 backend contract): accept `memory_key`, `memory_base_url`, `memory_model`, `plan`, keeping backward compatibility with the current shape (absent fields → current defaults `CMEM_PRO_BASE_URL`/`CMEM_PRO_MODEL`).
   - On ready, persist in ONE `mergeSettings` call (pattern `:1767-1776`): cloud-sync trio + device name + `CLAUDE_MEM_PRO_TRIAL_STATE`, `CLAUDE_MEM_PRO_TRIAL_ENDS_AT` (new, from `trial.ends_at`), `CLAUDE_MEM_PRO_PLAN` (new, from `plan`), and stash the delivered key material for Phase 5's provider step — do NOT set `CLAUDE_MEM_PROVIDER` here; the user hasn't chosen yet. Return the parsed result object instead of the current `'openrouter' | null`.
   - Success note: `✓ Signed in — your memory key is ready.` plus, when `plan==='trial'`, `Free week active through <date>.`, when `plan==='none'`, `Your key is created with a $0 balance — pick any provider below; add the claude-mem observer anytime at cmem.ai.` (This is the ONE place the $0-balance state is explained.)
4. Declare the trial/plan settings keys properly in `SettingsDefaultsManager.ts` (interface `:22-114`, defaults `:117-206`): `CLAUDE_MEM_PRO_TRIAL_EMAIL`, `CLAUDE_MEM_PRO_TRIAL_AT`, `CLAUDE_MEM_PRO_TRIAL_STATE`, `CLAUDE_MEM_PRO_TRIAL_ENDS_AT`, `CLAUDE_MEM_PRO_PLAN` — all default `''`. (Fixes the known round-trip-loss gap.)
5. Write `SYNC-NOTES-cmem-backend.md` at repo root documenting the Phase 0 backend contract delta (poll returns `memory_key` for every login; checkout no longer gates `ready`; `plan` field). This is the handoff to the cmem-pro repo.

### Documentation references

- Poll wire contract + stage rendering: `install.ts:1468-1530, 1699-1850`.
- Atomic settings write: `install.ts:1767-1776`. Settings key declaration style: `SettingsDefaultsManager.ts:86-91`.
- Credential hygiene: never print the key; scrub patterns per `observer-health.ts:92-111`.

### Verification checklist

- With `CMEM_PRO_ORIGIN` pointed at a scratchpad mock server (tiny Bun HTTP script serving both old-shape and new-shape ready responses): both shapes persist correct settings; the key never appears in stdout.
- Ctrl+C during poll → install completes, "finish anytime" line printed, no partial provider settings written.
- `settings.json` round-trips through `SettingsDefaultsManager.loadFromFile()` without dropping the five Pro keys (unit test in `tests/`).
- Non-interactive install: no network call to `/api/pro/trial/*` at all.

### Anti-pattern guards

- Do not block install completion on login success — login failure/skip still yields a working install (provider step handles the no-key path).
- Do not invent extra endpoints (`/api/pro/keys`, etc.) — the poll response is the ONLY delivery channel.
- Do not write `CLAUDE_MEM_PROVIDER` in the login step.

---

## Phase 5: Provider Choice Redesign

**Self-contained context**: `promptProvider` (`install.ts:1006-1283`) currently offers cmem/openrouter/gemini/claude with live $-figure labels. It now runs AFTER login, knows whether a delivered key exists, and uses Phase 1's static "% more usage" labels.

### What to implement

1. Rewrite the option list (labels live in `buildProviderLabels()`, `cmem-pro-costs.ts` — final copy):
   ```
   ◆  Choose your memory provider
   │  ● claude-mem (recommended) — memory runs off-plan: up to 100% more usage from your plan. Free for 7 days, then falls back to your Anthropic plan unless you subscribe.
   │  ○ Your OpenRouter key — memory runs off-plan on your OpenRouter credit
   │  ○ Gemini API key — memory runs off-plan on your Gemini key
   │  ○ Anthropic plan — memory shares your Claude plan usage
   ```
   `initialValue: 'cmem'` stays. NO dollar figures anywhere in this prompt.
2. Branch behavior:
   - `cmem` + delivered key from Phase 4 → write `CLAUDE_MEM_PROVIDER='openrouter'`, `CLAUDE_MEM_OPENROUTER_BASE_URL=<memory_base_url>`, `CLAUDE_MEM_OPENROUTER_MODEL=<memory_model>`, `CLAUDE_MEM_OPENROUTER_API_KEY=<memory_key>` (pattern `:1230-1235`). No paste prompt, no second browser trip.
   - `cmem` + NO delivered key (login skipped/failed) → fall back to the existing paste flow (`:1209-1243`) unchanged except copy (no "$30/mo card required" lead; reuse the price-disclosure line once).
   - `openrouter` / `gemini` → existing masked key prompts (`:1250-1282`) with the new labels.
   - `claude` → existing `runClaudeAuthFlow` (`:1135-1177`) + `promptClaudeModel` (`:1285-1360`) — model prompt copy keeps its qualitative labels but drops "most expensive" → "highest quality (slowest)".
   - Non-interactive `--provider` path (`:1121-1133`) unchanged.
3. Align the settings default with the prompt default is NOT wanted — headless installs must keep landing on `claude` (no key exists headlessly). Add a comment at `SettingsDefaultsManager.ts:124` stating this divergence is deliberate.
4. Update the "Next Steps" block (`install.ts:2346-2369`): drop `PRO_TRIAL_PITCH` line when the user is already signed in (extend the existing `trialActivated` suppression `:2358-2360` to any delivered key).

### Documentation references

- Sentinel rule: `install.ts:834-841` — `cmem` must never reach settings.json.
- Validation gate: `SettingsRoutes.ts:145-147`.

### Verification checklist

- Interactive sandbox run: choosing each of the four options writes the correct settings keys (assert on `settings.json` contents).
- `grep -n '\$' src/npx-cli/commands/install.ts src/npx-cli/cmem-pro-costs.ts` → only `CMEM_PRO_MONTHLY_USD` disclosure line(s) and TS syntax (template literals) remain; zero `$/1k` patterns.
- Worker boots with each provider selection (health poll `:2277-2325` green).

### Anti-pattern guards

- Do not remove the paste-key fallback — offline/skipped-login users need it.
- Do not add a fifth provider value to the runtime union.

---

## Phase 6: Trial Expiry → Automatic Fallback to Anthropic Plan

**Self-contained context**: Nothing client-side reads trial dates today. When a cmem-gateway key stops being funded (trial over, not subscribed), requests 402 with `allowance_exhausted` → classified `quota_exhausted` (`OpenRouterProvider.ts:28-34,130`) and the observer just fails with a scary outage warning. The promise "falls back to your Anthropic plan" is net-new.

### What to implement

1. Extract the duplicated provider dispatch (`SessionRoutes.ts:70-75` and `worker-service.ts:280-282`) into ONE shared helper, e.g. `src/services/worker/provider-dispatch.ts` → `getSelectedProvider(): 'claude'|'gemini'|'openrouter'` (DRY — both call sites import it).
2. Fallback trigger (event-driven, NOT date-driven — a subscribed user's key keeps working past `ends_at`, so the date alone must never disable anything):
   - When the OpenRouter provider hits a terminal `quota_exhausted` or `key_invalid` error AND the configured base URL is the cmem gateway (`settings.CLAUDE_MEM_OPENROUTER_BASE_URL` starts with `CMEM_PRO_ORIGIN`), write `CLAUDE_MEM_PRO_FALLBACK_AT=<ISO now>` (new declared settings key, default `''`) via the settings manager.
   - `getSelectedProvider()` returns `'claude'` whenever `CLAUDE_MEM_PRO_FALLBACK_AT` is non-empty (and provider is openrouter+cmem-gateway), instead of attempting the dead key.
   - Clearing: any successful cmem-gateway response, or the installer writing fresh key material (Phase 4/5), clears `CLAUDE_MEM_PRO_FALLBACK_AT`.
3. One-time user notice (NOT the scary outage banner): on the session-start context path (`src/cli/handlers/context.ts:163` area), when fallback is newly active, emit once:
   ```
   Your claude-mem free week ended — memory now runs on your Anthropic plan.
   Keep it off-plan (up to 100% more usage): https://cmem.ai/pro?from=fallback
   ```
   Add `'fallback'` to the `ProPromoSource` union (`pro-promo.ts:24-31`). Track "shown" with a marker file in `DATA_DIR` (pattern: `oauth-stale.marker`, `oauth-token.ts:340-364`).
4. Ensure the observer-health outage warning (`observer-health.ts:271-301`) does NOT fire for this handled fallback (the failure is consumed, provider switches; do not record it as consecutive observer failures).
5. Days-remaining nicety: while `CLAUDE_MEM_PRO_TRIAL_ENDS_AT` is set, plan `'trial'`, and no fallback, the session-start banner MAY append `claude-mem free week: N days left` (compute from the stored ISO date; no network).

### Documentation references

- Error classification flow: `OpenRouterProvider.ts:28-34, 85, 130`; `plans/2026-08-16-observer-error-path.md:65-71` (gateway taxonomy).
- Settings declaration style: `SettingsDefaultsManager.ts:86-91`.
- Quota-guard precedent (aborting SDK work on plan limits): `ClaudeProvider.ts:272-300`.

### Verification checklist

- Unit tests in `tests/`: dispatch helper returns `claude` when fallback marker set; returns `openrouter` when key healthy; clears on success.
- Simulated 402 from a mock gateway (scratchpad Bun server) → fallback key written, next session uses claude provider, notice emitted exactly once, observer-health ledger records zero failures for the handled path.
- `grep -rn "getSelectedProvider" src/` → exactly one definition, two imports.

### Anti-pattern guards

- No date-based auto-disable — 402-driven only.
- Fallback must not fire for user-owned openrouter.ai keys (base-URL guard) — a personal key running dry is the existing outage-warning path, unchanged.

---

## Phase 7: Docs + Surface Sweep

**Self-contained context**: docs never mention the login flow or claude-mem observer option, and several pages carry $/token tables.

### What to implement

1. `docs/public/installation.mdx:18-25`: rewrite the flow bullets to the new order (install → browser sign-in → provider choice), document the four provider options with the "% more usage" framing, document skip paths (`--provider`, `CLAUDE_MEM_ONLINE_OPTIN=false`, CI).
2. Remove/replace $-figure tables and "cheap/free-tier" cost framing:
   - `docs/public/usage/openrouter-provider.mdx:11, 129-131, 150, 287`
   - `docs/public/cursor/openrouter-setup.mdx:107-109`
   - `docs/public/usage/gemini-provider.mdx:8, 16, 165`
   - `docs/public/cursor/index.mdx:3, 28, 140, 145`
   - `docs/public/configuration.mdx:75-77` (drop "most expensive")
   Replacement framing: which provider runs memory off-plan vs on-plan; keep model quality/speed guidance without prices. (`smart-explore-benchmark.mdx` "17.8x cheaper" is a benchmark result about the search tool, not provider pricing — leave it.)
3. `docs.json` navigation: no new pages needed unless a "Sign in & providers" page is added to `docs/public/` — add one short page if `installation.mdx` grows past ~150 lines.
4. `README.md:131-171` install section: mention the sign-in step and the 7-day observer week, no prices.
5. Viewer settings modal (`src/ui/viewer/components/ContextSettingsModal.tsx:343, 403-446`): update the stale provider tooltip ("Choose between Claude (via Agent SDK) or Gemini") to cover all providers; label the openrouter option "OpenRouter / claude-mem observer".

### Verification checklist

- `grep -rn '\$[0-9]' docs/public/ README.md cursor-hooks/` → only non-pricing hits (e.g. shell `$VAR`) remain; zero price figures.
- `grep -rn "free tier\|cheaper\|most expensive" docs/public/` → zero pricing-pitch hits (benchmark page exempt).
- Mintlify build check if available (`docs/` lints), else MDX files parse (no broken tables).

---

## Phase 8: Final Verification

1. **Anti-pattern greps** (all must be clean):
   - `grep -rn "costPer1kObservations\|fetchBlendedRates\|/1k observations" src/ docs/ cursor-hooks/` → zero.
   - `grep -rn "'cmem'" src/services/` → zero (sentinel never leaks past the installer).
   - `grep -rn "2x more" src/ docs/ cursor-hooks/ README.md` → zero.
2. **Test suite**: run the repo's test command (check `package.json` scripts; `bun test tests/`) — all green, including new tests from Phases 2/4/6.
3. **Build**: `npm run build-and-sync` per CLAUDE.md (build, sync to marketplace, restart worker) completes.
4. **End-to-end sandbox install** (scratchpad `HOME`, mock `CMEM_PRO_ORIGIN`): full interactive run through banner → install → login → provider (`cmem`) → worker healthy; then a second run with login skipped → provider (`claude`) → worker healthy.
5. **Non-interactive matrix**: `--provider claude`, `--provider openrouter`, `CI=1` — no prompts, no network to cmem.ai, correct settings.
6. Confirm telemetry events (`install_completed` fields `install.ts:2395-2407`) unchanged in shape.

---

## Execution notes for /do

- Phases are strictly ordered; 1 and 2 are independent of each other but both precede 3.
- Phase 3 must land as a compiling, shippable reorder BEFORE 4–5 rewrite the moved blocks.
- All temporary scripts/mock servers go in the session scratchpad directory, never `/tmp`.
- No try/catch additions during Phases 1–6 except where the plan names an existing fail-soft helper; hardening beyond that is out of scope.
- Commit per phase on this branch (`almondine-detective`); PR to `main` after Phase 8.
