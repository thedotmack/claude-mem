# Phase 06: Security Fixes

This phase addresses 5 security issues spanning command injection in CI, arbitrary file write via settings, port collision data leakage, and permission bypass. While none are remotely exploitable (all require local access or CI write permissions), they represent real risk vectors: the GitHub Actions injection could compromise the CI pipeline, and the file write vulnerability could be exploited by malicious CLAUDE.md instructions.

## Tasks

- [ ] Fix the GitHub Actions command injection vulnerability (issues #1285, #1521). The workflow file likely interpolates user-controlled input (PR title, branch name, or issue body) directly into a `run:` step without sanitization. To fix:
  - Read all workflow files: `ls .github/workflows/` and read each `.yml` file
  - Search for patterns where user input is interpolated into shell commands: `${{ github.event.pull_request.title }}`, `${{ github.event.issue.title }}`, `${{ github.event.comment.body }}`, `${{ github.head_ref }}`, or similar `github.event.*` expressions inside `run:` blocks
  - For each unsafe interpolation found:
    - Move the expression to an `env:` block at the step or job level (e.g., `env: PR_TITLE: ${{ github.event.pull_request.title }}`) and reference as `$PR_TITLE` in the `run:` block — this prevents shell metacharacter injection
    - OR use an intermediate step that sanitizes the input
  - Also check for `actions/github-script` steps that pass user input to `exec.exec()` or `child_process`
  - Verify the `claude.yml` workflow specifically — Claude Code GitHub Actions may pass PR context to Claude, which could include injection payloads. Ensure any Claude-generated output that feeds back into shell commands is sanitized

- [ ] Fix the arbitrary file write via `watch.context.path` setting (issue #1204). The `watch.context.path` setting in `~/.claude-mem/settings.json` allows specifying a custom path for the AGENTS.md context file, but there is no path validation. A malicious CLAUDE.md could instruct claude-mem to write to sensitive locations. To fix:
  - Search the codebase for `watch.context.path` or `context.path` in settings handling: `grep -r "context.path\|contextPath\|context_path" src/`
  - Read the file that processes this setting to understand how the path is used for file writes
  - Add path validation:
    - Resolve the path to an absolute path and normalize it (resolve symlinks with `fs.realpathSync`)
    - Reject paths that escape the project directory (the context file should only be written within the current working directory or `~/.claude-mem/`)
    - Reject paths targeting sensitive locations: `/etc/`, `/usr/`, `~/.ssh/`, `~/.claude/`, Windows system directories
    - Reject paths with `..` traversal components after normalization
  - Add a allowlist approach: the context file path must be within `cwd` or within `~/.claude-mem/`. Any other path is rejected with an error log
  - Write the validation as a reusable `isPathSafe(targetPath: string, allowedRoots: string[]): boolean` utility in `src/utils/`

- [ ] Fix port collision data leakage between unrelated claude-mem instances. When two users or two projects on the same machine both try to use port 37777, the second instance connects to the first's worker and can read/write that project's memory data. To fix:
  - Read `src/shared/SettingsDefaultsManager.ts` for how `CLAUDE_MEM_WORKER_PORT` is resolved
  - Read `src/services/infrastructure/HealthMonitor.ts` `isPortInUse()` and `src/services/worker-service.ts` `ensureWorkerStarted()` for the existing port conflict handling
  - The current behavior: if port is in use, hooks connect to whatever worker is running, regardless of project. This is by design for single-user scenarios but dangerous in shared environments
  - Add project identity verification to the health check: include the project name in the `/api/health` response, and in `ensureWorkerRunning()`, compare the running worker's project with the hook's project
  - If projects don't match and the setting `CLAUDE_MEM_SHARED_WORKER=true` is not set, log a warning: `"Port 37777 is in use by project '<other_project>'. Set CLAUDE_MEM_WORKER_PORT to a different port in settings.json to avoid data leakage."`
  - For the default single-user case: the worker serves ALL projects (this is correct). The fix is to ensure the health response includes project info and the warning is logged for awareness
  - For shared environments: document that each user should set a unique `CLAUDE_MEM_WORKER_PORT` in their `~/.claude-mem/settings.json`

- [ ] Audit hook execution for permission and input validation:
  - Read `src/cli/hook-command.ts` to understand how hook input (JSON from stdin) is parsed and validated
  - Read `src/hooks/hook-response.ts` for how hook output is structured
  - Read `src/utils/tag-stripping.ts` for the `<private>` tag stripping implementation
  - Verify that:
    - Hook stdin input is validated before use (JSON.parse wrapped in try-catch, with schema validation for required fields)
    - No user-provided string from hook input is passed directly to `execSync`, `spawn`, or template literals that get executed
    - The `<private>` tag stripping is applied early enough (before any storage or transmission) and cannot be bypassed by nested tags (`<private><private>...</private>...</private>`)
    - File paths from hook input (e.g., `files_read`, `files_modified` arrays) are not used for file system operations without validation
  - Read `src/supervisor/env-sanitizer.ts` to verify that `CLAUDECODE_*` and `CLAUDE_CODE_*` environment variables are properly stripped before subprocess spawning — confirm no API keys leak to chroma-mcp or other children

- [ ] Write tests for security fixes:
  - Test path validation: verify `isPathSafe()` rejects `../../../etc/passwd`, symlinks to `/etc/`, paths outside allowed roots, and Windows UNC paths
  - Test port collision warning: mock health response with different project name, verify warning is logged
  - Test private tag stripping: verify nested tags, malformed tags, and partial tags are all handled correctly
  - Test env sanitization: verify `ANTHROPIC_API_KEY`, `CLAUDECODE_SESSION`, and similar vars are stripped from child process environment

- [ ] Run build and verify:
  - Run `npm run build-and-sync`
  - Run the test suite and fix any failures
  - Run a quick grep for common security anti-patterns in the built output:
    - `execSync(` or `exec(` with string concatenation (potential injection)
    - `eval(` (code injection)
    - Template literals inside `execAsync` calls
