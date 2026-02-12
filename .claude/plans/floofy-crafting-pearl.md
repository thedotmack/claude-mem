# Update Documentation: Bun → Node.js Migration

## Context

The codebase was migrated from Bun runtime to Node.js + better-sqlite3 (commit `6005f1ac`). All user-facing and technical documentation still references Bun as the runtime, `bun:sqlite` as the database driver, and `bun run`/`bun install` as commands. This plan updates ~45 documentation files to reflect the new Node.js-based architecture.

## Replacement Rules

| Old | New |
|-----|-----|
| `bun install` | `npm install` |
| `bun run <script>` | `npm run <script>` |
| `bun scripts/<file>.ts` | `npx tsx scripts/<file>.ts` |
| `bun:sqlite` | `better-sqlite3` |
| `Bun` (as runtime/process manager) | `Node.js` |
| Bun installation links (`bun.sh`) | Remove (Node.js already required) |
| `bun test` | `npm test` (uses vitest) |

## Phase 1: High-Priority User-Facing Docs (7 files)

### 1. `README.md`
- Line 156: `Bun management` → `Node.js management`
- Line 174: `managed by Bun` → `managed by Node.js`
- Line 235: Replace Bun system requirement with note that Node.js >= 18 is the only JS runtime needed (Bun line removed)

### 2. `docs/public/introduction.mdx`
- Line 64: `managed by Bun` → `managed by Node.js`
- Line 75: Remove Bun requirement line
- Lines 88-90: Update v7.1.0 section to note the subsequent Node.js migration, or rewrite as historical

### 3. `docs/public/installation.mdx`
- Line 29: Remove Bun requirement
- Line 100: Update v7.1.0 note to reflect Node.js is now used

### 4. `docs/public/cursor/index.mdx` (~18 edits)
- Line 51: `bun install && bun run build` → `npm install && npm run build`
- Line 54: `bun run cursor:setup` → `npm run cursor:setup`
- Lines 86,91,96: Remove Bun installation prerequisites (3 platform-specific Bun install lines)
- Lines 109-115: All `bun run` → `npm run` in command table
- Lines 123,128: `bun run` → `npm run`
- Line 157: `bun run worker:stop && bun run worker:start` → `npm run worker:stop && npm run worker:start`
- Line 160: `bun run worker:logs` → `npm run worker:logs`
- Lines 166,171: `bun run` → `npm run`

### 5. `docs/public/cursor/gemini-setup.mdx` (~8 edits)
- Lines 35,38: `bun install`/`bun run build` → `npm install`/`npm run build`
- Line 48: `bun run cursor:setup` → `npm run cursor:setup`
- Lines 80,81: `bun run` → `npm run`
- Lines 92,95: `bun run` → `npm run`
- Line 172: `bun run worker:logs` → `npm run worker:logs`

### 6. `docs/public/cursor/openai-compat-setup.mdx` (~8 edits)
- Same pattern as gemini-setup.mdx

### 7. `docs/public/usage/manual-recovery.mdx` (~11 edits)
- All `bun scripts/check-pending-queue.ts` → `npx tsx scripts/check-pending-queue.ts`
- All `bun scripts/clear-failed-queue.ts` → `npx tsx scripts/clear-failed-queue.ts`

## Phase 2: Architecture & Technical Docs (7 files)

### 8. `docs/public/architecture/worker-service.mdx`
- Line 3: `managed natively by Bun` → `managed by Node.js`
- Line 13: `Native Bun process management` → `Native Node.js process management`
- Line 670: `bun:sqlite` → `better-sqlite3`

### 9. `docs/public/architecture/database.mdx`
- Line 8: `bun:sqlite native module` → `better-sqlite3`
- Line 18: `bun:sqlite` → `better-sqlite3`
- Line 21: Update legacy note
- Line 304: `bun:sqlite reuses connections` → `better-sqlite3 reuses connections`

### 10. `docs/public/architecture/overview.mdx`
- Line 25: Process Manager `Bun` → `Node.js`
- Line 208: `Auto-managed by Bun` → `Auto-managed by Node.js`

### 11. `docs/public/hooks-architecture.mdx`
- Lines 93-94: `Starts Bun worker service` → `Starts Node.js worker service`
- Line 172: Same replacement
- Lines 473-500: Rewrite "Bun Process Management" section → "Node.js Process Management"
- Line 577: Update cleanup reference

### 12. `docs/public/configuration.mdx`
- Line 229: `managed by Bun` → `managed by Node.js`
- Line 424: `managed by Bun` → `managed by Node.js`

### 13. `docs/public/architecture-evolution.mdx`
- Lines 56,62: Update "Current Approach" to reference Node.js
- Line 159: `bun:sqlite which requires no installation` → `better-sqlite3 (auto-installed)`

### 14. `docs/public/usage/search-tools.mdx`
- Line 443: `managed by Bun` → `managed by Node.js`

## Phase 3: Historical Migration Doc (1 file)

### 15. `docs/public/architecture/pm2-to-bun-migration.mdx`
- Update the `<Note>` at the top to indicate Bun has since been replaced by Node.js
- Add a clear notice: "As of v8.x, the project has migrated from Bun to Node.js + better-sqlite3. This document is preserved for historical reference only."
- No need to rewrite the entire 560-line doc - just frame it as historical

## Phase 4: Translated READMEs (28 files)

All 28 files in `docs/i18n/README.*.md` have the same 3 Bun references matching the English README pattern:
- Worker Service line: `managed by Bun` → `managed by Node.js` (or translated equivalent)
- System requirement: Remove Bun requirement line
- Architecture link: `Bun management` → `Node.js management`

**Approach:** Use `replace_all` with exact English strings since these appear verbatim even in translations (code/technical terms aren't translated). For truly translated strings, handle per-file.

## Execution Strategy

1. Use parallel subagents to update files in batches
2. Group by similarity (cursor guides share same patterns)
3. Translated READMEs can be batch-processed with grep/sed patterns
4. Run `npm run build` at end to verify no broken MDX

## Verification

1. `grep -r "bun" docs/ README.md --include="*.md" --include="*.mdx" -l` — should return only CHANGELOG.md and pm2-to-bun-migration.mdx
2. Review key files manually for coherent reading
3. No build/test impact (docs only)
