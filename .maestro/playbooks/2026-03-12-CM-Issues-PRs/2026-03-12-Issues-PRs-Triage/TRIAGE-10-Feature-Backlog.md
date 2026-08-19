# Phase 10: Features — Backlog Prioritization & Triage

These are feature requests, not bugs. None are urgent, but several have strong user demand. This phase triages each request: close those that are out of scope, label those worth doing, and implement the small ones that provide outsized value. Large features should be planned as separate playbooks.

**Issues addressed:** #1322, #1273, #1272, #943, #1252, #1284, #1256
**Prerequisite:** Phases 01-09 should be complete (all bugs fixed first).

## Tasks

- [ ] Implement manual save_memory MCP tool (#1322). Users want explicit control over what gets saved, beyond automatic observation capture. This is a small, high-value feature:
  - Read the existing MCP tool registration in `src/services/worker-service.ts` or `src/services/server/Server.ts` — find where MCP tools like `search`, `get_observations` are defined
  - Add a new MCP tool `save_memory` that accepts:
    - `title` (required string) — the memory title
    - `content` (required string) — the memory content/narrative
    - `tags` (optional string array) — categorization tags
  - The tool handler should:
    1. Create an observation directly via `ObservationStore.storeObservation()` with `tool_name: 'save_memory'`
    2. Use the current session's `contentSessionId` and `cwd`
    3. Skip the SDK agent compression pipeline — store the user's content as-is (title becomes title, content becomes narrative)
    4. Return `{ saved: true, id: <observation_id> }`
  - Search for existing manual observation patterns before implementing

- [ ] Triage project detection fragmentation (#1256). `basename(cwd)` causes data fragmentation in monorepos where multiple subdirectories share the same name:
  - Check if PR #1298 (git root detection) was reviewed/merged in Phase 01
  - If merged, verify it resolves #1256 by testing: observations from different subdirectories of a monorepo should group under the same project
  - If not merged, the fix is to use `git rev-parse --show-toplevel` for project identification instead of `basename(cwd)`. Read `src/shared/paths.ts` `getCurrentProjectName()` to understand the current logic
  - Close #1256 with a comment explaining the fix (either the merged PR or the new implementation)

- [ ] Triage and close deferred feature requests. These features are valuable but too large for this playbook. Close with thoughtful comments explaining they're deferred, not rejected:
  - #1273 (UUID observation IDs) — Comment: `Valuable for multi-machine sync. Requires schema migration and ID format change across all APIs. Deferring to a dedicated playbook. Current integer IDs remain stable for single-machine use.`
  - #943 (LiteLLM proxy support) — Comment: `Good feature request. Requires adding proxy URL configuration to SDK agent spawn. Deferring — workaround: set ANTHROPIC_API_BASE env var if your proxy supports the Anthropic API format.`
  - #1252 (embedded/in-process mode) — Comment: `Architecture change to eliminate the external worker. This would be a major refactor of the hook→worker communication layer. Deferring to a dedicated design effort.`
  - #1284 (claude-brain integration) — Comment: `Interesting integration idea. claude-brain and claude-mem solve overlapping problems with different approaches. Deferring — users can use both independently.`
  - Label each with `enhancement` and `deferred` if labels are available

- [ ] Implement CLAUDE.md generation toggle (#1272). Users want to disable the automatic CLAUDE.md file generation in subdirectories:
  - Search for where CLAUDE.md files are written — look for `CLAUDE.md`, `writeClaudeMd`, `agents-md` in the codebase
  - Add a setting `CLAUDE_MEM_GENERATE_CLAUDE_MD` with default `'true'` to `src/shared/SettingsDefaultsManager.ts`
  - In the CLAUDE.md generation code, check this setting before writing. If `'false'`, skip generation entirely
  - This is a simple gate — do NOT refactor the generation logic

- [ ] Create final comprehensive triage report at `/Users/alexnewman/Scripts/claude-mem/Auto Run Docs/2026-03-12-CM-Issues-PRs/2026-03-12-Issues-PRs-Triage/Working/final-triage-report.md`:
  - Use YAML front matter: `type: report`, `title: Final Issues & PRs Triage Report`, `created: 2026-03-12`, `tags: [triage, final-report, issues, prs]`
  - Summarize all 10 phases: issues addressed, PRs merged, issues closed, remaining open items
  - List total issue count before vs after triage
  - List total PR count before vs after triage
  - List any issues that were NOT addressed by any phase (gaps)
  - List stale PRs that should be closed (open for >3 months with no activity): candidates include #474, #854, #996, #1064, #1072, #1078, #1083, #1085, #1088, #1092, #1101, #1102
  - Recommend which stale PRs to close vs keep based on whether their target issue still exists

- [ ] Run final test suite and build:
  - Run `npm test` — all tests must pass
  - Run `npm run build-and-sync`
  - Verify the worker starts and the viewer UI loads at `http://localhost:37777`
