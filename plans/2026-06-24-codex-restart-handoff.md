# Codex Restart Handoff — claude-mem Recovery Release

You are Codex in the `thedotmack/claude-mem` repo. Continue from the current
working tree; do not restart analysis from scratch and do not revert user or
previous-agent changes.

## User Intent

The user wants `claude-mem` working correctly in Codex first, then wants the
recovery-release plan executed to bring users back. Ignore the Gemini-generated
artifacts unless the user explicitly asks for them again.

Immediate user context:

- The user is going to restart Codex to confirm `claude-mem` works.
- The plugin cache was broken and has been patched locally.
- After confirming Codex works, start executing the recovery plan, beginning
  with preserving/landing the Codex compatibility fix and then Phase 0/Phase 1
  of the release plan.

## Repo And Working Tree

Current repo/worktree:

```text
/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/night-parsnip
```

Expected relevant working tree changes:

```text
 M plugin/hooks/codex-hooks.json
 M plugin/scripts/worker-service.cjs
 M scripts/build-hooks.js
 M src/services/worker-service.ts
 M tests/infrastructure/plugin-distribution.test.ts
 M tests/infrastructure/worker-json-status.test.ts
?? plans/2026-06-24-release-recovery-plan.md
?? plans/2026-06-24-codex-restart-handoff.md
```

The untracked release plan is intentional. Preserve it.

## What Was Fixed Already

Codex compatibility root cause:

1. `plugin/hooks/codex-hooks.json` had an unsupported root-level
   `description` key. Codex 0.140+ rejects unknown hook-config root keys, so
   hooks looked installed/enabled but did not load correctly.
2. Codex hook startup paths could emit Claude-style `suppressOutput`, which
   Codex rejects on current hook output contracts.

Implemented repo changes:

- `plugin/hooks/codex-hooks.json`
  - Removed root `description`; root keys are now only `["hooks"]`.
  - Added `CLAUDE_MEM_CODEX_HOOK=1` to every Codex hook command.
- `scripts/build-hooks.js`
  - Codex hook generation now injects `CLAUDE_MEM_CODEX_HOOK=1`.
  - Build verification now fails if Codex hooks contain unsupported root keys.
- `src/services/worker-service.ts`
  - `buildStatusOutput()` includes `suppressOutput` by default for Claude.
  - `worker-service start` omits `suppressOutput` when
    `CLAUDE_MEM_CODEX_HOOK=1`.
- `plugin/scripts/worker-service.cjs`
  - Regenerated bundle carrying the worker-service fix.
- Tests updated in:
  - `tests/infrastructure/plugin-distribution.test.ts`
  - `tests/infrastructure/worker-json-status.test.ts`

Local installed plugin copies were also patched so the user's restarted Codex
session should work immediately:

```text
/Users/alexnewman/.claude/plugins/marketplaces/thedotmack/plugin
/Users/alexnewman/.codex/plugins/cache/claude-mem-local/claude-mem/13.8.0
```

Both local copies were verified:

```text
rootKeys=["hooks"]
commandCount=7
missingCodexEnv=0
```

Installed-cache smoke results:

```text
Codex env:
{"continue":true,"status":"ready"}

Default/Claude env:
{"continue":true,"status":"ready","suppressOutput":true}
```

`codex doctor --summary --ascii` after the patch:

```text
Configuration config loaded
16 ok | 1 idle | 2 notes | 1 warn | 0 fail degraded
```

The remaining doctor warning was unrelated stale thread state:

```text
threads: rollout files are missing from the state DB
```

## Verification Already Run

These passed after the Codex fix:

```bash
bun test tests/infrastructure/plugin-distribution.test.ts tests/infrastructure/worker-json-status.test.ts tests/hook-lifecycle.test.ts
npm run typecheck:root
npm run lint:spawn-env
npm run lint:hook-io
```

Focused test result:

```text
124 pass
3 skip
0 fail
403 expect() calls
```

