// Single source of truth for the set of dependencies that are permitted to run
// install / preinstall / postinstall scripts.
//
// This one list feeds three consumers so they can never drift:
//   1. scripts/check-postinstall-allowlist.js — the CI guard that fails when a
//      NEW script-bearing dep is added without review.
//   2. scripts/build-hooks.js — writes the `allowScripts` field into the
//      generated plugin/package.json.
//   3. package.json (root) — carries the same `allowScripts` field.
//
// WHY the `allowScripts` field exists: npm 11.16+ runs dependency install
// scripts only for packages declared there. It is npm's counterpart to bun's
// `trustedDependencies`. The installer itself still passes `--ignore-scripts`
// everywhere, so this is hardening for npm-based installs of these manifests,
// not the EALLOWSCRIPTS fix: that error comes from an `allow-scripts` value
// inherited through the environment, which
// src/npx-cli/install/npm-install-helper.ts strips (#3697).
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
