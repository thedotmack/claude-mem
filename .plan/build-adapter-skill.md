# Plan: `build-adapter` skill for claude-mem

**Goal:** ship a claude-mem skill that, given any target agent/IDE/CLI, produces a merged-quality PR adding a claude-mem adapter for it — in one shot, with minimal user intervention.

**Deliverable:** `plugin/skills/build-adapter/SKILL.md` (single file, ~80 lines). Auto-discovered; no manifest edits.

**Design principle:** the skill is *not* a system. It is **one well-crafted prompt for `/claude-mem:make-plan`** that tells make-plan to run two Phase 0 research tracks in parallel. All the leverage is already in `make-plan` and `do` — this skill just hands them the right assignment.

---

## Why this shape

`make-plan` already:
- Deploys parallel Explore subagents for fact-gathering
- Forces every claim to cite sources (file:line / URL + quote)
- Synthesizes phased plans with verification checklists and anti-pattern guards

`do` already:
- Executes phased plans with fresh subagent contexts per phase
- Requires evidence, runs verification + code review
- Handles branching, committing, PR creation per the ship pattern

So `build-adapter` doesn't need its own workflow, reference files, templates, or interview. It needs to:
1. Tell make-plan to research **both** claude-mem's adapter contract **and** the target platform's extension API, in parallel
2. Pin the authoritative claude-mem source files as anchors
3. Name `src/cli/adapters/cursor.ts` as the copy-from template
4. Hand off to `do` for execution + PR

That's the entire skill.

---

## What the skill does, end-to-end

User types: `/build-adapter <TARGET>` (e.g., `/build-adapter zed`, `/build-adapter "codex CLI"`, `/build-adapter aider`).

1. Skill loads. Contains the dual-track research brief below.
2. Skill invokes `/claude-mem:make-plan` with the brief, substituting `<TARGET>`.
3. `make-plan` fires two Phase 0 subagents in parallel:
   - **Track A** reads claude-mem source (adapter interface, HookInput, HTTP routes, DB schema, hook manifest pattern)
   - **Track B** researches the target (WebSearch, WebFetch, mcp-deepwiki) for extension API, lifecycle events, tool-use format, session identity, prior art
4. `make-plan` synthesizes a phased implementation plan grounded in both tracks.
5. Skill shows the plan, asks user for approval.
6. On approval, skill invokes `/claude-mem:do` against the plan.
7. `do` writes `src/cli/adapters/<target>.ts`, registers it in `index.ts`, adds hook manifest if applicable, smoke-tests, commits, opens PR.

User appears at two gates: plan approval and PR merge. Everything else is automatic.

---

## Implementation phases

### Phase 0 — Discovery (already done)

The research grounding this plan is complete. Authoritative facts:

| Surface | Location | Role in adapter |
|---|---|---|
| `Adapter` interface | `src/cli/adapters/index.ts` | Normalizer + formatter contract every adapter implements |
| Best exemplars | `src/cli/adapters/cursor.ts`, `gemini-cli.ts` | Copy-from templates (NOT `claude-code.ts` — too special-cased) |
| `HookInput` schema | `src/cli/hook-command.ts:79–81` | Canonical fields adapters must emit |
| Ingestion API | `src/services/worker/http/routes/SessionRoutes.ts:555–748` | `POST /api/sessions/observations`, `POST /api/sessions/summarize`, `GET /api/sessions/status` |
| DB schema | `src/services/sqlite/migrations.ts:217–296` | Tables adapter data ultimately lands in |
| Hook registration example | `plugin/hooks/hooks.json:1–96` | Reference manifest pattern |
| Skill conventions | `plugin/skills/{make-plan,do,mem-search}/SKILL.md` | Frontmatter: `name` + `description` only |
| PR convention | Recent `git log` | `feat(adapter): add <target> adapter` |

**Anti-patterns confirmed:**
- Don't edit `CHANGELOG.md` (auto-generated per `CLAUDE.md:94`)
- Don't add a skills-registry manifest (skills auto-discover from `plugin/skills/`)
- Don't populate `agent_id`/`agent_type` unless target has true subagents
- Don't `--no-verify` / `--amend` / force-push
- Don't invent endpoints beyond SessionRoutes