## Primary Plan File

Use this as the release execution source of truth:

```text
plans/2026-06-24-release-recovery-plan.md
```

That plan cross-references the PostHog report and GitHub issues/PRs. It defines
the recovery-release blockers:

1. Setup/dependency preflight and graceful degradation.
2. Chroma launch/lifecycle reliability.
3. Observer output loop fix.
4. Codex hook compatibility.
5. Gemini request-shape fix.
6. Platform session identity fix.
7. Chroma backfill JSON tolerance.
8. Telemetry UUID compatibility.
9. Upgrade/install survival for partial dependency installs.

The Codex hook compatibility blocker is already implemented locally and should
be treated as the first completed release slice, subject to final review/commit.

## Start Here After Restart

First confirm the restarted Codex session can load the plugin:

```bash
codex doctor --summary --ascii
codex plugin list
```

Expected:

- `claude-mem@claude-mem-local` is installed and enabled.
- `codex doctor` shows config loaded and no plugin/hook config failure.
- Any stale-thread warning is unrelated unless it changes.

Then verify the local cache still has the patched hook file:

```bash
node - <<'NODE'
const fs = require('fs');
const paths = [
  '/Users/alexnewman/.claude/plugins/marketplaces/thedotmack/plugin/hooks/codex-hooks.json',
  '/Users/alexnewman/.codex/plugins/cache/claude-mem-local/claude-mem/13.8.0/hooks/codex-hooks.json',
];
function commands(hooks) {
  return Object.values(hooks).flatMap(groups =>
    groups.flatMap(group => (group.hooks || []).map(hook => hook.command || ''))
  );
}
for (const p of paths) {
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cmds = commands(json.hooks);
  console.log(p);
  console.log('rootKeys=' + JSON.stringify(Object.keys(json)));
  console.log('commandCount=' + cmds.length);
  console.log('missingCodexEnv=' + cmds.filter(c => !c.includes('CLAUDE_MEM_CODEX_HOOK=1')).length);
}
NODE
```

Then smoke the installed worker-service output shape:

```bash
node - <<'NODE'
const { spawnSync } = require('child_process');
const runner = '/Users/alexnewman/.codex/plugins/cache/claude-mem-local/claude-mem/13.8.0/scripts/bun-runner.js';
const worker = '/Users/alexnewman/.codex/plugins/cache/claude-mem-local/claude-mem/13.8.0/scripts/worker-service.cjs';
for (const [label, env] of [
  ['codex', { ...process.env, CLAUDE_MEM_CODEX_HOOK: '1' }],
  ['default', { ...process.env }],
]) {
  const result = spawnSync(process.execPath, [runner, worker, 'start'], { env, encoding: 'utf8' });
  console.log(label + ': exit=' + result.status + ' stdout=' + result.stdout.trim() + ' stderr=' + result.stderr.trim());
}
NODE
```

Expected:

```text
codex: exit=0 stdout={"continue":true,"status":"ready"} stderr=
default: exit=0 stdout={"continue":true,"status":"ready","suppressOutput":true} stderr=
```

## Execution Plan

### Step 1 — Preserve The Codex Compatibility Fix

Review the six modified files and the generated bundle diff. Do not throw away
`plugin/scripts/worker-service.cjs`; it is the distributed artifact for users.

Run:

```bash
git diff --stat
git diff -- plugin/hooks/codex-hooks.json scripts/build-hooks.js src/services/worker-service.ts tests/infrastructure/plugin-distribution.test.ts tests/infrastructure/worker-json-status.test.ts
```

Then rerun:

```bash
bun test tests/infrastructure/plugin-distribution.test.ts tests/infrastructure/worker-json-status.test.ts tests/hook-lifecycle.test.ts
npm run typecheck:root
npm run lint:spawn-env
npm run lint:hook-io
```

