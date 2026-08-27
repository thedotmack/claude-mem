## Summary

OpenCode supplies tool arguments on the input object passed to `tool.execute.after`, but the plugin reads `output.args`. Normal observations therefore send `tool_input` as `{}`, so the observer receives no file paths, commands, or diffs. The plugin now prefers `input.args` while retaining the existing output fallback.

## Why

The local hook interface declares args on the wrong side of the provider boundary, and `index.ts:205` follows that model. The change corrects the adapter field selection without changing the rest of the observation payload.

## Scope

This covers tool argument extraction for `tool.execute.after`. Platform identity, tool-name mapping, plugin exports, worker ports, chat capture, timing, and worker-side behavior remain separate.

## Risk

Input args are used when present; existing output args and empty-object fallback remain. Tool name, response truncation, cwd, fire-and-forget delivery, and other hooks are unchanged.

## Verification

- [x] `bun test tests/integrations/opencode-plugin-contract.test.ts` — 10 pass, 0 fail
- [x] `npm run typecheck`
- [x] `npm run build` — all build targets compiled; generated outputs restored
- [x] `npm run lint:hook-io` — clean
- [x] `npm run lint:spawn-env` — clean
- [ ] `npm run strip-comments:check` — repository-wide baseline reports `Changed: 413`; check mode writes nothing
- [x] `git diff --check` — clean

Closes #3678
