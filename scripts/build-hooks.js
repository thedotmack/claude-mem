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
    const distDir = 'dist';

    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }
    console.log('✓ Output directories ready');

    // Build worker service
    console.log(`\n🔧 Building worker service...`);
    await build({
      entryPoints: [WORKER_SERVICE.source],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: `${distDir}/${WORKER_SERVICE.name}.cjs`,
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
    fs.chmodSync(`${distDir}/${WORKER_SERVICE.name}.cjs`, 0o755);
    const workerStats = fs.statSync(`${distDir}/${WORKER_SERVICE.name}.cjs`);
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

    console.log('\n✅ All hooks and worker service built successfully!');
    console.log(`   Hooks: ${hooksDir}/`);
    console.log(`   Worker: ${distDir}/worker-service.cjs`);

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
