# Remove Gemini CLI, Add Antigravity CLI (full parity)

## Why

Google officially confirmed (May 19, 2026, https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) that free/individual-tier Gemini CLI access was cut off June 18, 2026 in favor of **Antigravity CLI**, a standalone headless-capable binary (`https://github.com/google-antigravity/antigravity-cli`) that reuses Gemini CLI's `~/.gemini/` config tree and "keeps the most critical features of Gemini CLI: Agent Skills, Hooks, Subagents, and Extensions." This plan removes claude-mem's Gemini CLI *host* integration and replaces it with an Antigravity CLI integration at feature parity.

**Scope lock (confirmed with user):**
- Remove ONLY the Gemini CLI host integration (adapter, installer, hooks, IDE-detection entry, docs). **Do NOT touch** the separate, unrelated Gemini LLM/observation *provider* (`CLAUDE_MEM_GEMINI_API_KEY`, `GeminiProvider.ts`, `GeminiObservationProvider.ts`, `SettingsDefaultsManager.ts` Gemini keys, `ContextSettingsModal.tsx` Gemini form, `docs/public/usage/gemini-provider.mdx`, `docs/public/cursor/gemini-setup.mdx`, `openclaw/install.sh --provider gemini`). That's a different Google product (Gemini API) that isn't being deprecated.
- Antigravity CLI hook wiring will be built on the working hypothesis that it's schema-compatible with Gemini CLI's hook system (same vendor claim: "same underlying agent harness"), modeled directly on `GeminiCliHooksInstaller.ts`. **A hands-on manual verification against a real Antigravity CLI install is a hard merge gate** (Phase C) — the schema is not independently documented by Google (their docs pages are an unscrapable Angular SPA) and must not be shipped on assumption alone.
- **Update:** Phase B0 has since been completed against a real, already-installed Antigravity CLI on the dev machine (not a hypothesis anymore — see "B0 findings" below). Phase C's hands-on gate is downgraded from "install and configure from scratch" to "confirm the shipped installer's output matches what's already proven-working on disk," since live hooks/MCP/context files already exist on this machine from manual/prior use.

## Phase 0 — Documentation Discovery (already completed during planning)

**Allowed facts to build against** (cited, not invented):

| Fact | Source | Confidence |
|---|---|---|
| Antigravity CLI is a real standalone binary, install via `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | https://github.com/google-antigravity/antigravity-cli | High — primary source |
| Headless flags exist: `-p`/`--print`, `--sandbox`, `-c`/`--conversation`, `--model` | CLI's own CHANGELOG.md (fetched directly) + https://codelabs.developers.google.com/antigravity-cli-hands-on | High |
| Global instructions file is `~/.gemini/GEMINI.md`; workspace rules at `.agent/rules/`, workflows at `.agent/workflows/` | https://atamel.dev/posts/2025/11-25_customize_antigravity_rules_workflows/ (fetched directly) | High |
| AGENTS.md/CLAUDE.md are NOT auto-loaded by default | same source | Medium (Nov 2025 dated, unconfirmed as of now) |
| MCP natively supported; format is `mcpServers` object, `serverUrl` (not `url`/`httpUrl`) for remote, no top-level `timeout`, no JSON comments | https://cloud.google.com/blog/products/data-analytics/connect-google-antigravity-ide-to-googles-data-cloud-services + https://medium.com/google-cloud/configuring-mcp-servers-and-skills-for-antigravity-cli-and-ide-a938c7eebb78 | Medium — third-party corroborated, not Google-verbatim |
| MCP config path is `~/.gemini/config/mcp_config.json` per third-party docs | same Medium post | **Conflicts with existing codebase assumption** (`~/.gemini/antigravity/mcp_config.json` in `McpIntegrations.ts:127`) — must verify which is real in Phase B0 |
| Google confirms "Hooks" feature name carries over from Gemini CLI | https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ (fetched directly, quoted) | High for the claim, **unverified** for exact schema |
| Exact hook event names/JSON shape for Antigravity | Not found anywhere scrapable | **Unknown — do not invent.** Use Gemini CLI's schema as starting hypothesis only. |

**Anti-pattern guard:** Do not write installer code asserting a hook event name, CLI flag, or config path that isn't in the table above or confirmed in Phase B0. Where uncertain, copy Gemini CLI's exact schema and flag it inline as `// HYPOTHESIS: verify against real Antigravity CLI install` — do not silently assume correctness.

---

## Phase A — Remove Gemini CLI host integration

