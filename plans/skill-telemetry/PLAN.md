# PLAN: Skill Telemetry (PostHog events for shipped claude-mem skills)

**Status:** Plan only. No product code in this PR.  
**Base:** `main`  
**Style:** make-plan (phases a later `/do` can run in fresh chats)  
**Precedent:** `plans/2026-09-01-posthog-observed-model.md`

---

## What this is

We want PostHog to answer a simple product question: **which bundled skills do people actually load?**

Today we have a mature worker telemetry stack (consent, whitelist scrub, `captureEvent`, rollups) and **zero skill-level events**. The Skill tool is on the default observation skip list, so a skill load never becomes an observation and never becomes a PostHog event.

This plan is the implementation contract for a later `/do`. It does not ship instrumentation.

---

## Locked decision (Az)

**Claude Code `PostToolUse` for the `Skill` tool fires when the skill instructions are loaded, not when the agent's work finishes.**

That is a host behavior, not a claude-mem bug. The Skill tool returns as soon as `SKILL.md` is in context. Everything after that — searches, edits, subagents, success, failure — is ordinary tool use, not a second Skill completion.

Consequences (do not reopen in `/do` without a new greenlight):

| Do | Do not |
|---|---|
| Emit **`skill_loaded`** | Emit `skill_completed` / `skill_failed` from PostToolUse |
| Document the event as **load**, not finish | Attach a work `duration_ms` from this hook |
| Chart "loads" and "unique installs that loaded X" | Chart "skill success rate" or "time to complete /make-plan" from v1 |
| Keep `Skill` on `CLAUDE_MEM_SKIP_TOOLS` | Start storing Skill tool I/O as observations just to get telemetry |

`skill_invoked` from earlier research is the same signal. This plan uses **`skill_loaded`** so a dashboard cannot honestly be titled "skills completed."

Real completion / duration is only possible later, and only for the few skills that have their own scripts (Phase 5, deferred).

---

## Phase 0: Documentation Discovery (done in this planning pass)

Prior research lived at `/workspace/skill-telemetry/research-findings.md` in an earlier session. That file is **not in this checkout**. Findings below were re-verified against current `main` and against claude-mem memory of that research.

### 0.1 Skills that ship with the plugin

Claude Code auto-discovers `plugin/skills/<dir>/SKILL.md`. `plugin/.claude-plugin/plugin.json` has **no** `skills` key (intentional). `package.json` `"files"` includes `plugin/skills`. Marketplace sync copies the whole `plugin/` tree.

**19 bundled skills. None emit telemetry today.**

| Skill | Kind | Notes |
|---|---|---|
| `babysit` | instructions | Watch a PR |
| `what-the` | instructions | Plain-English explainer |
| `pathfinder` | instructions | Flowcharts → `/make-plan` |
| `oh-my-issues` | instructions | Cluster GitHub issues |
| `cloud-sync` | instructions | Pro SyncHub setup; still ships in OSS plugin |
| `design-is` | instructions | Design audit |
| `mem-search` | instructions | MCP search; may already cause `search_performed` |
| `mode-creator` | **scripts** | `scripts/install-mode.mjs`, `scripts/configure-telegram.mjs` |
| `smart-explore` | instructions | AST / `smart_*` MCP |
| `do` | instructions | Execute a plan via subagents |
| `wowerpoint` | instructions | External `notebooklm` CLI |
| `make-plan` | instructions | This skill |
| `version-bump` | **scripts** | `scripts/generate_changelog.js` |
| `standup` | **scripts** | `standup.mjs` |
| `how-it-works` | instructions | + `onboarding-explainer.md` |
| `timeline-report` | instructions | Worker HTTP / timeline |
| `learn-codebase` | instructions | Read the tree |
| `weekly-digests` | instructions | ISO-week chapters |
| `knowledge-agent` | instructions | Corpora via MCP |

No Pro-only skill tree exists in this repo. Sibling copies (`cowork/skills`, `openclaw/skills`, `claude-mem-cursor/skills`, `claude-mem-grok-bot/skills`) are **out of v1**.

### 0.2 How a skill load reaches us

1. Host runs `PostToolUse` with `tool_name: "Skill"` and `tool_input: { skill, args }`.
2. `src/cli/adapters/claude-code.ts` maps stdin → `NormalizedHookInput`.
3. `src/cli/handlers/observation.ts` POSTs `/api/sessions/observations` (worker) or `/v1/events` (server runtime).
4. Worker: `SessionRoutes.handleObservationsByClaudeId` → `ingestObservation`.
5. `ingestObservation` (`src/services/worker/http/shared.ts:78-83`) returns `tool_excluded` because default `CLAUDE_MEM_SKIP_TOOLS` includes `Skill`.

