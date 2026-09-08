# PostHog telemetry for bundled skills (`skill_invoked`)

**Status:** PLAN ONLY — **NOT APPROVED FOR BUILD.** Awaiting LFG / Az PASS on the open questions in §D. Nothing here has been implemented, no PR exists.
**Branch (when built):** `worktree-skill-telemetry-plan` (worktree). **Base:** `main` @ `fd0ecf02` (v13.24.1 + tool_uses dual-write).
**Research input:** `/workspace/skill-telemetry/research-findings.md` (2026-09-05). This plan re-verified every citation against the current worktree; where the research's line numbers drifted (main moved 3 commits), the numbers below win.
**Precedent plan to mirror:** `plans/2026-09-01-posthog-observed-model.md` (the last "add a property to PostHog" plan).

---

## Goal

Answer one product question honestly: **which of the 19 bundled skills do people actually invoke, on which host, on which version.**

Deliverable is one new event, `skill_invoked`, emitted from the worker through the existing telemetry stack, with three new closed-enum properties and nothing free-form. It ships:

1. A first-party skill-id allowlist module with a test that pins it to `plugin/skills/` so a new skill cannot silently become `other`.
2. The emit at the worker skip gate in `src/services/worker/http/shared.ts` (model-chosen skills, `Skill` tool_use).
3. A second emit at the session-init route (user-typed `/claude-mem:<skill>`), because Phase 0 proved typed invocations never produce a tool_use and would otherwise be invisible. **Decision-gated — see §D-2.**
4. The four documentation/CLI surfaces a telemetry change must touch.

**Explicit non-goals (from research §5, confirmed in Phase 0):** no `duration_ms` or `outcome` on `skill_invoked`; no `skill_completed` / `skill_failed` / `skill_step`; no change to `CLAUDE_MEM_SKIP_TOOLS` (skills still produce no observations); no new consent switch or settings key; no new PostHog client or transport; no touching `plugin/scripts/*.cjs`; no changes to the server runtime (`CLAUDE_MEM_RUNTIME=server`) path; no PostHog custom scout; no naming of third-party skills.

---

## A. Defaults chosen (each is flagged; override any before build)

| # | Decision | Default picked | Why |
|---|---|---|---|
| A-1 | Third-party skills | Emit `skill_id: 'other'`, `skill_source: 'third_party'`, never the name | Keeps the denominator (research §6-1 option a); naming is user-inventory disclosure |
| A-2 | Completion / duration | Invocation-only in v1 | `PostToolUse` on `Skill` fires at instruction-load, not at finish (research §3.1). Any duration would be a lie in a dashboard |
| A-3 | `instrument()` layer | **Do not build it** in this PR; add a direct `captureEvent` call site like every other event | Zero call sites exist today (Phase 0 §0.4). Building it is a separate refactor. Fix the stale docs paragraph separately (§D-7) |
| A-4 | Project exclusion suppresses skill events | Yes, keep as-is | The gate at `shared.ts:74-76` runs first; respects user intent, slight undercount |
| A-5 | Four `mem-search` copies | One id `mem-search`; `ide` disambiguates host | Research §6-5 |
| A-6 | Unprefixed allowlist hit (`make-plan` with no `claude-mem:` prefix) | Count as first-party | OpenClaw ships `do`/`make-plan` unprefixed; transcripts show both forms. Collision with a user's own skill named `do` is accepted noise |
| A-7 | Foreign prefix (`superpowers:make-plan`) | `third_party` | Different plugin, even if the tail matches |
| A-8 | `ide` value | Bucket to closed enum `claude \| codex \| cursor \| windsurf \| antigravity \| other` | `normalizePlatformSource` passes unknown strings through (`platform-source.ts:18`); backfill already buckets in JS for exactly this reason (`backfill.ts:300-315`) |
| A-9 | Typed-prompt path (Phase 3) | Emit only on a first-party allowlist match; unknown `/foo` emits nothing | A typed `/foo` may be a Claude Code builtin (`/clear`, `/context`, `/loop`) or a private skill. From the prompt path we do not report `third_party` at all |
| A-10 | Volume / rollup | Per-occurrence `captureEvent`, no buffer | Handfuls per session, 2-4 orders of magnitude under the compression stream. `telemetryBuffer` can absorb it later if wrong |
| A-11 | Person profile | `$process_person_profile: false` (default when `opts.person` is omitted) | Not a lifecycle event |
| A-12 | Non-string `toolInput.skill` | Emit nothing, `logger.debug` | Keep enums two-valued; a malformed Skill call is not worth a third bucket |
| A-13 | Stale `EVENT_NAMES` / `COLLECTED_FIELDS` cleanup | Add only the new rows; **do not** refresh the stale list in this PR | Keep the feature PR narrow (precedent §0.5). Flagged in §D-8 |

---

## Phase 0 — Consolidated discovery (READ THIS; DO NOT RE-DERIVE)

Four discovery subagents read the worktree. Everything below carries a `file:line` that was verified in this checkout.

### 0.1 The instrumentation target (worker ingest)