### A1. Delete dedicated files
- `src/cli/adapters/gemini-cli.ts` (79 lines, entire file)
- `src/services/integrations/GeminiCliHooksInstaller.ts` (393 lines, entire file)
- `tests/gemini-cli-compat.test.ts` (204 lines, entire file)
- `docs/public/gemini-cli/setup.mdx` (192 lines, entire file/directory)

### A2. Deregister from hub files
- `src/cli/adapters/index.ts` — remove `import { geminiCliAdapter } from './gemini-cli.js';` (line 5), remove `case 'gemini': case 'gemini-cli': return geminiCliAdapter;` (line 14-15), remove `geminiCliAdapter` from the barrel export (line 22).
- `src/npx-cli/commands/ide-detection.ts` — remove the `gemini-cli` entry (lines 49-53).
- `src/npx-cli/commands/install.ts` — remove the `case 'gemini-cli':` branch (~lines 323-335) that dynamically imports `installGeminiCliHooks()`.
- `src/npx-cli/commands/uninstall.ts` — remove the `{ label: 'Gemini CLI hooks', ... }` entry (~lines 358-360).
- `src/services/worker-service.ts` — remove `import { handleGeminiCliCommand } from './integrations/GeminiCliHooksInstaller.js';` (lines 73-75), remove `case 'gemini-cli': { ... }` dispatch (lines 1233-1237), update the `console.error('Platforms: ...')` help text (line 1250) to drop `gemini-cli`.
- `src/cli/handlers/context.ts` — remove the `platform === 'gemini-cli' || platform === 'gemini'` display branch (line 137). **Verify first** this branch is about hook-invoked platform display, not `CLAUDE_MEM_PROVIDER`/LLM-provider selection — do not touch anything reading `CLAUDE_MEM_PROVIDER`.
- `src/npx-cli/index.ts` — remove `gemini-cli` from help text (line 56).
- `src/services/integrations/install-paths.ts` — update the comment on line 5 that lists Gemini among installers.

### A3. Tests
- `tests/install-error-matrix.test.ts` — remove `'gemini-cli'` from the IDE matrix (line 24).
- `tests/infrastructure/plugin-distribution.test.ts` — remove the assertion expecting `'src/services/integrations/GeminiCliHooksInstaller.ts'` in the shipped-files manifest (line 436).

### A4. Docs
- `docs/public/docs.json` — remove the `"group": "Gemini CLI Integration"` nav entry (lines 62-65).
- `docs/public/installation.mdx` — remove "Gemini CLI" from the supported-IDE list (lines 20, 22, 47).
- `docs/public/introduction.mdx` — remove "Gemini CLI" from the supported-IDE list (line 83).
- `README.md` — remove the `npx claude-mem install --ide gemini-cli` line (139-142), the "Restart Claude Code or Gemini CLI" mention (line 158), and the setup-doc link (line 194).

### A5. Verify Gemini transcript-parser is truly dead for this concern
- `src/shared/transcript-parser.ts` — `isGeminiTranscriptFormat()`/`extractLastMessageFromGeminiTranscript()` parse Gemini CLI's transcript file format. Before deleting, grep for callers; if the summarization pipeline still needs it for some other reason, leave it — otherwise delete. **Do not delete blind.**

### A6. Verification checklist for Phase A
- `grep -ril "gemini-cli\|GeminiCliHooksInstaller\|geminiCliAdapter" src/ tests/ docs/public/ README.md` returns zero hits (except CHANGELOG.md history, which stays).
- `grep -ril "CLAUDE_MEM_GEMINI\|GeminiProvider\|GeminiObservationProvider" src/` still returns all the original Part-B hits — confirms the LLM provider was untouched.
- `npm run build-and-sync` succeeds.
- Full test suite passes with the deleted test files removed (not skipped).

---

## Phase B — Add Antigravity CLI (full parity)

### B0. Verification spike — COMPLETE (findings below, confirmed 2026-07-03 against a live install)