```146:146:src/shared/SettingsDefaultsManager.ts
    CLAUDE_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
```

Logger already prints `Skill(<name>)` when `input.skill` is present (`src/utils/logger.ts:206-208`). That is local log only.

**Transcript replay** also calls `ingestObservation` (`src/services/transcripts/processor.ts:247-255`). If telemetry is added on the shared skip path with no source gate, historical Skill lines will look like live loads.

**Server runtime** never hits `ingestObservation` on the happy path (`observation.ts:68-90`). v1 is worker-only.

**SlashCommand** is also skipped. A user typing `/mem-search` may fire `SlashCommand` instead of (or as well as) `Skill`. v1 Skill-only will undercount slash-first use. Phase 4 can close that if we can map the command string to the same allowlist.

### 0.3 Existing telemetry (copy these APIs — do not invent)

| API | Where | Use for skill telemetry? |
|---|---|---|
| `captureEvent(event, props?, opts?)` | `src/services/telemetry/telemetry.ts:489` | **Yes** — worker, fire-and-forget, consent + scrub + debug |
| `captureCliEvent(...)` | `src/services/telemetry/cli-telemetry.ts:22` | No for v1 (hook latency; Skill already reaches the worker) |
| `telemetryBuffer.record(...)` | `src/services/telemetry/buffer.ts:339` | No for v1 (load volume is per Skill tool call, not per-token) |
| `scrubProperties` / `ALLOWED_PROPERTY_KEYS` | `src/services/telemetry/scrub.ts` | **Yes** — new keys must be listed or they vanish |
| `resolveTelemetryConsent` | `src/services/telemetry/consent.ts:69` | Inherited by `captureEvent` |
| `instrument()` / `instrument.ts` | claimed in `docs/public/telemetry.mdx:20` | **Does not exist.** Do not build skill telemetry on it |

Consent order (first match wins): `DO_NOT_TRACK` → `CLAUDE_MEM_TELEMETRY` → `telemetry.json` → **default on**. Same gate as every other analytics event. No new settings key.

High-volume compression/injection already roll up. Skill loads are closer to `search_performed`: one discrete user/model action, send directly, `$process_person_profile: false`.

### 0.4 Privacy (hard)

`tool_input.args` on Skill can hold paths, PR numbers, repo names, and the user's actual instruction. **Never send args. Never send raw third-party skill names.**

Safe fields only:

- `skill_id` — closed set: the 19 names above, or `other`
- `skill_source` — `bundled` or `other`
- `ide` — already whitelisted (`claude-code` / `codex` / `cursor` / …)
- plus automatic `buildBaseProperties()` (`version`, `os`, …)

Host skill ids often look like `claude-mem:mem-search` (see Linear ALE-245 skillOverrides). Strip a leading `claude-mem:` before the allowlist check. Anything else, including other plugins' skills, becomes `other`.

### 0.5 Allowed APIs (implementation may use only these)

- `captureEvent` from `src/services/telemetry/telemetry.ts`
- `scrubProperties` / `ALLOWED_PROPERTY_KEYS` from `src/services/telemetry/scrub.ts`
- `normalizePlatformSource` (already used on this path) for `ide`
- `logger.debug` / `logger.warn` — no `console.*` in the worker
- bun tests + global PostHog mock in `tests/preload.ts`
- `__resetTelemetryForTests()` for unit tests

### 0.6 Anti-patterns

- Do not invent `instrument()`
- Do not call `posthog.capture()` at the call site
- Do not emit `skill_completed` / `duration_ms` of work from PostToolUse (Az)
- Do not put `args`, paths, prompts, project names, or raw third-party skill names on the event
- Do not remove `Skill` from `CLAUDE_MEM_SKIP_TOOLS`
- Do not emit from `src/services/transcripts/processor.ts`
- Do not add a settings key for this; consent is env / `telemetry.json` only
- Do not edit `plugin/scripts/*.cjs` (rebuild artifacts)
- Do not implement `instrument.ts` "while we're here"

### Phase 0 verification (this planning PR)

- [x] Inventory of `plugin/skills/*/SKILL.md` (19)
- [x] Confirm zero `captureEvent` / PostHog calls under `**/skills/**`
- [x] Confirm Skill skip at `shared.ts:78-83` and default at `SettingsDefaultsManager.ts:146`
- [x] Confirm `captureEvent` pipeline and whitelist rules
- [x] Confirm `instrument.ts` is documented but missing
- [x] Confirm transcript replay shares `ingestObservation`
- [x] Az load-vs-completion written as a locked decision

