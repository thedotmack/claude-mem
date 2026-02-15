# Rebrand: magic-claude-mem → magic-claude-mem

## Context

The project is being rebranded from "magic-claude-mem" to "magic-claude-mem". This covers all references: package names, functional paths (`~/.magic-claude-mem/`, `MAGIC_CLAUDE_MEM_*` env vars, `magic-claude-mem.db`), GitHub URLs, documentation domain, copyright, and 28 i18n README files. Copyright changes from "2025 Frederic Thomas" to "2026 Frederic Thomas".

**Scope**: ~1,724 references across ~284 files, 507 env var references, 852+ GitHub URLs.

## Pre-requisite: Commit Current Changes

Commit the 18 uncommitted files (UI rebrand, animated logo, glow effects) before starting the bulk rebrand.

## Replacement Strategy

Apply in order (longest-first to avoid partial matches), excluding `node_modules/`, `.git/`, `plugin/scripts/*.cjs`, `plugin/ui/viewer-bundle.js`:

| Order | Pattern | Replacement | Notes |
|-------|---------|-------------|-------|
| 1 | `MAGIC_CLAUDE_MEM_` | `MAGIC_CLAUDE_MEM_` | Env vars (507 refs). Skip `MAGIC_CLAUDE_MEM_INSTALLED` — it's in user rules, not codebase |
| 2 | `MagicClaudeMemEnv` | `MagicMagicClaudeMemEnv` | TypeScript interface |
| 3 | `loadMagicMagicClaudeMemEnv` / `saveMagicMagicClaudeMemEnv` | `loadMagicMagicClaudeMemEnv` / `saveMagicMagicClaudeMemEnv` | Function names |
| 4 | `Magic-Claude-Mem` | `Magic-Claude-Mem` | Title case in UI/docs |
| 5 | `magic-claude-mem` | `magic-claude-mem` | Kebab case: paths, URLs, package names, DB name, tags |
| 6 | `magic_claude_mem` | `magic_magic_claude_mem` | Snake case (rare) |
| 7 | `magic-claude-mem` | `magic-claude-mem` | Space-separated (docs) |
| 8 | `Frederic Thomas` | `Frederic Thomas` | Copyright/author |
| 9 | `2025 Frederic Thomas` → `2026 Frederic Thomas` | Already covered by 8, but fix year in LICENSE |
| 10 | `docs.magic-claude-mem.ai` | `docs.magic-claude-mem.ai` | Already covered by 5, listed for clarity |

