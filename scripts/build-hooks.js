#!/usr/bin/env node

/**
 * Build script for claude-mem hooks
 * Bundles TypeScript hooks into individual standalone executables using esbuild
 */

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKER_SERVICE = {
  name: 'worker-service',
  source: 'src/services/worker-service.ts'
};

const MCP_SERVER = {
  name: 'mcp-server',
  source: 'src/servers/mcp-server.ts'
};

const CONTEXT_GENERATOR = {
  name: 'context-generator',
  source: 'src/services/context-generator.ts'
};

async function buildHooks() {
  console.log('🔨 Building claude-mem hooks and worker service...\n');

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

    // Generate plugin/package.json for cache directory dependency installation
    // Note: bun:sqlite is a Bun built-in, no external dependencies needed for SQLite
    console.log('\n📦 Generating plugin package.json...');
    const pluginPackageJson = {
      name: 'claude-mem-plugin',
      version: version,
      private: true,
      description: 'Runtime dependencies for claude-mem bundled hooks',
      type: 'module',
      dependencies: {},
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

    // Build worker service
    console.log(`\n🔧 Building worker service...`);
    await build({
      entryPoints: [WORKER_SERVICE.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${hooksDir}/${WORKER_SERVICE.name}.cjs`,
      minify: true,
      logLevel: 'error', // Suppress warnings (import.meta warning is benign)
      external: ['bun:sqlite'],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: '#!/usr/bin/env bun'
      }
    });

    // Make worker service executable
    fs.chmodSync(`${hooksDir}/${WORKER_SERVICE.name}.cjs`, 0o755);
    const workerStats = fs.statSync(`${hooksDir}/${WORKER_SERVICE.name}.cjs`);
    console.log(`✓ worker-service built (${(workerStats.size / 1024).toFixed(2)} KB)`);

    // Build MCP server
    console.log(`\n🔧 Building MCP server...`);
    await build({
      entryPoints: [MCP_SERVER.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${hooksDir}/${MCP_SERVER.name}.cjs`,
      minify: true,
      logLevel: 'error',
      external: ['bun:sqlite'],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: '#!/usr/bin/env node'
      }
    });

    // Make MCP server executable
    fs.chmodSync(`${hooksDir}/${MCP_SERVER.name}.cjs`, 0o755);
    const mcpServerStats = fs.statSync(`${hooksDir}/${MCP_SERVER.name}.cjs`);
    console.log(`✓ mcp-server built (${(mcpServerStats.size / 1024).toFixed(2)} KB)`);

    // Build context generator
    console.log(`\n🔧 Building context generator...`);
    await build({
      entryPoints: [CONTEXT_GENERATOR.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${hooksDir}/${CONTEXT_GENERATOR.name}.cjs`,
      minify: true,
      logLevel: 'error',
      external: ['bun:sqlite'],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      }
    });

    const contextGenStats = fs.statSync(`${hooksDir}/${CONTEXT_GENERATOR.name}.cjs`);
    console.log(`✓ context-generator built (${(contextGenStats.size / 1024).toFixed(2)} KB)`);

    console.log('\n✅ Worker service, MCP server, and context generator built successfully!');
    console.log(`   Output: ${hooksDir}/`);
    console.log(`   - Worker: worker-service.cjs`);
    console.log(`   - MCP Server: mcp-server.cjs`);
    console.log(`   - Context Generator: context-generator.cjs`);

  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    if (error.errors) {
      console.error('\nBuild errors:');
      error.errors.forEach(err => console.error(`  - ${err.text}`));
    }
    process.exit(1);
  }
}

buildHooks();