| Fact | Evidence |
|---|---|
| `Skill` calls DO reach the worker. PostToolUse matcher is `"*"`, async, 120s, runs `hook claude-code observation` | `plugin/hooks/hooks.json:48-60` |
| Adapter passes `tool_name` / `tool_input` verbatim; no tool filtering anywhere hook-side | `src/cli/adapters/claude-code.ts:15-26`; `src/cli/handlers/observation.ts:18-31` (POST body), `:44` (`platformSource = normalizePlatformSource(input.platform)`) |
| `toolInput` arrives at the worker as a JSON **object** (one `JSON.stringify` in `executeWithWorkerFallback`, Express re-parses; Zod `z.unknown()`) | `src/shared/worker-utils.ts:859`; `SessionRoutes.ts:448-465` (schema, `tool_input: z.unknown().optional()` at `:451`) |
| Route: `POST /api/sessions/observations` → `handleObservationsByClaudeId` → `ingestObservation(...)` | `SessionRoutes.ts:428-432` (registration), `:476-519` (handler), `:494-506` (call) |
| Second caller: transcript watcher (Codex) | `src/services/transcripts/processor.ts:243-260` |
| `ingestObservation` signature + payload type | `src/services/worker/http/shared.ts:65` — `export async function ingestObservation(payload: ObservationPayload): Promise<IngestResult>`; `ObservationPayload` at `:45-63` (`toolName: string`, `toolInput: unknown`, `platformSource?: string`, `cwd?: string`, …). No `sessionId` field; it is `contentSessionId` |
| `platformSource` normalized at the top of the function | `shared.ts:68` `const platformSource = normalizePlatformSource(payload.platformSource);` |
| Settings loaded per call | `shared.ts:72` `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)`; env override of any key via `applyEnvOverrides` `SettingsDefaultsManager.ts:266-274` (tests can set `process.env.CLAUDE_MEM_SKIP_TOOLS`) |
| Project-exclusion gate runs BEFORE the skip gate | `shared.ts:74-76` → `reason: 'project_excluded'` |
| **The skip gate (instrumentation point)** | `shared.ts:78-83`: builds `skipTools` Set from `settings.CLAUDE_MEM_SKIP_TOOLS`, `if (skipTools.has(payload.toolName)) return { ok: true, status: 'skipped', reason: 'tool_excluded' };` |
| `Skill` and `SlashCommand` are both in the default skip list | `src/shared/SettingsDefaultsManager.ts:146` `CLAUDE_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion'` (type at `:28`). Duplicated in `docs/public/configuration.mdx:25,424`, `docs/public/architecture/hooks.mdx:489-497`, `openclaw/install.sh:978` — **none of these change in this plan** |
| `shared.ts` imports NO telemetry today | `shared.ts:1-12`. New import path: `'../../telemetry/telemetry.js'` |
| Only place in `src/` that reads a Skill's input shape | `src/utils/logger.ts:206-208` `if (toolName === 'Skill' && input.skill) return \`${toolName}(${input.skill})\`` |
| `tool_excluded` branch has zero test coverage | `grep -rn tool_excluded tests/` → 0 hits |
| Skip gate runs before the `tool_uses` dual-write, so skipped tools never land in `tool_uses` either | `shared.ts:138-163` is after `:82` |

### 0.2 Skill invocation shapes (live transcript evidence, structural only)

| Fact | Evidence |
|---|---|
| Model-chosen skill → `tool_use` named `Skill` with input keys exactly `skill` (always) and `args` (optional). 25 real invocations across 15 files; 12 distinct ids, both `claude-mem:do` and bare `make-plan` forms observed | `~/.claude/projects/**/*.jsonl` filtered to `.type=="assistant"` tool_use blocks. (366 of 391 raw `"name":"Skill"` hits are `type:"attachment"` tool-listing noise — irrelevant to hooks) |
| **User-typed `/claude-mem:mem-search` produces NO tool_use of any kind.** It is a `type:"user"` record whose content string carries `<command-message>`/`<command-name>`/`<command-args>` markers | e.g. `~/.claude/projects/-home-box-sand-host/fb90c181-….jsonl` (0 `Skill` hits in that file) |
| `SlashCommand` tool_use: **0 occurrences** in 1031 transcripts | grep `"name":"SlashCommand"` → 0 |
| Typed invocations dominate in practice: `/claude-mem:do`×34, `/make-plan`×22, `/claude-mem:make-plan`×7 typed vs. 4 `claude-mem:do` tool_use | `<command-name>` census vs tool_use census |
| **Typed slash commands DO reach the worker as raw prompt text** on `POST /api/sessions/init` (UserPromptSubmit → `hook claude-code session-init`). Leading tokens seen in `user_prompts`: `/make-plan`, `/do`, `/mem-search`, `/babysit`, `/claude-mem:do`, `/claude-mem:babysit`, `/wowerpoint`, `/oh-my-issues` | `plugin/hooks/hooks.json:36-44`; `src/cli/handlers/session-init.ts:56,76,113-119`; `SessionRoutes.ts:440-446` (schema, `prompt: z.string().optional()`), `:569` (`handleSessionInitByClaudeId`); read-only query of `~/.claude-mem/claude-mem.db` `user_prompts` leading token |
| Session-init handler order: internal-protocol skip `:577-581` → byte-cap truncation `:585-598` → `createSDKSession` `:610` → `stripMemoryTags` `:628` → private-prompt skip `:630-643` → `findRecentDuplicateUserPrompt` `:645-667` → **`store.saveUserPrompt(...)`** (first line after the duplicate block) | `SessionRoutes.ts:569-680` |

### 0.3 Telemetry stack (allowed surface)

