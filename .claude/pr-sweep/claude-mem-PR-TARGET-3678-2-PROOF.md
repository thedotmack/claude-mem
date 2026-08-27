# Proof report: T3678-2

| surface | command run | observed result | base/head | bounded verbatim evidence |
|---|---|---|---|---|
| input-side args | `bun test tests/integrations/opencode-plugin-contract.test.ts` | The captured OpenCode input-only shape posts the input args exactly; `OpenCode plugin event contract > posts observations to the worker via tool.execute.after`; `10 pass`. | base: `posts {}`; head: `10 pass`, `0 fail` | `OpenCode plugin event contract > posts observations to the worker via tool.execute.after`; `10 pass`; `0 fail` |
| input precedence | `bun test tests/integrations/opencode-plugin-contract.test.ts` | Different input and output args select the input object; `prefers input args when both hook payloads contain arguments`. | base: output wins; head: input wins | `prefers input args when both hook payloads contain arguments`; `41 expect() calls` |
| output fallback | `bun test tests/integrations/opencode-plugin-contract.test.ts` | Output args remain selected when input args are absent; `retains output args as the fallback when input args are absent`. | base: output fallback; head: output fallback preserved | `retains output args as the fallback when input args are absent` |
| empty fallback | `bun test tests/integrations/opencode-plugin-contract.test.ts` | Neither args source produces `{}` and body fields pass; `uses an empty object when neither hook payload contains args`; `0 fail`. | base: `{}` and body fields preserved; head: same | `uses an empty object when neither hook payload contains args`; `10 pass`; `0 fail` |
| provider shape | `bun test tests/integrations/opencode-plugin-contract.test.ts` | The fixture models the issue-author capture with `args` on input and no args on output; `expect(obsBody.tool_input).toEqual({ path: "/a" })`. | base: local fixture exposed the wrong object; head: input-only provider shape passes | `args: { path: "/a" }`; `expect(obsBody.tool_input).toEqual({ path: "/a" })` |
| Type safety | `npm run typecheck` | Both configured TypeScript projects pass. | head: proved | `tsc --noEmit && tsc --noEmit -p src/ui/viewer/tsconfig.json` |
| Build | `npm run build`, then `git restore --worktree -- plugin/scripts/*.cjs plugin/scripts/*.js plugin/ui/viewer-bundle.js` | All build targets compile; generated contributor outputs were restored. | head: proved | `✅ All build targets compiled successfully!` |
| Hook I/O lint | `npm run lint:hook-io` | Clean. | head: proved | `hook-io discipline: OK (handlers + adapters are pure)` |
| Spawn environment lint | `npm run lint:spawn-env` | Clean. | head: proved | `spawn-env discipline: OK (all env-bearing spawns sanitize process.env)` |
| Strip-comments check | `npm run strip-comments:check` | Fails on the repository-wide baseline count; no files were written. | blocker, not caused by the target's runtime change | `Changed:   413 (check mode, no writes)` |
| Diff check | `git diff --check` | Clean. | head: proved | empty output, exit 0 |

Reality gate evidence: `D:\Repos\.claude\pr-sweep\bodies\claude-mem-issue-comment-5417186544.md` records that OpenCode tool arguments are on `input.args` and `output.args` may be absent. The exact installed provider runtime isn't locally launchable; the input-only fixture reaches the adapter boundary and the output fallback remains.
