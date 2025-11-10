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

const HOOKS = [
  { name: 'context-hook', source: 'src/hooks/context-hook.ts' },
  { name: 'new-hook', source: 'src/hooks/new-hook.ts' },
  { name: 'save-hook', source: 'src/hooks/save-hook.ts' },
  { name: 'summary-hook', source: 'src/hooks/summary-hook.ts' },
  { name: 'cleanup-hook', source: 'src/hooks/cleanup-hook.ts' },
  { name: 'user-message-hook', source: 'src/hooks/user-message-hook.ts' }
];

const WORKER_SERVICE = {
  name: 'worker-service',
  source: 'src/services/worker-service.ts'
};

// OPTIONAL: MCP search server (users can enable via .mcp.json)
// Default: skill-based search (progressive disclosure, ~2,250 token savings)
// To enable MCP: UI toggle copies .mcp.json.template to plugin/.mcp.json
const SEARCH_SERVER = {
  name: 'search-server',
  source: 'src/servers/search-server.ts'
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
      external: ['better-sqlite3'],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: '#!/usr/bin/env node'
      }
    });

    // Make worker service executable
    fs.chmodSync(`${hooksDir}/${WORKER_SERVICE.name}.cjs`, 0o755);
    const workerStats = fs.statSync(`${hooksDir}/${WORKER_SERVICE.name}.cjs`);
    console.log(`✓ worker-service built (${(workerStats.size / 1024).toFixed(2)} KB)`);

    // Build each hook
    for (const hook of HOOKS) {
      console.log(`\n🔧 Building ${hook.name}...`);

      const outfile = `${hooksDir}/${hook.name}.js`;

      await build({
        entryPoints: [hook.source],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'esm',
        outfile,
        minify: true,
        external: ['better-sqlite3'],
        define: {
          '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
        },
        banner: {
          js: '#!/usr/bin/env node'
        }
      });

      // Make executable
      fs.chmodSync(outfile, 0o755);

      // Check file size
      const stats = fs.statSync(outfile);
      const sizeInKB = (stats.size / 1024).toFixed(2);
      console.log(`✓ ${hook.name} built (${sizeInKB} KB)`);
    }

    // Build MCP search server (optional - users can enable via .mcp.json)
    console.log(`\n🔧 Building MCP search server (optional)...`);
    await build({
      entryPoints: [SEARCH_SERVER.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      outfile: `${hooksDir}/${SEARCH_SERVER.name}.mjs`,
      minify: true,
      external: ['better-sqlite3'],
      banner: {
        js: '#!/usr/bin/env node'
      }
    });

    fs.chmodSync(`${hooksDir}/${SEARCH_SERVER.name}.mjs`, 0o755);
    const searchStats = fs.statSync(`${hooksDir}/${SEARCH_SERVER.name}.mjs`);
    console.log(`✓ search-server built (${(searchStats.size / 1024).toFixed(2)} KB)`);

    console.log('\n✅ All hooks and worker service built successfully!');
    console.log(`   Output: ${hooksDir}/`);
    console.log(`   - Hooks: *-hook.js`);
    console.log(`   - Worker: worker-service.cjs`);
    console.log(`   - MCP Server: search-server.mjs (optional)`);
    console.log(`   - Skills: plugin/skills/`);
    console.log('\n💡 Note: Dependencies will be auto-installed on first hook execution');
    console.log('💡 MCP search: disabled by default (enable via viewer UI at http://localhost:37777)');

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
