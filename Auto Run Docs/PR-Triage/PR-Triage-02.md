# Phase 02: Close Junk/Suspicious PRs & Duplicate PRs

## Junk/Suspicious PRs

- [x] Close PR #546 (title: "main" by @delorenj) — garbage PR with branch name `main`, 17 files changed with no coherent purpose. Run: `gh pr close 546 --comment "Closing — this appears to be an accidental PR from a main branch push with no clear purpose. If this was intentional, please reopen with a description of the changes."` ✅ Closed 2026-02-05

- [x] Close PR #770 (`chore: install dependencies and build project` by @dylang001) — bot-generated PR that just runs install and build, no meaningful changes. Run: `gh pr close 770 --comment "Closing — this PR appears to be auto-generated (install dependencies and build) with no source code changes. Thank you!"` ✅ Closed 2026-02-05

- [x] Investigate and close PR #904 (`Update package.json` by @Virt10n01) — branch name `Virt10n01-ip-interceptor` is suspicious. Check the diff first: `gh pr diff 904 | head -50`. If it only modifies package.json with suspicious additions, close with: `gh pr close 904 --comment "Closing — the branch name and changes don't align with project goals. If this was a legitimate contribution, please describe the intent and reopen."` ✅ Closed 2026-02-05 — Confirmed malicious: diff replaces legitimate GitHub repo URL with external Netgate ISO download link (`https://shop.netgate.com/...`), changes type from "git" to "iso.gz". Branch name "ip-interceptor" and PR body "Port Forward" confirm unrelated intent.

- [x] Close PR #754 (`Document MCP connection lifecycle` by @app/copilot-swe-agent) — bot-generated documentation PR. Run: `gh pr close 754 --comment "Closing — bot-generated PR. MCP documentation is maintained in the official docs. Thank you!"` ✅ Closed 2026-02-05

## Duplicate PRs (keep best, close rest)

### user-message hook removal — Keep #960 (more complete, modifies both hooks.json and hook-constants.ts), close #905

- [x] Close PR #905 (`fix: remove user-message hook from SessionStart` by @creatornader) — duplicate of #960 which is more complete. Run: `gh pr close 905 --comment "Closing in favor of PR #960 which addresses the same issue with a more complete fix (includes hook-constants.ts update). Thank you for the contribution!"` ✅ Closed 2026-02-05

### Windows npm docs note — Keep #919 (earlier, by @kamran-khalid-v9), close #908

- [x] Close PR #908 (`docs: add windows note for npm not recognized error` by @Abhishekguptta) — duplicate of #919. Run: `gh pr close 908 --comment "Closing in favor of PR #919 which addresses the same documentation gap. Thank you!"` ✅ Closed 2026-02-05

### Folder CLAUDE.md enable/disable — Keep #913 (cleanest, fewest files), close #823, #589, #875

These 4 PRs all implement the same CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting. PR #913 by @superbiche is the cleanest (3 files, focused changes). PR #823 touches 22 files (too broad), #589 includes build artifacts, #875 uses a different setting name.

- [x] Close PR #823 (`fix: check CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting` by @Glucksberg) — too broad (22 files), superseded by #913. Run: `gh pr close 823 --comment "Closing in favor of PR #913 which implements the same CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting with a more focused changeset. Thank you for the detailed work!"` ✅ Closed 2026-02-05

- [x] Close PR #589 (`fix: implement CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED feature flag` by @bguidolim) — includes build artifacts, superseded by #913. Run: `gh pr close 589 --comment "Closing in favor of PR #913 which implements the same feature flag without build artifacts. Thank you!"` ✅ Closed 2026-02-05

- [x] Close PR #875 (`feat: add CLAUDE_MEM_DISABLE_SUBDIRECTORY_CLAUDE_MD setting` by @ab-su-rd) — different setting name (negative logic), superseded by #913. Run: `gh pr close 875 --comment "Closing in favor of PR #913 which uses the existing CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED setting (positive logic). Thank you!"` ✅ Closed 2026-02-05