### Phase 0 greenlight

Alex (or the next `/do` orchestrator) accepts:

1. Event name **`skill_loaded`**
2. Worker-only v1 emit site (not CLI, not server `/v1/events`, not transcript replay)
3. Allowlist-or-`other` for `skill_id`
4. No completion events in v1

---

## Phase 1: Schema helper + whitelist (no emit yet)

### What to implement

Add a **pure** helper. Do not send anything yet.

**New file:** `src/services/telemetry/skill-id.ts` (name can vary; keep it next to scrub/consent, not inside a skill).

Copy the "closed enum, never throw, never pass through free text" posture from `scrub.ts` and from billing detection in `plans/2026-09-01-posthog-observed-model.md` §0.2.

```ts
export const BUNDLED_SKILL_IDS = [
  'babysit', 'cloud-sync', 'design-is', 'do', 'how-it-works',
  'knowledge-agent', 'learn-codebase', 'make-plan', 'mem-search',
  'mode-creator', 'oh-my-issues', 'pathfinder', 'smart-explore',
  'standup', 'timeline-report', 'version-bump', 'weekly-digests',
  'what-the', 'wowerpoint',
] as const;

export type BundledSkillId = (typeof BUNDLED_SKILL_IDS)[number];

export function classifySkillId(raw: unknown): {
  skill_id: BundledSkillId | 'other';
  skill_source: 'bundled' | 'other';
}
```

Rules:

1. If `raw` is not a non-empty string → `{ skill_id: 'other', skill_source: 'other' }`.
2. Trim, lowercase.
3. If it contains `:`, keep the **last** segment (`claude-mem:mem-search` → `mem-search`). Do not keep other plugins' namespaces as data.
4. If that segment is in `BUNDLED_SKILL_IDS` → bundled. Else `other`.
5. Never return the original string.

Also add a tiny extractor used later:

```ts
export function skillNameFromToolInput(toolName: string, toolInput: unknown): unknown
```

- `toolName === 'Skill'` and `toolInput` is an object → `toolInput.skill`
- otherwise `undefined` (SlashCommand mapping is Phase 4)

**Whitelist** in `src/services/telemetry/scrub.ts` `ALLOWED_PROPERTY_KEYS`:

- `skill_id`
- `skill_source`

Do **not** add them to `PERSON_PROPERTY_KEYS`. This is not a person-profile trait.

### Documentation references

- Allowlist + silent drop: `src/services/telemetry/scrub.ts:8-198` and `:231-241`
- Scrub test pattern: `tests/telemetry/scrub.test.ts:219-231` and `:243-263`
- Consent default-on: `src/services/telemetry/consent.ts:39-43`
- Public rules: `docs/public/telemetry.mdx` "What is NEVER collected"

### Verification checklist

- [ ] `bun test tests/telemetry/scrub.test.ts` — new keys survive; `args`, `skill`, `path`, `prompt` still drop
- [ ] Unit tests for `classifySkillId`:
  - `mem-search` → bundled
  - `claude-mem:make-plan` → `make-plan` / bundled
  - `CLAUDE-MEM:DO` → `do` / bundled
  - `someone-else:evil` → `other` / `other`
  - `../../etc/passwd` → `other`
  - `""`, `null`, `{ skill: 'x' }` → `other`
- [ ] Helper file has **no** import of `captureEvent` yet
- [ ] Grep: no `skill_completed` / `duration_ms` added to skill helper

### Anti-pattern guards

- Do not whitelist `skill`, `args`, `command`, or `skill_name` as a free-form field
- Do not read `tool_response` (it is the loaded markdown)
- Do not add person `$set` keys

### Phase 1 greenlight

Helper + whitelist merged or at least tests green on the `/do` branch. Reviewer confirms third-party names cannot leak.

---

## Phase 2: Emit `skill_loaded` on the live worker observation route

### What to implement

Emit **only** from the live worker hook route, after the project-exclusion check, before the Skill skip returns.

**Preferred site:** `ingestObservation` in `src/services/worker/http/shared.ts`, with an explicit source so transcript replay stays silent.

1. Add optional `source?: 'hook' | 'transcript'` to `ObservationPayload` (default `'hook'` so existing callers stay hook-like — **except** the transcript processor, which must pass `'transcript'`).
2. After the `project_excluded` return, if `payload.source !== 'transcript'` and `payload.toolName === 'Skill'`:
   - `classifySkillId(skillNameFromToolInput(...))`
   - `captureEvent('skill_loaded', { skill_id, skill_source, ide: platformSource })`  
     No `{ person: true }`.