| Fact | Evidence |
|---|---|
| `captureEvent(event: string, props?: Record<string, unknown>, opts?: { person?: boolean }): void` — sync, fire-and-forget, never throws (outer try/catch logs `'Telemetry: captureEvent failed; event dropped'`) | `src/services/telemetry/telemetry.ts:489-501` |
| Order inside: `if (isShutdown \|\| !hasConsent()) return;` → `scrubProperties({ ...buildBaseProperties(), ...props })` → `$set` / `$process_person_profile:false` → `CLAUDE_MEM_TELEMETRY_DEBUG === '1'` prints to stderr and returns → `getClient().capture({ distinctId: getOrCreateInstallId(), event, properties })` | `telemetry.ts:515-543` |
| Consent chain: `DO_NOT_TRACK` → `CLAUDE_MEM_TELEMETRY` → `telemetry.json` → default on; 30s TTL cache | `consent.ts:39-63`; `telemetry.ts:30-41` |
| `ALLOWED_PROPERTY_KEYS: Set<string>` built from a flat array literal, blocks preceded by a `//` comment naming the event family and asserting closed-enum-ness; closes at `]);` | `scrub.ts:8` (open), `:197-198` (close). Comment-block style: `:24-34`, `:118-125`, `:172-177` |
| `scrubProperties(props): Record<string, string\|number\|boolean>` — whitelisted primitives only; strings truncated at 200 (`MAX_STRING_LENGTH` `:199`); everything else dropped **silently** | `scrub.ts:206-241` |
| Existing whitelisted keys reusable without change: `ide` (`:28`), `outcome` (`:20`), `endpoint` (`:27`), `hook_type` (`:122`) | `scrub.ts` |
| Closed-enum precedents to copy: `Set` + `has(x) ? x : 'other'` (`SearchRoutes.ts:121-127`); `as const` tuple + membership filter → `null` (`worker-utils.ts:755-772`); JS bucketing of a user-influenceable platform string (`backfill.ts:300-315`) | — |
| `ide` is already sent as raw normalized platformSource by three sites | `ResponseProcessor.ts:533`, `SessionRoutes.ts:336,382`, `ClaudeProvider.ts:311` |
| `instrument.ts` does not exist; `instrument(` has 0 call sites in `src/` (only an unrelated test helper) | `ls src/services/telemetry/`; grep |
| Test harness: `posthog-node` mocked globally in `tests/preload.ts` (bunfig preload); assert via `postHogCaptureCalls[i].event` / `.properties`; force consent with env + `__resetTelemetryForTests()` | `tests/preload.ts:41-100`; `tests/telemetry/telemetry-client.test.ts:20-69` |
| Ingest test harness (real in-memory `SessionStore`, `setIngestContext` with fakes, logger spies, payload factory) | `tests/worker/ingest-tool-uses-dual-write.test.ts:1-55` |
| Repo-dir-reading test precedent (`projectRoot` resolve) | `tests/infrastructure/plugin-distribution.test.ts:9-13,42-43` |
| Whitelist negative test to extend | `tests/telemetry/scrub.test.ts:265-269` |
| Test runner: `bun test tests` (`package.json:98`); telemetry-only: `bun test tests/telemetry/` | — |

### 0.4 Skills inventory + docs/CLI surfaces

| Fact | Evidence |
|---|---|
| 19 skill dirs, all with `SKILL.md`; `plugin/skills/` is the ONLY source (no `src/skills/`, no build-time copy step; build only verifies 7 files exist and copies one explainer md in) | `ls plugin/skills/`; `scripts/build-hooks.js:673-681, 692-699`; `package.json:59` |
| Sibling copies are hand-maintained: `cowork/skills/{mem-search,mem-setup}`, `claude-mem-cursor/skills/{install,mem-search}`, `claude-mem-grok-bot/skills/{host-observer,install,mem-search}`, `openclaw/skills/{do,make-plan}` (byte-identical to plugin) | md5 comparison |
| No constant enumerating bundled skill names exists in `src/` | grep `make-plan`, `BUNDLED_SKILL`, `KNOWN_SKILLS` → 0 |
| Other hosts: `codex.ts:68,92`, `cursor.ts:43`, `raw.ts:15`, `antigravity-cli.ts:24,51` forward `tool_name` verbatim; `windsurf.ts` synthesizes a closed set of 4 names (no skill concept). None special-cases `Skill`. Coverage on non-Claude hosts is therefore "whatever the host sends", unverified | `src/cli/adapters/*.ts` |
| `docs/public/telemetry.mdx` (269 lines): properties table header `:46-47` rows to `:123`; Events table header `:129-130` rows to `:147`; never-collected table `:199-209`; GFM pipe tables, separator `\|---\|---\|---\|` | — |
| Stale doc paragraph claiming `instrument()` in `src/services/telemetry/instrument.ts` | `telemetry.mdx:20-25` |
| CLI disclosure: `EVENT_NAMES` `src/npx-cli/commands/telemetry.ts:84-95`; `COLLECTED_FIELDS` `:23-82` (fixed-width strings, 2-line form at `:47-48`); rendered only in `runTelemetryEnable` `:140-159`. No tests import this file | — |
| The only written "keep these in sync" rule | `src/shared/worker-utils.ts:748-753` (scrub comment + CLI disclosure + telemetry.mdx) |
| Changelog is auto-generated — never edit | `CLAUDE.md:31-33` |

### 0.5 Allowed APIs (only these — do not invent others)

- `captureEvent(event, props?, opts?)` — `src/services/telemetry/telemetry.ts:489`
- `scrubProperties(props)` / `ALLOWED_PROPERTY_KEYS` — `src/services/telemetry/scrub.ts:231`, `:8`
- `normalizePlatformSource(value)` — `src/shared/platform-source.ts:7`
- `logger.debug(component, message, context?)` — `src/utils/logger.ts:296` (same shape as the `logger.warn` at `shared.ts:157`)
- `ingestObservation` / `setIngestContext` (tests only) — `shared.ts:65`, `:23`
- Test spies: `postHogCaptureCalls`, `postHogConstructorCalls` — `tests/preload.ts:42-43`; `__resetTelemetryForTests` — `telemetry.ts:552`
- Node `fs.readdirSync`, `fs.existsSync`, `path.resolve` (allowlist parity test)

### 0.6 Anti-patterns (hard rules for the implementer)

