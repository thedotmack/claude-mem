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
import { POSTINSTALL_ALLOWLIST, allowScriptsMap, allowScriptsNpmrcLine } from './postinstall-allowlist.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_KEYS = ['preinstall', 'install', 'postinstall'];

// The known, reviewed set of plugin deps that carry install scripts. These are
// the tree-sitter grammar native-binding builders (suppressed at runtime by
// --ignore-scripts) plus the tree-sitter-cli builder. The list itself lives in
// scripts/postinstall-allowlist.js so the CI guard, the build, and the shipped
// `allowScripts` declarations all read one source. Adding a NEW entry there must
// be a deliberate, reviewed change.
const ALLOWLIST = new Set(POSTINSTALL_ALLOWLIST);

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
  console.error('If the script is genuinely required, add the package to POSTINSTALL_ALLOWLIST in');
  console.error('scripts/postinstall-allowlist.js AFTER review. Do NOT auto-add.');
  process.exit(1);
}

// Drift guard: the shipped `allowScripts` declarations MUST equal the reviewed
// allowlist. These are what lets Claude Code's marketplace install run install
// scripts on npm 11.16+/v12 instead of aborting with EALLOWSCRIPTS. If someone
// edits the allowlist but not the shipped manifests (or hand-edits a manifest),
// the install silently regresses — so fail loud here.
const expectedMap = allowScriptsMap();
const expectedKeys = Object.keys(expectedMap).sort();
const driftErrors = [];

function checkAllowScriptsField(label, relPath) {
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) {
    driftErrors.push(`${label}: missing file ${relPath}`);
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(abs, 'utf-8'));
  } catch (e) {
    driftErrors.push(`${label}: could not parse ${relPath} (${e.message})`);
    return;
  }
  const actual = pkg.allowScripts;
  if (!actual || typeof actual !== 'object') {
    driftErrors.push(`${label}: ${relPath} is missing an "allowScripts" field`);
    return;
  }
  const actualKeys = Object.keys(actual).sort();
  const sameKeys =
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((k, i) => k === expectedKeys[i]);
  const allTrue = expectedKeys.every((k) => actual[k] === true);
  if (!sameKeys || !allTrue) {
    driftErrors.push(`${label}: "allowScripts" in ${relPath} does not match the reviewed allowlist`);
  }
}

checkAllowScriptsField('root manifest', 'package.json');
checkAllowScriptsField('plugin manifest', join('plugin', 'package.json'));

// The committed root .npmrc is the belt for the git-clone marketplace path
// (npm strips .npmrc from published tarballs, so the package.json field above is
// the load-bearing form for the npx-install path).
const npmrcPath = join(repoRoot, '.npmrc');
const expectedNpmrcLine = allowScriptsNpmrcLine();
if (!existsSync(npmrcPath)) {
  driftErrors.push(`root .npmrc: missing file .npmrc (expected line: ${expectedNpmrcLine})`);
} else {
  const npmrc = readFileSync(npmrcPath, 'utf-8');
  const hasLine = npmrc.split(/\r?\n/).some((l) => l.trim() === expectedNpmrcLine);
  if (!hasLine) {
    driftErrors.push(`root .npmrc: missing or stale "allow-scripts" line (expected: ${expectedNpmrcLine})`);
  }
}

if (driftErrors.length > 0) {
  console.error('\nallowScripts declaration guard FAILED — shipped config is out of sync with the allowlist:');
  for (const e of driftErrors) console.error(`  - ${e}`);
  console.error('\nThese declarations are what keep Claude Code\'s marketplace install from aborting');
  console.error('with EALLOWSCRIPTS on npm 11.16+/v12. Regenerate them from the single source of');
  console.error('truth (scripts/postinstall-allowlist.js): run `node scripts/build-hooks.js` to');
  console.error('refresh plugin/package.json, and sync package.json + .npmrc to match.');
  process.exit(1);
}

console.log(`Postinstall allowlist guard passed — ${deps.length} plugin deps checked, no unexpected install/postinstall scripts.`);
console.log(`allowScripts declaration guard passed — root + plugin manifests and .npmrc match the ${expectedKeys.length}-entry allowlist.`);
process.exit(0);
