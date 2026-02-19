#!/usr/bin/env node

/**
 * Build script for claude-mem unified binary
 * Compiles the TypeScript CLI into a standalone platform-specific binary using Bun
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function buildHooks() {
  console.log('🔨 Building claude-mem unified built artifact...\n');

  try {
    // Read version from package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const version = packageJson.version;
    console.log(`📌 Version: ${version}`);

    // Create output directories
    console.log('\n📦 Preparing output directories...');
    const hooksDir = 'plugin/scripts';
    const uiDir = 'plugin/ui';

    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    if (!fs.existsSync(uiDir)) {
      fs.mkdirSync(uiDir, { recursive: true });
    }
    console.log('✓ Output directories ready');

    // Generate plugin/package.json (minimal metadata)
    console.log('\n📦 Generating plugin package.json...');
    const pluginPackageJson = {
      name: 'claude-mem-plugin',
      version: version,
      private: true,
      description: 'Claude-mem persistent memory system',
      type: 'module',
      engines: {
        node: '>=18.0.0',
        bun: '>=1.0.0'
      }
    };
    fs.writeFileSync('plugin/package.json', JSON.stringify(pluginPackageJson, null, 2) + '\n');
    console.log('✓ plugin/package.json generated');

    // Build React viewer
    console.log('\n📋 Building React viewer...');
    const { spawn } = await import('child_process');
    const viewerBuild = spawn('node', ['scripts/build-viewer.js'], { stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      viewerBuild.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Viewer build failed with exit code ${code}`));
        }
      });
    });

    // Build the unified Bun binary (Primary built artifact)
    // This binary contains CLI, Daemon, and MCP server logic.
    console.log('\n🔧 Building compiled binary (claude-mem)...');
    try {
      execSync(
        `bun build src/cli/cli.ts --compile --outfile plugin/scripts/claude-mem --define __DEFAULT_PACKAGE_VERSION__='"${version}"'`,
        {
          stdio: 'inherit',
          cwd: path.join(__dirname, '..')
        }
      );
      const binaryStats = fs.statSync(`${hooksDir}/claude-mem`);
      console.log(`✓ claude-mem binary built (${(binaryStats.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (binaryBuildError) {
      console.error('\n❌ Fatal: Binary compilation failed. Bun is required to build the unified artifact.');
      console.error(`   ${binaryBuildError.message}`);
      process.exit(1);
    }

    console.log('\n✅ Unified built artifact created successfully!');
    console.log(`   Output: ${hooksDir}/claude-mem`);

  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    process.exit(1);
  }
}

buildHooks();