- **Never read, log, hash, truncate, or forward `toolInput.args`.** Extract `toolInput.skill` only, via a typed narrow (`typeof x === 'string'`), then immediately map it to the closed enum. The raw string must not be assigned to any variable that outlives the classification function.
- Never pass the raw `skill` string (or the raw prompt, or its leading token) into `captureEvent`. The whitelist truncation is a length guard, not a cardinality guard.
- Never add keys to `captureEvent` props that are not in `ALLOWED_PROPERTY_KEYS` — they vanish silently and you will think the feature works.
- Do not use `telemetryBuffer.record(...)` for this event (that API rolls up `session_compressed` / `context_injected` only).
- Do not touch `CLAUDE_MEM_SKIP_TOOLS` in `SettingsDefaultsManager.ts:146` or any of its four documentation copies.
- Do not add a settings key or env var for skill telemetry; consent is env / `telemetry.json` only (precedent §0.5).
- Do not build `instrument.ts` in this PR (A-3).
- Do not emit from the hook process (`captureCliEvent` in `observation.ts`) — PostToolUse is the hottest hook path (research §3.3-B rejected).
- Do not wrap the new code in try/catch beyond what `captureEvent` already provides; a throw in classification is a bug that should surface in tests.
- Do not edit `plugin/scripts/*.cjs` or `CHANGELOG.md`.
- Do not use `person: true`.
- Do not read `args`, `cwd`, `project`, `contentSessionId`, `agentId`, or `toolUseId` into the event.

---

## Phase 1 — Skill-id classification module + whitelist keys

**Depends on:** nothing. **Blocks:** Phases 2-4.

### 1.1 New file `src/services/telemetry/skill-id.ts`

Pure functions, no I/O, no imports from worker code (so `scrub.test.ts`-style unit tests can import it cheaply).

```ts
// src/services/telemetry/skill-id.ts
/**
 * Closed enum of the skills claude-mem ships in plugin/skills/. Pinned by
 * tests/telemetry/skill-id.test.ts to the directory listing so a new skill
 * cannot silently be reported as `other`. Third-party skill names are user
 * inventory and are NEVER reported — they collapse to { other, third_party }.
 */
export const FIRST_PARTY_SKILL_IDS = [
  'babysit', 'cloud-sync', 'design-is', 'do', 'how-it-works', 'knowledge-agent',
  'learn-codebase', 'make-plan', 'mem-search', 'mode-creator', 'oh-my-issues',
  'pathfinder', 'smart-explore', 'standup', 'timeline-report', 'version-bump',
  'weekly-digests', 'what-the', 'wowerpoint',
] as const;
export type FirstPartySkillId = (typeof FIRST_PARTY_SKILL_IDS)[number];

export const FIRST_PARTY_SKILL_NAMESPACE = 'claude-mem';

export type SkillSource = 'claude-mem' | 'third_party';
export type SkillTrigger = 'tool' | 'prompt';
export type SkillIdeBucket = 'claude' | 'codex' | 'cursor' | 'windsurf' | 'antigravity' | 'other';

export interface SkillInvocationProps {
  skill_id: FirstPartySkillId | 'other';
  skill_source: SkillSource;
}

/**
 * Map a raw Skill-tool identifier ("claude-mem:make-plan", "make-plan",
 * "superpowers:make-plan", "hyperframes") to the closed enum. The raw string
 * never leaves this function. Returns null for non-string input.
 */
export function classifySkillId(raw: unknown): SkillInvocationProps | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const idx = raw.indexOf(':');
  const ns = idx === -1 ? null : raw.slice(0, idx);
  const name = idx === -1 ? raw : raw.slice(idx + 1);
  const isOurNamespace = ns === null || ns === FIRST_PARTY_SKILL_NAMESPACE;   // A-6, A-7
  if (isOurNamespace && (FIRST_PARTY_SKILL_IDS as readonly string[]).includes(name)) {
    return { skill_id: name as FirstPartySkillId, skill_source: 'claude-mem' };
  }
  return { skill_id: 'other', skill_source: 'third_party' };               // A-1
}

/**
 * Leading-token match for a user-typed slash command. Reads at most the first
 * whitespace-delimited token of `prompt`; the prompt itself is never retained.
 * Returns null unless the token is /<id> or /claude-mem:<id> for a first-party
 * id (A-9: nothing is reported for builtins or unknown commands).
 */
export function classifyTypedSkillPrompt(prompt: unknown): SkillInvocationProps | null {
  if (typeof prompt !== 'string') return null;
  const m = /^\s*\/(?:([a-z0-9-]+):)?([a-z0-9-]+)(?=\s|$)/i.exec(prompt.slice(0, 128));
  if (!m) return null;
  const [, ns, name] = m;
  if (ns && ns !== FIRST_PARTY_SKILL_NAMESPACE) return null;
  return (FIRST_PARTY_SKILL_IDS as readonly string[]).includes(name)
    ? { skill_id: name as FirstPartySkillId, skill_source: 'claude-mem' }
    : null;
}

/** A-8: platformSource is user-influenceable (platform-source.ts:18); bucket in JS like backfill.ts:300-315. */
export function bucketSkillIde(platformSource: string): SkillIdeBucket {
  switch (platformSource) {
    case 'claude': case 'codex': case 'cursor': case 'windsurf': case 'antigravity':
      return platformSource;
    default:
      return 'other';
  }
}
```

Copy the `as const` tuple + `includes` narrowing from `src/shared/worker-utils.ts:755-772`. Copy the `switch`-bucket idea from `src/services/telemetry/backfill.ts:310-314`.

### 1.2 `src/services/telemetry/scrub.ts` — three new keys

Insert a new comment block immediately before the closing `]);` at `scrub.ts:197-198`, matching the house style at `scrub.ts:118-125`:

```ts
  // skill_invoked — skill_id is one of OUR bundled skill directory names
  // (plugin/skills/, pinned by tests/telemetry/skill-id.test.ts) or the
  // literal 'other'; skill_source is claude-mem | third_party; skill_trigger is
  // tool | prompt. Third-party skill names are user inventory and never sent.
  // The Skill tool's `args` field is raw user intent and is never read.
  'skill_id',
  'skill_source',
  'skill_trigger',
```