### Phase 1 — Write `SKILL.md`

**What to implement:** Create `plugin/skills/build-adapter/SKILL.md` with this exact shape:

```markdown
---
name: build-adapter
description: Use when the user wants claude-mem to work with a new agent, IDE,
  or CLI (Cursor, Zed, Aider, Codex, custom agents, etc.). Researches both
  claude-mem's adapter contract and the target platform's extension API in
  parallel via make-plan, executes the plan via do, and opens a PR. Trigger
  phrases: "add claude-mem support for X", "build a claude-mem adapter for X",
  "integrate claude-mem with X", "make claude-mem work with X".
---

# build-adapter

## When to use
The user names a target agent, IDE, or CLI tool they want claude-mem to work
with. Examples: Zed, Aider, Codex CLI, Continue, a custom in-house agent.

## The one-shot

Invoke `/claude-mem:make-plan` with the brief below, **verbatim**, substituting
`<TARGET>` with the user's target platform name.

make-plan already knows how to orchestrate parallel Phase 0 discovery. This
brief tells it exactly what to research and what anchors to use.

## The brief (paste into make-plan)

> Build a claude-mem adapter for **<TARGET>**.
>
> **Deploy two Phase 0 discovery tracks in parallel.**
>
> ### Track A — claude-mem integration contract
>
> Explore subagent reads and reports file:line facts from:
> - `src/cli/adapters/index.ts` — the `Adapter` interface (normalizeInput,
>   formatOutput, registration)
> - `src/cli/adapters/cursor.ts` and `src/cli/adapters/gemini-cli.ts` — use
>   these as copy-from templates. Do NOT use `claude-code.ts` (too special-cased).
> - `src/cli/hook-command.ts` — canonical `HookInput` schema
> - `src/services/worker/http/routes/SessionRoutes.ts` — ingestion endpoints
>   (`POST /api/sessions/observations`, `POST /api/sessions/summarize`,
>   `GET /api/sessions/status`)
> - `src/services/sqlite/migrations.ts` — DB schema the adapter writes into
> - `plugin/hooks/hooks.json` — hook registration pattern (if the
>   target has a hook mechanism)
>
> Report must include: exact `Adapter` TS interface, the `HookInput` field
> list, the three ingestion endpoints with request/response shapes, and a
> one-line diff between `cursor.ts` and `gemini-cli.ts` showing what varies
> between adapters.
>
> ### Track B — <TARGET> platform surface
>
> Research subagent uses `WebSearch`, `WebFetch`, and `mcp-deepwiki` (if
> <TARGET> is on GitHub) to report:
> - Extension/plugin/hook mechanism (name, registration location, config
>   schema)
> - Lifecycle events it emits (session start, user message, tool use, session
>   end)
> - Tool-use message format
> - Session identity — is there a stable session ID the adapter can read?
> - Working-directory / project-context propagation
> - Prior art — existing memory, observability, or logging plugins that
>   already hook these events. Copy their patterns.
>
> Report must cite URLs + quoted snippets, not paraphrase. Reject and
> redeploy if the subagent returns conclusions without sources.
>
> ### Synthesis
>
> Plan the implementation as phases that COPY from `cursor.ts` and adjust
> only where Track B says <TARGET> diverges.
>
> - New file: `src/cli/adapters/<target>.ts`
> - Register in `src/cli/adapters/index.ts`
> - If <TARGET> has a hook mechanism, add a manifest under `plugin/` or the
>   appropriate location, mirroring `plugin/hooks/hooks.json`
> - If <TARGET> has no hook mechanism, plan uses direct HTTP POSTs to the
>   worker instead
> - Tests mirror in `tests/cli/adapters/<target>.test.ts` if test convention
>   applies
>
> ### Anti-patterns (MUST NOT)
>
> - Don't invent endpoints not in `SessionRoutes.ts`
> - Don't populate `agent_id` / `agent_type` unless <TARGET> has true subagents
> - Don't edit `CHANGELOG.md` (auto-generated)
> - Don't add a skills-registry manifest
> - Don't `--no-verify` / `--amend` / force-push
> - Don't use `claude-code.ts` as the copy-from template
>
> ### Final phase
>
> - Smoke test: `npm run build-and-sync`, then POST a synthetic observation
>   to `/api/sessions/observations`, confirm it lands via `GET /api/sessions/status`
> - `git checkout -b adapter/<target>`
> - Commit: `feat(adapter): add <target> adapter`
> - `gh pr create` against `main` with a body summarizing both research tracks
>   and linking the key sources

## After make-plan returns

1. Show the user the plan. Wait for approval.
2. On approval, invoke `/claude-mem:do` on the plan.
3. `do` handles verification, commit, and PR creation per its own contract.

## Stop conditions

- Target has no documented extension API and no public repo → ask the user
  for a docs URL before starting Track B
- Track B finds no session-ID mechanism → flag to user; a direct-HTTP
  adapter may still be viable but needs explicit session-ID assignment
- `do` verification fails → do NOT open the PR; return control to user
```