**Exclusions** — do NOT rename:
- `.claude/` directory paths (Claude Code's config, not ours)
- `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_*` env vars (Claude Code's, not ours)
- `doublefx` username in marketplace paths (stays the same)
- `mcp-search` MCP server name (tool name, not project name)

## Phase 1: Core Functional Files

These set the foundation — all other code depends on them:

| File | Changes |
|------|---------|
| `src/shared/SettingsDefaultsManager.ts` | All `MAGIC_CLAUDE_MEM_*` keys → `MAGIC_CLAUDE_MEM_*` in interface + defaults. `~/.magic-claude-mem` → `~/.magic-claude-mem`. Add migration in `loadFromFile()` to auto-rename old keys. |
| `src/shared/paths.ts` | `magic-claude-mem.db` → `magic-claude-mem.db`, `MAGIC_CLAUDE_MEM_DATA_DIR` → `MAGIC_CLAUDE_MEM_DATA_DIR` |
| `src/shared/EnvManager.ts` | `~/.magic-claude-mem` → `~/.magic-claude-mem`, `MagicClaudeMemEnv` → `MagicMagicClaudeMemEnv`, function renames |
| `src/shared/worker-utils.ts` | `MAGIC_CLAUDE_MEM_*` setting keys, GitHub URL |
| `src/utils/logger.ts` | `~/.magic-claude-mem` default, `magic-claude-mem-*.log` filename |
| `src/utils/tag-stripping.ts` | `<magic-claude-mem-context>` → `<magic-claude-mem-context>` |

## Phase 2: Worker Service & Agents

| File | Changes |
|------|---------|
| `src/services/worker/SDKAgent.ts` | `~/.magic-claude-mem/.env` paths, settings refs |
| `src/services/worker/GeminiAgent.ts` | `~/.magic-claude-mem/settings.json`, `MAGIC_CLAUDE_MEM_*` keys |
| `src/services/worker/OpenAICompatAgent.ts` | `~/.magic-claude-mem/.env`, `'magic-claude-mem'` app name, GitHub URL |
| `src/services/worker-service.ts` | `magic-claude-mem hook` string |
| `src/services/infrastructure/ProcessManager.ts` | `~/.magic-claude-mem` path |
| `src/services/infrastructure/HealthMonitor.ts` | GitHub URL |
| `src/services/sync/ChromaSync.ts` | `~/.magic-claude-mem/vector-db`, `magic-claude-mem-chroma-sync` name, GitHub URL |
| `src/services/context/ContextConfigLoader.ts` | `~/.magic-claude-mem/settings.json`, `MAGIC_CLAUDE_MEM_*` keys |
| `src/services/domain/ModeManager.ts` | `MAGIC_CLAUDE_MEM_*` refs |
| `src/services/integrations/CursorHooksInstaller.ts` | `~/.magic-claude-mem`, MCP key, `magic-claude-mem-context.mdc`, `docs.magic-claude-mem.ai`, help text |

## Phase 3: UI Components

| File | Changes |
|------|---------|
| `src/ui/viewer/types.ts` | `MAGIC_CLAUDE_MEM_*` interface properties |
| `src/ui/viewer/constants/settings.ts` | `MAGIC_CLAUDE_MEM_OPENAI_COMPAT_APP_NAME` |
| `src/ui/viewer/hooks/useSettings.ts` | `MAGIC_CLAUDE_MEM_*` refs |
| `src/ui/viewer/hooks/useTheme.ts` | `'magic-claude-mem-theme'` localStorage key |
| `src/ui/viewer/components/Header.tsx` | `docs.magic-claude-mem.ai`, `doublefx/magic-claude-mem` GitHub link |
| `src/ui/viewer/components/ObservationCard.tsx` | `'magic-claude-mem/'` path delimiter |
| `src/ui/viewer/components/ContextSettingsModal.tsx` | `MAGIC_CLAUDE_MEM_*` refs, `'magic-claude-mem'` placeholder |
| `src/ui/viewer-template.html` | Any remaining `magic-claude-mem` refs |
| `src/cli/handlers/user-message.ts` | `"Magic-Claude-Mem Context Loaded"` |
| `src/cli/handlers/observation.ts` | `MAGIC_CLAUDE_MEM_*` settings refs |
| `src/utils/cursor-utils.ts` | `magic-claude-mem-context.mdc` filename |

## Phase 4: Package & Manifest Files

| File | Changes |
|------|---------|
| `package.json` | name, author (`Frederic Thomas`), repository/homepage/bugs URLs, script paths |
| `plugin/package.json` | name (`magic-claude-mem-plugin`), repository, homepage |
| `.claude-plugin/plugin.json` | name, homepage, repository |
| `plugin/.claude-plugin/plugin.json` | name, repository |
| `.claude-plugin/marketplace.json` | homepage, plugin name |

## Phase 5: Build Scripts

| File | Changes |
|------|---------|
| `scripts/build-hooks.js` | `magic-claude-mem-plugin` name, description |
| `scripts/sync-marketplace.cjs` | cache path `doublefx/magic-claude-mem` → `doublefx/magic-claude-mem` |
| `scripts/publish.js` | GitHub URL, title |
| `scripts/discord-release-notify.js` | GitHub URL, docs URL |
| `scripts/bug-report/cli.ts` | DB path, data dir, GitHub URL |
| `scripts/bug-report/collector.ts` | DB path, data dir |
| `scripts/regenerate-claude-md.ts` | `~/.magic-claude-mem`, `<magic-claude-mem-context>` |

## Phase 6: Documentation

| File | Changes |
|------|---------|
| `README.md` | All refs, GitHub URLs, docs URLs |
| `CLAUDE.md` | Paths, DB name, docs URL, env vars |
| `docs/i18n/README.*.md` (28 files) | All refs, GitHub URLs, docs URLs, `Frederic Thomas` → `Frederic Thomas` |
| `docs/public/docs.json` | Name, GitHub URLs, SEO, logo filenames |
| `docs/public/*.mdx` (all) | All refs, `MAGIC_CLAUDE_MEM_*`, URLs |
| `cursor-hooks/*.md` (8 files) | All refs, docs URLs |
| `CHANGELOG.md` | All GitHub URLs, path refs |
| `src/services/worker/README.md` | `MAGIC_CLAUDE_MEM_*` refs |
| `docs/reports/*.md` | GitHub URLs, paths |

## Phase 7: Tests

All test files with `MAGIC_CLAUDE_MEM_*`, `.magic-claude-mem`, `magic-claude-mem` references — apply same replacements.

Key files: `tests/shared/settings-defaults-manager.test.ts`, `tests/gemini_agent.test.ts`, `tests/cursor-mcp-config.test.ts`, `tests/infrastructure/*.test.ts`, `tests/utils/tag-stripping.test.ts`, `tests/cursor-context-update.test.ts`, `tests/worker-spawn.test.ts`

## Phase 8: LICENSE & Copyright

| File | Changes |
|------|---------|
| `LICENSE` | `Copyright (C) 2025 Frederic Thomas (fthomas@apache.org)` → `Copyright (C) 2026 Frederic Thomas (fthomas@apache.org)` |

## Phase 9: Asset Renames

Rename physical files in `docs/public/`:
- `magic-claude-mem-logomark.webp` → `magic-claude-mem-logomark.webp`
- `magic-claude-mem-logo-for-dark-mode.webp` → `magic-claude-mem-logo-for-dark-mode.webp`
- `magic-claude-mem-logo-for-light-mode.webp` → `magic-claude-mem-logo-for-light-mode.webp`

## Phase 10: Settings Migration (Backward Compat)

Add migration in `SettingsDefaultsManager.loadFromFile()` (modeled on existing OPENROUTER migration):
- Auto-rename any `MAGIC_CLAUDE_MEM_*` keys to `MAGIC_CLAUDE_MEM_*` in `settings.json`
- Write updated file back
- Log migration message

## Phase 11: Build & Verify

1. `npm run build` — regenerate all `plugin/` outputs
2. `npm test` — all tests pass
3. Grep verification — no stale `MAGIC_CLAUDE_MEM_` or `.magic-claude-mem` references in source
4. Worker starts, viewer loads at http://localhost:37777
5. `npm run build-and-sync` — deploy

## Phase 12: Local Installation Migration

**WSL**:
```bash
# Stop worker
node ~/.claude/plugins/marketplaces/doublefx/plugin/scripts/worker-service.cjs stop
# Rename data directory and database
mv ~/.magic-claude-mem ~/.magic-claude-mem
mv ~/.magic-claude-mem/magic-claude-mem.db ~/.magic-claude-mem/magic-claude-mem.db
# Rename cache
mv ~/.claude/plugins/cache/doublefx/magic-claude-mem ~/.claude/plugins/cache/doublefx/magic-claude-mem
```

**Windows (via WSL)**:
```bash
WIN_HOME="/mnt/c/Users/DoubleFx"
mv "$WIN_HOME/.magic-claude-mem" "$WIN_HOME/.magic-claude-mem"
mv "$WIN_HOME/.magic-claude-mem/magic-claude-mem.db" "$WIN_HOME/.magic-claude-mem/magic-claude-mem.db"
mv "$WIN_HOME/.claude/plugins/cache/doublefx/magic-claude-mem" "$WIN_HOME/.claude/plugins/cache/doublefx/magic-claude-mem"
```

## Phase 13: External Steps (Post-merge, manual)

1. **GitHub**: Rename repo `doublefx/magic-claude-mem` → `doublefx/magic-claude-mem` (auto-redirects old URLs)
2. **DNS**: Set up `docs.magic-claude-mem.ai` domain
3. **Mintlify**: Update deployment config for new domain
4. **npm**: Deprecate `magic-claude-mem`, publish as `magic-claude-mem`

## Execution Approach

Given ~1,724 references, use bulk `sed` replacements in order (Phase 1 strategy), then targeted manual fixes for edge cases. Each replacement pass excludes `node_modules/`, `.git/`, and build outputs. Verify with grep after each pass.
