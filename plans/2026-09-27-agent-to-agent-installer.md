# Agent-to-agent installer: phased plan

Status: **Built** (Sep 28, 2026) on branch `feat/agent-installer`. Server work: claude-mem-pro #238 (Phase 1: new sources, post-expiry check), #242 (Phase 2: advisor endpoints, migration 0063), #244 (Phase 3: promotion cron, stacked on #242).
Written Sun Sep 27, 2026. Branch: `plan/installer-opus`.

**Still open after the build** (see Open questions):
- Q1: whether Claude Code shows a SessionStart `systemMessage` to the person still needs a hand check. `additionalContext` works either way.
- Q3: the npm `bun` fallback is verified on Linux x64 only (glibc; the musl build is probed and skipped). macOS, Linux arm64 and Windows still need a CI job.
- Q4: whether a committed `docs/public/llms.txt` overrides Mintlify's generated one needs a check on the preview deploy.
- Q6: the OpenRouter key's daily limit, and running `npm run eval:installer-advisor` with that key before `INSTALLER_ADVISOR_MODE=on`.

**Goal:** get emails from installs of `npx claude-mem install` that an AI agent runs.

**Sources** (all under `/workspace/installer-plan-opus/`):
- `install-patterns-REPORT.md` (called "patterns" below)
- `hybrid-installer-REPORT.md` ("hybrid")
- `funnel-REPORT.md` ("funnel")
- `ADDENDUM.md`, which holds Alex's final framing and wins wherever the reports disagree.

Every number below comes from one of these reports or from the code. Where I don't know something, I say so.

---

## 0. The problem in numbers (all cited)

