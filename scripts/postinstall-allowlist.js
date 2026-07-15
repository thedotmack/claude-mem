// Single source of truth for the set of dependencies that are permitted to run
// install / preinstall / postinstall scripts.
//
// This one list feeds three consumers so they can never drift:
//   1. scripts/check-postinstall-allowlist.js — the CI guard that fails when a
//      NEW script-bearing dep is added without review.
//   2. scripts/build-hooks.js — writes the `allowScripts` field into the
//      generated plugin/package.json.
//   3. package.json (root) + .npmrc — carry the same `allowScripts` allowlist so
//      the marketplace install Claude Code runs does not abort.
//
// WHY the `allowScripts` field exists at all: npm 11.16+/v12 turned install
// scripts into an opt-in. Claude Code's plugin setup runs an install over the
// marketplace dir and, on that newer npm, a bare `--allow-scripts` flag is
// rejected in project scope with EALLOWSCRIPTS — npm's own remedy is to declare
// the trusted packages in an `allowScripts` field in package.json (or `.npmrc`).
// Without it a fresh install on Node 26+/npm 12 aborts before the tree-sitter
// grammars / native deps can build, so no plugin and no memory capture. The
// `allowScripts` field is npm's prescribed, strict-mode-satisfying declaration;
// it is the complement to the runtime installer's `--ignore-scripts` (which is
// deliberately conservative) and to bun's `trustedDependencies`.
//
// Adding a NEW entry here must be a deliberate, reviewed act (see the CHANGELOG
// v12.6.1 -> v12.6.2 incident referenced in check-postinstall-allowlist.js).

export const POSTINSTALL_ALLOWLIST = [
  'tree-sitter-cli',
  'tree-sitter',
  'tree-sitter-c',
  'tree-sitter-cpp',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-ruby',
  'tree-sitter-rust',
  'tree-sitter-typescript',
  'tree-sitter-kotlin',
  'tree-sitter-swift',
  'tree-sitter-php',
  'tree-sitter-scala',
  'tree-sitter-bash',
  'tree-sitter-haskell',
  'tree-sitter-css',
  'tree-sitter-scss',
  '@tree-sitter-grammars/tree-sitter-lua',
  '@tree-sitter-grammars/tree-sitter-zig',
  '@tree-sitter-grammars/tree-sitter-toml',
  '@tree-sitter-grammars/tree-sitter-yaml',
  '@tree-sitter-grammars/tree-sitter-markdown',
  '@derekstride/tree-sitter-sql',
  'esbuild',
  '@biomejs/biome',
  'better-sqlite3',
];

// The `allowScripts` package.json field maps each allowlisted package name to
// `true`. Name-only keys (no version pin) allow any installed version — correct
// here because we ship semver ranges, not pinned versions. Entries for packages
// not present in a given install location are harmless (npm ignores them).
export function allowScriptsMap() {
  const map = {};
  for (const name of POSTINSTALL_ALLOWLIST) map[name] = true;
  return map;
}

// The `.npmrc` equivalent: a comma-separated `allow-scripts` config key. Note
// this is the CONFIG-FILE form, which npm accepts — distinct from the bare
// `--allow-scripts` CLI flag, which npm rejects in project-scoped installs.
export function allowScriptsNpmrcLine() {
  return `allow-scripts=${POSTINSTALL_ALLOWLIST.join(',')}`;
}