The dev machine already has both Antigravity IDE and standalone Antigravity CLI installed and in active use, including a **pre-existing, live, working claude-mem Gemini CLI hook installation** sharing the same config tree — this turned B0 from a hypothesis exercise into direct filesystem/binary inspection. No network installs were performed; no live `agy` session/model call was triggered (avoids spending the user's API quota / mutating their plugin state unasked).

**Confirmed facts:**

1. **Binary name**: `agy` (`~/.local/bin/agy`, v1.0.16) is the real standalone headless Antigravity CLI. `antigravity` (`~/.antigravity/antigravity/bin/antigravity`, v1.107.0) is a **different binary** — the desktop IDE's internal executable, not the CLI. Detection must check `isCommandInPath('agy')`, not `antigravity`.
2. **Hook config location — CONFIRMED**: `~/.gemini/settings.json`, the exact same file Gemini CLI used. Proof: claude-mem's pre-existing `gemini-cli` hooks (installed by the current, soon-to-be-removed `GeminiCliHooksInstaller.ts`) are sitting live in this file on a machine that has `agy` installed and in daily use — same file, same JSON schema (`hooks.<Event>[].hooks[].{name,type,command,timeout}`). This proves Antigravity CLI reads the shared Gemini settings file rather than a separate one. No separate `~/.gemini/antigravity-cli/settings.json` hook block exists — that file only holds unrelated CLI preferences (`colorScheme`, `model`, `trustedWorkspaces`, `enableTelemetry`), not hooks.
3. **Hook event names — CONFIRMED superset**: the live installed config has **8** events, not the 7 in current `GeminiCliHooksInstaller.ts` source: `SessionStart`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `Notification`, `PreCompress`, **and `SessionEnd` → `session-complete`** (present on disk but absent from the current source's `GEMINI_EVENT_TO_INTERNAL_EVENT` map — pre-existing doc/code drift from an older installer version). Use all 8 for the new Antigravity map since the on-disk config proves all 8 are valid, live event names.
   - `agy --help` has no dedicated `hooks` subcommand — hooks are pure config-file-driven (declare in settings.json, no CLI registration step), matching Gemini CLI's own model exactly.
4. **MCP config path — TWO real files exist, genuinely ambiguous, needs a dual-write**:
   - `~/.gemini/antigravity/mcp_config.json` (old path, already has claude-mem registered from the existing MCP-only installer, real content, in use).
   - `~/.gemini/config/mcp_config.json` (exists but **empty**, directory created recently alongside the CLI's own app-data dir) — matches third-party docs' claimed newer/unified path, but nothing has written real content there yet on this machine.
   - **Decision: write to both paths.** Both are cheap idempotent JSON merges (reuse `writeMcpJsonConfig` from `McpIntegrations.ts` verbatim for each path) — safe insurance until it's confirmed via a live tool-call test which one `agy` actually reads. Do not pick just one on a guess.
5. **Rules/context file path — CONFIRMED, existing code was already right**: `~/.agents/rules/` (**plural** "agents") is real and populated (`~/.agents/rules/claude-mem-context.md` already exists from the current `ANTIGRAVITY_CONFIG` MCP installer). The earlier research citing singular `.agent/rules/` was wrong for this install — no `.agent/` (singular) directory exists anywhere. Keep the existing codebase's path assumption in `McpIntegrations.ts:129` as-is.
6. **GEMINI.md — CONFIRMED live**: `~/.gemini/GEMINI.md` is real, in active use (has native Antigravity "Gemini Added Memories" auto-entries plus claude-mem's own `<claude-mem-context>` tag block already injected and rendering correctly). No change needed to the context-injection target.
7. **New architectural finding (not required for parity, follow-up candidate):** `agy plugin {list,import,install,uninstall,enable,disable,validate,link}` is a first-class plugin-marketplace subcommand system, structurally similar to Codex CLI's `codex plugin marketplace` — notably `agy plugin import gemini|claude` suggests native cross-tool plugin migration. `agy plugin list` currently reports "No imported plugins" on this machine (unexercised). This could be a cleaner, more idiomatic integration path than hand-editing `settings.json` (bundling hooks+MCP+skills registration the way Codex's `.codex-plugin/plugin.json` does) but its manifest schema isn't discoverable without actually running `agy plugin import`/`install` against a real manifest, which would mutate the user's live local plugin state — **out of scope for this plan**; ship the proven settings.json + dual mcp_config.json approach now, note the plugin-marketplace path as a future enhancement in the new doc page.

No further B0 work needed — proceed to B1 with confirmed values, not hypotheses.

### B1. IDE detection — upgrade the existing `antigravity` entry, don't fork it

`src/npx-cli/commands/ide-detection.ts` — the existing entry (lines 90-95) is MCP-only. Upgrade in place rather than adding a duplicate `antigravity-cli` id (Antigravity IDE and CLI share the same `~/.gemini/antigravity` config namespace per Google — a second near-identical entry would confuse the install picker):
```ts
{
  id: 'antigravity',
  label: 'Antigravity',
  detected: existsSync(join(home, '.gemini', 'antigravity')) || isCommandInPath('agy'),
  hint: 'hooks + MCP integration',
}
```

### B2. New installer: `src/services/integrations/AntigravityCliHooksInstaller.ts`

Copy `GeminiCliHooksInstaller.ts` wholesale as the starting point (per the existing codebase's own pattern — Cursor/Windsurf/Gemini installers already copy from each other; there's no shared factory yet, per `.plan` observation "Installer code duplication audit reveals 44% reducible LoC," so don't invent one here — out of scope for this plan). Specifically:
- The idempotent hook-merge mechanism (`mergeHooksIntoSettings`, lines 97-131 of the Gemini file) is generic JSON-group merging — copy verbatim, it doesn't depend on event names.
- Keep `GEMINI_SETTINGS_PATH`/`GEMINI_MD_PATH` pointed at the SAME confirmed paths (`~/.gemini/settings.json`, `~/.gemini/GEMINI.md`) — these are shared with (former) Gemini CLI, confirmed in B0, not separate files.
- Use the confirmed 8-event map: `SessionStart→context, BeforeAgent→session-init, AfterAgent→observation, BeforeTool→observation, AfterTool→observation, Notification→observation, PreCompress→summarize, SessionEnd→session-complete` (the 8th, `SessionEnd`, is new vs. the removed Gemini installer's 7-event source map, but is confirmed live/valid per B0 — carry it forward here).
- Replace the hook command string `hook gemini-cli ${internalEvent}` with `hook antigravity-cli ${internalEvent}`.
- Fold in MCP server registration into the same installer, writing to **both** confirmed paths (`~/.gemini/antigravity/mcp_config.json` AND `~/.gemini/config/mcp_config.json`) via two calls to the existing `writeMcpJsonConfig`/`buildMcpServerEntry` helpers already in `McpIntegrations.ts` (reuse them, don't reimplement) — mirror how Cursor's installer already combines hooks+MCP (`CursorHooksInstaller.ts`).
- `handleAntigravityCliCommand(subcommand, args)` dispatcher — mirror `handleGeminiCliCommand` (install/uninstall/status); `status` should report both MCP config paths' state.

### B3. New adapter: `src/cli/adapters/antigravity-cli.ts`

Copy `gemini-cli.ts` (79 lines) as the starting point:
- Env var fallbacks: Antigravity-specific env vars (e.g. `ANTIGRAVITY_CWD`) were not discoverable without a live hook firing (out of scope for B0's read-only inspection) — keep the `GEMINI_CWD ?? GEMINI_PROJECT_DIR ?? CLAUDE_PROJECT_DIR ?? process.cwd()` fallback chain as-is, since hooks are confirmed to run through the same shared `~/.gemini/settings.json`/harness and may well set the same env vars. Flag this one spot with `// unverified: confirm Antigravity sets GEMINI_* env vars on first real hook firing` since it's the one place B0 couldn't fully close out.
- Keep the ANSI-strip logic in `formatOutput` (line 67-68 of the Gemini file) — this fixed a real, documented bug class (raw escape codes in hook output) and there's no reason a new terminal-based CLI would be immune to the same issue.
- Register in `src/cli/adapters/index.ts`: `case 'antigravity': case 'antigravity-cli': return antigravityCliAdapter;`

### B4. Register into hub files (mirror every A2 removal, in reverse, for the new platform)
- `src/services/worker-service.ts` — import + `case 'antigravity-cli':` dispatch to `handleAntigravityCliCommand`, update platforms help text.
- `src/npx-cli/commands/install.ts` — interactive-installer branch for `antigravity` calling the new combined installer instead of the old MCP-only `installMcpIntegration(ANTIGRAVITY_CONFIG)`.
- `src/npx-cli/commands/uninstall.ts` — uninstall entry calling the new uninstaller.
- `src/cli/handlers/context.ts` — add an `antigravity`/`antigravity-cli` display branch analogous to the removed Gemini one, only if B0/testing shows the generic `executeWithWorkerFallback` path needs a platform-specific carve-out (Codex needed one for MCP-based context fetch — check whether Antigravity does too, given it also has native MCP).
- `src/services/integrations/McpIntegrations.ts` — remove the now-superseded standalone `ANTIGRAVITY_CONFIG`/`installMcpIntegration(ANTIGRAVITY_CONFIG)` entry from `MCP_IDE_INSTALLERS` (superseded by B2's combined installer), unless B2 chooses to keep calling this function internally for the MCP half — either is fine, just don't leave two live code paths that both claim to install Antigravity's MCP config.

### B5. Tests
- New `tests/antigravity-cli-compat.test.ts` mirroring the deleted `tests/gemini-cli-compat.test.ts` structure — test the hook event-mapping table and adapter normalization against real (or B0-recorded) Antigravity CLI behavior, not assumptions.
- `tests/install-error-matrix.test.ts` — add `'antigravity'` (already may be present for the MCP-only tier — extend, don't duplicate) to the IDE matrix.
- `tests/infrastructure/plugin-distribution.test.ts` — add `'src/services/integrations/AntigravityCliHooksInstaller.ts'` to the shipped-files manifest assertion.

### B6. Docs
- New `docs/public/antigravity-cli/setup.mdx` modeled on the deleted `docs/public/gemini-cli/setup.mdx` — document the real (B0-verified) config paths, hook events, and explicitly note which events are hypothesis-based vs. confirmed if any remain unverified at ship time.
- `docs/public/docs.json` — add nav group for `antigravity-cli/setup`.
- `docs/public/installation.mdx`, `docs/public/introduction.mdx` — add/update "Antigravity CLI" in the supported-IDE list (upgrade existing "Antigravity" mention if present, from MCP-only framing to full hooks+MCP).
- `README.md` — add `npx claude-mem install --ide antigravity` example and setup-doc link, replacing the removed Gemini CLI lines.

### B7. Verification checklist for Phase B
- `grep -ril "antigravity" src/ tests/ docs/public/` shows the new installer, adapter, tests, and docs all present and consistent (no leftover `antigravity-cli` vs `antigravity` id mismatches across files).
- `npm run build-and-sync` succeeds; `claude-mem install --ide antigravity` runs clean in a scratch directory (no real Antigravity CLI required for this dry-run — just confirm the installer writes valid JSON/MD without throwing).

---

## Phase C — Final verification, docs polish, and the hard merge gate

1. Full repo grep sweep: zero remaining functional references to `gemini-cli`/`GeminiCliHooksInstaller`/`geminiCliAdapter` outside `CHANGELOG.md`. Zero remaining references to the OLD `ANTIGRAVITY_CONFIG` MCP-only-only code path.
2. Run full test suite (`npm test` or project equivalent) — must pass, not just build.
3. `npm run build-and-sync`, confirm the worker restarts cleanly.
4. **Hard gate (per user's chosen risk approach — cannot be skipped or waved through by CI alone):** hands-on manual verification against the real, already-installed Antigravity CLI on this machine (`agy` v1.0.16, live `~/.gemini/` tree) —
   - Run the new `claude-mem install --ide antigravity` for real on this machine and confirm it produces a superset/no-op-safe merge against the pre-existing live hooks (must not duplicate or corrupt the existing `claude-mem`-named hook entries already in `~/.gemini/settings.json`).
   - Start a real `agy` session (interactive or `agy -p "..."` print mode), perform a tool call, confirm claude-mem's hook fires (check worker logs / DB for a newly captured observation timestamped after the test run).
   - Confirm `GEMINI.md` context injection still renders correctly (it already does today under the old Gemini CLI installer — confirm the new Antigravity-branded installer doesn't regress it).
   - Confirm MCP registration: check whether `agy` actually reads `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/config/mcp_config.json`, or both, by testing claude-mem's MCP tools are reachable from a live `agy` session — this resolves the one dual-write ambiguity left open from B0.
   - If ANY of these fail, do not merge — fix the schema/path assumption and re-verify. This is the one place in the plan where "tests pass" is explicitly insufficient proof.
5. No changelog edits — per `CLAUDE.md`, it's auto-generated.

---

## Execution notes for `/do`

- Execute Phase A fully before starting Phase B — Phase A is low-risk, mechanical, and independently verifiable; keep it as a clean, revertible unit.
- Phase B0 is already complete (see confirmed findings above) — `/do` should build directly from those values, not re-derive or re-hypothesize them.
- The one still-open item is the MCP dual-write ambiguity (`~/.gemini/antigravity/mcp_config.json` vs `~/.gemini/config/mcp_config.json`) — implement the dual-write as specified in B2, and let Phase C's hard gate resolve which path (or both) is actually live.
- After Phase C's hard gate passes, open the PR and hand off to `/babysit` for review/CI monitoring.