If the user wants a commit, commit only the Codex compatibility fix plus the
handoff/recovery plan files if they want those included. Do not include
unrelated generated churn.

Suggested commit message:

```text
fix(codex): ship strict plugin hooks and Codex-safe worker status
```

### Step 2 — Start Release Branch Discipline

Use the plan file:

```text
plans/2026-06-24-release-recovery-plan.md
```

Target branch from the plan:

```text
release/recovery-2026-06-24
```

Before creating or switching branches, inspect current branch and status. Do
not drop local changes.

```bash
git branch --show-current
git status --short
```

If continuing in this worktree, keep the release branch scoped to recovery
blockers only.

### Step 3 — Execute Remaining Release Phases

Codex compatibility is plan-19 / Phase 1A and is already implemented locally.
Next priorities from the recovery plan:

1. Phase 0: branch/freeze and route GitHub issues/PRs to recovery blockers.
2. Phase 1: setup/install survival.
   - Add dependency health for Claude CLI, Bun, uv/uvx, plugin hard deps, and
     provider key state.
   - Runtime missing Claude CLI becomes `setup_required`, not retry spam.
   - Runtime missing `uvx` disables vector search, but SQLite capture/search
     continues.
   - Replace `Bun.randomUUIDv5` in `src/services/telemetry/backfill.ts`.
3. Phase 2: Chroma lifecycle reliability.
   - Prefer `uvx --from chroma-mcp==<pin> chroma-mcp`.
   - Split prewarm timeout from MCP handshake timeout.
   - Capture bounded stderr on connect failure.
   - Treat backoff/unavailable as "not synced yet", not user-flow throws.
4. Phase 3: observer output and quota pause.
   - Drop non-XML/prose instead of poison-respawn.
   - Pause on quota/weekly-limit messages without losing pending work.
5. Phase 4: Gemini request envelopes and platform-namespaced session identity.
6. Phase 5: Chroma backfill malformed JSON tolerance.

Do not spend time on new providers, broad refactors, or feature bundles unless
they directly unblock one of the recovery blockers.

## GitHub / Report Context

The plan was built from:

```text
Attached PostHog report:
/Users/alexnewman/.superset/host/e7c5cb1f-3f94-4b7b-b6b7-37a97d3b4a51/attachments/08a4bcfe-650a-4094-a534-815c15b67701/08a4bcfe-650a-4094-a534-815c15b67701.json

GitHub snapshots:
/tmp/claude_mem_open_issues_full.json
/tmp/claude_mem_open_prs.json
```

High-impact report categories:

- Claude executable not found.
- `uvx` not found.
- `Bun.randomUUIDv5` not a function.
- Chroma 30s timeout.
- MCP `-32000 Connection closed`.
- Chroma backoff throws into sync.
- Gemini 400 bad request.
- Platform source conflict.
- JSON parse error with Chinese/non-JSON strings.
- Observer poison/respawn loop.

Codex-specific blockers:

- #2972 / #2947: Codex refuses to load hooks config.
- #2975 / #2871: Codex rejects hook output.
- #2962 / #2941 / #2914: Codex/Windows spawn contract regressions.

PRs to consolidate from the plan:

- #3039 partial dependency install survival.
- #3033 UTF-8 BOM settings readers.
- #3018 proxy env preservation.
- #3028 observer poisoned respawn fix.
- #2920 Chroma uvx prewarm.
- #2880 Chroma `uvx --from`.
- #2887 bundle zod.
- #2849 SQLite busy timeout.
- #2953 Codex compatibility, if it still rebases cleanly.
- #2945 Windows hook install spawn/PATH fixes, if still needed.

## Operating Constraints

- Keep edits scoped to recovery blockers.
- Preserve user changes and untracked plan files.
- Use `rg` for search.
- Use `apply_patch` for manual file edits.
- Do not use destructive git commands.
- Verify with focused tests before broad tests.
- For generated bundles, ensure only required bundle artifacts remain modified.