3. Then fall through to the existing skip / ingest logic. Skill remains `tool_excluded`.
4. In `src/services/transcripts/processor.ts` `sendObservation`, pass `source: 'transcript'`.

Copy the `search_performed` call shape from `src/services/worker/http/routes/SearchRoutes.ts:133` (direct `captureEvent`, closed props, no buffer).

Do **not** emit from `src/cli/handlers/observation.ts`. The hook is short-lived; the worker already has the batched client and the consent cache.

### Documentation references

- Skip + return: `src/services/worker/http/shared.ts:65-83`
- Route mapping: `src/services/worker/http/routes/SessionRoutes.ts:476-516`
- Transcript ingest: `src/services/transcripts/processor.ts:243-255`
- Capture pipeline: `src/services/telemetry/telemetry.ts:470-544`
- Ingest tests: `tests/worker/ingest-tool-uses-dual-write.test.ts`

### Verification checklist

- [ ] Skill ingest still returns `{ ok: true, status: 'skipped', reason: 'tool_excluded' }`
- [ ] With `CLAUDE_MEM_TELEMETRY=1` and the PostHog test mock, one Skill hook ingest → one `skill_loaded` in `postHogCaptureCalls`
- [ ] Props are only scrubbed primitives: `skill_id`, `skill_source`, `ide`, plus base props
- [ ] `tool_input.args` does not appear even if passed
- [ ] `DO_NOT_TRACK=1` or `CLAUDE_MEM_TELEMETRY=0` → zero captures
- [ ] Transcript `sendObservation` with `toolName: 'Skill'` → zero captures
- [ ] Non-Skill tools → zero `skill_loaded`
- [ ] Existing ingest dual-write tests still pass
- [ ] Capture is inside try/swallow already provided by `captureEvent` — do not wrap the whole ingest in a new try

### Anti-pattern guards

- Do not emit on `tool_excluded` for `SlashCommand` yet
- Do not emit `skill_completed` when `tool_response` is present (that response is the skill body)
- Do not start the generator or write `tool_uses` for Skill
- Do not send `contentSessionId` (not whitelisted; would be a session identifier)

### Phase 2 greenlight

A reviewer runs `CLAUDE_MEM_TELEMETRY_DEBUG=1`, loads `/mem-search` (or Skill tool) in a real Claude Code session against the branch, and sees one stderr `[telemetry] {"event":"skill_loaded",...}` with `skill_id:"mem-search"`. Nothing is sent if they also set debug (debug prints and does not POST). Then they load a third-party skill and see `skill_id:"other"` only.

---

## Phase 3: Docs + CLI status list + tests that pin the public contract

### What to implement

Update the public contract so the event cannot be misread.

**`docs/public/telemetry.mdx`**

- Property table: add `skill_id` (closed enum + `other`) and `skill_source` (`bundled` | `other`).
- Events table: add `skill_loaded` — "Skill tool finished loading instructions (not work completion). Worker hook path only."
- Never-collected: explicitly say skill arguments, skill markdown, and third-party skill names are dropped.

**`src/npx-cli/commands/telemetry.ts` `EVENT_NAMES`**

- Add `skill_loaded`.
- Optional in this phase (do not expand scope): stop listing retired raw `session_compressed` / `context_injected`. Only if the `/do` session is already touching that list; otherwise leave a one-line comment that the list is stale and `telemetry.mdx` is source of truth.

Do **not** rewrite the stale `instrument.ts` paragraph unless the same `/do` session is already in that file. If you touch it, replace "single `instrument()` path" with the real sentence: call sites use `captureEvent` / `captureCliEvent` / `telemetryBuffer.record`.

### Documentation references

- Event table: `docs/public/telemetry.mdx:127-147`
- Never-collected: `docs/public/telemetry.mdx:197-213`
- CLI list: `src/npx-cli/commands/telemetry.ts:84-95`

### Verification checklist

- [ ] Docs say **loaded**, not completed
- [ ] Docs list the two new keys
- [ ] `npx claude-mem telemetry` help (or the printed EVENT_NAMES) includes `skill_loaded` if that list was edited
- [ ] No new changelog entry required here; changelog is generated

### Anti-pattern guards

- Do not promise Cursor / Cowork / OpenClaw / server-runtime coverage in the docs
- Do not document `skill_completed`

### Phase 3 greenlight

Docs and code names match. A stranger reading `telemetry.mdx` cannot think we measure skill success.

---

## Phase 4 (optional, separate greenlight): SlashCommand loads

Only if Phase 2 live check shows we miss a lot of `/skill` use.

