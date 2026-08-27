# Target 3678-1 proof report

Base: `origin/main` at `866a0ca3b34cddd8aa4c5fba72b9ad2b3a5621fe`
Head: `866a0ca3b34cddd8aa4c5fba72b9ad2b3a5621fe` plus the staged worktree diff

| Surface | Command run | Observed result | Base/head |
| --- | --- | --- | --- |
| OpenCode session identity | `bun test tests/integrations/opencode-plugin-contract.test.ts` | `8 pass`, `0 fail`, `Ran 8 tests across 1 file.` | base: `platformSource omitted and missing metadata follows claude`; head: `canonical opencode on every session POST` |
| All five POST consumers | `bun test tests/integrations/opencode-plugin-contract.test.ts` | `stamps every session-write POST and leaves GET and deletion unchanged (pass)` | base: `five egress paths omit integration provenance`; head: `init, tool, assistant, compaction, and idle calls carry opencode` |
| Canonical routing | `bun test tests/integrations/opencode-plugin-contract.test.ts` | `47 expect() calls`, `0 fail` | base: `no plugin stamp reaches the canonical normalizer`; head: `emitted value equals normalizePlatformSource("opencode")` |
| Search/deletion boundaries | `bun test tests/integrations/opencode-plugin-contract.test.ts` | `stamps every session-write POST and leaves GET and deletion unchanged (pass)` | base: `search is GET and deletion clears maps`; head: `search stays GET and deletion emits no POST` |
| Missing-source default | `bun test tests/sqlite/session-store-sessions.test.ts` | `15 pass`, `0 fail`, `Ran 15 tests across 1 file.` | base: `missing source defaults to claude`; head: `existing storage default remains unchanged` |

## Additional gates

| Gate | Result | Bounded verbatim evidence |
| --- | --- | --- |
| `npm run typecheck` | passed | `tsc --noEmit && tsc --noEmit -p src/ui/viewer/tsconfig.json` |
| `npm run build` | passed | `✅ All build targets compiled successfully!` |
| `npm run lint:hook-io` | passed | `hook-io discipline: OK (handlers + adapters are pure)` |
| `npm run lint:spawn-env` | passed | `spawn-env discipline: OK (all env-bearing spawns sanitize process.env)` |
| `npm run strip-comments:check` | blocked by current baseline | `Changed:   413 (check mode, no writes)`<br>`Unchanged: 508` |
| `git diff --check` | passed | no output, exit code 0 |

The strip-comments check is repository-wide and reported 413 changed files in check mode without writing them. The implementation diff is limited to the OpenCode helper and its contract test; generated build output was restored as prescribed.
