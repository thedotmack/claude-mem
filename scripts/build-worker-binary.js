#!/usr/bin/env node

import { execFileSync } from 'child_process';
import fs from 'fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const version = packageJson.version;
const outDir = 'dist/binaries';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

fs.mkdirSync(outDir, { recursive: true });

console.log(`Building Windows exe v${version}...`);

try {
  // Rebuild the source graph even when this script is invoked directly. The
  // checked-in worker bundle alone cannot prove that recent source is shipped.
  execFileSync(npm, ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
  // Sharp's dynamically loaded native library is not a portable JS bundle.
  // Ship a host-installed sidecar, and resolve it from process.execPath.
  // https://sharp.pixelplumbing.com/install/#bundlers
  // https://bun.sh/docs/bundler#external
  execFileSync('bun', [
    'build', '--compile', '--minify', '--target=bun-windows-x64',
    // Bun disables runtime package.json resolution by default in executables;
    // enable it so the adjacent Sharp sidecar and its dependencies can load.
    // https://bun.com/docs/bundler/executables#automatic-config-loading
    '--compile-autoload-package-json',
    '--external', 'sharp', '--define', '__CMEM_MEDIA_STANDALONE__=true',
    // Compile the shipped CJS graph: Bun's independent TS/ESM bundling selects
    // a different Zod graph and fails before startup on Windows. The existing
    // esbuild output is already the user-facing, verified worker distribution.
    './plugin/scripts/worker-service.cjs',
    '--outfile', `${outDir}/worker-service-v${version}-win-x64.exe`,
  ], { stdio: 'inherit' });
  fs.writeFileSync(`${outDir}/package.json`, JSON.stringify({
    name: 'claude-mem-worker-native-runtime', private: true,
    dependencies: { sharp: packageJson.dependencies.sharp },
  }, null, 2) + '\n');
  execFileSync(npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: outDir, stdio: 'inherit', shell: process.platform === 'win32',
  });
  fs.writeFileSync(`${outDir}/README-media-runtime.txt`,
    'Install the locked native sidecar on the target Windows host before enabling media:\n' +
    'npm ci --ignore-scripts --no-audit --no-fund\n' +
    'Keep package.json, package-lock.json and node_modules next to the executable.\n' +
    'Run the executable with media-smoke to verify both WebP variants.\n');
  console.log(`\nBuilt: ${outDir}/worker-service-v${version}-win-x64.exe`);
} catch (error) {
  console.error('Failed to build Windows binary:', error.message);
  process.exit(1);
}