- **About 330 installs a day end with no email.** These are agent-run installs that skip sign-in (funnel §G, quoting FINDINGS.md §1).
- **The deferred link from 13.28.0 (PR #4235) barely converts.** Sep 26: 231 links, 2 sign-ins (0.9%). Sep 27, partial day: 439 links, 7 sign-ins (1.6%). Normal interactive links finish about 75% of the time (funnel §G).
- **Agents loop on `bun-missing-after-install`.** Over 14 days, 313 non-interactive users produced 19,888 of these failures, about 64 each (hybrid, PostHog table).
- **`unknown-install-error` in non-interactive installs:** 17,277 events from 4,799 users over Sep 13–26 (hybrid). The hybrid report ties most of this to the old "provider must be explicit" abort. Those days are almost all before 13.28.0 shipped on Sep 26 at 11:42 AM (funnel §G).
- **What a 10-point gain is worth:** about 33 more emails a day (hybrid §3).
- **Why emails matter:** email → trial is 11.3% (Sep 20–26), and doubling capture is the most direct lever toward 60 trials a day (funnel §D, §E).

## 1. What the code does today (13.28.0, this repo)

| Behavior | Where |
|---|---|
| The agent check is a TTY check: `isInteractive = process.stdin.isTTY === true` | `src/npx-cli/commands/install.ts:58` |
| A browser helper already exists (`open` / `cmd /c start` / `xdg-open`) | `install.ts:1054` `openBrowser()` |
| The deferred sign-in link never opens a browser and never polls. It prints "Optional: …", the link, and the `AGENT:` line | `install.ts:1842-1867` `offerDeferredLogin()` |
| The deferred link is printed after "installed successfully!" | `install.ts:2619-2628` |
| **A missing `--provider` no longer aborts.** A fresh config defaults to `claude`; a saved config keeps its provider | `install.ts:2035-2086` `validateNonInteractiveProvider()` |
| Text that still names only `--provider claude` (the route that skips sign-in): (a) the taxonomy remediation; (b) the credentials remediation; (c) the "defaulting to your Anthropic plan" log line and the "Skipping claude-mem login" reason; (d) the help line | (a) `install/error-taxonomy.ts:161-165`; (b) `install.ts:2072-2074`; (c) `install.ts:2085` and `install.ts:2392-2397`; (d) `src/npx-cli/index.ts:27` |
| The error table: 14 categories, first match wins | `src/npx-cli/install/error-taxonomy.ts` |
| Bun setup. It already checks the usual install locations (`~/.bun/bin`, brew, `/usr/local/bin` …) | `install/setup-runtime.ts:65` `bunCommonPaths()`, `:184` `runBunInstaller()`, `:332` `ensureBun()` |
| An abort writes `last-install-error.json` | `install/error-reporter.ts:98` |
| Telemetry sends one event with a 2s timeout and never throws. An allowlist scrubber drops unknown keys | `src/services/telemetry/cli-telemetry.ts`, `src/services/telemetry/scrub.ts:10` `ALLOWED_PROPERTY_KEYS` |
| An error-text scrubber exists (home dir, caps, redaction) | `src/services/telemetry/error-scrub.ts` |
| A random anonymous install ID exists | `src/services/telemetry/consent.ts:134` `getOrCreateInstallId()` |
| The SessionStart hook sends `additionalContext` to the model and `systemMessage` to the user, and already shows one-time notices using a marker file | `src/cli/handlers/context.ts:1-3`, `:89-115` |
| There is **no** `login` command | `src/npx-cli/index.ts:121-250` |
| **Server (claude-mem-pro):** only `npx-installer` and `npx-installer-deferred` are accepted as sources; anything else is stored as `npx-installer`. Pairings live 30 minutes | `src/app/api/installer/oauth/start/route.ts:33,45` |
| **Server:** the poll endpoint returns `410 expired` once `expires_at` passes, **even if the user already signed in** | `src/app/api/pro/trial/poll/route.ts:156-157` |

**Correction to the brief.** The "provider must be explicit" abort is already gone in 13.28.0. The work that remains for that item is rewording the four places above that still point agents only at `--provider claude`. Older clients cached by npx will keep printing the old text, and only the docs can reach those (§1.9).

## Ground rules (from ADDENDUM and the reports)

1. **Our model never runs commands on the user's machine.** It returns steps and allowlisted fix ids. The user's own agent runs them, under its own permission rules.
2. **"Your agent works with my agent."** We ask the user's agent for a small snapshot and tell it to follow its own security rules and ask its human if it needs to. We never demand.
3. **Command output states facts; docs give instructions.** Railway removed directive "ask the user" output because agents flagged it as prompt injection (patterns #5, Railway PR #919).
4. **The npm package never contains an OpenRouter key and never has a postinstall step** (hybrid §5, s1ngularity).
5. **Phase 1 uses no LLM.**

---

## Phase 1: ship first, no LLM (claude-mem repo, plus one small claude-mem-pro PR)

### 1.1 Open the browser for the deferred sign-in on desktop machines

- **What.** In `offerDeferredLogin()`, when a desktop is present, call `openBrowser(pairing.authorizationUrl)` after printing the link, and print "A sign-in page opened in your browser."
- **Desktop means** all of the following:
  - the platform is `darwin` or `win32`, or it's Linux with `DISPLAY` or `WAYLAND_DISPLAY` set;
  - `CI` is not set;
  - neither `SSH_CONNECTION` nor `SSH_TTY` is set.

  Under WSL, skip auto-open for v1. `xdg-open` is unreliable there, and I haven't verified a WSL opener.
- **Limits.**
  - `--no-browser` flag, plus `CLAUDE_MEM_NO_BROWSER=1`.
  - At most one auto-opened tab per install ID, ever. A marker file `signin-browser-opened` in the data dir enforces this (hybrid §3).
  - Never wait for the sign-in and never change the exit status.
- **A/B split** (hybrid §3), assigned by hash of `getOrCreateInstallId()`:
  - **A:** today's deferred link.
  - **B:** browser auto-open.
  - **C:** auto-open plus the SessionStart reminder (§1.8).
- **How the arm is measured.** Each arm gets its own pairing `source`, so the arm shows up in Supabase `cli_pairings` even with telemetry off: `npx-installer-deferred` (A), `npx-installer-deferred-open` (B and C).
- **Files.**
  - `src/npx-cli/commands/install.ts`: `offerDeferredLogin`, flag plumbing.
  - `src/npx-cli/index.ts`: parse `--no-browser`.
  - A new `src/npx-cli/install/desktop-detect.ts`, a pure function of `(platform, env)`.
  - A new `src/npx-cli/install/signin-arm.ts`, which maps the install-ID hash to an arm.
- **Tests.**
  - `tests/npx-cli/desktop-detect.test.ts`: a table test over platform and env combinations.
  - `signin-arm.test.ts`: a fixed ID always gets the same arm, and the arms split roughly evenly over 10k IDs.
  - Extend `tests/install-non-tty.test.ts`:
    - with `--no-browser`, the opener is never called;
    - on a second run, the marker stops a second tab;
    - under CI, nothing opens.
- **claude-mem-pro (must merge and deploy BEFORE the claude-mem release).** Add the new sources to `INSTALLER_OAUTH_SOURCES` in `src/app/api/installer/oauth/start/route.ts`: `npx-installer-deferred-open`, `npx-login-request`, `npx-session-reminder`. Funnel §G logged a one-hour window where 13.28.0 was live but the server refused its source. This ordering prevents a repeat.

### 1.2 The `CLAUDE_MEM_RESULT` line at the end of every run

- **What.** The last line on stdout is one line: `CLAUDE_MEM_RESULT {json}`. It is printed for install, update, repair, and `login` in every outcome: ok, partial, aborted.
- **Schema v1.** Keys only from this list:
  ```json
  {"v":1,"command":"install","status":"ok|partial|failed","version":"13.29.0",
   "failed_step":null,"error_category":null,"fix_tried":null,
   "attempt_n":1,"retry_same_command":true,"next_command":null,
   "human_action_required":"sign-in"|null,
   "signin":{"status":"pending","url":"https://cmem.ai/…","expires_in":1800,
             "check_command":"npx claude-mem login --check",
             "renew_command":"npx claude-mem login --request"}}
  ```
- **The pairing secret is never printed.** It goes into `<dataDir>/pending-signin.json` with mode 0600, so `check_command` needs no arguments.
- **Files.**
  - A new `src/npx-cli/install/result-line.ts`, which builds and prints the line.
  - `install.ts`: the success path at about `:2612-2629`, the abort path in `runInstallCommand` at `:2110-2135`, and repair at `:2715`.
- **Tests.** A new `tests/npx-cli/result-line.test.ts`:
  - the line always parses as JSON;
  - no key outside the schema appears;
  - it contains no `secret`, home path or email.

  Also extend `tests/install-error-matrix.test.ts`: every ABORT category produces `status:"failed"` and a non-null `error_category`.

### 1.3 Stop steering agents away from sign-in

- **What.** Reword the four places listed in §1 so both choices appear and it's clear which one needs the person. Base the copy on patterns §4d:
  ```
  No --provider given: memory will run on the user's own Anthropic plan (no account).
  Sign-in is separate and needs the person (free): npx claude-mem login --request
  ```
  Apply the same pattern to the `provider-selection-non-interactive` remediation, the credentials remediation, and the help line.
- **Files.** `install/error-taxonomy.ts`, `install.ts` (the lines listed in §1), `index.ts:27`.
- **Tests.** Snapshot the remediation strings in `tests/install-error-matrix.test.ts`. Add an assertion that no remediation mentions `--provider claude` unless it also mentions `login --request`.

### 1.4 Replace the `AGENT:` directive with facts

- **What.** Replace `install.ts:1864-1866` with the fact-shaped block from patterns §4c. No line addresses "AGENT:" and nothing gives orders:
  ```
  claude-mem installed successfully!

  Sign-in not finished. The user needs to open this link to finish claude-mem
  setup (free; turns on cloud sync and the 30-day CMEM Pro trial offer).
    Link:  https://cmem.ai/…   (valid 30 min)
    Check: npx claude-mem login --check
    New link later: npx claude-mem login --request
  ```
  Arms B and C add "A sign-in page opened in your browser."
- **Copy check before shipping.** Every benefit claim must match what the README and cmem.ai say at ship time. Patterns #7 quotes the README's "free for your first 30 days … no card required". Recheck it, and don't overpromise: a login-only sign-in gives an account and an email, not cloud sync by itself (see Open questions).
- **Tests.**
  - `tests/install-non-tty.test.ts` asserts that the old `AGENT:` string is gone.
  - It also asserts that the `CLAUDE_MEM_RESULT` line comes after the block.

### 1.5 `claude-mem login --request` / `--check` / `--dismiss`

- **What.** A new command that exits straight away, following Netlify, Stripe and Neon (patterns #2).
  - **`--request [--json]`**
    - Makes a **fresh** pairing every time, with source `npx-login-request`.
    - Writes `pending-signin.json`.
    - Prints the link, the expiry and `check_command`, then the `CLAUDE_MEM_RESULT` line.
    - With `--json`, it prints `url`, `expires_in`, `check_command`, `for_the_user` and `agent_next_steps` (patterns #2 shape).
    - Opens the browser only under the same desktop rule and arm as §1.1, and honors `--no-browser`.
  - **`--check [--json]`**
    - Polls once using the saved pairing.
    - Prints one of `signed_in`, `pending`, `expired`, `none`.
    - On `signed_in`, sets `signin-state.json` to `claimed`.
    - On `expired`, it points to `--request`.
  - **`--dismiss`** sets the state to `dismissed`, which stops the reminder in §1.8.
- **Files.**
  - A new `src/npx-cli/commands/login.ts`.
  - A new `src/npx-cli/install/signin-state.ts`, which reads and writes `pending-signin.json` and `signin-state.json` (states `unclaimed`, `claimed`, `dismissed`).
  - `index.ts`: add the `login` case and a help line.
  - `install.ts`: export `pollInstallerPairingOnce`. `offerDeferredLogin` writes the state file too.
- **Tests.** A new `tests/npx-cli/login-command.test.ts`, with fetch mocked:
  - every poll outcome maps to the right status;
  - `--request` makes a new pairing on each call;
  - the secret never appears on stdout;
  - `--dismiss` is respected.
- **claude-mem-pro.** Today the poll returns 410 after the 30-minute TTL, even for a user who already signed in (`poll/route.ts:156`). Change it so that a login-only pairing that reached `authenticated` still answers `{status:"authenticated"}` after expiry, for 30 days. Without that, `--check` can't confirm a sign-in the next day. It stays read-only, and no credentials are delivered after expiry.

### 1.6 Scripted bun fix and a retry guard

- **What we know.** `ensureBun()` already checks the common install locations, so a PATH problem alone doesn't explain the 313 looping users. Most likely `runBunInstaller()` itself fails: `curl | bash` or PowerShell. I don't know the exact sub-causes, so step 1 is to measure them.
  1. **Classify the failure.** Add `bun_fail_reason` as a closed list, parsed from `describeExecError` output: `curl-missing`, `unzip-missing`, `network`, `tls`, `permission`, `powershell-policy`, `binary-not-found`, `other`. Send it on `install_failed`. Nothing free-text leaves the machine.
  2. **Fallback fix `fix.bun.npm-package`.** If the official script fails, install the `bun` npm package into `<dataDir>/runtime` with the npm that is already running npx, then resolve the binary from there. Node is always present in this path because npx is running.
     - **Open question:** the npm `bun` package still needs to be checked on macOS, Linux x64/arm64 and Windows. Add a CI job before relying on it.
  3. **Retry guard.** `<dataDir>/install-attempts.json` holds `{category: {count, first_at, last_at}}`. On the second failure in the same category within 24 hours:
     - skip the step that is failing again;
     - print "Same failure as last run (bun-missing-after-install). Re-running will not fix it. Manual fix: <platform command>";
     - set `retry_same_command:false`, `next_command` and `attempt_n` in the result line.

     A success clears the entry.
- **Files.** `install/setup-runtime.ts` (`installBun` and `ensureBun`), `install/error-taxonomy.ts` (add `fixId` to the category shape), a new `install/attempt-guard.ts`, `install.ts` (abort path).
- **Tests.**
  - Extend `tests/install-error-matrix.test.ts` with each `bun_fail_reason` stderr fixture mapping to its reason.
  - A new `tests/npx-cli/attempt-guard.test.ts` covering: the second failure is flagged, the counter resets after 24 hours, and success clears it.
  - A setup-runtime test in which a failed script leads to the npm fallback being tried, with the child process mocked.

### 1.7 `install_step` telemetry event

- **What.** One event per step, with closed lists only (hybrid §2):
  - `step_id`: `detect`, `bun.ensure`, `uv.ensure`, `marketplace.copy`, `marketplace.deps`, `plugin.register`, `ide.<id>`, `provider`, `worker.start`, `signin`;
  - `outcome` (`ok` / `error` / `skipped`), `duration_ms`, `error_category`;
  - `fix_id`, `fix_outcome`, `attempt_n`;
  - `agent_context`: `claude-code`, `cursor`, `codex`, `unknown-non-tty`, `tty`, from env markers only (`CLAUDECODE`, `CURSOR_AGENT`, `CODEX_SANDBOX`, `AI_AGENT`, per patterns #5);
  - `signin_arm` (`A`/`B`/`C`), `browser_open` (`opened`, `skipped-no-desktop`, `skipped-flag`, `skipped-marker`, `failed`), `bun_fail_reason`.
- **Files.**
  - `install.ts`: wrap `runTasks` titles with step ids and emit per task.
  - `services/telemetry/scrub.ts`: add the keys to `ALLOWED_PROPERTY_KEYS`.
  - `npx-cli/commands/telemetry.ts`: update the `COLLECTED_FIELDS` list.
  - `docs/public/telemetry.mdx`: document the new fields.
- **Tests.**
  - Extend `tests/npx-cli/telemetry-scrub-installer-keys.test.ts` (new keys pass, free text dropped).
  - Add a test that each step emits exactly one event, run with `CLAUDE_MEM_TELEMETRY_DEBUG=1`.

### 1.8 SessionStart reminder while the install is unclaimed

- **What.** While `signin-state.json` says `unclaimed`, and the install is in arm C, show the reminder at most once per session.
  - **The human sees** (`systemMessage`): `claude-mem: sign-in not finished (free). Link, valid 30 min: <fresh url>`.
  - **The agent's context gets** (`additionalContext`): `claude-mem sign-in is not finished for this install. The user can finish it here (valid 30 min): <url>. New link: npx claude-mem login --request.`
- **A fresh link each time.** The context handler asks the worker, since the hook must stay fast. The worker:
  1. first checks the previous pending pairing; if it's `authenticated`, it marks the install `claimed` and shows nothing;
  2. otherwise starts a new pairing (source `npx-session-reminder`) with a 3s timeout.

  Any failure means no reminder, never an error.
- **Stops when** the install is claimed or dismissed. Only installs that went through `offerDeferredLogin` are ever `unclaimed`, so existing users are never nagged.
- **Files.**
  - `src/cli/handlers/context.ts` (next to the fallback notice at `:100-115`).
  - A new worker route next to the existing routes in `src/services/worker/http/routes/`, `GET /api/signin/reminder?session_id=`.
  - `signin-state.ts` from §1.5.
  - A session marker file in the data dir, like the existing Pro fallback marker.
- **Tests.**
  - A context-handler test: the reminder is shown once per session ID, never when claimed or dismissed, and never outside arm C.
  - A worker route test with the pairing start mocked (timeout leads to an empty reply).
- **Unverified.** Does Claude Code actually show `systemMessage` to the person on SessionStart? The hybrid and patterns reports disagree (hybrid §3 item 3, patterns #1). Check it by hand in Claude Code before the read-out. `additionalContext` works either way.

### 1.9 "Instructions for AI agents" in the README and llms.txt

- **What.** Adapt patterns §4a and §4b, with these changes:
  - sign-in is offered **before** installing;
  - `login --request` / `--check` are named;
  - the `CLAUDE_MEM_RESULT` line is explained;
  - "Do not retry the same command after `retry_same_command:false`" is added.

  Phase 2 later adds the snapshot paragraph (§2.7).
- **Files.**
  - `README.md`, a new section right under `## Quick Start` (line 135).
  - `docs/public/installation.mdx`.
  - A new `docs/public/llms.txt`. Mintlify generates an llms.txt, so check on the preview deploy that a committed file overrides it.
- **Tests.** None in code. Check the preview deploy by hand, and check that `https://docs.claude-mem.ai/llms.txt` shows the section after the merge.

### Phase 1: measurement

- **Primary:** emails ÷ agent-run installs, per arm, at 24 hours and at 7 days (hybrid §3).
  - Numerator: Supabase `cli_pairings` signed in, split by `source`.
  - Denominator: PostHog `install_completed` with `interactive=false`. That only counts installs with telemetry on, so use it as a rate, not a count.
- **Baselines to beat:** 0.9% (Sep 26) and 1.6% (Sep 27, partial) for deferred links. About 75% for interactive links (funnel §G).
- **Report deferred pairings on their own line** in every funnel number, as funnel §G asks, so new sources don't make pairing → trial look worse.
- **Also track:**
  - `bun-missing-after-install` events per user (baseline about 64, hybrid);
  - the share of non-interactive installs that complete;
  - `login --request` use per day;
  - reminders shown vs. signed in;
  - `browser_open` outcomes.
- **Guardrail:** watch GitHub issues and support mail for "unexpected browser tab" complaints.

### Phase 1: rollout

1. Merge the claude-mem-pro PR first (new sources, and poll-after-expiry for authenticated login-only pairings). Deploy it and check it with `scripts/test-installer-oauth-start-route.ts`.
2. Release claude-mem with all of 1.1–1.9, running arms A/B/C at 1/3 each.
3. Read out after 7 full days, with weekdays and weekends kept apart (funnel house rule: full days only). Ship the winner to 100% in the next patch.
4. **Kill switches:**
   - `CLAUDE_MEM_NO_BROWSER=1` locally;
   - a patch release that pins everyone to arm A;
   - the reminder can be turned off with `CLAUDE_MEM_SIGNIN_REMINDER=false` in settings.

---

## Phase 2: the agent-to-agent endpoint (mostly claude-mem-pro)

**The pitch (ADDENDUM):** "bespoke install, because our agent knows Claude-Mem and your agent knows your machine."

### 2.1 How it flows

1. The user's agent reads our instructions (README, llms.txt, installer output). It builds a snapshot, following its own security rules.
2. It runs `npx claude-mem advisor plan --snapshot -` with the snapshot JSON on stdin. The CLI validates and redacts the snapshot locally, **prints exactly what it will send**, and posts it to `cmem.ai/api/installer/plan`.
3. Our server-side Claude-Mem agent returns steps for that setup. The CLI prints them, then a `CLAUDE_MEM_RESULT` line. The user's agent runs the steps.
4. If a step fails, the agent runs `npx claude-mem advisor fix`. It reads the last `CLAUDE_MEM_RESULT` and `last-install-error.json`, redacts them, and posts to `/api/installer/fix`. Back comes a fix id plus steps.
5. `npx claude-mem fix <fix_id>` runs **only fix code that ships inside the signed npm package** (hybrid §5, `curl | sh` row). The server can't add new actions.

**Path 2 (ADDENDUM 12:26) for human TTY runs** uses the same backend. The installer offers "Get a setup plan from the Claude-Mem agent?" If the person says yes, the snapshot is collected by **our code** (the §2.2 fields, no LLM) and sent. Our model still never runs anything.

Why go through the CLI and not a raw API? Redaction happens on the user's machine before anything is sent, and the agent doesn't have to write HTTP calls by hand. The HTTP API is still documented in llms.txt for agents that prefer it, and the server re-runs redaction either way.

### 2.2 Snapshot schema v1 and redaction rules

**Allowed fields only.** The server drops unknown keys, the same pattern as `scrub.ts`.

```json
{"v":1,
 "os":{"platform":"darwin|linux|win32","release_major":"24","arch":"arm64|x64","is_wsl":false},
 "shell":"bash|zsh|fish|pwsh|powershell|cmd|other",
 "node":"22.11.0","npm":"10.9.0","bun":"1.3.1|null","uv":"0.9.2|null",
 "ai_tools":[{"id":"claude-code","version":"2.1.3"},{"id":"cursor","version":null}],
 "agent_host":"claude-code|cursor|codex|windsurf|other|none",
 "tty":false,"desktop":true,"ci":false,
 "claude_mem":{"installed_version":"13.28.0|null","provider":"claude|openrouter|gemini|host|null"},
 "install_id":"<anonymous uuid>",
 "shared_by":"agent|human","human_asked":true}
```

**Redaction rules**, enforced in both the CLI and the server:
- `ai_tools[].id` must come from the IDE ids in `commands/ide-detection.ts`. Anything else becomes `other`.
- Version strings must match `^[0-9A-Za-z.+-]{1,32}$`. Anything else becomes `null`.
- **No paths.** Reject any value that contains `/`, `\`, `~` or `:` outside the enums.
- No hostnames, usernames, emails, env var values or file contents. There is no free-text field in `plan` at all.
- **`fix` only:** at most 40 lines or 4 KB of error text, passed through `error-scrub.ts` (home dir, tokens, emails). The server scrubs it again. If a token or email pattern is still there, the server rejects the request (400), and nothing is stored.
- `install_id` is the existing anonymous telemetry ID. We don't join it to an email on the server.

### 2.3 Endpoints (claude-mem-pro)

**`POST /api/installer/plan`** takes a snapshot and returns:

```json
{"advice_id":"…","source":"rules|cache|model",
 "steps":[{"id":"signin.offer","human_action_required":"sign-in",
           "for_the_user":"…","command":"npx claude-mem login --request"},
          {"id":"install","command":"npx claude-mem install --provider claude --ide claude-code"},
          {"id":"fix.bun.npm-package","when":"bun missing","command":"npx claude-mem fix fix.bun.npm-package"}],
 "notes":"plain-English advice, never executed"}
```

**`POST /api/installer/fix`** takes `{snapshot, failed_step, error_category, error_snippet}` and returns `{advice_id, source, fix_id|null, steps, notes}`.

**`POST /api/installer/outcome`** takes `{advice_id, step_id, outcome}`. It is sent by `claude-mem fix` and by the installer when a run follows an advice. Phase 3 depends on it.

**Allowlisted output.** Every `command` must be `npx claude-mem <subcommand>` with flags from a fixed list, or `npx claude-mem fix <id>` with `<id>` in the fix catalog. The server checks the model's output against the catalog. Anything that fails is dropped into `notes` as text, or the whole answer falls back to the rules answer.

**Sign-in comes first.** Every plan puts `signin.offer` first, following Vercel, Neon and Clerk (patterns #3). That moves the question to before the install, while the person is still watching.

**Files (claude-mem-pro):**
- `src/app/api/installer/plan/route.ts`
- `src/app/api/installer/fix/route.ts`
- `src/app/api/installer/outcome/route.ts`
- `src/lib/installer-advisor/`:
  - `schema.ts`, `redact.ts`
  - `fix-catalog.ts`, generated from claude-mem's `error-taxonomy.ts` fix ids at build time, or copied with a version check
  - `rules.ts`, `cache.ts`, `advisor.ts` (the OpenRouter call)
  - `memory.ts` (save and search)
  - `limits.ts` (kill switch)
- A drizzle migration `drizzle/00xx_installer_advice.sql`.

**Files (claude-mem):**
- `src/npx-cli/commands/advisor.ts` (`plan` and `fix`)
- `src/npx-cli/commands/fix.ts` (`fix <id>`)
- `src/npx-cli/install/fix-catalog.ts`, with one function per fix id that the package ships
- `src/npx-cli/install/snapshot.ts` (collect and redact)
- `index.ts`

### 2.4 The answer cache

**Order of answers:** rules, then cache, then Claude-Mem search as context, then the model.

**Keys:**
- Plan answers are keyed by `setup signature = hash(platform, release_major, arch, is_wsl, shell, node major, agent_host, sorted ai_tool ids + major versions, claude-mem minor)`.
- Fix answers are keyed by `setup signature + step_id + error_category + error signature`. The error signature is a hash of the scrubbed snippet after numbers, hashes and versions are normalized away.

**Table `installer_advice`:**
- `key`, `kind` (`plan` or `fix`), the signature fields in plain columns so they can be queried;
- `response` jsonb, `source`, `model`;
- `hits`, `ok_count`, `fail_count`;
- `status` (`live`, `promoted`, `blocked`);
- `created_at`, `last_hit_at`.

**Invalidation.** Entries are tied to the claude-mem minor version, so a new release starts cold for the parts of the key that changed. An admin can mark an entry `blocked`.

### 2.5 Saving answers into Claude-Mem

- Every answer from `model` is written as an observation into a Claude-Mem cloud project we own, `installer-agent`, under a house account. Cache hits only bump their counts. Outcomes are attached later.
- **What's stored:** the redacted signature fields, the error category and signature, the fix id, the steps and the outcome counts. Nothing else.
- **Before calling the model**, the advisor searches that project for the top 5 similar past installs, using the existing cloud read surface: `hybridSearch` in `src/lib/cloud/queries`, already used by `src/lib/what/memory.ts`. Those results go into the prompt. This is how the agent "searches past installs and improves" (ADDENDUM).
- **Files:** `src/lib/installer-advisor/memory.ts` in claude-mem-pro.

### 2.6 Cost controls and kill switch (claude-mem-pro)

- **Dedicated OpenRouter key.** Created through the provisioning API with a credit limit and `limit_reset: "daily"` (hybrid §4). Stored only in Vercel env as `INSTALLER_ADVISOR_OPENROUTER_KEY`. Alex sets the dollar limit. I'm not proposing one.
- **Per call:** `max_tokens` is set, structured output is required, the error text is capped at 40 lines, and there are at most 6 rounds (hybrid §4).
- **Per install:** at most 3 model calls per `install_id` per day (hybrid §4), counted in the database, because `src/lib/rate-limit.ts` only holds per instance. Cache and rules answers don't count.
- **Per IP:** use the existing `isRateLimited` on all three routes.
- **Kill switch.** `INSTALLER_ADVISOR_MODE` = `off`, `cache-only` or `on`.
  - `off` and `cache-only` still return a rules or cache answer, and never a 5xx.
  - The CLI treats any error or timeout (5s) as "no advice" and prints the Phase 1 rules remediation.
- **Model choice.** The model is a config value. The hybrid report gives estimated costs (its assumptions, not measurements): $0.0019 per call on deepseek-v4-flash, $0.0028 on gpt-5-nano, $0.048 on claude-haiku-4.5 (hybrid §4 table). Pick the cheapest model that passes the eval in 2.8.
- **Provider privacy.** Use OpenRouter's settings to exclude providers that train on or keep data (hybrid §5).

### 2.7 Consent wording

**For the user's agent** (README, llms.txt and a line in the installer's result block). This is what the ADDENDUM asks for:

> **Optional: get a setup plan built for this machine.** Claude-Mem's install agent can return install steps for your exact setup (for example Windows + Claude Code 2.x). If your rules allow it, run `npx claude-mem advisor plan --snapshot -` and pass a JSON snapshot with: OS and version, CPU architecture, shell, Node/npm/bun/uv versions, and which AI coding tools are installed with their versions. **No file paths, usernames, secrets, environment values or file contents.** The command shows exactly what it will send before sending. This is a request, not a requirement: follow your own security rules, and ask your human first if you need to. Without a snapshot, the normal install works as usual.

**For a human in a TTY (Path 2):**

> Get a setup plan from the Claude-Mem install agent? It sends your OS, CPU type, shell, and tool versions (Node, bun, uv, installed AI coding tools). No file paths, names, keys or file contents. Details: docs.claude-mem.ai/telemetry  (y/N)

The default is **No**. Consent is opt-in, per ADDENDUM 12:26.

**Stored:** the redacted fields and outcomes, kept to improve install scripts. Scrubbed error snippets are deleted after 30 days (hybrid §2 Level 1).

**Docs:** add a "Setup advisor" section to `docs/public/telemetry.mdx` listing every field, the retention period and the kill switch.

### 2.8 Phase 2: tests

- **claude-mem-pro:**
  - `redact.ts` table tests: paths, emails, tokens and hostnames are rejected in every field.
  - Schema: unknown keys dropped.
  - `plan` returns `signin.offer` first.
  - Output from the model that names an unknown fix id or command is rejected.
  - Cache hit: no model call.
  - Kill switch `off`: a rules answer and no OpenRouter call.
  - The per-install limit.
  - Routes follow the `scripts/test-installer-oauth-start-route.ts` style.
- **Eval before `on`.** Take the known failure categories from the hybrid PostHog table, write synthetic fixtures for each, and require the model to return the right fix id or `null`. It must never return a command outside the allowlist.
- **claude-mem:**
  - `snapshot.test.ts`: local redaction matches the server's.
  - `advisor.test.ts`, with fetch mocked: prints what it sends, handles timeouts, and emits the result line.
  - `fix.test.ts`: an unknown id is refused, and known ids call the packaged function.

### 2.9 Phase 2: measurement

- `plan` and `fix` calls per day, split by `source` (rules, cache, model).
- Cache hit rate.
- Model spend per day against the daily limit.
- Fix success rate from `/outcome`, by source.
- Completion rate for installs that followed a plan vs. those that didn't.
- **Emails ÷ agent-run installs, for installs that asked for a plan vs. those that didn't.** This is the question that matters, since plans put sign-in first.

### 2.10 Phase 2: rollout

1. Deploy claude-mem-pro with `INSTALLER_ADVISOR_MODE=cache-only`. Rules only, no model spend.
2. Ship the claude-mem `advisor` and `fix` commands. Add the consent paragraph to the docs.
3. Run the eval. Switch to `on` with the daily limit set.
4. Review spend and outcomes after 7 full days.
5. Turn on the Path 2 TTY offer last.

---

## Phase 3: weekly promotion of advisor fixes into scripted rules

- **What.** A weekly cron in claude-mem-pro (`src/app/api/cron/installer-promote/route.ts`, plus an entry in `vercel.json`) groups `installer_advice` of kind `fix` by `(step_id, error_category, error signature, platform)`.
  - A group becomes a **candidate** at ≥20 successes and a ≥90% success rate. These are the hybrid report's starting thresholds (§2) and can be tuned.
  - The job opens **one** GitHub issue in claude-mem per week listing the candidates: fix id, signature, counts, and an example scrubbed snippet.
- **A person writes the rule.** They add a taxonomy match and a test fixture in `install/error-taxonomy.ts` and `tests/install-error-matrix.test.ts`, and ship it in the next patch.
- **After the release,** the entry is marked `promoted`, so the server answers from rules and stops calling the model.
- **Auto-block.** Groups with at least 20 uses and a success rate below 50% are marked `blocked`. They go back to "unknown", and the model is told not to suggest them again for that signature.
- **Measure:**
  - the scripted share vs. the advisor share of fixes (should rise, hybrid §2);
  - model calls per week (should fall);
  - time from candidate to shipped rule.
- **Tests (claude-mem-pro).** Fixture tables → expected candidates and blocks. The issue body contains no snippet that fails a re-scrub.

---

## Which repo owns what

| Item | claude-mem | claude-mem-pro |
|---|---|---|
| 1.1 Browser open + A/B | ✔ | New sources in `INSTALLER_OAUTH_SOURCES` (**ships first**) |
| 1.2 Result line, 1.3 copy, 1.4 fact block | ✔ | |
| 1.5 `login --request/--check/--dismiss` | ✔ | Poll answers `authenticated` after expiry for login-only pairings |
| 1.6 Bun fix + retry guard, 1.7 `install_step` | ✔ | |
| 1.8 SessionStart reminder | ✔ | (uses the 1.1 source) |
| 1.9 README / llms.txt / installation.mdx | ✔ | |
| 2.x CLI `advisor`, `fix`, snapshot, fix catalog | ✔ | |
| 2.x Endpoints, redaction, cache, memory, limits, kill switch | | ✔ |
| 3 Weekly promotion job | Rules land here | ✔ cron + issue |

## Out of scope for this plan

- **An on-machine agent or `doctor --ai`.** Our model never runs commands (ADDENDUM, hybrid §1).
- **The "interactive onboarding guide"** (ADDENDUM 12:23): first memory, first search, then the trial offer. It can sit on top of Phase 2 later. It is not planned here.

## Open questions (not settled by the reports or the code)

1. Does Claude Code show a SessionStart `systemMessage` to the person? Test by hand (§1.8).
2. After a **login-only** sign-in, how does an agent-run install get cloud sync or the trial on the machine? Today that only happens through the interactive `cmem` provider path. Needed so the copy doesn't overpromise.
3. Does the npm `bun` package work on every platform we support (§1.6)?
4. Does a committed `docs/public/llms.txt` override Mintlify's generated one?
5. What share of deferred links go to headless runs where no human reads the output (patterns §3 item 6)? `agent_context` in 1.7 starts to answer this.
6. What daily dollar limit on the OpenRouter key? This is Alex's call.
