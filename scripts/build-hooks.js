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
  { name: 'context-hook', source: 'src/bin/hooks/context-hook.ts' },
  { name: 'new-hook', source: 'src/bin/hooks/new-hook.ts' },
  { name: 'save-hook', source: 'src/bin/hooks/save-hook.ts' },
  { name: 'summary-hook', source: 'src/bin/hooks/summary-hook.ts' },
  { name: 'cleanup-hook', source: 'src/bin/hooks/cleanup-hook.ts' }
];

const WORKER_SERVICE = {
  name: 'worker-service',
  source: 'src/services/worker-service.ts'
};

const SEARCH_SERVER = {
  name: 'search-server',
  source: 'src/servers/search-server.ts'
};

async function buildHooks() {
  console.log('🔨 Building claude-mem hooks, worker service, and search server...\n');

  try {
    // Read version from package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const version = packageJson.version;
    console.log(`📌 Version: ${version}`);

    // Create output directory
    console.log('\n📦 Preparing output directory...');
    const hooksDir = 'plugin/scripts';

    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    console.log('✓ Output directory ready');

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

    // Build search server
    console.log(`\n🔧 Building search server...`);
    await build({
      entryPoints: [SEARCH_SERVER.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      outfile: `${hooksDir}/${SEARCH_SERVER.name}.js`,
      minify: true,
      external: ['better-sqlite3'],
      define: {
        '__DEFAULT_PACKAGE_VERSION__': `"${version}"`
      },
      banner: {
        js: '#!/usr/bin/env node'
      }
    });

    // Make search server executable
    fs.chmodSync(`${hooksDir}/${SEARCH_SERVER.name}.js`, 0o755);
    const searchStats = fs.statSync(`${hooksDir}/${SEARCH_SERVER.name}.js`);
    console.log(`✓ search-server built (${(searchStats.size / 1024).toFixed(2)} KB)`);

    console.log('\n✅ All hooks, worker service, and search server built successfully!');
    console.log(`   Output: ${hooksDir}/`);
    console.log(`   - Hooks: *-hook.js`);
    console.log(`   - Worker: worker-service.cjs`);
    console.log(`   - Search: search-server.js`);
    console.log('\n💡 Note: Dependencies will be auto-installed on first hook execution');

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
