#!/usr/bin/env node

/**
 * Build script for all platform-specific claude-mem release artifacts.
 * Each artifact is a compressed tarball containing the /plugin directory
 * with the correct platform-specific binary already in place.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const version = packageJson.version;
const distDir = 'dist/release';
const tempBuildDir = 'dist/temp-plugin';

const TARGETS = [
  { name: 'macos-arm64', target: 'bun-darwin-arm64' },
  { name: 'macos-x64', target: 'bun-darwin-x64' },
  { name: 'linux-arm64', target: 'bun-linux-arm64' },
  { name: 'linux-x64', target: 'bun-linux-x64' },
  { name: 'windows-x64', target: 'bun-windows-x64', ext: '.exe' }
];

async function buildRelease() {
  console.log(`🚀 Building release artifacts for v${version}...\n`);

  // 1. Ensure fresh build of common assets (UI)
  console.log('📦 Building React viewer and common assets...');
  execSync('npm run build', { stdio: 'inherit' });

  // 2. Prepare output directory
  if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  for (const { name, target, ext = '' } of TARGETS) {
    console.log(`\n🏗️  Processing target: ${name} (${target})...`);
    
    // a. Create a clean copy of the plugin directory for this target
    if (fs.existsSync(tempBuildDir)) fs.rmSync(tempBuildDir, { recursive: true });
    fs.mkdirSync(tempBuildDir, { recursive: true });
    execSync(`cp -R plugin/* ${tempBuildDir}/`);

    // b. Build the binary directly into the temp plugin dir
    const binaryPath = `${tempBuildDir}/scripts/claude-mem${ext}`;
    console.log(`   - Compiling binary...`);
    try {
      execSync(
        `bun build src/cli/cli.ts --compile --minify --target=${target} --outfile ${binaryPath} --define __DEFAULT_PACKAGE_VERSION__='"${version}"'`,
        { stdio: 'inherit' }
      );
      
      // c. Package the result
      const archiveName = `claude-mem-${name}.tar.gz`;
      const archivePath = path.join(distDir, archiveName);
      console.log(`   - Creating archive ${archiveName}...`);
      
      // Use tar to preserve permissions (important for hooks and binary)
      execSync(`tar -czf ${archivePath} -C dist temp-plugin`);
      
      const stats = fs.statSync(archivePath);
      console.log(`   ✓ Created ${archiveName} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (error) {
      console.error(`   ❌ Failed to build for ${name}:`, error.message);
    }
  }

  // Cleanup
  if (fs.existsSync(tempBuildDir)) fs.rmSync(tempBuildDir, { recursive: true });

  console.log('\n✅ All release artifacts built in dist/release/');
}

buildRelease();
