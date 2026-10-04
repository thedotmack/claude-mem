# Agent-to-agent installer

**Status:** plan only. House rule: plan, then Alex approves, then build. Do not implement from this file until that approval.

**Pitch (Alex, Sep 27 2:34pm PT, final):** "Your agent works with my agent." Our install instructions ask the user's coding agent for a system snapshot (OS, which AI tools and versions, shell, Node). They say plainly: this is what we'd like, but defer to your own security rules; ask your human if you need to. The snapshot goes to our server-side Claude-Mem agent on cmem.ai. That agent returns install steps built for that setup. Errors go back to our agent, which returns a fix. Every answer is cached and saved into Claude-Mem, so our agent searches past installs and improves, and the cache becomes the scripted fast path. **Our model never runs commands on the user's machine.**

This addendum wins over the research reports wherever they conflict. The reports stay the source for facts, copy drafts, and file-level detail.

---

## Why this exists

The npx install is the main email capture step, and agent-run installs leak it.

- About **330 installs a day** finish with no email (FINDINGS.md via agent-install-dig and mil-report G).
- The deferred sign-in link from PR #4235 / 13.28.0 converts at **1–2%**: Sep 26 had 231 deferred links and 2 sign-ins (0.9%); Sep 27 so far had 439 and 7 (1.6%). Normal interactive links finish about **75%** of the time (mil-report G).
- Interactive 75% is an **upper bound, not a forecast**. Those users were at a terminal and pressed Return (agent-installer-idea §3).
- From Sep 20–26 (full days), emails averaged 265.4/day, pairings 501.0/day, trials 30.0/day, email → trial 11.3% (mil-report F). Reaching the $1M goalpost math in mil-report D needs about **60 trials a day**, which is either ~2× email → trial or ~2× emails. Turning the 330-a-day leak into emails is the most direct capture lever (mil-report E).
- Count deferred pairings on their **own line**. Including them on Sep 26 made pairing → trial look like 3.9% instead of 6.0% (mil-report G).

The leak is not a model problem. The installer prints into an agent's Bash tool; the agent summarizes after "claude-mem installed successfully!"; the line starts with "Optional"; the link dies in 30 minutes; and older error text steered agents to `--provider claude`, which skips sign-in (agent-install-dig §3; FINDINGS.md §1: 3,508 users re-ran that way in 14 days).

A second LLM on the user's machine does not fix that, and it looks like malware to security teams (Nx s1ngularity). Phase 1 reaches the human directly. Phase 2 is the server-side partner agent. Phase 3 turns its cached answers into scripts.

---

## What already exists (13.28.0)

Checked in this repo, not invented:

- Agent detection is `process.stdin.isTTY === true` (`src/npx-cli/commands/install.ts`).
- Non-TTY fresh installs already default provider to `claude` and print a deferred login-only link (`offerDeferredLogin`). The old abort string `A provider must be explicit when stdin is not interactive.` is gone from `install.ts`, but leftover copy still steers agents to skip sign-in: taxonomy remediation, README ("Prefer to skip the sign-in? Pass an explicit `--provider` flag"), and `docs/public/installation.mdx` ("optional" / "best-effort").
- Deferred output is still the three lines ending `AGENT: show this link…`. Tests pin that string (`tests/install-non-tty.test.ts`, `tests/npx-cli/install-trial-contract.test.ts`).
- `openBrowser()` already exists (`open` / `cmd /c start` / `xdg-open`). Interactive login calls it after Return. Deferred login never does.
- Pairing start/poll already exist: `POST /api/installer/oauth/start` and `POST /api/pro/trial/poll` (`src/npx-cli/cmem-pro-costs.ts`). Server TTL is 30 minutes. There is **no** `claude-mem login` command.
- Error table already has 14 rules, including `bun-missing-after-install` (`src/npx-cli/install/error-taxonomy.ts`). `ensureBun()` auto-installs bun, then looks on PATH and `bunCommonPaths()` (`~/.bun/bin`, `$BUN_INSTALL`, etc.). It does not prepend those dirs to `PATH` for the rest of the process, and it does not tell a looping agent to stop.
- PostHog, 14 full days Sep 13–26 PT (agent-installer-idea): non-interactive `bun-missing-after-install` was **19,888 events / 313 users** (~64 each). Non-interactive `unknown-install-error` was 17,277 / 4,799 (the old provider abort, now classified). Interactive rows are undercounted because those users can refuse telemetry; do not compare the two columns directly.
- SessionStart already injects `additionalContext` and, when enabled, a `systemMessage` (`src/cli/handlers/context.ts`). The welcome-hint / Pro line already uses this channel. Cursor has no SessionStart equivalent (`cursor-hooks/PARITY.md`). Whether Claude Code shows `systemMessage` on SessionStart was **not confirmed** (agent-installer-idea §3); test it before relying on it.
- Telemetry is opt-out, whitelist-scrubbed (`src/services/telemetry/scrub.ts`, `docs/public/telemetry.mdx`). New property keys must be added to the set or they are dropped.
- Docs site is Mintlify (`docs/public/docs.json`). Public `llms.txt` is a page list with no agent directions (agent-install-dig). There is no `llms.txt` in this repo today.