Do **not** add `skill_name`, `skill_version`, `skill_args`, or anything else.

### 1.3 Tests (Phase 1)

New `tests/telemetry/skill-id.test.ts` (shape: `tests/telemetry/scrub.test.ts:1-30`; dir reading: `tests/infrastructure/plugin-distribution.test.ts:9-13`):

1. **Allowlist parity** — `readdirSync(resolve(projectRoot, 'plugin/skills'))` filtered to dirs containing `SKILL.md`, sorted, `toEqual([...FIRST_PARTY_SKILL_IDS].sort())`. This is the test that fails when someone adds a skill.
2. `classifySkillId('claude-mem:make-plan')` → `{ skill_id: 'make-plan', skill_source: 'claude-mem' }`.
3. `classifySkillId('make-plan')` → first-party (A-6).
4. `classifySkillId('superpowers:make-plan')` → `{ other, third_party }` (A-7).
5. `classifySkillId('hyperframes')`, `('claude-api')` → `{ other, third_party }`; assert the returned object's values never contain the input string.
6. `classifySkillId(undefined)`, `(42)`, `('')`, `('   ')` → `null`.
7. `classifyTypedSkillPrompt('/claude-mem:do plans/x.md')` → `do`; `('/make-plan fix it')` → `make-plan`; `('/clear')`, `('/loop 5m /foo')`, `('/superpowers:do')`, `('do it')`, `('')`, `(undefined)` → `null`; a 10 KB prompt starting with `/mem-search` still classifies (slice guard).
8. `bucketSkillIde('claude')` → `'claude'`; `('grok-bot')`, `('raw')`, `('')` → `'other'`.

Extend `tests/telemetry/scrub.test.ts`:
- Positive: `scrubProperties({ skill_id: 'mem-search', skill_source: 'claude-mem', skill_trigger: 'tool' })` → equal.
- Negative (extend `:265-269` list): `'skill_name'`, `'skill_args'`, `'args'`, `'skill'` are **not** in `ALLOWED_PROPERTY_KEYS`.

### 1.4 Verification checklist (Phase 1)

```
bun test tests/telemetry/skill-id.test.ts tests/telemetry/scrub.test.ts
grep -n "'skill_id'\|'skill_source'\|'skill_trigger'" src/services/telemetry/scrub.ts      # 3 hits
grep -rn "args" src/services/telemetry/skill-id.ts                                          # 0 hits
ls plugin/skills | wc -l                                                                     # 19, matches tuple length
npx tsc --noEmit -p .
```

### 1.5 Anti-pattern guards (Phase 1)

- The module must not import anything from `src/services/worker/` or `src/cli/`.
- No regex over the whole prompt; `slice(0, 128)` before matching, anchored `^`.
- No `toLowerCase()` of the raw skill id before the allowlist check that would widen matches silently — the ids are already lowercase-kebab; keep exact match.

---

## Phase 2 — Emit `skill_invoked` at the worker skip gate (tool-triggered)

**Depends on:** Phase 1. **This is research Option A.**

### 2.1 `src/services/worker/http/shared.ts`

Add imports after line 12:

```ts
import { captureEvent } from '../../telemetry/telemetry.js';
import { classifySkillId, bucketSkillIde } from '../../telemetry/skill-id.js';
```

Replace the gate at `shared.ts:78-83` with:

```ts
  const skipTools = new Set(
    settings.CLAUDE_MEM_SKIP_TOOLS.split(',').map(t => t.trim()).filter(Boolean)
  );
  if (skipTools.has(payload.toolName)) {
    // Skill is skipped by default (SettingsDefaultsManager.ts CLAUDE_MEM_SKIP_TOOLS),
    // so this is the only place a model-chosen skill invocation is visible to
    // the worker. Emit a closed-enum adoption counter and still skip the
    // observation. Only `toolInput.skill` is read; `args` is raw user intent and
    // is never touched (docs/public/telemetry.mdx "never collected").
    if (payload.toolName === 'Skill') {
      const input = payload.toolInput && typeof payload.toolInput === 'object'
        ? (payload.toolInput as { skill?: unknown })
        : undefined;
      const classified = classifySkillId(input?.skill);
      if (classified) {
        captureEvent('skill_invoked', {
          ...classified,
          skill_trigger: 'tool',
          ide: bucketSkillIde(platformSource),
        });
      } else {
        logger.debug('INGEST', 'Skill call without a string skill id; no telemetry emitted');
      }
    }
    return { ok: true, status: 'skipped', reason: 'tool_excluded' };
  }
```

Notes:
- The emit stays **inside** the `skipTools.has(...)` branch so a user who removes `Skill` from their skip list (and therefore gets observations for it) does not get double semantics. If Alex wants the event regardless of the skip list, hoist the `if (payload.toolName === 'Skill')` block above the gate — flagged in §D-4.
- `platformSource` is already the normalized value from `shared.ts:68`.
- `captureEvent` is sync and swallows; no `await`, no try/catch.
- The `project_excluded` return at `:74-76` stays above this; A-4.

### 2.2 Tests (Phase 2)

New `tests/worker/ingest-skill-telemetry.test.ts`, copying the harness from `tests/worker/ingest-tool-uses-dual-write.test.ts:1-55` (in-memory `SessionStore`, `setIngestContext` fakes, logger spies, payload factory) **plus** the telemetry env recipe from `tests/telemetry/telemetry-client.test.ts:20-53` (`CLAUDE_MEM_TELEMETRY='1'`, delete `DO_NOT_TRACK` / `CLAUDE_MEM_TELEMETRY_DEBUG`, `__resetTelemetryForTests()`, `postHogCaptureCalls.length = 0`). Do not set `CLAUDE_MEM_SKIP_TOOLS`; the default already contains `Skill` (assert that in a guard test so the suite fails loudly if the default changes).

