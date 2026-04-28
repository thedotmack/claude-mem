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