---

## Framing that must not drift

| Keep | Drop |
|---|---|
| User's agent knows the machine. Our agent knows Claude-Mem. | Our model running shell on the user's machine (default or hidden). |
| Snapshot is asked for in docs/output. User's agent follows **its** security rules and asks its human if needed. | Shipping an OpenRouter key in npm. |
| Answers are allowlisted fix ids plus steps the user's agent (or our scripted installer) may run. | Fetching shell scripts from our server at runtime. |
| Cache + Claude-Mem memory of past installs → scripted fast path. | Reporting raw shell commands back (paths, usernames, secrets). |
| Phase 1 ships with no LLM. | Waiting on Phase 2 to capture emails. |
| Claim language: install works now; sign-in turns on cloud sync and the free 30-day off-plan trial, no card. Do not hint that local memory will be lost (agent-install-dig #4). | "Optional" / `AGENT:` orders / `--provider claude` as the only fix. |

The 12:26pm "two paths, our agent installs on the machine if the human says yes" note is superseded. Path 2 for a human at a TTY stays the existing interactive installer (already ~75%). Do not build `npx claude-mem doctor --ai` unless Phase 2 shows failures the allowlist cannot cover (agent-installer-idea Phase 4). The earlier "interactive onboarding walk-through" note is also superseded; do not build a paid first-memory tour in this plan.

---

## Phase 1 — ship first, no LLM (claude-mem)

Biggest email lever. Nothing here calls OpenRouter. A small pairing-source allowlist may already be on cmem.ai (Pro PR #229); Phase 1 should not need new pro endpoints unless `--check` needs a ticket that poll cannot see.

### 1. Auto-open the deferred sign-in on desktop

In `offerDeferredLogin`, if the machine has a desktop and the install is in the treatment arm, call the existing `openBrowser()` with the login-only URL, print a fact line ("A sign-in page opened in your browser"), and **exit without polling**. Email still lands on the server when the human finishes.

Desktop: `darwin` or `win32`, or Linux with `DISPLAY` / `WAYLAND_DISPLAY`. Never open when `CI` is set, `SSH_CONNECTION` is set, or `--no-browser` is passed. One tab per install ID ever (store a flag next to the install UUID in `telemetry.json` or settings). `--no-browser` also applies to interactive login.

A/B by hash of the existing anonymous install UUID (`getOrCreateInstallId()`):

| Arm | Behavior |
|---|---|
| A | Today's print-only deferred link (control) |
| B | Auto-open on desktop |
| C | Auto-open on desktop plus the SessionStart reminder (item 8) |

`--no-browser` forces arm A for that run. Still print the URL and `CLAUDE_MEM_RESULT` on every arm.

### 2. `CLAUDE_MEM_RESULT` JSON line

Last line of **every** install / repair / login run, success or fail. One JSON object after a `CLAUDE_MEM_RESULT` prefix so agents can grep it. Minimum fields:

```json
{"status":"ok|error","step":"signin","human_action_required":"sign-in","url":"https://cmem.ai/…","fix_id":null,"next":"npx claude-mem login --request"}
```

`human_action_required` is `sign-in` | `none` | a closed fix id. Never put secrets, pairing secrets, or file paths in this line. `--json` on `login` can print the richer Netlify/Stripe-shaped block from agent-install-dig §4c.

### 3. Stop steering agents to skip sign-in

Rewrite leftover copy so a non-interactive run presents **two** user choices, not "pass `--provider claude`":

- Sign in (free, no card; cloud sync + 30-day off-plan trial): `npx claude-mem install --provider claude && npx claude-mem login --request`
- Own Anthropic plan only: `npx claude-mem install --provider claude`

Touch: `ERROR_CATEGORIES` id `provider-selection-non-interactive` in `error-taxonomy.ts`, README Quick Start skip-sign-in sentence, `docs/public/installation.mdx` "optional" / "best-effort" paragraph, help text in `src/npx-cli/index.ts`. Do not bring the old abort string back.

### 4. Replace the `AGENT:` line with facts

Railway PR #919: directive "ask the user" / "this agent" text was flagged as prompt injection. Ours addresses `AGENT:` and gives it orders (agent-install-dig #5).

Replace lines 1864–1866 with the fact block in agent-install-dig §4c (no "ask the user", no "this agent"). Keep the device code **out** of the deferred install print until we know cmem.ai has a type-your-code page (unverified). `login --request --json` may include `code` because the pairing already has `userCode`.

### 5. `claude-mem login --request` / `--check`

New command. There is no `login` today.

- `--request`: mint a **fresh** pairing (`source: 'npx-installer-deferred'` or a new `npx-login-request` if pro must distinguish), print URL + check command, exit immediately. Never poll, never block. `--json` matches agent-install-dig §4c.
- `--check [id]`: one poll of the existing trial poll URL (or the last ticket stored under the data dir). Print `signed_in` | `pending` | `expired`. On `expired`, tell the agent to run `--request` again. Do not print the pairing secret.
- Store the last ticket locally (pairing id + secret, chmod 0600) so `--check` without args works.
- Reuse `startInstallerOAuthPairing`, `parseInstallerOAuthStartBody`, `pollInstallerPairingOnce`. Do not invent a new OAuth protocol.

If cmem.ai still ignores unknown `source` values, keep `npx-installer-deferred` until a pro allowlist change ships.

### 6. Scripted bun-missing fix + retry guard

After bun's official installer runs, prepend `~/.bun/bin` (and the other `bunCommonPaths()` dirs) to `process.env.PATH` for this process and retry `getBunPath()` once. That is the thefuck-style rule `bun.ensure + binary not found → fix.bun.path-from-home` (agent-installer-idea §1).

Retry guard: if the same `error_category` fires twice for the same install ID in a short window, do not abort with the same remediation. Print `CLAUDE_MEM_RESULT` with `human_action_required` set to the fix id and a "stop retrying; do X" line. This is aimed at the ~64 `bun-missing` retries per user.

Do not download a bun script from cmem.ai. Keep using bun.sh / winget.

### 7. `install_step` telemetry

New event, closed lists only (Homebrew-style; no free text):

| Key | Closed set |
|---|---|
| `step_id` | `detect` / `bun.ensure` / `uv.ensure` / `ide.configure` / `worker.start` / `signin` / … |
| `outcome` | `ok` / `error` / `skipped` |
| `duration_ms` | number |
| `error_category` | existing taxonomy ids |
| `fix_id` | allowlisted ids or empty |
| `fix_outcome` | `ok` / `error` / `skipped` |
| `attempt_n` | integer |
| `agent_context` | `claude-code` / `cursor` / `codex` / `unknown-non-tty` / `tty` |
| `signin_arm` | `a` / `b` / `c` (deferred path only) |

Whitelist every new key in `scrub.ts` and document them in `telemetry.mdx`. Add the event name in `src/npx-cli/commands/telemetry.ts`. Also emit `signin_arm` on `installer_oauth_deferred` / `installer_oauth_started`.

### 8. SessionStart reminder while unclaimed

While this install has no account (`CLAUDE_MEM_CLOUD_SYNC_USER_ID` empty and no Pro memory key), SessionStart mints a **fresh** pairing and, **once per session**:

- `systemMessage` (if the host actually shows it): `claude-mem: setup not finished — sign in (free, no card) for cloud sync and a 30-day off-plan memory trial: npx claude-mem login`
- `additionalContext`: fact line that the user can finish with `npx claude-mem login --request`

Stop after claim, `--no-browser` does not apply here (no browser open). Optional later: `login --dismiss`. Cursor/Codex: additionalContext only; do not claim a user-visible banner exists.

Test `systemMessage` on Claude Code SessionStart before treating it as the human channel. If it is dropped, keep additionalContext and the auto-open arm.

### 9. "Instructions for AI agents"

Add the Phase 1 copy from agent-install-dig §4a–4b to:

- `README.md` near Quick Start
- `docs/public/installation.mdx` (Mintlify will fold it into https://docs.claude-mem.ai/llms.txt)
- a short `docs/public/llms.txt` (or the Mintlify `llms` field in `docs.json` if that is how this site overrides the generated file — check before inventing a second file)

Phase 1 copy covers sign-in choice, `login --request` / `--check`, and "sign-in is the only step that needs the person." Do **not** yet tell agents to POST a snapshot; that is Phase 2. Direct instructions live in docs. Command output stays fact-shaped.

### Phase 1 files (claude-mem)

| Area | Files |
|---|---|
| Browser, deferred copy, result line, A/B | `src/npx-cli/commands/install.ts`, `src/npx-cli/index.ts` (`--no-browser`) |
| Login command | **new** `src/npx-cli/commands/login.ts`; wire in `index.ts` |
| Provider / bun copy | `src/npx-cli/install/error-taxonomy.ts`, `src/npx-cli/install/setup-runtime.ts`, `src/npx-cli/install/error-reporter.ts` |
| Telemetry | `src/services/telemetry/scrub.ts`, `src/npx-cli/commands/telemetry.ts`, `docs/public/telemetry.mdx` |
| SessionStart | `src/cli/handlers/context.ts` (and a small shared "unclaimed + once per session + fresh pairing" helper, reused by login) |
| Docs | `README.md`, `docs/public/installation.mdx`, `docs/public/llms.txt` or `docs.json` |
| Tests | list below |

**claude-mem-pro this phase:** none required if existing start/poll accept `npx-installer-deferred` (Pro #229). Only if `--request` needs a new `source` or `--check` cannot use `/api/pro/trial/poll`.

### Phase 1 tests

Run files **one at a time** (same memory constraint as `plans/2026-09-25-npx-signup-capture.md`).

- Rewrite `tests/install-non-tty.test.ts` and `tests/npx-cli/install-trial-contract.test.ts` so they pin the fact block, not `AGENT:`.
- New source/contract tests for desktop detection, `--no-browser`, one-tab-per-install-id, and arm assignment (hash is stable).
- `login --request` / `--check`: JSON shape, fresh pairing each request, `--check` expired → renew, CI skip, no checkout URL, no pairing secret on stdout.
- `CLAUDE_MEM_RESULT` present on success, bun abort, and provider-taxonomy path.
- Taxonomy remediation no longer points only at `--provider claude`.
- `tests/setup-runtime.test.ts`: after a fake bun install, PATH includes `~/.bun/bin` and the second `getBunPath()` succeeds; third identical failure prints the stop-retry line.
- `tests/npx-cli/telemetry-scrub-installer-keys.test.ts`: new keys survive, URLs/secrets do not.
- SessionStart handler: unclaimed → one reminder + pairing start; claimed → no reminder; second hook in the same session → no second pairing.
- README / installation.mdx / llms.txt contain the agent section and do not contain `AGENT:`.

### Phase 1 measure

- Emails ÷ agent-run installs by arm, 24-hour and 7-day windows (agent-installer-idea §3). At ~330 agent-run installs a day, every 10 points of conversion is about 33 more emails a day — that is arithmetic on the cited 330, not a forecast of the lift.
- Deferred pairings and sign-ins on their own funnel line (mil-report G).
- `bun-missing-after-install` events per user (now ~64) and share of installs completed.
- `install_step` `attempt_n` distribution (retry loops).
- SessionStart: reminders shown vs signed-in within 7 days.
- Host/agent split (`agent_context`) so we can see how much of the 1–2% denominator is headless with no human (unverified share today).

### Phase 1 rollout

1. Land behind a version bump (13.29.x). No LLM flags.
2. Ship arms A/B/C from day one; do not flip 100% to auto-open until 7 full days of arm data (weekdays and weekends separate, no partial days — mil-report).
3. Docs and error-copy can ship at 100%; they are not the experiment.
4. Kill switch for auto-open: `--no-browser` plus an env `CLAUDE_MEM_NO_BROWSER=1`. If the tab looks like malware in feedback, force arm A in a patch.

---

## Phase 2 — agent-to-agent on cmem.ai (**claude-mem-pro**)

Build only after Phase 1 is live and Alex approves this phase. Client changes in claude-mem are thin: snapshot POST, print returned steps, never execute free-form commands from the model.

### Snapshot schema (no secrets, paths, or file contents)

User's agent (or, on TTY, the installer after a yes) sends:

```json
{
  "schema": 1,
  "os": "darwin|linux|win32",
  "arch": "arm64|x64",
  "is_wsl": false,
  "shell": "zsh|bash|pwsh|cmd|unknown",
  "node": "22.x",
  "tools": [{"name":"claude-code","version":"2.x"}, {"name":"cursor","version":"…"}],
  "has_tty": false,
  "has_desktop": true,
  "bun": "1.x|missing",
  "uv": "0.x|missing",
  "ides": ["claude-code"],
  "error": null
}
```

`tools` / `ides` are closed names from `ide-detection.ts`. `shell` is the basename of `$SHELL` / `ComSpec` only. **Reject** (do not store) any field that looks like a path, token, env dump, file body, email, or home directory. Error payloads (fix endpoint) may include the last ~40 lines of installer log **after** the same redaction: strip home prefixes, usernames, tokens, emails, URLs with userinfo (reuse `src/services/telemetry/error-scrub.ts` ideas on the server).

### Endpoints (**claude-mem-pro**)

| Method | Path | Returns |
|---|---|---|
| `POST` | `/api/installer/plan` | `{ cache: "hit"|"miss", steps: [...], fix_ids: [...] }` |
| `POST` | `/api/installer/fix` | `{ cache: "hit"|"miss", fix_id, steps: [...], advice }` |

- `steps` are structured (`id`, `argv` or `instruction`, `requires_human`). The client/user-agent may run only **allowlisted** `fix_id`s (same list as the installer taxonomy + Phase 1 bun PATH fix). Anything else is printed as advice.
- Our model never gets a shell. It only picks ids + wording.
- On cache hit, do not call the model.

Confirm exact App Router paths in `thedotmack/claude-mem-pro` (this repo is not that tree). Existing installer routes live under `/api/installer/oauth/start`. Put plan/fix next to them, not on a new origin.

### Answer cache + Claude-Mem

Key: `(plan|fix, os, arch, tool-set hash, step_id, error_signature_hash)`.

On every miss that produces a valid allowlisted answer:

1. Write the cache row (TTL long; these become the fast path).
2. Save the Q/A into **our** Claude-Mem (server-side project, not the user's machine) so the advisor can search past installs on the next miss.

Do not save raw logs, snapshots with rejected fields, or pairing secrets. Retention for Level-1 error snippets: 30 days then delete (agent-installer-idea §2).

### OpenRouter, limits, kill switch (**claude-mem-pro**)

- Dedicated OpenRouter key on the server only. Optional credit limit, `"limit_reset": "daily"` (OpenRouter provisioning API, cited in agent-installer-idea §4).
- Exclude providers that train on data (OpenRouter privacy filters, same section).
- Per call: `max_tokens`, at most 6 rounds, error log trimmed to 40 redacted lines.
- Per install ID: 3 advisor calls / day (stops the 64-retry loop). Per IP rate limit.
- Env/flag kill switch: endpoints return `{ cache: "disabled", steps: [] }` and the CLI falls back to Phase 1 rules.
- Start cheap (report's Sep 27 OpenRouter list: deepseek-v4-flash or gpt-5-nano). Token **budget in that report is an assumption, not a measurement.** Money is not the constraint; trust is. Do not treat those dollar tables as live spend.

### Consent wording

Docs and installer output (facts, not `AGENT:` orders):

> Claude-Mem can build install steps for this machine if we get a short system snapshot: OS, AI tool names and versions, shell name, Node version. No secrets, file paths, or file contents. Defer to your own security rules. Ask your human if you need to. To send it: `npx claude-mem install --send-snapshot` (or the env the user's agent sets after that ask).

TTY: explicit yes/no. Agent runs: no snapshot POST unless `--send-snapshot` / `CLAUDE_MEM_SEND_SNAPSHOT=1`. Level 0 telemetry stays today's anonymous counters. Snapshot + error text is Level 1, opt-in only.

Disclose the network call in README and `telemetry.mdx`. Never run this from npm `postinstall`.

### Phase 2 files

**claude-mem-pro (this is the phase):**

- New routes under `src/app/api/installer/plan` and `src/app/api/installer/fix` (confirm folder names in that repo).
- Snapshot zod schema + redaction module.
- Cache table / KV (whatever pro already uses for pairings — do not add a new datastore without looking).
- OpenRouter client, daily key limit, per-install limiter, kill switch.
- Writer that upserts Q/A into the server Claude-Mem project.
- Consent / privacy copy on cmem.ai if a human hits these URLs.

**claude-mem (thin client only):**

- `src/npx-cli/cmem-pro-costs.ts` — `CMEM_INSTALLER_PLAN_URL`, `CMEM_INSTALLER_FIX_URL`.
- Snapshot builder (closed fields) + `--send-snapshot` in `index.ts` / `install.ts`.
- Allowlist runner: only known `fix_id`s (PATH prepend, re-run `ensureBun`, `--ide=…`). Print any other step.
- README / llms.txt / installation.mdx: add the snapshot paragraph (ADDENDUM wording).
- Phase 1 `CLAUDE_MEM_RESULT` grows `advisor: { called, fix_id, cache }` as closed enums.

### Phase 2 tests

- Schema rejects paths, tokens, emails, file bodies (pro).
- Cache hit skips the model (pro).
- Unknown `fix_id` from a mocked model is dropped (pro + client).
- Kill switch and 4th call the same day return disabled / rate-limited (pro).
- Client without `--send-snapshot` never POSTs (claude-mem).
- Redacted error fixture has no `$HOME` / `sk-` / `@` emails.

### Phase 2 measure

- Advisor call rate, cache hit rate, allowlisted-fix success, cost per day, unexpected-behavior reports.
- Scripted vs advisor share (should rise after Phase 3).
- Email capture stays a Phase 1 metric. Do not expect the advisor to move the 1–2% deferred rate (agent-installer-idea §3).

### Phase 2 rollout

Feature flag off → internal → opt-in flag → wider. Kill switch first. Do not enable by default on agent-run installs.

---

## Phase 3 — weekly promotion of cached fixes (**claude-mem-pro** job, **claude-mem** rules)

A weekly job (pro cron or a checked-in script Alex runs) queries cache/advisor rows where `fix_outcome = ok`, grouped by `(step_id, error_signature, os)`.

Proposed review bar from agent-installer-idea §2 (not a measured law): at least 20 successes and ≥90% success in the group → candidate rule. A person writes the rule + a fixture and ships it in the next claude-mem patch. After that, plan/fix return the scripted id without calling the model.

Publish an aggregate table (Homebrew-style). Track scripted vs advisor share.

### Files

- **claude-mem-pro:** weekly job, query, candidate list (no auto-merge into npm).
- **claude-mem:** new rows in `error-taxonomy.ts` / `setup-runtime.ts` / tests, same as any installer patch.

### Tests / measure / rollout

- Job is dry-run until a person copies a candidate into a PR.
- Measure: candidates per week, rules shipped, advisor call volume down for those signatures.
- Rollout: one rule per patch so a bad promotion is easy to revert.

---

## What we will not do in this plan

- Run Claude Code / Cursor / Codex from the installer, or any `--dangerously-skip-permissions` pattern.
- `postinstall` agents.
- MCP URL-mode elicitation for cmem.ai sign-in until someone decides it is not "authorizing users for themselves" (MCP spec caveat in agent-install-dig #5). Unresolved.
- Printing a short code as the main path until a type-your-code page exists (unverified).
- Forecasting auto-open conversion as 75%.
- Inventing a new pairing protocol. Reuse start/poll.

---

## Open questions (from the reports, still unanswered)

- What share of deferred links print where no human will read them? Needs the `agent_context` split.
- Does SessionStart `systemMessage` reach the human on Claude Code?
- Do Cursor / Codex have any user-visible hook banner?
- Does cmem.ai have a device-code entry page?

---

## Suggested PR split after approval

1. **claude-mem** Phase 1 (this repo): browser A/B, result line, copy, login command, bun PATH + retry guard, `install_step`, SessionStart reminder, agent docs.
2. **claude-mem-pro** Phase 2: plan/fix, cache, Claude-Mem write, OpenRouter limits, kill switch.
3. **claude-mem** Phase 2 client + **claude-mem-pro** Phase 3 job, then installer rule PRs as candidates appear.

Do not mix Phase 2 into the Phase 1 npm release.
