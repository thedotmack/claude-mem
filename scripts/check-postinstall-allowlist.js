#!/usr/bin/env node
// Postinstall regression guard.
//
// Enforces: every DIRECT dependency declared in plugin/package.json that ships
// an install / preinstall / postinstall script must be explicitly allowlisted.
// A new dep with a network postinstall that is NOT allowlisted fails CI.
//
// Why: see CHANGELOG.md (v12.6.1 -> v12.6.2 incident). PR #2300 moved 21
// tree-sitter grammars into dependencies; tree-sitter-swift's postinstall pulled
// a nested tree-sitter-cli that downloaded a Rust binary and SIGINT'd, hanging
// `npx claude-mem install`. npm does NOT honor trustedDependencies (Bun-only),
// which is why the runtime install paths pass --ignore-scripts. This guard is
// the CI-time complement: it makes adding a new postinstall-bearing dep a
// deliberate, reviewed act instead of a silent landmine.
//
// Scope: plugin/package.json direct deps only. The repo's own dev node_modules
// (tree-sitter grammars used for tests) legitimately carry install scripts and
// are NOT the install surface the user fetches via npx — so they are out of
// scope here.

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_KEYS = ['preinstall', 'install', 'postinstall'];

// The known, reviewed set of plugin deps that carry install scripts. These are
// the tree-sitter grammar native-binding builders (suppressed at runtime by
// --ignore-scripts) plus the tree-sitter-cli builder. Adding a NEW entry here
// must be a deliberate, reviewed change.
const ALLOWLIST = new Set([
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
  'tree-sitter-elixir',
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
]);

const pluginPkgPath = join(repoRoot, 'plugin', 'package.json');
if (!existsSync(pluginPkgPath)) {
  console.error(`Cannot find ${pluginPkgPath}. Run \`npm run build\` first.`);
  process.exit(1);
}

const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, 'utf-8'));
const deps = Object.keys(pluginPkg.dependencies || {});

const offenders = [];
const missing = [];
for (const dep of deps) {
  const installed = join(repoRoot, 'node_modules', ...dep.split('/'), 'package.json');
  if (!existsSync(installed)) {
    // Not resolvable in the dev tree — can't inspect. Note but don't fail
    // (the dep may be plugin-only and not hoisted into the root dev tree).
    missing.push(dep);
    continue;
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(installed, 'utf-8'));
  } catch {
    continue;
  }
  const scripts = pkg.scripts || {};
  const keys = SCRIPT_KEYS.filter((k) => typeof scripts[k] === 'string' && scripts[k].trim().length > 0);
  if (keys.length > 0 && !ALLOWLIST.has(dep)) {
    offenders.push({ name: dep, keys });
  }
}

if (missing.length > 0) {
  console.log(`(info) ${missing.length} plugin dep(s) not present in the dev node_modules tree — skipped: ${missing.join(', ')}`);
}

if (offenders.length > 0) {
  console.error('\nPostinstall allowlist guard FAILED.');
  console.error('These plugin/package.json dependencies declare install/postinstall scripts and are NOT allowlisted:');
  for (const o of offenders) {
    console.error(`  - ${o.name} (${o.keys.join(', ')})`);
  }
  console.error('\nA network postinstall can hang `npx claude-mem install` (see CHANGELOG v12.6.1 -> v12.6.2).');
  console.error('If the script is genuinely required, add the package to ALLOWLIST in');
  console.error('scripts/check-postinstall-allowlist.js AFTER review. Do NOT auto-add.');
  process.exit(1);
}

console.log(`Postinstall allowlist guard passed — ${deps.length} plugin deps checked, no unexpected install/postinstall scripts.`);
process.exit(0);