Cases:
1. `toolName: 'Skill', toolInput: { skill: 'claude-mem:mem-search', args: '/home/me/secret repo #123' }` → result `{ ok: true, status: 'skipped', reason: 'tool_excluded' }`; `queued.length === 0`; `postHogCaptureCalls` has exactly one call with `event === 'skill_invoked'` and `properties` containing `skill_id: 'mem-search'`, `skill_source: 'claude-mem'`, `skill_trigger: 'tool'`, `ide: 'claude'`, `$process_person_profile: false`.
2. **`args` never leaks:** `JSON.stringify(postHogCaptureCalls[0].properties)` does not contain `'secret'`, `'#123'`, `'/home'`; `Object.keys(properties)` contains none of `args`, `skill`, `cwd`, `project`.
3. Third-party: `{ skill: 'hyperframes', args: 'x' }` → `skill_id: 'other'`, `skill_source: 'third_party'`; stringified properties do not contain `'hyperframes'`.
4. `platformSource: 'grok-bot'` → `ide: 'other'`; `platformSource: 'cursor'` → `ide: 'cursor'`.
5. Non-Skill skipped tool (`TodoWrite`) → skipped, **zero** capture calls.
6. Non-skipped tool (`Read`) → queued, zero `skill_invoked` calls.
7. Malformed: `toolInput: { skill: 42 }`, `toolInput: 'string'`, `toolInput: undefined` → skipped, zero capture calls, no throw.
8. Consent off: set `CLAUDE_MEM_TELEMETRY='0'` + `__resetTelemetryForTests()` → skipped, zero capture calls. Restore afterwards.
9. Project excluded: `process.env.CLAUDE_MEM_EXCLUDED_PROJECTS` pointing at the payload cwd → `reason: 'project_excluded'`, zero capture calls (A-4 pinned).

### 2.3 Verification checklist (Phase 2)

```
bun test tests/worker/ingest-skill-telemetry.test.ts tests/worker/ingest-tool-uses-dual-write.test.ts
grep -n "captureEvent('skill_invoked'" src/services/worker/http/shared.ts     # exactly 1
grep -n "\.args\|args:" src/services/worker/http/shared.ts                     # 0 new hits
npx tsc --noEmit -p .
```

### 2.4 Anti-pattern guards (Phase 2)

- Do not stringify `payload.toolInput` before the gate; the existing `JSON.stringify` at `shared.ts:122` is for the observation path only.
- Do not move the gate; do not remove `Skill` from the default skip list.
- Do not add `duration_ms` (there is no start time) or `outcome` (there is no outcome).
- Do not touch the transcript-watcher caller (`processor.ts:243`); it flows through the same function and gets the same behaviour for free.

---

## Phase 3 — Typed invocations at session-init (`skill_trigger: 'prompt'`)

