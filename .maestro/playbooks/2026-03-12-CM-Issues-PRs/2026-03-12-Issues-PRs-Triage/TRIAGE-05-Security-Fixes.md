# Phase 05: High — Security Fixes

Security issues require careful, targeted fixes. Code analysis confirms one real vulnerability (arbitrary file write via watch.context.path), one design-level concern (multi-user port sharing), and two items that need audit review rather than code changes. GitHub Actions workflows were analyzed and found to be safe — no injection vectors.

**Issues addressed:** #1285, #1255, #1204, #1251
**Prerequisite:** Phases 01-04 should be complete.

## Tasks

- [x] Fix arbitrary file write via watch.context.path (#1204). ✅ Added `isPathWithinHomeDirectory()` validation to `agents-md-utils.ts`, applied in `writeAgentsMd()` and `loadTranscriptWatchConfig()`. 11 new tests pass. CONFIRMED VULNERABILITY: `src/services/transcripts/processor.ts` line ~362 writes to a user-configured path from `~/.claude-mem/transcript-watch.json` without boundary validation. The `expandHomePath()` in `src/services/transcripts/config.ts` only handles `~` expansion:
  - In `src/utils/agents-md-utils.ts`, in the `writeAgentsMd()` function (which already blocks `.git/` paths), add path boundary validation BEFORE the write:
    1. `const resolvedPath = path.resolve(agentsPath)`
    2. `const homeDir = os.homedir()`
    3. Reject if resolved path does NOT start with `homeDir` — log warning and return early
    4. Reject if resolved path contains `..` segments after resolution (defense in depth)
  - Also add validation at config load time in `src/services/transcripts/config.ts` `loadTranscriptWatchConfig()` — reject any `context.path` that resolves outside the user's home directory
  - Do NOT add overly restrictive validation — paths like `~/.codex/AGENTS.md` and `~/project/AGENTS.md` must remain valid

- [x] Fix cross-account data leakage on multi-user macOS (#1255). ✅ Added `computePerUserPort()` and `getEffectiveUid()` to `worker-utils.ts`. `getWorkerPort()` now derives a per-user port via `basePort + (uid % 1000)` when no explicit port override is set. 9 new tests pass. The worker binds to `127.0.0.1:37777` which is accessible to ALL local users on the same machine. Two users running claude-mem share the same port, causing data cross-contamination:
  - Read `src/services/worker-service.ts` and `src/shared/SettingsDefaultsManager.ts` to understand port binding
  - The fix: derive a per-user port from the UID to avoid collisions. In `src/shared/paths.ts` or a new utility:
    1. Get the current user's UID: `process.getuid()` (Unix) or `os.userInfo().uid` (cross-platform)
    2. Compute port: `37777 + (uid % 1000)` — this gives each user a unique port within a 1000-port range
    3. Only apply this when `CLAUDE_MEM_WORKER_PORT` is NOT explicitly set by the user
  - Update `getWorkerPort()` to use this derived port by default
  - Update all references to port 37777 in documentation comments (but NOT in settings defaults — the setting should remain `'37777'` as the base)
  - Alternative simpler fix: bind to a Unix domain socket at `~/.claude-mem/worker.sock` instead of TCP. Check if Express supports UDS. This is more secure but may break Windows compatibility — document the tradeoff and implement the per-user port approach

- [ ] Audit and close GitHub Actions injection concern (#1285). Code analysis of all 6 workflow files in `.github/workflows/` confirms NO exploitable injection vectors:
  - `convert-feature-requests.yml` uses `actions/github-script@v8` with proper API calls, not shell interpolation
  - `claude-code-review.yml` and `claude.yml` use Anthropic's official `claude-code-action`
  - `npm-publish.yml` uses standard npm workflow with no untrusted input
  - `deploy-install-scripts.yml` uses hardcoded paths only
  - `summary.yml` uses `github.event.issue.number` which is a trusted numeric value from GitHub API
  - Close #1285 with a comment documenting this analysis: `Audited all 6 GitHub Actions workflows. No ${{ github.event.* }} values are interpolated into shell run: commands. convert-feature-requests.yml uses actions/github-script with API calls. All workflows follow secure patterns. Closing as not-a-vulnerability.`

- [ ] Create security audit response document for #1251. This is a comprehensive audit request that requires documenting current security posture:
  - Create `/Users/alexnewman/Scripts/claude-mem/Auto Run Docs/2026-03-12-CM-Issues-PRs/2026-03-12-Issues-PRs-Triage/Working/security-audit-response.md` with YAML front matter: `type: report`, `title: Security Audit Response`, `created: 2026-03-12`, `tags: [security, audit]`
  - Document the following confirmed-secure patterns:
    - Worker binds to localhost only (`127.0.0.1`) with `requireLocalhost` middleware on admin endpoints
    - CORS restricted to localhost origins
    - Instructions endpoint uses path boundary validation (`startsWith` check)
    - Settings file uses merge-with-defaults pattern
  - Document the fixed vulnerabilities (from this phase):
    - watch.context.path now validated against home directory boundary
    - Multi-user port collision addressed with per-user port derivation
  - Document remaining considerations:
    - Settings file permissions (`~/.claude-mem/settings.json`) should be user-only (0600)
    - Database file permissions (`~/.claude-mem/claude-mem.db`) should be user-only
  - Add a comment on #1251 with a summary of findings and link to the audit response document

- [ ] Run tests and build:
  - Run `npm test` — all tests must pass
  - Run `npm run build-and-sync`
