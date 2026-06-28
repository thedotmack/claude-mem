# [plan-13] Grammar / Parser Fidelity — tree-sitter parse coverage + custom-grammar loading

## Defect

The structural-parsing layer (tree-sitter, powering smart_outline / smart_unfold and observation parsing) has two correctness gaps that share a root: the grammar/query contract is not validated against the languages it claims to support. Plain `.js` / `.mjs` / `.cjs` became unparseable when a shared JS/TS query started referencing TS-only node types that the tree-sitter version rejects (a realized regression of #1654), and `smart_outline` / `smart_unfold` never load the custom grammars declared in `.claude-mem.json`. The fix is a grammar contract: queries must parse against every declared language version, and custom-grammar configuration must actually be honored, both enforced in CI.

## Children

- #2750 — v12.6.0: plain `.js`/`.mjs`/`.cjs` unparseable — realized regression of #1654 (tree-sitter rejects TS-only node types in the shared jsts query)
- #2773 — smart_outline / smart_unfold never load custom grammars from `.claude-mem.json`

## Fix sequence

1. Split the shared JS/TS query so plain-JS files never hit TS-only node types; pin the query to the installed grammar version.
2. Wire `.claude-mem.json` custom-grammar declarations into the smart_outline / smart_unfold load path.
3. Add a CI matrix that parses representative files for every declared language + custom grammar; a query/grammar mismatch fails CI.

## Test matrix

| Language | Source | Required behavior |
|---|---|---|
| JS | `.js` / `.mjs` / `.cjs` | parses without TS-only node-type errors |
| TS/TSX | `.ts` / `.tsx` | parses (no regression) |
| custom | `.claude-mem.json` grammar | loaded and used by smart_outline/unfold |

## Out of scope

Observer output fidelity (plan-11); data persistence (plan-09).