**Depends on:** Phase 1. **Decision-gated: §D-2.** Without this phase, `skill_invoked` under-counts the dominant invocation form (Phase 0 §0.2: typed `/claude-mem:do` ×34 vs tool_use ×4 in the maintainer's own transcripts). The plan's default is **include**, because the signal is a leading-token match against a closed allowlist and never retains prompt text. The one honest caveat: it is the first telemetry code path that *looks at* `prompt` at all, and the docs "never collected" table must say so plainly (Phase 4).

### 3.1 `src/services/worker/http/routes/SessionRoutes.ts`

Add imports after line 22 (next to `telemetryBuffer`):

```ts
import { captureEvent } from '../../../telemetry/telemetry.js';
import { classifyTypedSkillPrompt, bucketSkillIde } from '../../../telemetry/skill-id.js';
```

In `handleSessionInitByClaudeId` (`:569`), immediately **after** `store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt, sessionDbId);` (the first statement after the duplicate-prompt block at `:645-667`), add:

```ts
    // User-typed /claude-mem:<skill> never produces a Skill tool_use (it is a
    // plain user record), so the PostToolUse path in shared.ts cannot see it.
    // Leading-token match only, against the bundled-skill allowlist; the prompt
    // is not retained, no third-party or builtin command is ever reported.
    const typedSkill = classifyTypedSkillPrompt(rawPrompt);
    if (typedSkill) {
      captureEvent('skill_invoked', {
        ...typedSkill,
        skill_trigger: 'prompt',
        ide: bucketSkillIde(platformSource),
      });
    }
```

Placement rationale: after the private-prompt skip (`:630-643`, a fully `<private>` prompt emits nothing) and after dedupe (`:645-667`, a resent prompt emits once). Use `rawPrompt` (the untruncated original) only for the 128-char leading-token slice; `cleanedPrompt` has memory tags stripped and is fine too, but `rawPrompt` avoids any dependence on stripping semantics.

### 3.2 Tests (Phase 3)

New `tests/worker/http/routes/session-routes-skill-telemetry.test.ts`, copying the handler-capture pattern from `tests/worker/http/routes/search-routes-platform-header.test.ts:1-60` (`captureGetHandlers` → adapt to `post`), a real in-memory `SessionStore`, telemetry env recipe as in Phase 2.

Cases:
1. `prompt: '/claude-mem:do plans/2026-07-22-cmem-launch.md and ship it'` → one `skill_invoked` with `skill_id: 'do'`, `skill_trigger: 'prompt'`; stringified properties do not contain `'plans/'` or `'cmem-launch'`.
2. `'/make-plan fix ALE-315'` → `make-plan`.
3. `'/clear'`, `'/loop 5m /babysit'`, `'/superpowers:do x'`, `'hello'` → zero capture calls.
4. Same prompt POSTed twice within the dedupe window → exactly one capture call.
5. `'<private>/claude-mem:do secret</private>'` → skipped `reason: 'private'`, zero capture calls.
6. Internal protocol payload → skipped `internal_protocol`, zero capture calls.
7. Consent off → zero capture calls.

### 3.3 Verification checklist (Phase 3)

```
bun test tests/worker/http/routes/session-routes-skill-telemetry.test.ts
grep -n "captureEvent('skill_invoked'" src/services/worker/http/routes/SessionRoutes.ts   # exactly 1
grep -n "classifyTypedSkillPrompt(rawPrompt)\|classifyTypedSkillPrompt(cleanedPrompt)" src/services/worker/http/routes/SessionRoutes.ts  # 1
```

### 3.4 Anti-pattern guards (Phase 3)

- Never pass `prompt`, `rawPrompt`, `cleanedPrompt`, `project`, `customTitle`, or `contentSessionId` into `captureEvent`.
- Do not emit before the private / duplicate checks.
- Do not add a `command`, `slash_command`, or `prompt_prefix` property. Only the three Phase 1 keys plus `ide`.
- Do not use `telemetryBuffer` here even though it is imported in this file for `session_compressed`.

---

## Phase 4 — Docs + CLI disclosure (the four surfaces)

**Depends on:** Phases 1-3 (property names final). Can run in parallel with Phase 2/3 tests.

### 4.1 `docs/public/telemetry.mdx`

Properties table (append rows after `:123`, same GFM syntax as `:48-49`):

```
| `skill_id` | `mem-search` | Which bundled claude-mem skill was invoked — one of the 19 names in `plugin/skills/`, or `other` |
| `skill_source` | `claude-mem` | `claude-mem` for a bundled skill, `third_party` for anything else. Third-party skill names are never sent |
| `skill_trigger` | `prompt` | `tool` when the model chose the skill, `prompt` when you typed `/claude-mem:<skill>` |
```

Events table (append after `:147`):

```
| `skill_invoked` | A bundled skill is invoked, by the model (Skill tool) or by typing `/claude-mem:<skill>` | `skill_id`, `skill_source`, `skill_trigger`, `ide` |
```

"Never collected" table (append after `:209`) — this row is mandatory for Phase 3 honesty:

```
| Skill arguments or the text of a `/slash-command` | For a typed `/claude-mem:<skill>`, only the leading command token is compared against the bundled-skill list; the prompt itself is neither stored by telemetry nor sent. Third-party skill names are never sent |
```

Do **not** rewrite `:20-25` (`instrument()`) in this PR — §D-7.

### 4.2 `src/npx-cli/commands/telemetry.ts`

- `EVENT_NAMES` (`:84-95`): add `'skill_invoked',` after `'search_performed',`.
- `COLLECTED_FIELDS` (`:23-82`): add three entries in the fixed-width style of `:47-48`:
  ```
  'skill_id               which bundled claude-mem skill was invoked (or "other")',
  'skill_source           claude-mem | third_party (third-party names never sent)',
  'skill_trigger          tool | prompt (model-chosen vs typed /claude-mem:<skill>)',
  ```
- Leave the stale entries alone (A-13, §D-8).

### 4.3 `src/shared/worker-utils.ts:748-753` sync comment

No code change; confirm the implementer read it. Optional: add `skill-id.ts` to the list of mirrored surfaces in that comment (one line).

### 4.4 Verification checklist (Phase 4)

```
grep -c "skill_invoked" docs/public/telemetry.mdx            # >= 1
grep -c "skill_id\|skill_source\|skill_trigger" docs/public/telemetry.mdx   # >= 3
grep -n "skill_invoked" src/npx-cli/commands/telemetry.ts    # 1
grep -n "skill_" src/npx-cli/commands/telemetry.ts | wc -l   # 4
```
Render check: Mintlify preview (`npx mintlify dev` in `docs/public/`) or eyeball the three tables for column count = separator count.

---

## Phase 5 — Final verification

1. `npx tsc --noEmit -p .` clean.
2. `npm run build` succeeds (build verifies skill files exist, `scripts/build-hooks.js:692-699`; nothing there changes).
3. `bun test tests` full suite green (the global PostHog mock in `tests/preload.ts` guarantees no real events are sent during tests).
4. Anti-pattern greps (all must be empty):
   ```
   grep -rn "toolInput.args\|input.args\|\.args\b" src/services/worker/http/shared.ts src/services/telemetry/skill-id.ts
   grep -rn "skill_name\|skill_args\|prompt_prefix\|slash_command" src/services/telemetry/scrub.ts
   grep -rn "captureCliEvent('skill" src/cli/
   grep -rn "instrument(" src/
   git diff --stat main -- src/shared/SettingsDefaultsManager.ts plugin/scripts/ CHANGELOG.md   # empty
   grep -rn "person: true" src/services/worker/http/shared.ts src/services/worker/http/routes/SessionRoutes.ts   # empty
   ```
5. Allowlist parity: `bun test tests/telemetry/skill-id.test.ts` (fails if `plugin/skills/` and the tuple differ).
6. Live smoke, debug mode, no network:
   ```
   CLAUDE_MEM_TELEMETRY_DEBUG=1 npm run build-and-sync
   # in a Claude Code session on this repo: let the model invoke a skill AND type /claude-mem:what-the
   # expect two stderr lines from the worker log: [telemetry] {"event":"skill_invoked", ... "skill_trigger":"tool"} and ..."prompt"
   # confirm neither line contains the args text or the prompt text
   ```
7. Opt-out smoke: `CLAUDE_MEM_TELEMETRY=0` → repeat step 6, expect zero `[telemetry]` lines.
8. Open PR against `main`; run `/claude-mem:babysit`; merge; then `/claude-mem:version-bump` **MINOR** (new event = new disclosed behaviour), per the version-bump skill. Do not publish to npm from the agent.

---

## Phase 6 (optional, later) — Real outcome signal for script-bearing skills

**Not part of v1. Depends on:** Phase 2 shipping and ~2 weeks of data showing `mode-creator` / `standup` / `version-bump` volume worth the packaging cost. Research §3.3-C.

- Targets: `plugin/skills/mode-creator/scripts/install-mode.mjs`, `plugin/skills/mode-creator/scripts/configure-telegram.mjs`, `plugin/skills/standup/standup.mjs`, `plugin/skills/version-bump/scripts/generate_changelog.js`.
- Transport: `captureCliEvent('skill_completed', { skill_id, outcome, duration_ms })` — the `hook_failed` pattern (`src/cli/hook-command.ts:153-165`).
- Blocker to solve first: those scripts run standalone under `node` and cannot import from `src/`; they would need a tiny built entry in `plugin/scripts/` (a build-time change, its own plan).
- New whitelist keys would be **none** (`outcome`, `duration_ms` already exist) but `skill_completed` needs its own docs row and `EVENT_NAMES` entry.

## Phase 7 (optional) — PostHog side

After ~2 weeks of data: one insight, "skill_invoked by skill_id, split by skill_trigger and ide, per version". **No custom scout** (Alex declined both proposed scouts in the 2026-07-14 self-driving setup; research §2.5).

---

## D. Open questions for LFG / Az PASS (defaults in §A apply if unanswered)

1. **Third-party bucketing** — confirm A-1 (`other` / `third_party`, never named) over dropping entirely.
2. **Phase 3 (typed prompts)** — include in v1? It is the majority of real usage and the only way to see `/claude-mem:do`. Cost: first telemetry code that inspects a prompt's leading token; mitigated by the "never collected" row. Default: **include**.
3. **`ide` bucketing** — A-8 buckets to a closed enum, which differs from the three existing sites that send the raw normalized platformSource. Alternative: send `platformSource` as-is for consistency. Default: bucket.
4. **Emit inside vs. regardless of the skip list** — Phase 2 emits only when `Skill` is actually skipped (the default). If a user removes `Skill` from `CLAUDE_MEM_SKIP_TOOLS`, they get observations and no `skill_invoked`. Hoist the block above the gate to count both? Default: inside (simpler, no double-path).
5. **Unprefixed match** — A-6 counts bare `make-plan` as first-party. Accept the collision with a user's own skill of the same name?
6. **Project exclusion** — A-4 keeps excluded projects silent for skill events.
7. **Stale `instrument()` docs paragraph** (`telemetry.mdx:20-25`) — fix in this PR, separately, or build the layer? Default: separate docs-only PR.
8. **Bundled cleanup** of stale `EVENT_NAMES` / `COLLECTED_FIELDS` (`session_compressed`, `context_injected`, `error_occurred` never emitted; `usage_limit_hit`, rollups, oauth/trial events, `observed_*` missing) — same PR or separate? Default: separate.
9. **Version bump** — MINOR (new disclosed event) vs PATCH. Default: MINOR.
10. **Non-Claude hosts** — Codex / Cursor / OpenClaw / Cowork coverage is "whatever `tool_name` they send"; none is verified to emit a `Skill`-shaped tool. Accept `ide` as a best-effort dimension for v1?

---

## Appendix A — Rejected, with reasons (do not re-propose)

- **Hook-process emit (`captureCliEvent` in `observation.ts`)** — PostToolUse is the hottest hook path; a 2s-capped network call per tool use is unacceptable. Research §3.3-B.
- **Derive only from existing worker signals (`search_performed`, `/api/corpus`)** — cannot attribute to a skill, blind to `make-plan` / `do` / `smart-explore`. Research §3.3-D; useful only as corroboration.
- **Asking the model to self-report in SKILL.md prose** — unreliable, costs tokens, risks the model echoing `args`. Research §3.1-d.
- **`skill_completed` / `duration_ms` from PostToolUse** — measures instruction-load latency, not work. Would mislead every dashboard built on it.
- **Reporting raw third-party skill names** — user inventory; equivalent to "installed software" telemetry.
- **A `skill_invoked_rollup` via `telemetryBuffer`** — premature; volume is tiny. Revisit only if PostHog volume proves otherwise.
- **Removing `Skill` from `CLAUDE_MEM_SKIP_TOOLS` to get observations instead** — changes memory behaviour for every user to serve an analytics need; out of scope and would flood the observer with instruction text.

## Appendix B — File touch list (for `/do`)

| File | Phase | Change |
|---|---|---|
| `src/services/telemetry/skill-id.ts` | 1 | new |
| `src/services/telemetry/scrub.ts` | 1 | +3 keys, +1 comment block before `]);` (`:197`) |
| `tests/telemetry/skill-id.test.ts` | 1 | new |
| `tests/telemetry/scrub.test.ts` | 1 | +positive case, +negative keys |
| `src/services/worker/http/shared.ts` | 2 | +2 imports, emit inside skip gate (`:78-83`) |
| `tests/worker/ingest-skill-telemetry.test.ts` | 2 | new |
| `src/services/worker/http/routes/SessionRoutes.ts` | 3 | +2 imports, emit after `saveUserPrompt` in `handleSessionInitByClaudeId` |
| `tests/worker/http/routes/session-routes-skill-telemetry.test.ts` | 3 | new |
| `docs/public/telemetry.mdx` | 4 | +3 property rows, +1 event row, +1 never-collected row |
| `src/npx-cli/commands/telemetry.ts` | 4 | +1 `EVENT_NAMES`, +3 `COLLECTED_FIELDS` |

Nothing else. In particular not: `SettingsDefaultsManager.ts`, `plugin/hooks/hooks.json`, any `SKILL.md`, `plugin/scripts/*`, `CHANGELOG.md`, `common.ts` (`PERSON_PROPERTY_KEYS`), `buffer.ts`.
