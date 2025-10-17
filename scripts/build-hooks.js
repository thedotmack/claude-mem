#!/usr/bin/env node

/**
 * Build script for claude-mem hooks
 * Bundles TypeScript hooks into individual standalone executables
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

const HOOKS = [
  { name: 'context-hook', source: 'src/bin/hooks/context-hook.ts' },
  { name: 'new-hook', source: 'src/bin/hooks/new-hook.ts' },
  { name: 'save-hook', source: 'src/bin/hooks/save-hook.ts' },
  { name: 'summary-hook', source: 'src/bin/hooks/summary-hook.ts' },
  { name: 'cleanup-hook', source: 'src/bin/hooks/cleanup-hook.ts' },
  { name: 'worker', source: 'src/bin/hooks/worker.ts' }
];

async function buildHooks() {
  console.log('🔨 Building claude-mem hooks...\n');

  try {
    // Read version from package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const version = packageJson.version;
    console.log(`📌 Version: ${version}`);

    // Check if bun is installed
    try {
      await execAsync('bun --version');
      console.log('✓ Bun detected');
    } catch {
      console.error('❌ Bun is not installed. Please install it from https://bun.sh');
      process.exit(1);
    }

    // Create scripts directory
    console.log('\n📦 Preparing scripts directory...');
    const scriptsDir = 'claude-mem/scripts';
    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }
    console.log('✓ Scripts directory ready');

    // Build each hook
    for (const hook of HOOKS) {
      console.log(`\n🔧 Building ${hook.name}...`);

      const outfile = `${scriptsDir}/${hook.name}.js`;
      const buildCommand = [
        'bun build',
        hook.source,
        '--target=bun',
        `--outfile=${outfile}`,
        '--minify',
        '--external bun:sqlite',
        `--define __DEFAULT_PACKAGE_VERSION__='"${version}"'`
      ].join(' ');

      const { stdout, stderr } = await execAsync(buildCommand);
      if (stdout) console.log(stdout);
      if (stderr && !stderr.includes('warn')) console.error(stderr);

      // Add shebang
      let content = fs.readFileSync(outfile, 'utf-8');
      content = content.replace(/^#!.*\n/gm, '');
      fs.writeFileSync(outfile, `#!/usr/bin/env bun\n${content}`);

      // Make executable
      fs.chmodSync(outfile, 0o755);

      // Check file size
      const stats = fs.statSync(outfile);
      const sizeInKB = (stats.size / 1024).toFixed(2);
      console.log(`✓ ${hook.name} built (${sizeInKB} KB)`);
    }

    console.log('\n✅ All hooks built successfully!');
    console.log(`   Output: ${scriptsDir}/`);

  } catch (error) {
    console.error('\n❌ Hook build failed:', error.message);
    if (error.stderr) {
      console.error('\nError details:', error.stderr);
    }
    process.exit(1);
  }
}

buildHooks();
