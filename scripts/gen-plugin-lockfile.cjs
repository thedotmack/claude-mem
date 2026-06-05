#!/usr/bin/env node

// Generates plugin/bun.lock as a build artifact from the GENERATED
// plugin/package.json (written by scripts/build-hooks.js). Shipping this
// lockfile lets the runtime installer (src/npx-cli/install/setup-runtime.ts)
// run `bun install --frozen-lockfile --ignore-scripts` for a deterministic
// dependency closure. See plan-10 (Build Artifact Hygiene, Approach A).
//
// MUST run AFTER build-hooks.js. Uses --ignore-scripts so generating the
// lockfile never triggers tree-sitter postinstall builds.

const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const pluginDir = path.join(rootDir, 'plugin');
const pluginManifest = path.join(pluginDir, 'package.json');

console.log('\n🔒 Generating plugin/bun.lock...');

if (!existsSync(pluginManifest)) {
  throw new Error(
    `gen-plugin-lockfile: no package.json at ${pluginManifest}. ` +
    `Run scripts/build-hooks.js first (it generates plugin/package.json).`
  );
}

try {
  execSync('bun install --ignore-scripts', {
    cwd: pluginDir,
    stdio: 'inherit',
  });
} catch (error) {
  throw new Error(`bun install failed in ${pluginDir}\n${error.message}`);
}

const lockfile = path.join(pluginDir, 'bun.lock');
if (!existsSync(lockfile)) {
  throw new Error(
    `gen-plugin-lockfile: bun install completed but ${lockfile} was not produced.`
  );
}

console.log('✓ plugin/bun.lock generated');
