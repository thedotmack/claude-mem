# [plan-20] Project Identity & Injection Scope — one resolver shared by capture, sync and retrieval, and injection config that reaches the query

> **Tracker:** #3608 · **Design doc:** `plans/20-project-identity-and-injection-scope.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611

## Defect

"Which project is this?" is computed independently on the write path (hook capture, observer, Chroma sync), the read path (SessionStart/compact context, PreToolUse file-context, semantic inject, timeline), and the migration path — with different rules — and there is no user-facing override. Every mismatch is a silent "This project has no memory yet" over thousands of observations, or memory scattered across five keys:

- Write path is `basename(process.cwd())` in the bundled hook scripts (subagent/SDK sessions inherit TMPDIR → project `T`; observer sessions → plugin version dir); read path is `basename(gitToplevel(cwd) ?? cwd)` since #2663 with a no-git fallback that differs from the parent-project attribution capture uses; the 13.4.0 switch from cwd-basename to git-root re-keyed monorepo subdirectories with no migration; submodules (`.git/modules/`) are treated as standalone leaf projects; worktrees are reconciled by a **one-shot** `.cwd-remap-applied-v1` marker so later-created worktrees and re-homed repos strand rows with `merged_into_project = NULL`; the key is compared with SQLite BINARY collation so `pasteypal` ≠ `PasteyPal` across machines; identical dir names in different repos collide; `<project>:dream` namespaces never match `WHERE project = ?`; Chroma docs are tagged with the *daemon's* cwd, so `/api/context/semantic?project=` is always empty.
- Injection configuration is decorative: `CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES/_CONCEPTS` are documented, persisted, and never reach `loadContextConfig`; `CLAUDE_MEM_EXCLUDED_PROJECTS` is honored by capture handlers but not by the SessionStart `context` handler; the injection query has no `agent_id IS NULL` filter so subagent step-logs evict durable memory from the recency window.
- Injection output is not deterministic or idempotent: minute-granularity timestamps in the SessionStart and file-context headers bust the Anthropic prefix cache every 60 s; the file-context hook re-injects the same block on every Read of an unchanged file (the once-per-session gate from #1629 is gone in 13.13.0); the folder-`CLAUDE.md` writer still creates 43-byte stubs in directories that had no `CLAUDE.md`; timeline anchoring uses a global LIMIT across projects and never selects the stream key.

The fix is a single `resolveProjectIdentity(cwd, env)` used by every path (with `CLAUDE_MEM_PROJECT_NAME` / marker-file / git-remote override, case-folded canonical key, worktree/submodule → parent, alias table backed by `merged_into_project`), a `ContextScope` object built once from settings + mode and passed to every injection query, and injection renderers that are pure functions of (scope, data).

## Children

- #2834 — Fix distilled memory context injection for project dream namespaces
- #2842 — Submodule cwd resolves to empty leaf project — "no memory yet" despite parent repo history
- #2864 — Worktree observations orphaned by one-shot `.cwd-remap-applied-v1` migration; unreachable after the worktree is removed
- #2872 — Volatile minute-granularity timestamps in injected context defeat Anthropic prompt caching
- #2882 — Project detection uses git root instead of working directory, causing issues in monorepos/subdirectories
- #2967 — tracking: project name detection resolves wrong directory in monorepos, worktrees, and submodules
- #2970 — tracking: minute-granularity timestamps in injected context bust Anthropic prefix cache every 60 seconds
- #2971 — tracking: distilled dream-namespace memories excluded from context injection
- #3025 — Summary timeline back-dating: per-stream lookahead + merged-source semantics
- #3062 — Re-home / parent `git init` orphans pre-move observations + collapses sub-projects into one git-root key
- #3194 — Context injection resolves project as basename(cwd) outside git repos while capture attributes to the parent project
- #3274 — Context injection should not include subagent observations (filter agent_id IS NULL, configurable)
- #3343 — Cursor: one workspace for different projects (per-prompt folder as project / manual project assignment)
- #3409 — CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES / _CONCEPTS are documented and persisted but never reach the injection query
- #3437 — project is basename(process.cwd()), so subagent/SDK observations file under TMPDIR — 26% of this store is misattributed
- #3480 — PreToolUse `file-context` hook re-injects the same "prior observations" block on every Read of the same unchanged file
- #3511 — EXCLUDED_PROJECTS not respected by SessionStart context injection
- #3531 — Project identity is basename(git-toplevel) compared case-sensitively — two checkouts silently fork into separate memory buckets
- #3544 — Still creates 43-byte stub-only CLAUDE.md in dirs without CLAUDE.md (v13.14.0)
- #3594 — Custom project name/alias for repos with identical directory names

Related PRs to evaluate/rebase: #2827 (git-remote identity source), #2883, #2856, #2665, #2858 (dream namespaces), #2886 (timestamps), #2701 (the git-root switch), #3358.

## Fix sequence

1. **`resolveProjectIdentity()` in `src/utils/project-name.ts`, used everywhere.** Order: `CLAUDE_MEM_PROJECT_NAME` env → `.claude-mem-project` marker walking up → `CLAUDE_PROJECT_DIR` → git remote slug (`org/repo`, opt-in default per #2827) → git toplevel (worktree and submodule resolve to their superproject; subdirs keep a `subpath` field for optional scoping) → nearest `.claude/` ancestor → `basename(cwd)` last, with a denylist for TMPDIR/homedir/plugin-dir basenames. Output is a canonical, case-folded key plus display name. Bundled hook scripts, observer ingest, Chroma sync metadata, and every read path call this one function.
2. **Idempotent reconciliation, not a one-shot marker.** On worker start, a versioned reconciler re-derives keys for rows whose stored cwd (kept from now on) resolves differently, writing `merged_into_project`; a `claude-mem project alias|merge <from> <into>` command exposes the same table; retrieval matches `project IN (key, aliases…)` with `COLLATE NOCASE`.
3. **`ContextScope` built once.** `{projects, excludedProjects, types, concepts, mainAgentOnly (default true), subagentTypesAllowlist, platformSource}` from settings ∩ mode; `SettingsDefaults` gains the missing keys; every injection query (`ObservationCompiler`, semantic inject, file-context, timeline) takes a `ContextScope`; the SessionStart `context` handler applies `excludedProjects` and dream-namespace inclusion (`<project>:dream` preferred over raw when present).
4. **Deterministic, idempotent rendering.** Headers stamp day granularity (or nothing); the file-context gate is persisted per (session, file, latestObservationEpoch) in SQLite so an unchanged file injects once; the folder-`CLAUDE.md` writer never creates a file that did not exist and never writes an empty wrapper; timeline queries select the stream key and apply per-stream lookahead with explicit merged-source semantics.
5. **Doctor row.** `claude-mem doctor` prints the resolved identity for the current cwd from both the read and write code paths and fails if they differ.

## Test matrix

| Layout | Path | Required behavior |
|---|---|---|
| plain repo, monorepo subdir, git worktree, submodule, non-git subdir under `$HOME`, TMPDIR subagent cwd, plugin cache dir, two case-variant checkouts, two repos with same dirname + `CLAUDE_MEM_PROJECT_NAME`, Cursor multi-root | capture vs SessionStart context vs semantic inject vs timeline vs Chroma metadata | identical canonical key on every path (asserted by a table test that runs all five resolvers) |
| worktree created after install, then removed | reconciliation | rows reachable from parent before and after removal |
| repo moved on disk / `git init` on parent | reconciliation | old rows aliased, not orphaned |
| excluded project | SessionStart, compact, file-context, semantic | nothing injected |
| `CONTEXT_OBSERVATION_TYPES=bugfix` | injection | only bugfix rows |
| subagent-heavy project | injection | window has zero `agent_id != NULL` rows by default |
| same file read 20× in one session | file-context | injected once (again only after a new observation) |
| dir without CLAUDE.md | any session | no CLAUDE.md created |
| two SessionStart injections 61 s apart | bytes | identical |

The matrix lives in CI (`tests/utils/project-identity.test.ts` with fixture repos + `tests/services/context/context-scope.test.ts`). A regression must fail CI before a user can file.

## Out of scope

Observer self-capture / observer cwd (plan-19). Chroma sync mechanics beyond stamping the right project (plan-22). Schema for `merged_into_project`/aliases beyond what step 2 needs (plan-21).