`SlashCommand` is also on `CLAUDE_MEM_SKIP_TOOLS`. If `tool_input.command` (or equivalent — **read a live hook payload before coding**) is a string, strip a leading `/` and run the same `classifySkillId`. Emit the **same** `skill_loaded` event so charts stay one series.

If the payload is not a closed command name, skip this phase. Do not invent a field.

Verification: `/mem-search` via slash produces one event, not two, if the host also fires Skill. Dedup is **not** required in v1 if we only enable one matcher; if both fire, prefer Skill-only until we see double counts in PostHog.

### Phase 4 greenlight

Alex confirms slash undercount is worth a second matcher, and a captured live payload is pasted into the `/do` chat.

---

## Phase 5 (deferred): Honest completion — scripts only

Do not schedule this in the first `/do` unless Alex asks.

Only these shipped skills have local executables:

- `mode-creator` — `install-mode.mjs`, `configure-telegram.mjs`
- `standup` — `standup.mjs`
- `version-bump` — `generate_changelog.js`

A later plan can have those scripts call `captureCliEvent('skill_script_finished', { skill_id, outcome, duration_ms })` with a closed `outcome`. That is a **script finish**, still not "the agent finished the skill."

MCP tools those skills call already emit `search_performed`. Do not re-attribute those as skill completion.

### Phase 5 greenlight

Separate plan. Not this `/do`.

---

## Final verification (end of the first `/do`)

1. `bun test tests/telemetry tests/worker/ingest-tool-uses-dual-write.test.ts` (and any new skill-id / ingest telemetry tests).
2. Grep guards:
   - `skill_completed` — no production hits
   - `instrument.ts` — still must not be imported
   - `toolInput.args` / `args:` must not appear in the capture props object
   - `source: 'transcript'` present on the processor call
3. Manual: debug-mode load of a bundled skill + a third-party skill (Phase 2 greenlight).
4. Confirm Skill still does not create observations or `tool_uses` rows.

---

## Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Dashboard lie | PostToolUse looks like "the skill ran" | Az decision: name `skill_loaded`; no completion/duration |
| `args` leak | Live Skill args include paths and user text | Never copy `toolInput` into props; only `classifySkillId(...)` |
| Third-party skill names | Names can be project- or user-specific; high cardinality | Collapse to `other` |
| Transcript replay | Processor shares `ingestObservation` | `source: 'transcript'` suppresses emit |
| Server runtime miss | `/v1/events` path skips this emit | Document as v1 gap; do not fake coverage |
| Slash undercount | `/mem-search` may be `SlashCommand` | Phase 4 after evidence |
| Orchestrator fan-out | `/do` and `/make-plan` load many child skills | Accept as loads; do not sample in v1 |
| Volume surprise | Unlikely vs compression stream, but not zero | Direct event first; rollup only if PostHog bill moves |
| Excluded projects | Hook returns before worker POST | Those loads are invisible; same as observations |
| Doc drift | `instrument.ts` and CLI EVENT_NAMES already stale | Phase 3; don't build on the missing file |

---

## Out of scope (first `/do`)

- Product implementation in **this** planning PR (already true)
- Skill observation capture (keep the skip list)
- Cursor / Grok / Cowork / OpenClaw skill copies
- Claude-mem-pro `captureServer` events
- Telemetry v2 `cm_daily.skills[]` (that design is not on this branch)
- Error tracking (`$exception`) for skill failures
- Person-profile traits for "favorite skill"
- Changing default telemetry to opt-in

---

## Suggested `/do` order

1. Greenlight Phase 0 (this document).
2. Phase 1 (helper + whitelist + tests).
3. Phase 2 (emit + ingest/transcript tests).
4. Phase 3 (docs).
5. Stop. Open the implementation PR.
6. Phase 4 / 5 only after a new greenlight.

Each phase should be committable on its own. If something in Phase 0 disagrees with the tree at `/do` time, **re-read the cited files** and update the plan comment in the implementation PR rather than inventing APIs.

---

## Sources

- `plugin/skills/*/SKILL.md` (19)
- `src/services/telemetry/{telemetry,consent,scrub,common,cli-telemetry,buffer}.ts`
- `docs/public/telemetry.mdx`
- `src/services/worker/http/shared.ts`
- `src/services/worker/http/routes/SessionRoutes.ts`
- `src/cli/handlers/observation.ts`
- `src/cli/adapters/claude-code.ts`
- `src/services/transcripts/processor.ts`
- `src/shared/SettingsDefaultsManager.ts`
- `src/utils/logger.ts`
- `plans/2026-09-01-posthog-observed-model.md`
- claude-mem memory of 2026-09-05 research (file `skill-telemetry/research-findings.md` not present in this workspace)