**Documentation references:**
- Skill format: `plugin/skills/make-plan/SKILL.md:1–4` (frontmatter pattern)
- Description tone: skill-creator guidance — pushy, explicit triggers, multiple phrasings

**Verification:**
- `head -4 plugin/skills/build-adapter/SKILL.md` shows valid YAML frontmatter
- `wc -l plugin/skills/build-adapter/SKILL.md` ≤ 100
- `grep -c "file:line" plugin/skills/build-adapter/SKILL.md` ≥ 1 (keeps the subagents grounded)

**Anti-pattern guards:**
- Do NOT create `references/` or `templates/` subdirectories — the brief is self-contained
- Do NOT add `scripts/` — this skill runs no code
- Do NOT embed architecture content in the skill body — the brief points at source files, and the subagents read live source

### Phase 2 — Smoke-test against a real target

**What to implement:** run the skill end-to-end against one real target to confirm the one-shot actually works.

1. Pick a real target with solid public docs (suggest: Zed or Aider)
2. Invoke `/build-adapter <target>`
3. Observe that `make-plan` dispatches two Phase 0 subagents in parallel
4. Observe that the returned plan cites both claude-mem file:line anchors and target-docs URLs
5. Approve the plan
6. Observe that `do` writes `src/cli/adapters/<target>.ts`, registers it, and smoke-tests successfully
7. Observe that a PR is opened with the correct title and body

**Documentation references:** the brief inside `SKILL.md` is itself the spec being tested.

**Verification:**
- PR exists on GitHub with title `feat(adapter): add <target> adapter`
- `src/cli/adapters/<target>.ts` exists on the branch
- Registration in `src/cli/adapters/index.ts` is present
- Smoke-test log in the PR body shows a successful round-trip observation

**Anti-pattern guards:**
- Do NOT merge the smoke-test PR as part of verification — close it or leave it for human review
- Do NOT use `/claude-mem:do` against a fake or hypothetical target — use a real one

### Phase 3 — Ship the skill itself

**What to implement:**

1. Branch: `feat/build-adapter-skill`
2. Commit message: `feat: add build-adapter skill for building claude-mem adapters`
3. Push and `gh pr create` against `main` with body:
   - Summary: what the skill does, how it leverages make-plan + do
   - Test plan: manual checklist — invoke skill, observe parallel Phase 0, approve plan, observe do, observe PR
   - Reference: link the smoke-test PR from Phase 2 as evidence the skill produces working adapters

**Documentation references:**
- PR convention: recent merged PRs like `97c7c999` and `2337997c`
- PR body HEREDOC pattern: `plugin/skills/claude-code-plugin-release/SKILL.md` (or `version-bump`)

**Verification:**
- PR opens, `claude-code-review` workflow triggers, CodeRabbit runs
- Address review feedback in additional commits (no amends)
- Merge only after human approval

**Anti-pattern guards:**
- Do NOT auto-merge
- Do NOT bump the claude-mem version for this PR — skill addition is non-breaking and versioning is a separate cut per convention
- Do NOT edit `CHANGELOG.md`

---

## Summary

Three phases. The skill is one file (~80 lines). Its runtime behavior is **invoke `make-plan` with a dual-track research brief → show plan → invoke `do` → PR opens**. Every architecture fact stays in live source; the skill only names anchors and rules. The magic comes from `make-plan` and `do` doing what they already do best — parallel research with citations, phased execution with verification — pointed at the right assignment.
